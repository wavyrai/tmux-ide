import { afterEach, describe, expect, it } from "vitest";
import type { PluginLimits } from "../protocol.ts";
import { PluginLuaState } from "./lua-state.ts";

const limits: PluginLimits = {
  callbackBudgetMs: 150,
  memoryBytes: 8 * 1024 * 1024,
  wallClockMs: 1000,
  logLinesPerSecond: 100,
};
const callback = { budgetMs: 150, wallClockMs: 1000 };

let states: PluginLuaState[] = [];
afterEach(() => {
  for (const state of states) state.close();
  states = [];
});

async function make() {
  const published: unknown[] = [];
  const logs: string[] = [];
  const state = await PluginLuaState.create({
    spec: { name: "tasks", includeRoots: [], moduleRoots: [], settings: {} },
    apiVersion: "1.0",
    productVersion: "9.9.9",
    limits,
    hooks: {
      busy() {},
      idle() {},
      log: (_level, message) => logs.push(message),
      trip() {},
      actions: (json) => published.push(JSON.parse(json)),
    },
  });
  states.push(state);
  const load = (code: string) => state.runSource(code, "=test", callback);
  const invoke = async (
    id: string,
    args: Record<string, unknown> = {},
    ctx = { source: "palette" },
  ) => JSON.parse(await state.invokeAction(id, args, ctx, callback)) as unknown[];
  const options = async (id: string, param: string, ctx = { source: "palette", pane: "%1" }) =>
    JSON.parse(await state.paramOptions(id, param, ctx, callback)) as unknown;
  return { state, load, invoke, options, published, logs };
}

const TASKS = `
ide.action.register{
  id = "tasks.new", title = "New task", category = "Tasks", description = "Start a task",
  params = {
    { name = "name", label = "Branch name", pattern = "^[%w][%w._/-]*$" },
    { name = "prompt", type = "text" },
    { name = "count", type = "number", optional = true, default = 1 },
    { name = "agent", type = "choice", choices = { "claude", { value = "codex", label = "Codex CLI" } } },
    { name = "task", type = "choice", optional = true,
      choices = function(ctx) return { ctx.pane .. ":a", ctx.pane .. ":b" } end,
      default = function(ctx) return ctx.pane .. ":a" end },
  },
  run = function(ctx, args) return { source = ctx.source, args = args } end,
}
ide.action.register{ id = "tasks.remove", title = "Remove task", dangerous = true, run = function() end }
`;

describe("ide.action.register", () => {
  it("publishes plain descriptors, without callbacks or patterns", async () => {
    const { load, published } = await make();
    await load(TASKS);
    expect(published.at(-1)).toEqual([
      {
        id: "tasks.new",
        title: "New task",
        category: "Tasks",
        description: "Start a task",
        dangerous: false,
        params: [
          {
            name: "name",
            type: "string",
            label: "Branch name",
            required: true,
            dynamicDefault: false,
            dynamicChoices: false,
          },
          {
            name: "prompt",
            type: "text",
            label: "prompt",
            required: true,
            dynamicDefault: false,
            dynamicChoices: false,
          },
          {
            name: "count",
            type: "number",
            label: "count",
            required: false,
            default: 1,
            dynamicDefault: false,
            dynamicChoices: false,
          },
          {
            name: "agent",
            type: "choice",
            label: "agent",
            required: true,
            dynamicDefault: false,
            dynamicChoices: false,
            choices: [
              { value: "claude", label: "claude" },
              { value: "codex", label: "Codex CLI" },
            ],
          },
          {
            name: "task",
            type: "choice",
            label: "task",
            required: false,
            dynamicDefault: true,
            dynamicChoices: true,
          },
        ],
      },
      {
        id: "tasks.remove",
        title: "Remove task",
        category: "Plugins",
        dangerous: true,
        params: [],
      },
    ]);
    expect(await load(`return ide.has("actions")`)).toBe("[true]");
  });

  it("refuses malformed actions with a clear error", async () => {
    const { load } = await make();
    const bad = [
      [`ide.action.register{ id = "Bad", title = "x", run = print }`, /action id must be/u],
      [`ide.action.register{ id = "a..b", title = "x", run = print }`, /action id must be/u],
      [`ide.action.register{ id = "a.", title = "x", run = print }`, /action id must be/u],
      [`ide.action.register{ id = "ok", title = "x" }`, /needs a run function/u],
      [`ide.action.register{ id = "ok", run = print }`, /title must be a string/u],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a" }, { name = "a" } } }`,
        /declared twice/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a", type = "choice" } } }`,
        /needs choices/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a", type = "date" } } }`,
        /unknown type/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "A" } } }`,
        /lowercase letters/u,
      ],
      [
        `ide.action.register{ id = string.rep("a", 81), title = "x", run = print }`,
        /action id must be/u,
      ],
      [`ide.action.register{ id = "ok", title = "a\\27[2Jb", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\nb", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\194\\155b", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\226\\128\\174b", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\226\\129\\166b", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\216\\156b", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\226\\128\\168b", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\226\\128\\139b", run = print }`, /plain text/u],
      [`ide.action.register{ id = "ok", title = "a\\239\\187\\191b", run = print }`, /plain text/u],
      [
        `ide.action.register{ id = "ok", title = "x", category = "a\\127b", run = print }`,
        /plain text/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a", label = "a\\rb" } } }`,
        /plain text/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a", default = "a\\27b" } } }`,
        /plain text/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a", type = "choice", choices = { "a\\27b" } } } }`,
        /entries must be/u,
      ],
      [
        `ide.action.register{ id = "ok", title = "x", run = print, params = { { name = "a", type = "choice", choices = { { value = "v", label = "a\\7b" } } } } }`,
        /entries must be/u,
      ],
    ] as const;
    for (const [code, error] of bad) await expect(load(code), code).rejects.toThrow(error);
    await expect(
      load(`for i = 1, 201 do ide.action.register{ id = "a" .. i, title = "x", run = print } end`),
    ).rejects.toThrow(/at most 200 actions/u);
  });

  it("keeps ordinary Unicode text and an 80-character id", async () => {
    const { load, published } = await make();
    await load(
      `ide.action.register{ id = string.rep("a", 80), title = "Café ✓ 日本 🚀", run = print }`,
    );
    expect(published.at(-1)).toMatchObject([{ id: "a".repeat(80), title: "Café ✓ 日本 🚀" }]);
  });

  it("re-registering replaces, and unregister removes and republishes", async () => {
    const { load, published } = await make();
    await load(`ide.action.register{ id = "a", title = "One", run = print }`);
    await load(`ide.action.register{ id = "a", title = "Two", run = print }`);
    expect((published.at(-1) as { title: string }[]).map((a) => a.title)).toEqual(["Two"]);
    expect(await load(`return ide.action.unregister("a"), ide.action.unregister("a")`)).toBe(
      "[true,false]",
    );
    expect(published.at(-1)).toEqual([]);
  });
});

