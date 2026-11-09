import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grantConsent, hashPluginDirectory } from "./consent.ts";
import type { PluginLogEntry } from "./plugin-log.ts";
import { PluginSupervisor, type PluginSupervisorOptions } from "./supervisor.ts";

const hostEntry = join(dirname(fileURLToPath(import.meta.url)), "host", "entry.ts");
const hostCommand = [process.execPath, "--import", "tsx", hostEntry];

let home: string;
let supervisors: PluginSupervisor[];
let logs: PluginLogEntry[];
let changes: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-plugin-actions-"));
  supervisors = [];
  logs = [];
  changes = 0;
});
afterEach(async () => {
  await Promise.all(supervisors.map((s) => s.stop()));
  rmSync(home, { recursive: true, force: true });
});

function supervisor(overrides: Partial<PluginSupervisorOptions> = {}) {
  const created = new PluginSupervisor({
    stateHome: home,
    productVersion: "9.9.9",
    hostCommand,
    hostEnv: { ...process.env, HOME: home, TMUX_IDE_HOME: home },
    onLog: (entry) => logs.push(entry),
    onCatalogChange: () => {
      changes += 1;
    },
    restartDelayMs: () => 50,
    ...overrides,
  });
  supervisors.push(created);
  return created;
}

function plugin(name: string, source: string) {
  const dir = join(home, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ name, version: "0.1.0", api: "^1.0" }),
  );
  writeFileSync(join(dir, "init.lua"), source);
  grantConsent(home, name, hashPluginDirectory(dir));
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

const TASKS = `
ide.action.register{
  id = "new", title = "New task", category = "Tasks",
  params = {
    { name = "name", label = "Branch name", pattern = "^[%w-]+$" },
    { name = "task", type = "choice", optional = true,
      choices = function(ctx) return { (ctx.session or "?") .. "/one" } end },
  },
  run = function(ctx, args) return { made = args.name, from = ctx.source, session = ctx.session } end,
}
ide.action.register{ id = "remove", title = "Remove task", dangerous = true,
  run = function() return "removed" end }
ide.action.register{ id = "leak", title = "Leak", run = function() error("token ownertoken-0123456789") end }
`;

const ids = (s: PluginSupervisor) => s.actionCatalog().entries.map((entry) => entry.descriptor.id);

describe("plugin actions through the supervisor", () => {
  it("lists registered actions as catalog entries owned by the plugin", async () => {
    plugin("tasks", TASKS);
    const s = supervisor();
    await s.start();
    const { entries, revision } = s.actionCatalog();
    expect(revision).toBeGreaterThan(0);
    expect(changes).toBeGreaterThan(0);
    expect(entries.map((e) => e.descriptor.id)).toEqual([
      "plugin.tasks.new",
      "plugin.tasks.remove",
      "plugin.tasks.leak",
    ]);
    expect(entries[0]).toMatchObject({
      plugin: "tasks",
      descriptor: {
        owner: "plugin",
        label: "New task",
        category: "Tasks",
        dangerous: false,
        confirmation: "none",
      },
    });
    expect(entries[1]?.descriptor).toMatchObject({ dangerous: true, confirmation: "dialog" });
  });

  it("invokes an action with arguments and context, and returns its value", async () => {
    plugin("tasks", TASKS);
    const s = supervisor();
    await s.start();
    expect(
      await s.invokeAction(
        "plugin.tasks.new",
        { name: "fix-login" },
        { source: "cli", session: "demo" },
      ),
    ).toEqual({ ok: true, value: { made: "fix-login", from: "cli", session: "demo" } });
    expect(
      await s.invokeAction("plugin.tasks.new", { name: "bad name" }, { source: "cli" }),
    ).toEqual({
      ok: false,
      error: expect.stringMatching(/does not match/u),
    });
    expect(await s.invokeAction("plugin.tasks.nope", {}, { source: "cli" })).toEqual({
      ok: false,
      error: "E_NOT_FOUND: no command 'plugin.tasks.nope'",
    });
  });

  it("runs a dangerous action only when confirmed", async () => {
    plugin("tasks", TASKS);
    const s = supervisor();
    await s.start();
    expect(await s.invokeAction("plugin.tasks.remove", {}, { source: "palette" })).toEqual({
      ok: false,
      error: "E_CONFIRM: 'Remove task' must be confirmed first",
    });
    expect(
      await s.invokeAction("plugin.tasks.remove", {}, { source: "palette" }, { confirmed: true }),
    ).toEqual({ ok: true, value: "removed" });
  });

  it("redacts secrets in action errors", async () => {
    plugin("tasks", TASKS);
    const s = supervisor({ secrets: () => ["ownertoken-0123456789"] });
    await s.start();
    const result = await s.invokeAction("plugin.tasks.leak", {}, { source: "cli" });
    expect(JSON.stringify(result)).not.toContain("ownertoken-0123456789");
    expect(JSON.stringify(logs)).not.toContain("ownertoken-0123456789");
  });

  it("asks the plugin for parameter choices", async () => {
    plugin("tasks", TASKS);
    const s = supervisor();
    await s.start();
    expect(
      await s.actionParamOptions("plugin.tasks.new", "task", {
        source: "palette",
        session: "demo",
      }),
    ).toEqual({ ok: true, choices: [{ value: "demo/one", label: "demo/one" }] });
    expect(await s.actionParamOptions("plugin.tasks.new", "nope", { source: "palette" })).toEqual({
      ok: false,
      error: "E_NOT_FOUND: 'plugin.tasks.new' has no parameter 'nope'",
    });
  });

  it("drops a plugin's actions when it changes on disk, and brings them back after a host restart", async () => {
    plugin("tasks", TASKS);
    plugin("other", `ide.action.register{ id = "hi", title = "Hi", run = function() end }`);
    const s = supervisor();
    await s.start();
    expect(ids(s)).toContain("plugin.other.hi");
    const pid = s.status().host.pid!;
    process.kill(pid, "SIGKILL");
    await until(
      () => s.status().host,
      (host) => host.running && host.pid !== pid,
    );
    await until(
      () => ids(s).length,
      (n) => n === 4,
    );
    writeFileSync(join(home, "plugins", "tasks", "init.lua"), TASKS + "\n-- edited");
    await s.reload();
    expect(ids(s)).toEqual(["plugin.other.hi"]);
  }, 30_000);

  it("drops the actions of a plugin that fails to load", async () => {
    plugin("half", `ide.action.register{ id = "a", title = "A", run = print } error("boom")`);
    const s = supervisor();
    await s.start();
    expect(ids(s)).toEqual([]);
  });

  it("ignores a plugin's actions once it is disabled", async () => {
    plugin(
      "spinner",
      `ide.action.register{ id = "spin", title = "Spin", run = function()
        while true do pcall(function() while true do end end) end end }`,
    );
    const s = supervisor({ heartbeatTimeoutMs: 1500, watchdogIntervalMs: 100 });
    await s.start();
    expect(ids(s)).toEqual(["plugin.spinner.spin"]);
    const result = await s.invokeAction("plugin.spinner.spin", {}, { source: "cli" });
    expect(result.ok).toBe(false);
    await until(
      () => s.status().plugins.find((p) => p.name === "spinner")?.state,
      (value) => value === "disabled",
    );
    // Nothing else to load, so the host stays down; the catalog is empty.
    expect(ids(s)).toEqual([]);
  }, 30_000);
});
