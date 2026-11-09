/**
 * One plugin's Lua state.
 *
 * Every state gets its own wasmoon factory, so its own WebAssembly module and
 * memory. Engines from one factory share a module, and a fatal abort in one
 * would leave the others in an unknown state.
 *
 * Code runs on runner threads driven by {@link PluginLuaState.runThread}, not
 * wasmoon's own `run`: the budget is spent only while Lua runs, so a callback
 * that awaits the host for a second has not used a second of its budget.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { LuaFactory, LuaMultiReturn, LuaReturn, LUA_REGISTRYINDEX, type LuaEngine } from "wasmoon";
import type { PluginLimits, PluginLogLevel, PluginSpec, PluginTripKind } from "../protocol.ts";
import { SANDBOX_PRELUDE, TIMEOUT_MESSAGE } from "./sandbox.ts";

/** Largest file `ide.include` or `require` will read. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

export interface PluginStateHooks {
  /** A Lua slice is about to run synchronously (sent before it starts). */
  busy(): void;
  idle(): void;
  log(level: PluginLogLevel, message: string, fields?: Record<string, unknown>): void;
  trip(kind: PluginTripKind): void;
}

export class PluginRunError extends Error {
  readonly trip: PluginTripKind | null;
  constructor(message: string, trip: PluginTripKind | null) {
    super(message);
    this.name = "PluginRunError";
    this.trip = trip;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a file name or module name to a readable file inside one of `roots`.
 * Refuses absolute names, `..` segments, and symlinks that lead outside a root.
 */
export function resolveSource(
  kind: "file" | "module",
  name: string,
  roots: readonly string[],
): { ok: true; source: string; display: string } | { ok: false; error: string } {
  let candidates: string[];
  if (kind === "module") {
    if (!/^[\w-]+(?:\.[\w-]+)*$/u.test(name))
      return { ok: false, error: `E_INVALID: bad module name '${name}'` };
    const base = name.split(".").join("/");
    candidates = [`${base}.lua`, `${base}/init.lua`];
  } else {
    if (isAbsolute(name) || name.includes("\0"))
      return { ok: false, error: `E_INVALID: '${name}' must be a relative path` };
    const normalized = normalize(name);
    if (normalized.split(/[\\/]/u).includes(".."))
      return { ok: false, error: `E_INVALID: '${name}' may not leave its directory` };
    if (!normalized.endsWith(".lua"))
      return { ok: false, error: `E_INVALID: '${name}' is not a .lua file` };
    candidates = [normalized];
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      const path = join(root, candidate);
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (!isInside(real, realRoot))
        return { ok: false, error: `E_DENIED: '${name}' resolves outside ${root}` };
      const stat = statSync(real);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SOURCE_BYTES)
        return { ok: false, error: `E_INVALID: '${name}' is larger than 1 MiB` };
      const display = relative(root, path).split(sep).join("/");
      return { ok: true, source: readFileSync(real, "utf8"), display };
    }
  }
  return {
    ok: false,
    error:
      kind === "module"
        ? `E_NOT_FOUND: module '${name}' not found`
        : `E_NOT_FOUND: '${name}' not found`,
  };
}

export const WALL_CLOCK_MESSAGE = "E_TIMEOUT: the callback took longer than its wall-clock limit";
export const FOREIGN_YIELD_MESSAGE =
  "E_INVALID: a callback may only yield to wait for the host; it yielded something else";

/** Host functions a state exposes as `ide.<name>`: each returns a promise Lua waits on. */
export type HostFunctions = Readonly<Record<string, (args: unknown[]) => Promise<unknown>>>;

interface Runner {
  /** The host call this runner yielded to wait for, if any. */
  pending: Promise<unknown> | null;
  /** The budget ran out at least once, even if the plugin caught E_TIMEOUT. */
  overran: boolean;
}

type Settled =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; value: string }
  | { status: "late"; value: undefined };

