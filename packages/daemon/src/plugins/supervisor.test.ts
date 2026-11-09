import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantConsent, hashPluginDirectory } from "./consent.ts";
import type { PluginLogEntry } from "./plugin-log.ts";
import {
  HOST_ENV_ALLOWLIST,
  PluginSupervisor,
  type PluginSupervisorOptions,
} from "./supervisor.ts";

const hostEntry = join(dirname(fileURLToPath(import.meta.url)), "host", "entry.ts");
const hostCommand = [process.execPath, "--import", "tsx", hostEntry];

let home: string;
let supervisors: PluginSupervisor[];
let logs: PluginLogEntry[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-plugins-"));
  supervisors = [];
  logs = [];
});
afterEach(async () => {
  await Promise.all(supervisors.map((supervisor) => supervisor.stop()));
  rmSync(home, { recursive: true, force: true });
});

function supervisor(overrides: Partial<PluginSupervisorOptions> = {}) {
  const created = new PluginSupervisor({
    stateHome: home,
    productVersion: "9.9.9",
    hostCommand,
    hostEnv: { ...process.env, HOME: home, TMUX_IDE_HOME: home },
    onLog: (entry) => logs.push(entry),
    restartDelayMs: () => 50,
    ...overrides,
  });
  supervisors.push(created);
  return created;
}

function plugin(
  name: string,
  source: string,
  manifest: Record<string, unknown> = {},
  consent = true,
) {
  const dir = join(home, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name, version: "0.1.0", api: "^1.0", ...manifest }),
  );
  writeFileSync(join(dir, "init.lua"), source);
  if (consent) grantConsent(home, name, hashPluginDirectory(dir));
}

