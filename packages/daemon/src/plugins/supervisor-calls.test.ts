/**
 * Host functions through the real plugin host and supervisor: Lua calls
 * ide.exec / ide.store / ide.notify, the host forwards them, the supervisor
 * checks who is calling and the handler does the work.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantConsent, hashPluginDirectory } from "./consent.ts";
import { sandboxedArgv } from "./exec-sandbox.ts";
import { createHostCallHandler } from "./host-calls.ts";
import type { PluginLogEntry } from "./plugin-log.ts";
import { PluginSupervisor } from "./supervisor.ts";

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

async function start() {
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
