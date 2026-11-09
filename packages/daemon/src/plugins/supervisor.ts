/**
 * The daemon side of plugins: starts the plugin host process, keeps it alive,
 * and decides when a plugin is switched off.
 *
 * Three guards, from gentle to hard:
 *  1. The host's own per-callback budget and memory cap, which raise Lua
 *     errors. Each one is reported here as a trip; `tripLimit` trips within
 *     `tripWindowMs` disable the plugin.
 *  2. The heartbeat watchdog. The host sends a heartbeat every second from its
 *     event loop. A Lua slice that never returns (for example one that keeps
 *     catching E_TIMEOUT) stops the heartbeats; after `heartbeatTimeoutMs`
 *     this kills the host with SIGKILL and disables the plugin that the
 *     host's last "busy" marker named.
 *  3. Restarts with exponential backoff when the host exits on its own.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  CommandChoiceSchemaZ,
  type CommandCatalogEntry,
  type CommandInvocationContext,
  type CommandInvokeResult,
  type CommandParamOptionsResult,
  terminalSafe,
  terminalSafeDeep,
} from "@tmux-ide/contracts";
import { z } from "zod";
import { isSecretKey, redactLogValue, redactText } from "../lib/log-sanitize.ts";
import { PluginActionCatalog, parsePluginCommandId } from "./action-catalog.ts";
import { ownerCapabilities, type HostCallHandler } from "./host-calls.ts";
import { discoverPlugins, type PluginAwaitingConsent, type PluginProblem } from "./discovery.ts";
import { appendPluginLog, pluginLogPath, type PluginLogEntry } from "./plugin-log.ts";
import {
  DEFAULT_PLUGIN_LIMITS,
  RUN_STATE_NAME,
  HostEventSchemaZ,
  MAX_PROTOCOL_LINE_BYTES,
  PLUGIN_HOST_PROTOCOL_VERSION,
  type HostCommand,
  type HostEvent,
  type PluginLimits,
  type PluginSpec,
  type PluginTripKind,
} from "./protocol.ts";

export type PluginRunState =
  | "loading"
  | "loaded"
  | "failed"
  | "disabled"
  | "invalid"
  | "needs-consent";

export interface PluginStatus {
  readonly name: string;
  readonly kind: "init" | "plugin";
  readonly state: PluginRunState;
  readonly error?: string;
  readonly memoryBytes?: number;
  readonly trips: number;
}

export interface PluginSupervisorStatus {
  readonly host: {
    readonly running: boolean;
    readonly pid: number | null;
    readonly restarts: number;
  };
  readonly plugins: readonly PluginStatus[];
}

export interface LuaRunResult {
  readonly ok: boolean;
  readonly values?: unknown[];
  readonly error?: string;
  readonly logs: readonly { level: string; message: string }[];
}

export interface PluginSupervisorOptions {
  readonly stateHome: string;
  readonly productVersion: string;
  /** argv of the host process, e.g. [node, cli.js, "__plugin-host"]. */
  readonly hostCommand: readonly string[];
  /** The host's environment. Defaults to {@link minimalHostEnv}. */
  readonly hostEnv?: NodeJS.ProcessEnv;
  /** Strings never to write to logs or return from `run`, e.g. daemon tokens. */
  readonly secrets?: () => Iterable<string>;
  readonly limits?: PluginLimits;
  readonly heartbeatTimeoutMs?: number;
  readonly watchdogIntervalMs?: number;
  readonly helloTimeoutMs?: number;
  readonly tripLimit?: number;
  readonly tripWindowMs?: number;
  readonly restartDelayMs?: (attempt: number) => number;
  /** A host up this long resets the restart backoff. */
  readonly healthyAfterMs?: number;
  /** Where plugin log entries go. Defaults to `logs/plugins.log`. */
  readonly onLog?: (entry: PluginLogEntry) => void;
  readonly now?: () => number;
  /** Serves the host functions plugins call (exec, panes, store…). */
  readonly calls?: HostCallHandler;
  /** Called after the set of plugin actions changes (the catalog revision moved). */
  readonly onCatalogChange?: () => void;
}

