import { afterEach, describe, expect, it } from "vitest";
import type { PluginLimits, PluginTripKind } from "../protocol.ts";
import { PluginLuaState, type HostFunctions } from "./lua-state.ts";

const limits: PluginLimits = {
  callbackBudgetMs: 150,
  memoryBytes: 8 * 1024 * 1024,
  wallClockMs: 2000,
  logLinesPerSecond: 100,
};

let states: PluginLuaState[] = [];
afterEach(() => {
  for (const state of states) state.close();
  states = [];
});

const endpoint = {
  kind: "pane",
  paneLifetimeId: "11111111-1111-4111-8111-111111111111",
  workspaceName: "demo",
  semanticPaneId: "pane.aaaaaaaaaaaaaaaaaaaa",
};

async function make(
  overrides: Partial<Record<string, (args: unknown[]) => Promise<unknown>>> = {},
) {
  const calls: [string, unknown[]][] = [];
  const logs: string[] = [];
  const trips: PluginTripKind[] = [];
  const record =
    (name: string, value: unknown) =>
    async (args: unknown[]): Promise<unknown> => {
      calls.push([name, args]);
      return value;
    };
  const hostFunctions: HostFunctions = {
    _exec: record("_exec", {
      code: 0,
      stdout: "out",
      stderr: "",
      timed_out: false,
      truncated: false,
    }),
    _panes: record("_panes", [
      { endpoint, title: "editor", session: "demo" },
      {
        endpoint: { ...endpoint, semanticPaneId: "pane.bbbbbbbbbbbbbbbbbbbb" },
        title: "shell",
        session: "other",
      },
    ]),
    _pane_read: record("_pane_read", "screen text"),
    _pane_send: record("_pane_send", true),
    _action: record("_action", { ok: true }),
    _notify: record("_notify", true),
    _store_get: record("_store_get", { n: 1 }),
    _store_set: record("_store_set", true),
    _store_keys: record("_store_keys", ["a", "b"]),
    ...overrides,
  } as HostFunctions;
  const state = await PluginLuaState.create({
    spec: { name: "tasks", includeRoots: [], moduleRoots: [], settings: {} },
    apiVersion: "1.0",
    productVersion: "9.9.9",
    limits,
    hostFunctions,
    hooks: {
      busy() {},
      idle() {},
      log: (_level, message) => logs.push(message),
      trip: (kind) => trips.push(kind),
    },
  });
  states.push(state);
  const run = async (code: string) =>
    JSON.parse(
      await state.runSource(code, "=test", { budgetMs: 150, wallClockMs: 2000 }),
    ) as unknown[];
  return { state, run, calls, logs, trips };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ide.exec", () => {
  it("sends a normalized request and returns the result", async () => {
    const { run, calls } = await make();
    expect(
      await run(
        `return ide.exec{ cmd = "git", args = { "log", 5 }, env = { A = 1 }, context = "%3", junk = true }`,
      ),
    ).toEqual([{ code: 0, stdout: "out", stderr: "", timed_out: false, truncated: false }]);
    expect(calls).toEqual([
      ["_exec", [{ cmd: "git", args: ["log", "5"], env: { A: "1" }, context: "%3" }]],
    ]);
  });

  it("turns a daemon refusal into a Lua error", async () => {
    const { run } = await make({
      _exec: async () => Promise.reject(new Error("E_DENIED: not allowed")),
    });
    expect(await run(`return pcall(ide.exec, { cmd = "rm" })`)).toEqual([
      false,
      expect.stringContaining("E_DENIED"),
    ]);
    await expect(run(`ide.exec("git status")`)).rejects.toThrow(/expects a table/u);
  });
});