async function until<T>(read: () => T, accept: (value: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const state = (s: PluginSupervisor, name: string) =>
  s.status().plugins.find((entry) => entry.name === name)?.state;

describe("PluginSupervisor", () => {
  it("does not start a host when there is nothing to load", async () => {
    const s = supervisor();
    const status = await s.start();
    expect(status).toEqual({ host: { running: false, pid: null, restarts: 0 }, plugins: [] });
  });

  it("loads plugins in name order, then init.lua, and logs through the daemon", async () => {
    plugin("beta", `ide.log.info("beta loaded")`);
    plugin("alpha", `ide.log.info("alpha loaded", { api = ide.api })`, {
      settings: { base: { type: "string", default: "main" } },
    });
    writeFileSync(join(home, "init.lua"), `print("init sees", ide.plugin.name)`);
    const s = supervisor();
    const status = await s.start();
    expect(status.host.running).toBe(true);
    expect(status.plugins.map((p) => [p.name, p.kind, p.state])).toEqual([
      ["alpha", "plugin", "loaded"],
      ["beta", "plugin", "loaded"],
      ["init", "init", "loaded"],
    ]);
    expect(logs.map((entry) => [entry.plugin, entry.message, entry.fields])).toEqual([
      ["alpha", "alpha loaded", { api: "1.0" }],
      ["beta", "beta loaded", undefined],
      ["init", "init sees\tinit", undefined],
    ]);
  });

  it("reports a plugin whose code fails, and invalid plugin directories, without stopping others", async () => {
    plugin("broken", `error("boom")`);
    plugin("fine", `return true`);
    plugin("wrongapi", `return true`, { api: "^2.0" });
    mkdirSync(join(home, "plugins", "nomanifest"), { recursive: true });
    const s = supervisor();
    const status = await s.start();
    const byName = Object.fromEntries(status.plugins.map((p) => [p.name, p]));
    expect(byName.fine?.state).toBe("loaded");
    expect(byName.broken?.state).toBe("failed");
    expect(byName.broken?.error).toMatch(/boom/u);
    expect(byName.wrongapi).toMatchObject({
      state: "invalid",
      error: expect.stringMatching(/\^2\.0/u),
    });
    expect(byName.nomanifest).toMatchObject({
      state: "invalid",
      error: "manifest.json is missing",
    });
    expect(
      logs.some((entry) => entry.plugin === "broken" && /load failed: .*boom/u.test(entry.message)),
    ).toBe(true);
  });

  it("does not load a plugin until it is consented to, and init.lua needs no consent", async () => {
    plugin("unasked", `ide.log.info("should not run")`, {}, false);
    const s = supervisor();
    let status = await s.start();
    expect(status.host.running).toBe(false);
    expect(status.plugins).toEqual([
      {
        name: "unasked",
        kind: "plugin",
        state: "needs-consent",
        error: "not consented to yet; run `tmux-ide plugin consent unasked`",
        trips: 0,
      },
    ]);
    writeFileSync(join(home, "init.lua"), `ide.log.info("init runs")`);
    status = await s.reload();
    expect(status.plugins.map((p) => [p.name, p.state])).toEqual([
      ["unasked", "needs-consent"],
      ["init", "loaded"],
    ]);
    expect(logs.map((entry) => entry.message)).toEqual(["init runs"]);
  });

  it("unloads a consented plugin that changed on disk, and asks again", async () => {
    plugin("tool", `ide.log.info("v1")`);
    const s = supervisor();
    await s.start();
    expect(state(s, "tool")).toBe("loaded");
    writeFileSync(join(home, "plugins", "tool", "init.lua"), `ide.log.info("v2")`);
    const status = await s.reload();
    expect(status.plugins).toEqual([
      expect.objectContaining({
        name: "tool",
        state: "needs-consent",
        error: expect.stringMatching(/changed since/u),
      }),
    ]);
    expect(logs.map((entry) => entry.message)).toEqual(["v1"]);
  });

  it("starts the host with a minimal environment, not the daemon's", async () => {
    plugin("probe", `return true`);
    const fake = join(home, "env-host.mjs");
    writeFileSync(
      fake,
      `import { writeSync } from "node:fs";
       const emit = (e) => writeSync(3, JSON.stringify(e) + "\\n");
       emit({ type: "hello", protocolVersion: 1, pid: process.pid });
       emit({ type: "log", plugin: "probe", level: "info", message: JSON.stringify(process.env) });
       process.stdin.on("data", () => {}).on("end", () => process.exit(0));`,
    );
    const secret = "daemon-owner-token-0123456789";
    process.env.TMUX_IDE_TEST_OWNER_TOKEN = secret;
    process.env.TMUX_IDE_HOME_FOR_TEST = home;
    try {
      const s = new PluginSupervisor({
        stateHome: home,
        productVersion: "9.9.9",
        hostCommand: [process.execPath, fake],
        onLog: (entry) => logs.push(entry),
      });
      supervisors.push(s);
      void s.start();
      const line = await until(() => logs.find((entry) => entry.plugin === "probe"), Boolean);
      const env = JSON.parse(line!.message) as Record<string, string>;
      // macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
      const keys = Object.keys(env).filter((key) => key !== "__CF_USER_TEXT_ENCODING");
      expect(keys.filter((key) => !HOST_ENV_ALLOWLIST.includes(key))).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH);
      expect(line!.message).not.toContain(secret);
      expect(env.TMUX_IDE_TEST_OWNER_TOKEN).toBeUndefined();
      expect(env.TMUX_IDE_HOME_FOR_TEST).toBeUndefined();
      expect(line!.message).not.toContain("TMUX_IDE_HOME_FOR_TEST");
    } finally {
      delete process.env.TMUX_IDE_TEST_OWNER_TOKEN;
      delete process.env.TMUX_IDE_HOME_FOR_TEST;
    }
  });

  it("redacts daemon credentials from plugin logs and lua run output", async () => {
    const token = "owner-capability-abcdef123456";
    plugin("leaky", `ide.log.warn("token is ${token}", { copy = "${token}" })`);
    const s = supervisor({ secrets: () => [token] });
    await s.start();
    const result = await s.run(`print("${token}") error("failed with ${token}")`);
    const ran = await s.run(`return "${token}", { nested = "Bearer ${token}" }`);
    const everything = JSON.stringify({ logs, result, ran });
    expect(everything).not.toContain(token);
    expect(logs[0]).toMatchObject({
      message: "token is [redacted]",
      fields: { copy: "[redacted]" },
    });
    expect(result.logs).toEqual([{ level: "info", message: "[redacted]" }]);
    expect(result.error).toMatch(/failed with \[redacted\]/u);
    expect(ran.values).toEqual(["[redacted]", { nested: "Bearer [redacted]" }]);
  });

  it("runs a script once and returns its values and logs", async () => {
    const s = supervisor();
    const result = await s.run(`print("hi") return 1 + 1, ide.plugin.name, { a = 1 }`);
    expect(result).toEqual({
      ok: true,
      values: [2, "run", { a: 1 }],
      logs: [{ level: "info", message: "hi" }],
    });
    const failed = await s.run(`error("nope")`, { chunkName: "=cli" });
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/cli:1: nope/u);
  });

  it("reloads one plugin from disk and clears its failure", async () => {
    plugin("tool", `error("first version")`);
    const s = supervisor();
    await s.start();
    expect(state(s, "tool")).toBe("failed");
    writeFileSync(join(home, "plugins", "tool", "init.lua"), `ide.log.info("second version")`);
    // Editing a plugin withdraws consent; the owner allows the new version.
    grantConsent(home, "tool", hashPluginDirectory(join(home, "plugins", "tool")));
    const status = await s.reload("tool");
    expect(status.plugins.find((p) => p.name === "tool")?.state).toBe("loaded");
    expect(logs.at(-1)?.message).toBe("second version");
  });

  it("forgets a plugin removed from disk on reload", async () => {
    plugin("gone", `return true`);
    const s = supervisor();
    await s.start();
    rmSync(join(home, "plugins", "gone"), { recursive: true });
    const status = await s.reload();
    expect(status.plugins).toEqual([]);
  });

  it("disables a plugin after three trips within the window, and reload clears it", async () => {
    plugin("spinner", `return true`);
    // A stand-in host that answers each load with three timeout trips.
    const fake = join(home, "fake-host.mjs");
    writeFileSync(
      fake,
      `import { writeSync } from "node:fs";
       import { createInterface } from "node:readline";
       const emit = (e) => writeSync(3, JSON.stringify(e) + "\\n");
       emit({ type: "hello", protocolVersion: 1, pid: process.pid });
       setInterval(() => emit({ type: "heartbeat", seq: 1 }), 200);
       createInterface({ input: process.stdin }).on("line", (line) => {
         const c = JSON.parse(line);
         if (c.type === "load") {
           for (let i = 0; i < 3; i++) emit({ type: "trip", plugin: c.plugin.name, kind: "timeout" });
           emit({ type: "loaded", plugin: c.plugin.name, ok: true });
         }
         if (c.type === "unload") emit({ type: "log", plugin: c.name, level: "info", message: "unloaded" });
       }).on("close", () => process.exit(0));`,
    );
    const s = supervisor({ hostCommand: [process.execPath, fake] });
    const status = await s.start();
    expect(status.plugins[0]).toMatchObject({
      name: "spinner",
      state: "disabled",
      trips: 3,
      error: expect.stringMatching(/ran past its time budget 3 times within 60 s/u),
    });
    await until(() => logs.some((entry) => entry.message === "unloaded"), Boolean);
    expect(logs.filter((entry) => entry.plugin === "spinner").map((entry) => entry.level)).toEqual([
      "warn",
      "warn",
      "warn",
      "error",
      "info",
    ]);
  });

  it("keeps a plugin loaded below the trip limit", async () => {
    plugin("spinner", `pcall(function() while true do end end) ide.log.info("survived")`);
    const s = supervisor({
      limits: {
        callbackBudgetMs: 100,
        memoryBytes: 8 << 20,
        wallClockMs: 30_000,
        logLinesPerSecond: 100,
      },
    });
    const status = await s.start();
    expect(status.plugins[0]).toMatchObject({ state: "loaded", trips: 1 });
    expect(logs.map((entry) => entry.message)).toEqual([
      "survived",
      "ran past its time budget (1/3)",
    ]);
  });

  it("kills the host, blames the busy plugin and restarts the others when a slice never returns", async () => {
    plugin("ok", `ide.log.info("ok loaded")`);
    plugin(
      "stuck",
      // Catches every E_TIMEOUT and keeps going: only the watchdog stops it.
      `while true do pcall(function() while true do end end) end`,
    );
    const s = supervisor({
      heartbeatTimeoutMs: 1500,
      watchdogIntervalMs: 100,
      limits: {
        callbackBudgetMs: 50,
        memoryBytes: 8 << 20,
        wallClockMs: 30_000,
        logLinesPerSecond: 100,
      },
    });
    const firstPid = (await s.start(), s.status().host.pid);
    const stuck = await until(
      () => state(s, "stuck"),
      (value) => value === "disabled",
    );
    expect(stuck).toBe("disabled");
    expect(s.status().plugins.find((p) => p.name === "stuck")?.error).toMatch(/watchdog/u);
    await until(
      () => s.status().host,
      (host) => host.running && host.pid !== firstPid,
    );
    await until(
      () => state(s, "ok"),
      (value) => value === "loaded",
    );
    expect(
      logs.some((entry) => entry.plugin === "host" && /watchdog: stuck kept/u.test(entry.message)),
    ).toBe(true);
  }, 30_000);

  it("survives the review's thenable scenarios on the real host: never-settling and spinning then", async () => {
    plugin("never", `coroutine.yield({ ["then"] = function() end }) ide.log.info("never: after")`);
    plugin(
      "spinner",
      `coroutine.yield({ ["then"] = function() while true do end end }) ide.log.info("spinner: after")`,
    );
    writeFileSync(join(home, "init.lua"), `ide.log.info("init ran")`);
    const s = supervisor({ heartbeatTimeoutMs: 1500, watchdogIntervalMs: 100 });
    const started = Date.now();
    const status = await s.start();
    expect(Date.now() - started).toBeLessThan(5000);
    const byName = Object.fromEntries(status.plugins.map((p) => [p.name, p]));
    expect(byName.never).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/E_INVALID/u),
    });
    expect(byName.spinner).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/E_INVALID/u),
    });
    expect(byName.init?.state).toBe("loaded");
    // Nothing spun outside the budget: the host stays up, with no restarts.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(s.status().host).toMatchObject({ running: true, restarts: 0 });
    expect(logs.map((entry) => entry.message)).toContain("init ran");
    expect(logs.some((entry) => /after/u.test(entry.message))).toBe(false);
  }, 20_000);

  it("does not blame a loading plugin when a stuck lua run is what the watchdog killed", async () => {
    const s = supervisor({
      heartbeatTimeoutMs: 1500,
      watchdogIntervalMs: 100,
      limits: {
        callbackBudgetMs: 50,
        memoryBytes: 8 << 20,
        wallClockMs: 30_000,
        logLinesPerSecond: 100,
      },
    });
    // The run keeps catching E_TIMEOUT, so only the watchdog stops it.
    const stuck = s.run(`while true do pcall(function() while true do end end) end`, {
      budgetMs: 50,
    });
    await until(() => s.status().host.running, Boolean);
    plugin("innocent", `ide.log.info("innocent loaded")`);
    const firstPid = s.status().host.pid;
    const reloaded = s.reload("innocent");
    const result = await stuck;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/run kept the plugin host busy/u);
    await reloaded;
    await until(
      () => state(s, "innocent"),
      (value) => value === "loaded",
    );
    expect(s.status().plugins).toEqual([
      expect.objectContaining({ name: "innocent", state: "loaded", trips: 0 }),
    ]);
    expect(s.status().host.pid).not.toBe(firstPid);
    expect(logs.some((entry) => entry.plugin === "innocent" && entry.level === "warn")).toBe(false);
  }, 30_000);

  it("redacts secrets in load errors shown by status", async () => {
    const token = "ownertoken-abcdef1234567890";
    plugin("leaky", `error("${token}")`);
    mkdirSync(join(home, "plugins", "badjson"), { recursive: true });
    writeFileSync(join(home, "plugins", "badjson", "manifest.json"), `{"name": "${token}" oops`);
    const s = supervisor({ secrets: () => [token] });
    const status = await s.start();
    expect(JSON.stringify(status)).not.toContain(token);
    expect(status.plugins.find((p) => p.name === "leaky")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("[redacted]"),
    });
  });

  it("charges a watchdog kill with no busy plugin to the plugin being loaded, then disables it", async () => {
    plugin("hang", `return true`);
    plugin("ok", `return true`);
    // A stand-in host whose event loop locks up while loading "hang" without
    // ever sending a busy marker, as a JS-side hang would.
    const fake = join(home, "hang-host.mjs");
    writeFileSync(
      fake,
      `import { writeSync } from "node:fs";
       import { createInterface } from "node:readline";
       const emit = (e) => writeSync(3, JSON.stringify(e) + "\\n");
       emit({ type: "hello", protocolVersion: 1, pid: process.pid });
       setInterval(() => emit({ type: "heartbeat", seq: 1 }), 50);
       createInterface({ input: process.stdin }).on("line", (line) => {
         const c = JSON.parse(line);
         if (c.type !== "load") return;
         if (c.plugin.name === "hang") for (;;) {}
         emit({ type: "loaded", plugin: c.plugin.name, ok: true });
       }).on("close", () => process.exit(0));`,
    );
    const s = supervisor({
      hostCommand: [process.execPath, fake],
      heartbeatTimeoutMs: 300,
      watchdogIntervalMs: 50,
    });
    void s.start();
    await until(
      () => state(s, "hang"),
      (value) => value === "disabled",
      20_000,
    );
    expect(s.status().plugins.find((p) => p.name === "hang")).toMatchObject({
      state: "disabled",
      trips: 3,
    });
    await until(
      () => state(s, "ok"),
      (value) => value === "loaded",
      20_000,
    );
    expect(s.status().host.restarts).toBeGreaterThanOrEqual(3);
  }, 40_000);

  it("resets the restart backoff once a host has stayed up", async () => {
    plugin("ok", `return true`);
    const attempts: number[] = [];
    const s = supervisor({
      healthyAfterMs: 600,
      restartDelayMs: (attempt) => {
        attempts.push(attempt);
        return 20;
      },
    });
    await s.start();
    const killAndWait = async () => {
      const pid = s.status().host.pid!;
      process.kill(pid, "SIGKILL");
      await until(
        () => s.status().host,
        (host) => host.running && host.pid !== pid,
      );
      await until(
        () => state(s, "ok"),
        (value) => value === "loaded",
      );
    };
    await killAndWait();
    await killAndWait();
    expect(attempts).toEqual([0, 1]);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await killAndWait();
    expect(attempts).toEqual([0, 1, 0]);
  }, 30_000);

  it("restarts a host that exits on its own and loads its plugins again", async () => {
    plugin("ok", `ide.log.info("loaded")`);
    const s = supervisor();
    await s.start();
    const pid = s.status().host.pid!;
    process.kill(pid, "SIGKILL");
    await until(
      () => s.status().host,
      (host) => host.running && host.pid !== pid && host.restarts === 1,
    );
    await until(
      () => logs.filter((entry) => entry.message === "loaded").length,
      (n) => n === 2,
    );
    // The plugin's log line arrives before the host reports the load finished.
    expect(
      await until(
        () => state(s, "ok"),
        (value) => value === "loaded",
      ),
    ).toBe("loaded");
  }, 30_000);

  it("fails pending runs when it stops, and runs nothing afterwards", async () => {
    const s = supervisor();
    const pending = s.run(`local t = os.clock() while os.clock() - t < 0.5 do end return 1`, {
      budgetMs: 2000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await s.stop();
    expect((await pending).ok).toBe(false);
    expect(await s.run("return 1")).toEqual({
      ok: false,
      error: "E_UNAVAILABLE: plugins are stopped",
      logs: [],
    });
    expect(s.status().host.running).toBe(false);
  });
});
