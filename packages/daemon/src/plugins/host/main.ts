/**
 * The plugin host process: `tmux-ide __plugin-host`.
 *
 * Started and supervised by the daemon (see ../supervisor.ts). Reads commands
 * from stdin, writes events to file descriptor 3. Each plugin has its own Lua
 * state. Loads and unloads run strictly in the order received; one-off runs
 * each have their own queue.
 */
import { readFileSync, statSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  DEFAULT_PLUGIN_LIMITS,
  HostCommandSchemaZ,
  MAX_PROTOCOL_LINE_BYTES,
  PLUGIN_API_VERSION,
  PLUGIN_HOST_PROTOCOL_VERSION,
  type HostCommand,
  type HostEvent,
  type PluginLimits,
  type PluginLogLevel,
  type PluginSpec,
} from "../protocol.ts";
import { MAX_SOURCE_BYTES, PluginLuaState, PluginRunError } from "./lua-state.ts";

export const HEARTBEAT_INTERVAL_MS = 1000;
const EVENT_FD = 3;
const LOAD_QUEUE = "\0loads";

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Write one event line synchronously, so it is on the wire before Lua runs. */
export function writeEventLine(fd: number, event: HostEvent): void {
  const buffer = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  let offset = 0;
  let spins = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" && spins < 2000) {
        spins += 1;
        Atomics.wait(sleeper, 0, 0, 1);
        continue;
      }
      if (code === "EPIPE" || code === "EBADF") process.exit(0);
      throw error;
    }
  }
}

interface LogBudget {
  windowStart: number;
  count: number;
  dropped: number;
}

export class PluginHost {
  readonly #emit: (event: HostEvent) => void;
  readonly #states = new Map<string, PluginLuaState>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #logBudgets = new Map<string, LogBudget>();
  #productVersion = "0.0.0";
  #limits: PluginLimits = DEFAULT_PLUGIN_LIMITS;

  constructor(emit: (event: HostEvent) => void) {
    this.#emit = emit;
  }

  /** Run `task` after every earlier task for the same plugin has settled. */
  #enqueue(name: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(name) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#queues.set(name, next);
    void next.finally(() => {
      if (this.#queues.get(name) === next) this.#queues.delete(name);
    });
    return next;
  }

