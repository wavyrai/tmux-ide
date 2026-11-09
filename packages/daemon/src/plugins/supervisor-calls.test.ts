/**
 * Host functions through the real plugin host and supervisor: Lua calls
 * ide.exec / ide.store / ide.notify, the host forwards them, the supervisor
 * checks who is calling and the handler does the work.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsent, hashPluginDirectory, revokeConsent } from "./consent.ts";
import { sandboxedArgv } from "./exec-sandbox.ts";
import { createHostCallHandler } from "./host-calls.ts";
import type { PluginLogEntry } from "./plugin-log.ts";
import { PluginSupervisor, type PluginSupervisorOptions } from "./supervisor.ts";
import { DEFAULT_PLUGIN_LIMITS } from "./protocol.ts";

const hostEntry = join(dirname(fileURLToPath(import.meta.url)), "host", "entry.ts");
const live = sandboxedArgv(["true"], { stateHome: "/", writable: "/" }).ok ? it : it.skip;

let home: string;
let supervisor: PluginSupervisor | null;
let logs: PluginLogEntry[];
let notify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-plugin-calls-"));
  supervisor = null;
  logs = [];
  notify = vi.fn(async () => {});
});
afterEach(async () => {
  await supervisor?.stop();
  rmSync(home, { recursive: true, force: true });
});

function plugin(name: string, source: string, capabilities: Record<string, unknown> = {}) {
  const dir = join(home, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name, version: "1.0.0", api: "^1.0", capabilities }),
  );
  writeFileSync(join(dir, "init.lua"), source);
  grantConsent(home, name, hashPluginDirectory(dir));
}

async function start(overrides: Partial<PluginSupervisorOptions> = {}) {
  supervisor = new PluginSupervisor({
    stateHome: home,
    productVersion: "9.9.9",
    hostCommand: [process.execPath, "--import", "tsx", hostEntry],
    hostEnv: { ...process.env, HOME: home, TMUX_IDE_HOME: home },
    onLog: (entry) => logs.push(entry),
    secrets: () => ["owner-token-0123456789"],
    calls: createHostCallHandler({
      stateHome: home,
      endpoint: () => null,
      tmux: async () => "",
      baseEnv: () => ({ PATH: "/usr/bin:/bin", HOME: home }),
      secrets: () => new Set(["owner-token-0123456789"]),
      notify,
    }),
    ...overrides,
  });
  await supervisor.start();
  return supervisor;
}

const ACTIONS = `
ide.action.register{ id = "echo", title = "Echo", params = { { name = "text" } },
  run = function(ctx, args) return ide.exec{ cmd = "echo", args = { args.text } }.stdout end }
ide.action.register{ id = "ls", title = "List", run = function() return ide.exec{ cmd = "ls" } end }
ide.action.register{ id = "count", title = "Count", run = function()
  local n = (ide.store.get("n") or 0) + 1
  ide.store.set("n", n)
  ide.notify("count is " .. n)
  return n end }
ide.action.register{ id = "panes", title = "Panes", run = function() return ide.panes() end }
`;

describe("host functions through the real host", () => {
  live(
    "runs a consented program and returns its redacted output",
    async () => {
      plugin("tasks", ACTIONS, { exec: ["echo"] });
      const s = await start();
      expect(
        await s.invokeAction(
          "plugin.tasks.echo",
          { text: "hi owner-token-0123456789" },
          { source: "cli" },
        ),
      ).toEqual({ ok: true, value: "hi [redacted]\n" });
    },
    30_000,
  );

  it("refuses a program the manifest did not list", async () => {
    plugin("tasks", ACTIONS, { exec: ["echo"] });
    const s = await start();
    expect(await s.invokeAction("plugin.tasks.ls", {}, { source: "cli" })).toEqual({
      ok: false,
      error: expect.stringContaining("E_DENIED: this plugin may not run 'ls'"),
    });
  }, 30_000);

  it("keeps the store across calls and notifies", async () => {
    plugin("tasks", ACTIONS);
    const s = await start();
    expect(await s.invokeAction("plugin.tasks.count", {}, { source: "cli" })).toEqual({
      ok: true,
      value: 1,
    });
    expect(await s.invokeAction("plugin.tasks.count", {}, { source: "cli" })).toEqual({
      ok: true,
      value: 2,
    });
    expect(notify).toHaveBeenLastCalledWith("tasks", "count is 2", "info");
  }, 30_000);

  it("redacts daemon secrets in every host call result Lua sees", async () => {
    plugin(
      "leaky",
      `ide.action.register{ id = "peek", title = "Peek", run = function()
         ide.store.set("token", "owner-token-0123456789")
         local seen = ide.store.get("token")
         -- Report something only Lua saw, so later redaction cannot hide a leak.
         return { text = seen, length = #seen } end }`,
    );
    const s = await start();
    expect(await s.invokeAction("plugin.leaky.peek", {}, { source: "cli" })).toEqual({
      ok: true,
      value: { text: "[redacted]", length: "[redacted]".length },
    });
  }, 30_000);

  it("reports pane calls as unavailable before the daemon listens", async () => {
    plugin("tasks", ACTIONS);
    const s = await start();
    expect(await s.invokeAction("plugin.tasks.panes", {}, { source: "cli" })).toEqual({
      ok: false,
      error: expect.stringContaining("E_UNAVAILABLE: the daemon is not ready yet"),
    });
  }, 30_000);

  live(
    "gives init.lua every capability and lua run a shell",
    async () => {
      writeFileSync(
        join(home, "init.lua"),
        `INIT_LS = ide.exec{ cmd = "ls", args = { "/" } }.code`,
      );
      const s = await start();
      expect(s.status().plugins).toEqual([
        expect.objectContaining({ name: "init", state: "loaded" }),
      ]);
      expect(await s.run(`return ide.exec{ cmd = "echo $((1+2))", shell = true }.stdout`)).toEqual({
        ok: true,
        values: ["3\n"],
        logs: [],
      });
    },
    30_000,
  );

  it("refuses host calls from a plugin once it is disabled", async () => {
    plugin("tasks", "return true");
    // A stand-in host: loads, trips three times (disabled), then tries a call
    // and reports the answer it got back as a log line.
    const fake = join(home, "fake-host.mjs");
    writeFileSync(
      fake,
      `import { writeSync } from "node:fs";
       import { createInterface } from "node:readline";
       const emit = (e) => writeSync(3, JSON.stringify(e) + "\\n");
       emit({ type: "hello", protocolVersion: 1, pid: process.pid });
       setInterval(() => emit({ type: "heartbeat", seq: 1 }), 100);
       createInterface({ input: process.stdin }).on("line", (line) => {
         const c = JSON.parse(line);
         if (c.type === "load") {
           emit({ type: "call", id: "before", plugin: "tasks", method: "_store_keys", args: "[]" });
         }
         if (c.type === "call-result" && c.id === "before") {
           emit({ type: "log", plugin: "tasks", level: "info", message: "before " + c.ok });
           emit({ type: "loaded", plugin: "tasks", ok: true });
           for (let i = 0; i < 3; i++) emit({ type: "trip", plugin: "tasks", kind: "timeout" });
           emit({ type: "call", id: "after", plugin: "tasks", method: "_store_keys", args: "[]" });
         }
         if (c.type === "call-result" && c.id === "after")
           emit({ type: "log", plugin: "host", level: "info", message: "after " + c.ok + " " + c.error });
       }).on("close", () => process.exit(0));`,
    );
    supervisor = new PluginSupervisor({
      stateHome: home,
      productVersion: "9.9.9",
      hostCommand: [process.execPath, fake],
      onLog: (entry) => logs.push(entry),
      calls: createHostCallHandler({
        stateHome: home,
        endpoint: () => null,
        tmux: async () => "",
        baseEnv: () => ({}),
        secrets: () => new Set(),
        notify,
      }),
    });
    await supervisor.start();
    const deadline = Date.now() + 10_000;
    while (!logs.some((entry) => entry.message.startsWith("after")) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logs.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "before true",
        "after false E_UNAVAILABLE: store_keys is not available",
      ]),
    );
  }, 30_000);
});

describe("programs a plugin started", () => {
  // The action starts a program that records its pid and sleeps; the test
  // then checks that program is gone after the plugin fails or goes away.
  const SLEEPER = `
ide.action.register{ id = "sleep", title = "Sleep", run = function()
  return ide.exec{ cmd = 'echo $$ > "$1"; exec sleep 30', args = { DATA .. "/pid" }, shell = true }
end }`;

  function sleeper() {
    const data = join(home, "plugin-data", "tasks");
    plugin("tasks", `DATA = ${JSON.stringify(data)}` + SLEEPER, { shell: true });
    return join(data, "pid");
  }

  async function runningPid(pidFile: string): Promise<number> {
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
      if (Date.now() > deadline) throw new Error("the program did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(pid)).toBe(true);
    return pid;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function gone(pid: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (alive(pid)) {
      if (Date.now() > deadline) throw new Error(`program ${pid} is still running`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  live(
    "are killed when the callback fails on its wall clock",
    async () => {
      const pidFile = sleeper();
      const s = await start({ limits: { ...DEFAULT_PLUGIN_LIMITS, wallClockMs: 1500 } });
      const result = s.invokeAction("plugin.tasks.sleep", {}, { source: "cli" });
      const pid = await runningPid(pidFile);
      expect(await result).toEqual({
        ok: false,
        error: expect.stringMatching(/wall-clock limit/u),
      });
      await gone(pid);
    },
    30_000,
  );

  live(
    "are killed when the plugin loses consent and is reloaded",
    async () => {
      const pidFile = sleeper();
      const s = await start();
      const result = s.invokeAction("plugin.tasks.sleep", {}, { source: "cli" });
      const pid = await runningPid(pidFile);
      revokeConsent(home, "tasks");
      await s.reload();
      await gone(pid);
      await result;
    },
    30_000,
  );

  live(
    "are killed when the plugin host exits",
    async () => {
      const pidFile = sleeper();
      const s = await start({ restartDelayMs: () => 60_000 });
      const result = s.invokeAction("plugin.tasks.sleep", {}, { source: "cli" });
      const pid = await runningPid(pidFile);
      process.kill(s.status().host.pid!, "SIGKILL");
      await gone(pid);
      expect((await result).ok).toBe(false);
    },
    30_000,
  );
});