/** Wait for `promise`, but no later than `deadline` (a performance.now() time). */
async function settleBefore(promise: Promise<unknown>, deadline: number): Promise<Settled> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Settled>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "late", value: undefined }),
      Math.max(0, deadline - performance.now()),
    );
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Settled => ({ status: "fulfilled", value }),
        (error: unknown): Settled => ({
          status: "rejected",
          value: error instanceof Error ? error.message : String(error),
        }),
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function classify(message: string): PluginTripKind | null {
  if (message.includes(TIMEOUT_MESSAGE) || message.includes(WALL_CLOCK_MESSAGE)) return "timeout";
  if (/not enough memory/u.test(message)) return "memory";
  if (/Aborted\(|RuntimeError/u.test(message)) return "abort";
  return null;
}

export class PluginLuaState {
  readonly name: string;
  readonly #engine: LuaEngine;
  readonly #hooks: PluginStateHooks;
  #deadline = Number.POSITIVE_INFINITY;
  /** The runner whose slice is executing right now, if any. */
  #active: Runner | null = null;
  #broken: string | null = null;

  private constructor(name: string, engine: LuaEngine, hooks: PluginStateHooks) {
    this.name = name;
    this.#engine = engine;
    this.#hooks = hooks;
  }

  static async create(options: {
    spec: Pick<PluginSpec, "name" | "includeRoots" | "moduleRoots" | "settings">;
    apiVersion: string;
    productVersion: string;
    limits: PluginLimits;
    hooks: PluginStateHooks;
    /** Async host functions exposed as `ide.<name>`. Slice A ships none. */
    hostFunctions?: HostFunctions;
  }): Promise<PluginLuaState> {
    const engine = await new LuaFactory().createEngine({
      openStandardLibs: true,
      injectObjects: false,
      enableProxy: false,
      traceAllocations: true,
    });
    const state = new PluginLuaState(options.spec.name, engine, options.hooks);
    const global = engine.global;
    global.set("__ide_over", () => {
      if (performance.now() <= state.#deadline) return false;
      if (state.#active) state.#active.overran = true;
      return true;
    });
    const hostFunctions = options.hostFunctions ?? {};
    // Starts a host call for the runner whose slice is running; the prelude
    // then yields, and runThread waits for exactly this promise.
    global.set("__ide_begin", (name: unknown, args: unknown) => {
      const runner = state.#active;
      if (!runner) throw new Error("E_INVALID: host calls are only possible inside a callback");
      if (runner.pending) throw new Error("E_INVALID: a host call is already in progress");
      const fn = typeof name === "string" ? hostFunctions[name] : undefined;
      if (!fn) throw new Error(`E_INVALID: no host function '${String(name)}'`);
      let parsed: unknown;
      try {
        parsed = typeof args === "string" ? JSON.parse(args) : [];
      } catch {
        parsed = [];
      }
      const list = Array.isArray(parsed) ? parsed : [];
      runner.pending = Promise.resolve().then(() => fn(list));
    });
    global.set("__ide_log", (level: unknown, message: unknown, fieldsJson: unknown) => {
      const lvl: PluginLogLevel =
        level === "debug" || level === "warn" || level === "error" ? level : "info";
      let fields: Record<string, unknown> | undefined;
      if (typeof fieldsJson === "string") {
        try {
          const parsed: unknown = JSON.parse(fieldsJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            fields = parsed as Record<string, unknown>;
        } catch {
          fields = undefined;
        }
      }
      options.hooks.log(lvl, String(message), fields);
    });
    global.set("__ide_resolve", (kind: unknown, name: unknown) => {
      if ((kind !== "file" && kind !== "module") || typeof name !== "string")
        return LuaMultiReturn.of(undefined, "E_INVALID: bad include request");
      const roots = kind === "file" ? options.spec.includeRoots : options.spec.moduleRoots;
      const resolved = resolveSource(kind, name, roots);
      return resolved.ok
        ? LuaMultiReturn.of(resolved.source, resolved.display)
        : LuaMultiReturn.of(undefined, resolved.error);
    });
    global.set("__ide_info", {
      api: options.apiVersion,
      version: options.productVersion,
      plugin: options.spec.name,
      settings: options.spec.settings,
      host_functions: Object.keys(hostFunctions),
    });
    engine.doStringSync(SANDBOX_PRELUDE);
    // Cap memory only after the prelude, so the cap measures plugin use.
    global.setMemoryMax(global.getMemoryUsed() + options.limits.memoryBytes);
    return state;
  }

  /** True once a fatal abort left this state unusable. */
  get broken(): string | null {
    return this.#broken;
  }

  memoryUsed(): number {
    return this.#engine.global.getMemoryUsed();
  }

  /**
   * Run `internalFunction` from `__ide_internal` on a fresh runner thread with
   * `args`, giving Lua at most `budgetMs` of run time across all its slices.
   */
  async runThread(
    internalFunction: string,
    args: unknown[],
    limits: { budgetMs: number; wallClockMs: number },
  ): Promise<unknown[]> {
    if (this.#broken) throw new PluginRunError(`E_UNAVAILABLE: ${this.#broken}`, null);
    const global = this.#engine.global;
    const lua = global.lua;
    const thread = global.newThread();
    // Anchor the thread in the registry instead of by stack index, so runner
    // threads that finish out of order cannot remove each other.
    const ref = lua.luaL_ref(global.address, LUA_REGISTRYINDEX);
    const runner: Runner = { pending: null, overran: false };
    const wallDeadline = performance.now() + limits.wallClockMs;
    let remaining = limits.budgetMs;
    try {
      thread.loadString(`return __ide_internal.${internalFunction}(...)`, `=${internalFunction}`);
      for (const arg of args) thread.pushValue(arg);
      let argCount = args.length;
      for (;;) {
        if (performance.now() > wallDeadline) throw new Error(WALL_CLOCK_MESSAGE);
        this.#hooks.busy();
        const started = performance.now();
        this.#deadline = started + Math.max(0, remaining);
        this.#active = runner;
        let result;
        try {
          result = thread.resume(argCount);
        } finally {
          this.#active = null;
          remaining -= performance.now() - started;
          this.#deadline = Number.POSITIVE_INFINITY;
          this.#hooks.idle();
        }
        argCount = 0;
        if (result.result === LuaReturn.Yield) {
          // Never inspect or convert what Lua yielded: a table can pose as a
          // promise and its `then` would run as JS outside every limit. The
          // only yield the host waits on is one it started itself.
          if (result.resultCount > 0) thread.pop(result.resultCount);
          const pending = runner.pending;
          runner.pending = null;
          if (pending) {
            const outcome = await settleBefore(pending, wallDeadline);
            if (outcome.status === "late") throw new Error(WALL_CLOCK_MESSAGE);
            thread.pushValue(outcome.status === "fulfilled");
            thread.pushValue(outcome.value);
            argCount = 2;
          } else if (result.resultCount > 0) {
            throw new Error(FOREIGN_YIELD_MESSAGE);
          } else {
            // A bare coroutine.yield(): let the event loop breathe, then go on.
            await new Promise((resolve) => setImmediate(resolve));
          }
          continue;
        }
        thread.assertOk(result.result);
        // The plugin caught E_TIMEOUT and still returned: count the overrun.
        if (runner.overran) this.#hooks.trip("timeout");
        return [...thread.getStackValues()];
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const trip = classify(message);
      if (trip) this.#hooks.trip(trip);
      if (trip === "abort") this.#broken = "the Lua runtime aborted; reload the plugin";
      throw new PluginRunError(message, trip);
    } finally {
      lua.luaL_unref(global.address, LUA_REGISTRYINDEX, ref);
    }
  }

  /** Run plugin source text. Resolves to the JSON text of its return values. */
  async runSource(
    source: string,
    chunkName: string,
    limits: { budgetMs: number; wallClockMs: number },
  ): Promise<string> {
    const [json] = await this.runThread("run_source", [source, chunkName], limits);
    return typeof json === "string" ? json : "[]";
  }

  close(): void {
    try {
      this.#engine.global.close();
    } catch {
      // A state that aborted may not close cleanly; its memory goes with the module.
    }
  }
}