describe("panes, windows and sessions", () => {
  it("lists panes as objects and filters them", async () => {
    const { run } = await make();
    expect(
      await run(
        `local p = ide.panes() return #p, p[1].id, p[1].workspace, p[1].session, p[1].title`,
      ),
    ).toEqual([2, "pane.aaaaaaaaaaaaaaaaaaaa", "demo", "demo", "editor"]);
    expect(await run(`return #ide.panes{ session = "other" }`)).toEqual([1]);
  });

  it("maps pane methods to the daemon's workspace actions and automation calls", async () => {
    const { run, calls } = await make();
    await run(`
      local p = ide.panes()[1]
      p:read()
      p:send("ls")
      p:send("partial", { enter = false })
      p:split{ dir = "down", title = "logs" }
      p:zoom()
      p:zoom(false)
      p:focus()
      p:rename("editor 2")
      p:kill()
      p:rename_window("work")
      p:kill_window()
      ide.session("demo"):rename("renamed")
      ide.session("demo"):kill()`);
    const scope = { workspaceName: "demo", semanticPaneId: "pane.aaaaaaaaaaaaaaaaaaaa" };
    expect(calls.slice(1)).toEqual([
      ["_pane_read", [endpoint]],
      ["_pane_send", [endpoint, "ls", true]],
      ["_pane_send", [endpoint, "partial", false]],
      [
        "_action",
        ["workspace.window.split", { ...scope, direction: "down", displayTitle: "logs" }],
      ],
      ["_action", ["workspace.pane.zoom.toggle", { ...scope, desired: "toggle" }]],
      ["_action", ["workspace.pane.zoom.toggle", { ...scope, desired: "unzoomed" }]],
      ["_action", ["workspace.pane.select", scope]],
      ["_action", ["workspace.rename", { ...scope, scope: "pane", name: "editor 2" }]],
      ["_action", ["workspace.pane.kill", scope]],
      [
        "_action",
        [
          "workspace.rename",
          {
            workspaceName: "demo",
            scope: "window",
            target: { by: "pane", semanticPaneId: scope.semanticPaneId },
            name: "work",
          },
        ],
      ],
      [
        "_action",
        [
          "workspace.window.kill",
          { workspaceName: "demo", target: { by: "pane", semanticPaneId: scope.semanticPaneId } },
        ],
      ],
      [
        "_action",
        ["workspace.rename", { workspaceName: "demo", scope: "session", name: "renamed" }],
      ],
      ["_action", ["workspace.session.kill", { workspaceName: "demo" }]],
    ]);
  });

  it("refuses bad split directions and empty sends before calling the daemon", async () => {
    const { run, calls } = await make();
    await expect(run(`ide.panes()[1]:split{ dir = "left" }`)).rejects.toThrow(/'right' or 'down'/u);
    await expect(run(`ide.panes()[1]:send("")`)).rejects.toThrow(/expects text/u);
    expect(calls.map(([name]) => name)).toEqual(["_panes", "_panes"]);
  });
});

describe("json, store and notify", () => {
  it("encodes and decodes JSON", async () => {
    const { run } = await make();
    expect(await run(`return ide.json.encode({ a = { 1, 2 }, b = "x" })`)).toEqual([
      '{"a":[1,2],"b":"x"}',
    ]);
    expect(
      await run(`local v = ide.json.decode('{"a":[1,2],"n":null}') return v.a[2], v.n`),
    ).toEqual([2, null]);
    await expect(run(`ide.json.decode("{")`)).rejects.toThrow(/E_INVALID: ide.json.decode/u);
  });

  it("forwards store and notify calls", async () => {
    const { run, calls } = await make();
    expect(
      await run(
        `ide.store.set("k", { 1 }) ide.store.delete("k") return ide.store.get("k"), ide.store.keys()`,
      ),
    ).toEqual([{ n: 1 }, ["a", "b"]]);
    await run(`ide.notify("hello", { level = "warn" }) ide.notify(42)`);
    expect(calls).toEqual([
      ["_store_set", ["k", [1]]],
      ["_store_set", ["k"]],
      ["_store_get", ["k"]],
      ["_store_keys", []],
      ["_notify", ["hello", "warn"]],
      ["_notify", ["42"]],
    ]);
  });
});

describe("ide.timer", () => {
  it("runs after and every callbacks, and cancels them", async () => {
    const { run, state } = await make();
    await run(`
      FIRED = 0 TICKS = 0
      ide.timer.after(20, function() FIRED = FIRED + 1 end)
      TICK = ide.timer.every(250, function() TICKS = TICKS + 1 end)`);
    expect(state.activeTimers()).toBe(2);
    await wait(600);
    expect(await run(`TICK.cancel() return FIRED, TICKS >= 2, TICK.cancel()`)).toEqual([
      1,
      true,
      false,
    ]);
    expect(state.activeTimers()).toBe(0);
  });

  it("enforces the minimum interval and the timer limit", async () => {
    const { run } = await make();
    await expect(run(`ide.timer.every(10, print)`)).rejects.toThrow(/at least 250 ms/u);
    await expect(run(`for i = 1, 65 do ide.timer.after(60000, print) end`)).rejects.toThrow(
      /at most 64 timers/u,
    );
  });

  it("runs callbacks under the budget, logs their errors, and stops on close", async () => {
    const { run, state, logs, trips } = await make();
    await run(`
      ide.timer.after(10, function() error("tick failed") end)
      ide.timer.after(20, function() local t = os.clock() while os.clock() - t < 3 do end end)
      ide.timer.every(250, function() end)`);
    await wait(400);
    expect(logs).toEqual(
      expect.arrayContaining([expect.stringMatching(/timer failed: .*tick failed/u)]),
    );
    expect(trips).toEqual(["timeout"]);
    state.close();
    expect(state.activeTimers()).toBe(0);
  });
});