describe("invoking actions", () => {
  it("checks arguments, applies defaults and passes the context", async () => {
    const { load, invoke } = await make();
    await load(TASKS);
    expect(
      await invoke(
        "tasks.new",
        { name: "fix-login", prompt: "Fix it", agent: "codex" },
        { source: "cli" },
      ),
    ).toEqual([
      { source: "cli", args: { name: "fix-login", prompt: "Fix it", agent: "codex", count: 1 } },
    ]);
  });

  it("refuses bad arguments before run is called", async () => {
    const { load, invoke } = await make();
    await load(TASKS + `CALLS = 0`);
    const base = { name: "ok", prompt: "p", agent: "claude" };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ prompt: "p", agent: "claude" }, /'Branch name' is required/u],
      [{ ...base, name: "-bad" }, /does not match/u],
      [{ ...base, name: 5 }, /must be a string/u],
      [{ ...base, count: "two" }, /must be a number/u],
      [{ ...base, agent: "gemini" }, /must be one of its choices/u],
      [{ ...base, extra: 1 }, /unknown argument 'extra'/u],
    ];
    for (const [args, error] of cases)
      await expect(invoke("tasks.new", args)).rejects.toThrow(error);
    await expect(invoke("tasks.missing")).rejects.toThrow(/E_NOT_FOUND/u);
  });

  it("refuses dynamic choices and defaults that are not plain text", async () => {
    const { load, options } = await make();
    await load(`ide.action.register{ id = "pick", title = "Pick", run = print, params = {
      { name = "c", type = "choice", choices = function() return { "ok", "a\\27[2Jb" } end },
      { name = "d", default = function() return "a\\nb" end },
    } }`);
    await expect(options("pick", "c")).rejects.toThrow(/entries must be/u);
    await expect(options("pick", "d")).rejects.toThrow(/plain text/u);
  });

  it("runs under the callback budget", async () => {
    const { load, invoke } = await make();
    await load(`ide.action.register{ id = "spin", title = "Spin", run = function()
      local t = os.clock() while os.clock() - t < 3 do end end }`);
    await expect(invoke("spin")).rejects.toThrow(/E_TIMEOUT/u);
  });

  it("asks the plugin for dynamic choices and defaults, and returns static ones", async () => {
    const { load, options } = await make();
    await load(TASKS);
    expect(await options("tasks.new", "task")).toEqual({
      choices: [
        { value: "%1:a", label: "%1:a" },
        { value: "%1:b", label: "%1:b" },
      ],
      default: "%1:a",
    });
    expect(await options("tasks.new", "count")).toEqual({ default: 1 });
    await expect(options("tasks.new", "nope")).rejects.toThrow(/has no param 'nope'/u);
  });
});