interface Entry {
  spec: PluginSpec | null;
  name: string;
  kind: "init" | "plugin";
  state: PluginRunState;
  error?: string;
  memoryBytes?: number;
  trips: number[];
}

interface HostHandle {
  child: ChildProcess;
  ready: boolean;
  lastHeartbeat: number;
  busy: string | null;
  outbox: HostCommand[];
  killedBy: string | null;
  healthyTimer: NodeJS.Timeout | null;
}

/**
 * The only variables the plugin host inherits. The daemon's own environment
 * (owner tokens, TMUX_IDE_* settings, anything the user exported) stays out.
 */
export const HOST_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMUX_IDE_HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TMPDIR",
  // Where tmux keeps its default socket: programs such as tmux-ide reach the
  // same tmux server as the daemon.
  "TMUX_TMPDIR",
  "TZ",
  // Windows needs these to start Node at all.
  "SystemRoot",
  "TEMP",
  "TMP",
]);

export function minimalHostEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Values of credential-named variables in `env`, to redact wherever they appear. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => isSecretKey(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value!);
}

type HostReply = { ok: true; text: string } | { ok: false; error: string };

const ParamOptionsReplySchemaZ = z
  .object({
    choices: z.array(CommandChoiceSchemaZ).max(500).optional(),
    default: z.union([z.string().max(10_000), z.number(), z.boolean()]).optional(),
  })
  .strip();

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const defaultRestartDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 60_000);