  #log(plugin: string, level: PluginLogLevel, message: string, fields?: Record<string, unknown>) {
    const now = Date.now();
    let budget = this.#logBudgets.get(plugin);
    if (!budget || now - budget.windowStart >= 1000) {
      if (budget && budget.dropped > 0)
        this.#emit({
          type: "log",
          plugin,
          level: "warn",
          message: `dropped ${budget.dropped} log lines (limit ${this.#limits.logLinesPerSecond}/s)`,
        });
      budget = { windowStart: now, count: 0, dropped: 0 };
      this.#logBudgets.set(plugin, budget);
    }
    if (budget.count >= this.#limits.logLinesPerSecond) {
      budget.dropped += 1;
      return;
    }
    budget.count += 1;
    this.#emit({
      type: "log",
      plugin,
      level,
      message: message.slice(0, 8192),
      ...(fields ? { fields: fields as Record<string, never> } : {}),
    });
  }

  async #createState(
    spec: Pick<PluginSpec, "name" | "includeRoots" | "moduleRoots" | "settings">,
    onLog?: (level: PluginLogLevel, message: string) => void,
  ): Promise<PluginLuaState> {
    return PluginLuaState.create({
      spec,
      apiVersion: PLUGIN_API_VERSION,
      productVersion: this.#productVersion,
      limits: this.#limits,
      hooks: {
        busy: () => this.#emit({ type: "busy", plugin: spec.name }),
        idle: () => this.#emit({ type: "idle", plugin: spec.name }),
        log: (level, message, fields) =>
          onLog ? onLog(level, message) : this.#log(spec.name, level, message, fields),
        trip: (kind) => this.#emit({ type: "trip", plugin: spec.name, kind }),
      },
    });
  }

  async #load(spec: PluginSpec): Promise<void> {
    this.#unload(spec.name);
    let state: PluginLuaState | null = null;
    try {
      const size = statSync(spec.entry).size;
      if (size > MAX_SOURCE_BYTES) throw new Error(`E_INVALID: ${spec.entry} is larger than 1 MiB`);
      const source = readFileSync(spec.entry, "utf8");
      state = await this.#createState(spec);
      this.#states.set(spec.name, state);
      const chunkName = spec.kind === "init" ? "@init.lua" : `@${spec.name}/init.lua`;
      await state.runSource(source, chunkName, this.#limits.callbackBudgetMs);
      this.#emit({ type: "loaded", plugin: spec.name, ok: true, memoryBytes: state.memoryUsed() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(spec.name, "error", `load failed: ${message}`);
      if (state?.broken) this.#unload(spec.name);
      this.#emit({ type: "loaded", plugin: spec.name, ok: false, error: message.slice(0, 4096) });
    }
  }

  #unload(name: string): void {
    const state = this.#states.get(name);
    if (!state) return;
    this.#states.delete(name);
    state.close();
  }

  async #run(command: Extract<HostCommand, { type: "run" }>): Promise<void> {
    const logs: { level: PluginLogLevel; message: string }[] = [];
    let state: PluginLuaState | null = null;
    try {
      state = await this.#createState(
        { name: "run", includeRoots: [], moduleRoots: [], settings: {} },
        (level, message) => {
          if (logs.length < 1000) logs.push({ level, message: message.slice(0, 8192) });
        },
      );
      const values = await state.runSource(command.code, command.chunkName, command.budgetMs);
      this.#emit({ type: "run-result", id: command.id, ok: true, values, logs });
    } catch (error) {
      const message =
        error instanceof PluginRunError || error instanceof Error ? error.message : String(error);
      this.#emit({
        type: "run-result",
        id: command.id,
        ok: false,
        error: message.slice(0, 8192),
        logs,
      });
    } finally {
      state?.close();
    }
  }

  handle(command: HostCommand): Promise<void> | void {
    switch (command.type) {
      case "configure":
        this.#productVersion = command.productVersion;
        this.#limits = command.limits;
        return;
      // Loads and unloads share one queue: plugins load in the order the
      // daemon sends them, so init.lua always runs after every plugin.
      case "load":
        return this.#enqueue(LOAD_QUEUE, () => this.#load(command.plugin));
      case "unload":
        return this.#enqueue(LOAD_QUEUE, async () => this.#unload(command.name));
      case "run":
        return this.#enqueue(`run:${command.id}`, () => this.#run(command));
      case "shutdown":
        this.shutdown();
        return;
    }
  }

  loadedPlugins(): string[] {
    return [...this.#states.keys()];
  }

  shutdown(): void {
    for (const name of [...this.#states.keys()]) this.#unload(name);
  }
}

/** Entry point for `tmux-ide __plugin-host`. */
export async function runPluginHost(): Promise<void> {
  const emit = (event: HostEvent) => writeEventLine(EVENT_FD, event);
  const host = new PluginHost(emit);
  emit({ type: "hello", protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION, pid: process.pid });
  let seq = 0;
  const heartbeat = setInterval(
    () => emit({ type: "heartbeat", seq: ++seq }),
    HEARTBEAT_INTERVAL_MS,
  );

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const finish = () => {
    clearInterval(heartbeat);
    host.shutdown();
    process.exit(0);
  };
  lines.on("line", (line) => {
    if (line.length === 0 || line.length > MAX_PROTOCOL_LINE_BYTES) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = HostCommandSchemaZ.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.type === "shutdown") {
      finish();
      return;
    }
    void host.handle(parsed.data);
  });
  // The daemon closed our stdin: it is gone or done with us.
  lines.on("close", finish);
}
