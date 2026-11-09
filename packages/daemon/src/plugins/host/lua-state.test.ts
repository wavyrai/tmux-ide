import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginLimits, PluginLogLevel, PluginTripKind } from "../protocol.ts";
import { PluginLuaState, resolveSource, type HostFunctions } from "./lua-state.ts";

const limits: PluginLimits = {
  callbackBudgetMs: 150,
  memoryBytes: 8 * 1024 * 1024,
  wallClockMs: 400,
  logLinesPerSecond: 100,
};

let dir: string;
let outside: string;
let states: PluginLuaState[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-lua-state-"));
  outside = mkdtempSync(join(tmpdir(), "tmux-ide-lua-outside-"));
  states = [];
});
afterEach(() => {
  for (const state of states) state.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function make(settings: Record<string, unknown> = {}, hostFunctions: HostFunctions = {}) {
  const logs: { level: PluginLogLevel; message: string; fields?: unknown }[] = [];
  const trips: PluginTripKind[] = [];
  const marks: string[] = [];
  const state = await PluginLuaState.create({
    spec: { name: "demo", includeRoots: [dir], moduleRoots: [dir], settings: settings as never },
    apiVersion: "1.0",
    productVersion: "9.9.9",
    limits,
    hostFunctions,
    hooks: {
      busy: () => marks.push("busy"),
      idle: () => marks.push("idle"),
      log: (level, message, fields) => logs.push({ level, message, ...(fields ? { fields } : {}) }),
      trip: (kind) => trips.push(kind),
    },
  });
  states.push(state);
  const run = async (
    code: string,
    budget = limits.callbackBudgetMs,
    wallClockMs = limits.wallClockMs,
  ) =>
    JSON.parse(
      await state.runSource(code, "=test", { budgetMs: budget, wallClockMs }),
    ) as unknown[];
  return { state, run, logs, trips, marks };
}

describe("sandbox", () => {
  it("exposes the ide table and hides everything outside the allow-list", async () => {
    const { run } = await make({ base: "main" });
    expect(
      await run(`return ide.api, ide.version, ide.plugin.name, ide.settings.base,
        io, os.execute, os.getenv, os.remove, debug, package, dofile, loadfile,
        string.dump, getmetatable(""), _G.io, __ide_internal, __ide_resolve`),
    ).toEqual([
      "1.0",
      "9.9.9",
      "demo",
      "main",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      null,
      null,
      null,
    ]);
  });

  it("keeps os.time, os.clock and os.date", async () => {
    const { run } = await make();
    const [time, clock, date] = await run(
      `return type(os.time()), type(os.clock()), type(os.date("%Y"))`,
    );
    expect([time, clock, date]).toEqual(["number", "number", "string"]);
  });

  it("refuses bytecode and reader functions in load", async () => {
    const { run } = await make();
    expect(
      await run(`
        local a = load("return 1 + 1")()
        local _, binary = load(string.char(27) .. "Lua")
        local _, reader = load(function() return nil end)
        local _, modeb = load("return 1", "x", "b")
        return a, binary, reader, modeb`),
    ).toEqual([
      2,
      expect.stringContaining("binary chunk"),
      "load accepts source text only",
      "load accepts source text only",
    ]);
  });

  it("gives load the plugin environment by default", async () => {
    const { run } = await make();
    expect(await run(`return load("return io == nil and ide ~= nil")()`)).toEqual([true]);
  });

  it("limits collectgarbage", async () => {
    const { run } = await make();
    expect(await run(`return pcall(collectgarbage, "stop")`)).toEqual([
      false,
      expect.stringContaining("only 'collect', 'count' and 'step'"),
    ]);
  });

  it("does not let plugin code change the string library the host uses", async () => {
    const { run } = await make();
    await run(`string.rep = function() return "evil" end`);
    expect(await run(`return ("ab"):rep(2)`)).toEqual(["abab"]);
  });
});

describe("string.dump", () => {
  it('is gone from both the plugin\'s string table and the one ("").dump reaches', async () => {
    const { run } = await make();
    expect(await run(`return string.dump, ("").dump, ("x").dump`)).toEqual([null, null, null]);
  });
});

describe("yields and host calls", () => {
  it("refuses a table that poses as a promise and never calls its then", async () => {
    const { run, state } = await make();
    const started = performance.now();
    await expect(
      run(`coroutine.yield({ ["then"] = function() CALLED = true end })`),
    ).rejects.toThrow(/E_INVALID: a callback may only yield to wait for the host/u);
    expect(performance.now() - started).toBeLessThan(300);
    expect(await run(`return CALLED`)).toEqual([null]);
    expect(state.broken).toBeNull();
  });

  it("refuses a then that would spin, without running it", async () => {
    const { run } = await make();
    const started = performance.now();
    await expect(
      run(
        `coroutine.yield(setmetatable({}, { __index = { ["then"] = function() while true do end end } }))`,
      ),
    ).rejects.toThrow(/E_INVALID/u);
    await expect(run(`coroutine.yield(print)`)).rejects.toThrow(/E_INVALID/u);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("stops a loop of bare yields at the wall clock, long before a large budget", async () => {
    const { run, trips } = await make();
    const started = performance.now();
    // Each bare yield costs almost no budget, so only the wall clock ends this.
    await expect(run(`while true do coroutine.yield() end`, 5000, 200)).rejects.toThrow(
      /wall-clock limit/u,
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(195);
    expect(elapsed).toBeLessThan(1500);
    expect(trips).toEqual(["timeout"]);
  });

  it("hands Lua plain JSON copies of host results", async () => {
    const shared = { tags: ["a", "b"], nested: { n: 1, ok: true, none: null } };
    const { run } = await make({}, { "test.data": async () => shared });
    expect(await run(`local d = ide.test.data() d.tags[1] = "changed" return d`)).toEqual([
      { tags: ["changed", "b"], nested: { n: 1, ok: true } },
    ]);
    expect(shared.tags[0]).toBe("a");
  });

  it("refuses host results that are not plain JSON, as a Lua error", async () => {
    class Pane {
      id = "p";
    }
    const returns: Record<string, unknown> = {
      fn: () => "secret",
      instance: new Pane(),
      inner: { run: () => 1 },
      map: new Map([["a", 1]]),
      getter: Object.defineProperty({}, "x", { get: () => 1, enumerable: true }),
      nan: Number.NaN,
      big: 10n,
    };
    const hostFunctions = Object.fromEntries(
      Object.entries(returns).map(([name, value]) => [`test.${name}`, async () => value]),
    );
    const { run } = await make({}, hostFunctions);
    for (const name of Object.keys(returns)) {
      const [ok, err] = await run(`return pcall(ide.test.${name})`);
      expect([name, ok, err]).toEqual([
        name,
        false,
        expect.stringContaining("not plain JSON data"),
      ]);
    }
  });

  it("allows a bare coroutine.yield", async () => {
    const { run } = await make();
    expect(await run(`coroutine.yield() return "after"`)).toEqual(["after"]);
  });

  it("waits for a host call without charging the wait to the budget", async () => {
    const { run } = await make(
      {},
      {
        "test.sleep": async ([ms]) => {
          await new Promise((resolve) => setTimeout(resolve, Number(ms)));
          return { slept: ms };
        },
      },
    );
    // 300 ms of waiting against a 150 ms budget and a 400 ms wall clock.
    expect(await run(`return ide.test.sleep(300)`)).toEqual([{ slept: 300 }]);
  });

  it("stops a host call that never settles at the wall-clock limit", async () => {
    const { run, trips } = await make({}, { "test.never": () => new Promise(() => {}) });
    const started = performance.now();
    await expect(run(`return ide.test.never()`)).rejects.toThrow(/wall-clock limit/u);
    expect(performance.now() - started).toBeGreaterThanOrEqual(390);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(trips).toEqual(["timeout"]);
  });

  it("turns a rejected host call into a Lua error the plugin can catch", async () => {
    const { run } = await make(
      {},
      { "test.fail": async () => Promise.reject(new Error("E_NOT_FOUND: no such pane")) },
    );
    expect(await run(`return pcall(ide.test.fail)`)).toEqual([
      false,
      expect.stringContaining("E_NOT_FOUND"),
    ]);
  });

  it("refuses host calls inside a plugin coroutine", async () => {
    const { run } = await make({}, { "test.sleep": async () => 1 });
    await expect(
      run(`local co = coroutine.wrap(function() return ide.test.sleep(1) end) return co()`),
    ).rejects.toThrow(/cannot be called inside a coroutine/u);
  });
});

// Busy loops in these tests stop on their own after 3 s, so a broken guard
// fails a test instead of hanging the suite.
describe("deadlines", () => {
  it("stops a busy loop at the budget and reports a timeout trip", async () => {
    const { run, trips } = await make();
    const started = performance.now();
    await expect(run(`local __t = os.clock() while os.clock() - __t < 3 do end`)).rejects.toThrow(
      /E_TIMEOUT/u,
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(trips).toEqual(["timeout"]);
  });

  it("counts a timeout the plugin caught with pcall", async () => {
    const { run, trips } = await make();
    const [ok, err] = await run(
      `return pcall(function() local __t = os.clock() while os.clock() - __t < 3 do end end)`,
    );
    expect([ok, err]).toEqual([false, expect.stringContaining("E_TIMEOUT")]);
    expect(trips).toEqual(["timeout"]);
  });

  it("arms coroutines the plugin creates", async () => {
    const { run, trips } = await make();
    await expect(
      run(
        `coroutine.wrap(function() local __t = os.clock() while os.clock() - __t < 3 do end end)()`,
      ),
    ).rejects.toThrow(/E_TIMEOUT/u);
    await expect(
      run(
        `local co = coroutine.create(function() local __t = os.clock() while os.clock() - __t < 3 do end end) local ok, e = coroutine.resume(co) error(e, 0)`,
      ),
    ).rejects.toThrow(/E_TIMEOUT/u);
    expect(trips).toEqual(["timeout", "timeout"]);
  });

  it("charges the budget across every slice of one callback", async () => {
    const { run, trips, marks } = await make();
    // Ten 40 ms slices separated by yields: 400 ms of Lua against a 150 ms budget.
    await expect(
      run(
        `for i = 1, 10 do local t = os.clock() while os.clock() - t < 0.04 do end coroutine.yield() end`,
      ),
    ).rejects.toThrow(/ran past its time budget/u);
    expect(trips).toEqual(["timeout"]);
    expect(marks.length).toBeGreaterThan(2);
  });

  it("brackets every Lua slice with busy and idle markers", async () => {
    const { run, marks } = await make();
    await run(`return 1`);
    expect(marks).toEqual(["busy", "idle"]);
  });

  it("leaves the state usable after a timeout", async () => {
    const { run } = await make();
    await expect(run(`local __t = os.clock() while os.clock() - __t < 3 do end`)).rejects.toThrow(
      /E_TIMEOUT/u,
    );
    expect(await run(`return 6 * 7`)).toEqual([42]);
  });
});

describe("memory", () => {
  it("stops a plugin at its memory cap with a memory trip, and stays usable", async () => {
    const { run, trips } = await make();
    await expect(
      run(`local t = {} for i = 1, 1e7 do t[i] = string.rep("x", 64) .. i end`, 10_000),
    ).rejects.toThrow(/not enough memory/u);
    expect(trips).toEqual(["memory"]);
    expect(await run(`collectgarbage() return 1`)).toEqual([1]);
  });

  it("gives each plugin its own module, so one state's cap does not touch another", async () => {
    const a = await make();
    const b = await make();
    await expect(
      a.run(`local t = {} for i = 1, 1e7 do t[i] = string.rep("x", 64) .. i end`, 10_000),
    ).rejects.toThrow(/not enough memory/u);
    expect(await b.run(`local t = {} for i = 1, 1000 do t[i] = i end return #t`)).toEqual([1000]);
  });
});

describe("logging and values", () => {
  it("routes print and ide.log with fields", async () => {
    const { run, logs } = await make();
    await run(`print("a", 1, nil, true) ide.log.warn("careful", { n = 2, list = {1, 2} })`);
    expect(logs).toEqual([
      { level: "info", message: "a\t1\tnil\ttrue" },
      { level: "warn", message: "careful", fields: { n: 2, list: [1, 2] } },
    ]);
  });

  it("encodes return values as JSON, including nil, arrays, objects and functions", async () => {
    const { run } = await make();
    expect(await run(`return nil, 1.5, "s", {1, 2}, { k = "v" }, {}, print, 0/0`)).toEqual([
      null,
      1.5,
      "s",
      [1, 2],
      { k: "v" },
      [],
      "<function>",
      null,
    ]);
  });

  it("refuses to encode a table that contains itself", async () => {
    const { run } = await make();
    await expect(run(`local t = {} t.self = t ide.log.info("x", t)`)).rejects.toThrow(
      /contains itself/u,
    );
  });

  it("reports ide.has features", async () => {
    const { run } = await make();
    expect(await run(`return ide.has("log"), ide.has("include"), ide.has("sidebar")`)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("include and require", () => {
  it("includes a file and requires a module once", async () => {
    writeFileSync(join(dir, "keys.lua"), `return "keys", ...`);
    mkdirSync(join(dir, "util"));
    writeFileSync(join(dir, "util", "init.lua"), `COUNT = (COUNT or 0) + 1 return { n = COUNT }`);
    const { run } = await make();
    expect(await run(`return ide.include("keys.lua")`)).toEqual(["keys"]);
    expect(
      await run(`local a = require("util") local b = require("util") return a.n, b.n, a == b`),
    ).toEqual([1, 1, true]);
  });

  it("detects a module that requires itself", async () => {
    writeFileSync(join(dir, "loop.lua"), `return require("loop")`);
    const { run } = await make();
    await expect(run(`return require("loop")`)).rejects.toThrow(/requires itself/u);
  });

  it("refuses absolute names, .. segments, non-.lua files and missing files", async () => {
    const { run } = await make();
    await expect(run(`ide.include("/etc/hosts")`)).rejects.toThrow(/must be a relative path/u);
    await expect(run(`ide.include("../x.lua")`)).rejects.toThrow(/may not leave/u);
    await expect(run(`ide.include("a/../../x.lua")`)).rejects.toThrow(/may not leave/u);
    await expect(run(`ide.include("notes.txt")`)).rejects.toThrow(/not a .lua file/u);
    await expect(run(`ide.include("missing.lua")`)).rejects.toThrow(/E_NOT_FOUND/u);
    await expect(run(`require("../x")`)).rejects.toThrow(/bad module name/u);
  });

  it("refuses a symlink that leads outside its root", async () => {
    writeFileSync(join(outside, "secret.lua"), `return "secret"`);
    symlinkSync(join(outside, "secret.lua"), join(dir, "link.lua"));
    const { run } = await make();
    await expect(run(`return ide.include("link.lua")`)).rejects.toThrow(/E_DENIED/u);
  });

  it("refuses files over 1 MiB", () => {
    writeFileSync(join(dir, "big.lua"), "-- " + "x".repeat(1024 * 1024));
    expect(resolveSource("file", "big.lua", [dir])).toEqual({
      ok: false,
      error: "E_INVALID: 'big.lua' is larger than 1 MiB",
    });
  });
});