export class PluginSupervisor {
  readonly #options: Required<
    Omit<
      PluginSupervisorOptions,
      "hostEnv" | "onLog" | "limits" | "now" | "secrets" | "onCatalogChange" | "calls"
    >
  > & {
    hostEnv: NodeJS.ProcessEnv;
    secrets: () => Iterable<string>;
    calls: HostCallHandler | undefined;
    onLog: (entry: PluginLogEntry) => void;
    limits: PluginLimits;
    now: () => number;
  };
  readonly #entries = new Map<string, Entry>();
  readonly #loadWaiters = new Map<string, (() => void)[]>();
  readonly #runs = new Map<string, (result: LuaRunResult) => void>();
  readonly #requests = new Map<string, (reply: HostReply) => void>();
  readonly #actions: PluginActionCatalog;
  #problems: readonly PluginProblem[] = [];
  #awaitingConsent: readonly PluginAwaitingConsent[] = [];
  #host: HostHandle | null = null;
  #restarts = 0;
  #backoffAttempt = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(options: PluginSupervisorOptions) {
    const logPath = pluginLogPath(options.stateHome);
    this.#options = {
      stateHome: options.stateHome,
      productVersion: options.productVersion,
      hostCommand: options.hostCommand,
      hostEnv: options.hostEnv ?? minimalHostEnv(),
      secrets: options.secrets ?? (() => secretEnvValues()),
      limits: options.limits ?? DEFAULT_PLUGIN_LIMITS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5000,
      watchdogIntervalMs: options.watchdogIntervalMs ?? 500,
      helloTimeoutMs: options.helloTimeoutMs ?? 15_000,
      tripLimit: options.tripLimit ?? 3,
      tripWindowMs: options.tripWindowMs ?? 60_000,
      restartDelayMs: options.restartDelayMs ?? defaultRestartDelay,
      healthyAfterMs: options.healthyAfterMs ?? 60_000,
      onLog: options.onLog ?? ((entry) => appendPluginLog(logPath, entry)),
      now: options.now ?? Date.now,
      calls: options.calls,
    };
    this.#actions = new PluginActionCatalog(() => {
      // A listener that throws must not break whatever changed the catalog
      // (a host event, an exit, a stop).
      try {
        options.onCatalogChange?.();
      } catch (error) {
        this.#log("host", "error", `a catalog listener failed: ${(error as Error).message}`);
      }
    });
  }

  // ------------------------------------------------------------------ public

  /** Discover plugins and load them. Starts the host only if there is something to load. */
  async start(): Promise<PluginSupervisorStatus> {
    return this.reload();
  }

  /**
   * Discover again and (re)load every plugin, or only `name`. Reloading
   * clears a plugin's disabled state and trip count.
   */
  async reload(name?: string): Promise<PluginSupervisorStatus> {
    if (this.#stopped) return this.status();
    const discovery = discoverPlugins(this.#options.stateHome);
    this.#problems = discovery.problems;
    this.#awaitingConsent = discovery.awaitingConsent;
    const found = new Set(discovery.specs.map((spec) => spec.name));

    // Plugins that vanished from disk, became invalid, or changed since
    // consent are unloaded and forgotten.
    for (const [entryName, entry] of [...this.#entries]) {
      // Whatever was asked to reload: a loaded plugin whose files changed,
      // lost consent or broke goes now, not at its own next reload.
      if (entry.spec && !found.has(entryName)) {
        this.#send({ type: "unload", name: entryName });
        this.#entries.delete(entryName);
        this.#actions.drop(entryName);
        this.#stopPrograms(entryName);
      }
    }
    for (const problem of discovery.problems) {
      // A loaded plugin that became a problem was unloaded above, actions
      // and programs included (it is no longer among the specs).
      this.#entries.delete(problem.name);
    }

    const toLoad = discovery.specs.filter((spec) => !name || spec.name === name);
    if (toLoad.length === 0) return this.status();
    if (!this.#host) this.#spawn();

    const waits: Promise<void>[] = [];
    for (const spec of toLoad) {
      // Loading again replaces the plugin's code: what the old code started goes.
      if (this.#entries.has(spec.name)) this.#stopPrograms(spec.name);
      this.#entries.set(spec.name, {
        spec,
        name: spec.name,
        kind: spec.kind,
        state: "loading",
        trips: [],
      });
      waits.push(this.#waitLoaded(spec.name));
      this.#send({ type: "load", plugin: spec });
    }
    const budget = this.#options.limits.callbackBudgetMs + this.#options.helloTimeoutMs;
    await Promise.race([
      Promise.all(waits),
      new Promise((resolve) => setTimeout(resolve, budget).unref()),
    ]);
    return this.status();
  }

  status(): PluginSupervisorStatus {
    const secrets = this.#secretSet();
    const plugins: PluginStatus[] = [...this.#entries.values()].map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      state: entry.state,
      ...(entry.error ? { error: entry.error } : {}),
      ...(entry.memoryBytes !== undefined ? { memoryBytes: entry.memoryBytes } : {}),
      trips: entry.trips.length,
    }));
    for (const problem of this.#problems) {
      plugins.push({
        name: problem.name,
        kind: "plugin",
        state: "invalid",
        error: problem.error,
        trips: 0,
      });
    }
    for (const pending of this.#awaitingConsent) {
      plugins.push({
        name: pending.name,
        kind: "plugin",
        state: "needs-consent",
        error:
          pending.reason === "new"
            ? `not consented to yet; run \`tmux-ide plugin consent ${pending.name}\``
            : `changed since it was consented to; run \`tmux-ide plugin consent ${pending.name}\` again`,
        trips: 0,
      });
    }
    plugins.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "init" ? 1 : -1,
    );
    return {
      host: {
        running: this.#host !== null,
        pid: this.#host?.child.pid ?? null,
        restarts: this.#restarts,
      },
      // Every error here can quote plugin output (a load error, a manifest
      // parse error): redact all of them on the way out.
      plugins: plugins.map((plugin) =>
        plugin.error ? { ...plugin, error: redactText(plugin.error, secrets) } : plugin,
      ),
    };
  }

  /** Run Lua source once in a fresh, temporary state. */
  async run(
    code: string,
    options: { chunkName?: string; budgetMs?: number } = {},
  ): Promise<LuaRunResult> {
    if (this.#stopped) return { ok: false, error: "E_UNAVAILABLE: plugins are stopped", logs: [] };
    if (!this.#host) this.#spawn();
    const id = randomUUID();
    const budgetMs = options.budgetMs ?? 5000;
    return new Promise<LuaRunResult>((resolve) => {
      const timer = setTimeout(
        () => {
          this.#runs.delete(id);
          resolve({ ok: false, error: "E_TIMEOUT: the host did not answer", logs: [] });
        },
        Math.max(this.#options.limits.wallClockMs, budgetMs * 2) +
          this.#options.heartbeatTimeoutMs +
          this.#options.helloTimeoutMs,
      );
      timer.unref();
      this.#runs.set(id, (result) => {
        clearTimeout(timer);
        this.#runs.delete(id);
        resolve(result);
      });
      this.#send({
        type: "run",
        id,
        code,
        chunkName: options.chunkName ?? "=run",
        budgetMs,
      });
    });
  }

  /** Every action plugins registered, as command catalog entries. */
  actionCatalog(): { revision: number; entries: CommandCatalogEntry[] } {
    return { revision: this.#actions.revision, entries: this.#actions.entries() };
  }

  /**
   * Invoke a plugin action by catalog id. A dangerous action runs only with
   * `confirmed`, which the caller sets after the person confirmed it.
   */
  async invokeAction(
    id: string,
    args: Record<string, string | number | boolean>,
    context: CommandInvocationContext,
    options: { confirmed?: boolean } = {},
  ): Promise<CommandInvokeResult> {
    const entry = this.#actions.find(id);
    const parsed = parsePluginCommandId(id);
    if (!entry || !parsed)
      return { ok: false, error: `E_NOT_FOUND: no command '${terminalSafe(id, 200)}'` };
    if (entry.descriptor.dangerous && options.confirmed !== true)
      return { ok: false, error: `E_CONFIRM: '${entry.descriptor.label}' must be confirmed first` };
    let origin = "";
    const reply = await this.#request((requestId) => ({
      type: "invoke",
      id: (origin = requestId),
      plugin: parsed.plugin,
      action: parsed.action,
      args,
      context,
    }));
    const secrets = this.#secretSet();
    if (!reply.ok) {
      // A failed callback leaves nothing running behind it; programs other
      // callbacks (timers, other requests) started keep running.
      this.#stopPrograms(parsed.plugin, origin);
      // Results and errors are plugin text on their way to terminals: plain
      // text only, whatever the plugin returned.
      return { ok: false, error: terminalSafe(redactText(reply.error, secrets)) };
    }
    let value: unknown;
    try {
      const list: unknown = JSON.parse(reply.text);
      value = Array.isArray(list) ? list[0] : undefined;
    } catch {
      value = undefined;
    }
    return value === undefined
      ? { ok: true }
      : { ok: true, value: terminalSafeDeep(redactLogValue(value, secrets)) as never };
  }

  /** Choices and default for one parameter of a plugin action. */
  async actionParamOptions(
    id: string,
    param: string,
    context: CommandInvocationContext,
  ): Promise<CommandParamOptionsResult> {
    const entry = this.#actions.find(id);
    const parsed = parsePluginCommandId(id);
    if (!entry || !parsed)
      return { ok: false, error: `E_NOT_FOUND: no command '${terminalSafe(id, 200)}'` };
    if (!entry.params.some((candidate) => candidate.name === param))
      return {
        ok: false,
        error: `E_NOT_FOUND: '${id}' has no parameter '${terminalSafe(param, 200)}'`,
      };
    let origin = "";
    const reply = await this.#request((requestId) => ({
      type: "param-options",
      id: (origin = requestId),
      plugin: parsed.plugin,
      action: parsed.action,
      param,
      context,
    }));
    const secrets = this.#secretSet();
    if (!reply.ok) {
      this.#stopPrograms(parsed.plugin, origin);
      return { ok: false, error: terminalSafe(redactText(reply.error, secrets)) };
    }
    const result = ParamOptionsReplySchemaZ.safeParse(
      terminalSafeDeep(redactLogValue(safeJson(reply.text), secrets)),
    );
    if (!result.success)
      return { ok: false, error: "E_INVALID: the plugin returned malformed choices" };
    return {
      ok: true,
      ...(result.data.choices ? { choices: result.data.choices } : {}),
      ...(result.data.default !== undefined ? { default: result.data.default } : {}),
    };
  }

  #request(build: (requestId: string) => HostCommand): Promise<HostReply> {
    if (this.#stopped)
      return Promise.resolve({ ok: false, error: "E_UNAVAILABLE: plugins are stopped" });
    if (!this.#host)
      return Promise.resolve({ ok: false, error: "E_UNAVAILABLE: the plugin host is not running" });
    const requestId = randomUUID();
    return new Promise<HostReply>((resolve) => {
      const timer = setTimeout(
        () => {
          this.#requests.delete(requestId);
          resolve({ ok: false, error: "E_TIMEOUT: the plugin did not answer" });
        },
        this.#options.limits.wallClockMs + this.#options.heartbeatTimeoutMs + 1000,
      );
      timer.unref();
      this.#requests.set(requestId, (reply) => {
        clearTimeout(timer);
        this.#requests.delete(requestId);
        resolve(reply);
      });
      this.#send(build(requestId));
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#stopWatchdog();
    const host = this.#host;
    this.#host = null;
    this.#failRuns("E_UNAVAILABLE: plugins stopped");
    if (!host) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        host.child.kill("SIGKILL");
        resolve();
      }, 2000);
      timer.unref();
      host.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        (host.child.stdin as Writable).end(`${JSON.stringify({ type: "shutdown" })}\n`);
      } catch {
        host.child.kill("SIGKILL");
      }
    });
  }

  // ---------------------------------------------------------------- internals

  #log(
    plugin: string,
    level: PluginLogEntry["level"],
    message: string,
    fields?: Record<string, unknown>,
  ) {
    const secrets = this.#secretSet();
    this.#options.onLog({
      ts: new Date(this.#options.now()).toISOString(),
      plugin,
      level,
      message: redactText(message, secrets),
      ...(fields ? { fields: redactLogValue(fields, secrets) as Record<string, unknown> } : {}),
    });
  }

  #secretSet(): ReadonlySet<string> {
    return new Set([...this.#options.secrets()].filter((secret) => secret.length >= 8));
  }

  #waitLoaded(name: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.#loadWaiters.get(name) ?? [];
      list.push(resolve);
      this.#loadWaiters.set(name, list);
    });
  }

  #settleLoad(name: string): void {
    const list = this.#loadWaiters.get(name);
    this.#loadWaiters.delete(name);
    for (const resolve of list ?? []) resolve();
  }

  #send(command: HostCommand): void {
    const host = this.#host;
    if (!host) return;
    if (!host.ready && command.type !== "configure") {
      host.outbox.push(command);
      return;
    }
    try {
      (host.child.stdin as Writable).write(`${JSON.stringify(command)}\n`);
    } catch {
      // The exit handler restarts the host and resends loads.
    }
  }

  #spawn(): void {
    const [command, ...args] = this.#options.hostCommand;
    if (!command) throw new Error("plugin host command is empty");
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: this.#options.hostEnv,
    });
    const host: HostHandle = {
      child,
      ready: false,
      lastHeartbeat: this.#options.now(),
      busy: null,
      outbox: [],
      killedBy: null,
      healthyTimer: null,
    };
    this.#host = host;

    const events = child.stdio[3] as Readable;
    const lines = createInterface({ input: events, crlfDelay: Infinity });
    lines.on("line", (line) => this.#onEventLine(host, line));
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      const out = createInterface({ input: stream, crlfDelay: Infinity });
      out.on("line", (line) => {
        if (line.trim()) this.#log("host", "warn", line.slice(0, 2000));
      });
    }
    child.on("error", (error) =>
      this.#log("host", "error", `plugin host failed: ${error.message}`),
    );
    child.on("exit", (code, signal) => this.#onExit(host, code, signal));

    const helloTimer = setTimeout(() => {
      if (this.#host === host && !host.ready) {
        host.killedBy = "the plugin host did not start in time";
        child.kill("SIGKILL");
      }
    }, this.#options.helloTimeoutMs);
    helloTimer.unref();
    child.once("exit", () => clearTimeout(helloTimer));
    this.#startWatchdog();
  }

  #onEventLine(host: HostHandle, line: string): void {
    if (this.#host !== host || line.length > MAX_PROTOCOL_LINE_BYTES) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = HostEventSchemaZ.safeParse(raw);
    if (!parsed.success) return;
    // Host lines carry plugin output: nothing in handling one may throw out
    // of the stream handler and take the daemon down.
    try {
      this.#onEvent(host, parsed.data);
    } catch (error) {
      this.#log("host", "error", `ignored a host event that failed: ${(error as Error).message}`);
    }
  }

  #onEvent(host: HostHandle, event: HostEvent): void {
    switch (event.type) {
      case "hello": {
        if (event.protocolVersion !== PLUGIN_HOST_PROTOCOL_VERSION) return;
        host.ready = true;
        // A host that stays up for a while has recovered: the next crash
        // starts the backoff from the beginning again.
        host.healthyTimer = setTimeout(() => {
          if (this.#host === host) this.#backoffAttempt = 0;
        }, this.#options.healthyAfterMs);
        host.healthyTimer.unref();
        host.lastHeartbeat = this.#options.now();
        this.#send({
          type: "configure",
          protocolVersion: PLUGIN_HOST_PROTOCOL_VERSION,
          productVersion: this.#options.productVersion,
          limits: this.#options.limits,
        });
        const queued = host.outbox.splice(0);
        for (const command of queued) this.#send(command);
        return;
      }
      case "heartbeat":
        host.lastHeartbeat = this.#options.now();
        return;
      case "busy":
        host.busy = event.plugin;
        return;
      case "idle":
        if (host.busy === event.plugin) host.busy = null;
        host.lastHeartbeat = this.#options.now();
        return;
      case "log":
        this.#log(event.plugin, event.level, event.message, event.fields);
        return;
      case "loaded": {
        const entry = this.#entries.get(event.plugin);
        if (entry && entry.state !== "disabled") {
          entry.state = event.ok ? "loaded" : "failed";
          // Raw here; status() is the one place entries leave the
          // supervisor, and it redacts every error on the way out.
          entry.error = event.ok ? undefined : event.error;
          entry.memoryBytes = event.memoryBytes;
        }
        // A plugin that failed to load keeps nothing running either: not the
        // programs its top-level code or its timers started.
        if (!event.ok) this.#stopPrograms(event.plugin);
        this.#settleLoad(event.plugin);
        return;
      }
      case "trip":
        this.#onTrip(event.plugin, event.kind);
        return;
      case "actions": {
        const entry = this.#entries.get(event.plugin);
        if (!entry?.spec || entry.state === "disabled") return;
        const problem = this.#actions.publish(event.plugin, event.actions);
        if (problem) this.#log(event.plugin, "warn", `ignored its action list: ${problem}`);
        return;
      }
      case "call":
        void this.#onCall(event);
        return;
      case "invoke-result":
        this.#requests.get(event.id)?.(
          event.ok
            ? { ok: true, text: event.value ?? "[]" }
            : { ok: false, error: event.error ?? "failed" },
        );
        return;
      case "param-options-result":
        this.#requests.get(event.id)?.(
          event.ok
            ? { ok: true, text: event.options ?? "{}" }
            : { ok: false, error: event.error ?? "failed" },
        );
        return;
      case "run-result": {
        const resolve = this.#runs.get(event.id);
        if (!resolve) return;
        let values: unknown[] | undefined;
        if (event.values !== undefined) {
          try {
            const parsed: unknown = JSON.parse(event.values);
            values = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            values = [];
          }
        }
        if (!event.ok) this.#stopPrograms(RUN_STATE_NAME);
        const secrets = this.#secretSet();
        resolve({
          ok: event.ok,
          ...(values ? { values: values.map((value) => redactLogValue(value, secrets)) } : {}),
          ...(event.error ? { error: redactText(event.error, secrets) } : {}),
          logs: event.logs.map((log) => ({ ...log, message: redactText(log.message, secrets) })),
        });
        return;
      }
    }
  }

  async #onCall(event: Extract<HostEvent, { type: "call" }>): Promise<void> {
    const reply = (result: { ok: true; value: unknown } | { ok: false; error: string }) => {
      const secrets = this.#secretSet();
      this.#send(
        result.ok
          ? {
              type: "call-result",
              id: event.id,
              ok: true,
              ...(result.value === undefined
                ? {}
                : { value: JSON.stringify(redactLogValue(result.value, secrets)) }),
            }
          : {
              type: "call-result",
              id: event.id,
              ok: false,
              error: redactText(result.error, secrets),
            },
      );
    };
    const entry = this.#entries.get(event.plugin);
    const capabilities =
      ownerCapabilities(event.plugin) ??
      (entry?.spec && entry.state !== "disabled" ? entry.spec.capabilities : null);
    if (!capabilities || !this.#options.calls) {
      reply({ ok: false, error: `E_UNAVAILABLE: ${event.method.slice(1)} is not available` });
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(event.args);
    } catch {
      args = null;
    }
    if (!Array.isArray(args)) {
      reply({ ok: false, error: "E_INVALID: malformed host call" });
      return;
    }
    // Whether the plugin that made this call may still act: a disable,
    // unload, reload or revoke that lands while the call awaits (say, a tmux
    // lookup before a program starts) stops it from starting anything.
    const host = this.#host;
    const active = () =>
      !this.#stopped &&
      this.#host === host &&
      (event.plugin === RUN_STATE_NAME ||
        (this.#entries.get(event.plugin) === entry &&
          entry !== undefined &&
          entry.state !== "disabled" &&
          entry.state !== "failed"));
    try {
      const value = await this.#options.calls.handle(
        {
          plugin: event.plugin,
          capabilities,
          active,
          ...(event.origin ? { origin: event.origin } : {}),
        },
        event.method,
        args,
      );
      reply({ ok: true, value });
    } catch (error) {
      reply({ ok: false, error: (error as Error).message });
    }
  }

  #onTrip(plugin: string, kind: PluginTripKind): void {
    // The callback that tripped failed; its programs go with it.
    this.#stopPrograms(plugin);
    const entry = this.#entries.get(plugin);
    if (!entry) return;
    const now = this.#options.now();
    entry.trips = entry.trips.filter((at) => now - at < this.#options.tripWindowMs);
    entry.trips.push(now);
    const label =
      kind === "timeout"
        ? "ran past its time budget"
        : kind === "memory"
          ? "ran out of memory"
          : "crashed the Lua runtime";
    this.#log(plugin, "warn", `${label} (${entry.trips.length}/${this.#options.tripLimit})`);
    if (kind === "abort" || entry.trips.length >= this.#options.tripLimit) {
      this.#disable(
        entry,
        kind === "abort"
          ? "the Lua runtime crashed"
          : `${label} ${entry.trips.length} times within ${Math.round(this.#options.tripWindowMs / 1000)} s`,
      );
    }
  }

  #disable(entry: Entry, reason: string): void {
    entry.state = "disabled";
    entry.error = `disabled: ${reason}; run \`tmux-ide plugin reload ${entry.name}\` to try again`;
    this.#log(entry.name, "error", entry.error);
    this.#send({ type: "unload", name: entry.name });
    this.#actions.drop(entry.name);
    // Its programs are already gone: a disable follows a trip (which stops
    // them) or a watchdog kill of the host (which stops every program).
    this.#settleLoad(entry.name);
  }

  /**
   * Kill the programs `plugin` (or, with no name, every plugin) still runs;
   * with `origin`, only those started for that request.
   */
  #stopPrograms(plugin?: string, origin?: string): void {
    const killed = this.#options.calls?.stopPrograms(plugin, origin) ?? 0;
    if (killed > 0)
      this.#log(
        plugin ?? "host",
        "info",
        `stopped ${killed} program${killed === 1 ? "" : "s"} it started`,
      );
  }

  #startWatchdog(): void {
    if (this.#watchdog) return;
    this.#watchdog = setInterval(() => {
      const host = this.#host;
      if (!host || !host.ready || host.killedBy) return;
      const silentFor = this.#options.now() - host.lastHeartbeat;
      if (silentFor <= this.#options.heartbeatTimeoutMs) return;
      const culprit = host.busy;
      host.killedBy = culprit
        ? `${culprit} kept the plugin host busy for more than ${Math.round(this.#options.heartbeatTimeoutMs / 1000)} s`
        : "the plugin host stopped responding";
      this.#log("host", "error", `watchdog: ${host.killedBy}; restarting the host`);
      const entry = culprit ? this.#entries.get(culprit) : undefined;
      if (culprit === RUN_STATE_NAME) {
        // A one-off `lua run` was busy: its own result already fails; no
        // plugin is to blame, so none is charged.
      } else if (entry) {
        this.#disable(
          entry,
          "the watchdog stopped it: it did not return control for more than 5 s",
        );
      } else {
        // No Lua slice was running, so no busy marker names a culprit. Charge
        // what the host was doing for us: the plugin it was loading (loads run
        // one at a time, in send order). Repeated kills then end in a disable
        // instead of a restart loop.
        const loading = [...this.#entries.values()].find(
          (candidate) => candidate.state === "loading",
        );
        if (loading) this.#onTrip(loading.name, "timeout");
      }
      host.child.kill("SIGKILL");
    }, this.#options.watchdogIntervalMs);
    this.#watchdog.unref();
  }

  #stopWatchdog(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;
  }

  #failRuns(error: string): void {
    for (const resolve of [...this.#runs.values()]) resolve({ ok: false, error, logs: [] });
    this.#runs.clear();
    for (const resolve of [...this.#requests.values()]) resolve({ ok: false, error });
    this.#requests.clear();
    // Plugins publish their actions again when the host loads them.
    this.#actions.clear();
    // No callback survives the host, so neither do the programs they started.
    this.#stopPrograms();
  }

  #onExit(host: HostHandle, code: number | null, signal: NodeJS.Signals | null): void {
    if (host.healthyTimer) clearTimeout(host.healthyTimer);
    if (this.#host !== host) return;
    this.#host = null;
    this.#stopWatchdog();
    this.#failRuns(
      `E_UNAVAILABLE: the plugin host exited (${host.killedBy ?? signal ?? `code ${code}`})`,
    );
    for (const name of [...this.#loadWaiters.keys()]) this.#settleLoad(name);
    if (this.#stopped) return;

    const pending = [...this.#entries.values()].filter(
      (entry) => entry.spec && entry.state !== "disabled",
    );
    if (pending.length === 0) return;
    if (!host.killedBy)
      this.#log("host", "error", `plugin host exited (${signal ?? `code ${code}`}); restarting`);
    for (const entry of pending) entry.state = "loading";
    const delay = this.#options.restartDelayMs(this.#backoffAttempt);
    this.#backoffAttempt += 1;
    this.#restarts += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (this.#stopped || this.#host) return;
      const again = [...this.#entries.values()].filter(
        (entry) => entry.spec && entry.state === "loading",
      );
      if (again.length === 0) return;
      this.#spawn();
      for (const entry of again) this.#send({ type: "load", plugin: entry.spec! });
    }, delay);
    this.#restartTimer.unref();
  }
}
