/**
 * The daemon ↔ plugin host wire.
 *
 * The daemon writes newline-delimited JSON to the host's stdin. The host
 * writes newline-delimited JSON to file descriptor 3 with synchronous writes,
 * so a "busy" marker is on the wire before a Lua slice starts: if that slice
 * never returns, the daemon still knows which plugin to blame. Stdout and
 * stderr stay free for anything the runtime prints on its own.
 */
import { z } from "zod";

/** Version of the Lua API exposed as `ide.api`. Minor versions only add. */
export const PLUGIN_API_VERSION = "1.0" as const;

/** Bumped when the daemon/host messages change shape. */
export const PLUGIN_HOST_PROTOCOL_VERSION = 1 as const;

export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
export const PluginNameSchemaZ = z.string().regex(PLUGIN_NAME_PATTERN);

/** The user's `init.lua` runs as this reserved plugin name. */
export const INIT_PLUGIN_NAME = "init" as const;

/**
 * Names the host and daemon use for their own work. No plugin directory may
 * take one: `run` labels `tmux-ide lua run`, `host` the host's own log lines.
 */
/** The name the host gives the temporary state behind `tmux-ide lua run`. */
export const RUN_STATE_NAME = "run" as const;

export const RESERVED_PLUGIN_NAMES: ReadonlySet<string> = new Set([
  INIT_PLUGIN_NAME,
  RUN_STATE_NAME,
  "host",
  "daemon",
  "ide",
  "plugin",
  "plugins",
  "tmux-ide",
]);

export const PluginLimitsSchemaZ = z
  .object({
    /** Lua run time allowed per callback, excluding time spent awaiting the host. */
    callbackBudgetMs: z.number().int().min(10).max(600_000),
    /** Bytes a plugin's Lua state may allocate. */
    memoryBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(1024 * 1024 * 1024),
    /**
     * Wall-clock limit for one load or callback, including time spent waiting
     * for the host. Stops a host call that never settles.
     */
    wallClockMs: z.number().int().min(100).max(3_600_000),
    /** Log lines a plugin may emit per second before lines are dropped. */
    logLinesPerSecond: z.number().int().min(1).max(10_000),
  })
  .strict();
export type PluginLimits = z.infer<typeof PluginLimitsSchemaZ>;

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = Object.freeze({
  callbackBudgetMs: 250,
  memoryBytes: 64 * 1024 * 1024,
  wallClockMs: 30_000,
  logLinesPerSecond: 100,
});

export const PluginSpecSchemaZ = z
  .object({
    name: z.union([PluginNameSchemaZ, z.literal(INIT_PLUGIN_NAME)]),
    kind: z.enum(["init", "plugin"]),
    /** Consented content hash; the host re-hashes the directory and refuses a mismatch. */
    contentHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    /** Absolute path of the entry file. */
    entry: z.string().min(1),
    /** Absolute directories `ide.include` may read from, in search order. */
    includeRoots: z.array(z.string().min(1)).max(8),
    /** Absolute directories `require` may read from, in search order. */
    moduleRoots: z.array(z.string().min(1)).max(8),
    settings: z.record(z.string(), z.json()),
    /** What the owner consented to; init.lua gets everything. */
    capabilities: z
      .object({
        exec: z.union([z.array(z.string()).max(32), z.literal("any")]),
        shell: z.boolean(),
        /** `panes.send`: type into panes and run programs as if typed there. */
        panes: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PluginSpec = z.infer<typeof PluginSpecSchemaZ>;

/**
 * Host functions the daemon serves for plugins (host-calls.ts). Each is
 * exposed to the preludes as `__ide_internal.host[name]`, never directly to
 * plugin code.
 */
export const HOST_CALL_METHODS = Object.freeze([
  "_exec",
  "_panes",
  "_pane_read",
  "_pane_send",
  "_action",
  "_notify",
  "_store_get",
  "_store_set",
  "_store_keys",
] as const);

// ---------------------------------------------------------------- daemon → host

export const HostCommandSchemaZ = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("configure"),
      protocolVersion: z.literal(PLUGIN_HOST_PROTOCOL_VERSION),
      productVersion: z.string(),
      limits: PluginLimitsSchemaZ,
    })
    .strict(),
  z.object({ type: z.literal("load"), plugin: PluginSpecSchemaZ }).strict(),
  z.object({ type: z.literal("unload"), name: z.string() }).strict(),
  z
    .object({
      type: z.literal("run"),
      id: z.string().min(1).max(64),
      code: z.string().max(1024 * 1024),
      chunkName: z.string().min(1).max(200),
      budgetMs: z.number().int().min(10).max(600_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("invoke"),
      id: z.string().min(1).max(64),
      plugin: z.string().min(1).max(64),
      action: z.string().min(1).max(100),
      args: z.record(z.string(), z.json()),
      context: z.record(z.string(), z.json()),
    })
    .strict(),
  z
    .object({
      type: z.literal("param-options"),
      id: z.string().min(1).max(64),
      plugin: z.string().min(1).max(64),
      action: z.string().min(1).max(100),
      param: z.string().min(1).max(64),
      context: z.record(z.string(), z.json()),
    })
    .strict(),
  z
    .object({
      type: z.literal("call-result"),
      id: z.string().min(1).max(64),
      ok: z.boolean(),
      /** JSON text of the result. */
      value: z
        .string()
        .max(8 * 1024 * 1024)
        .optional(),
      error: z
        .string()
        .max(16 * 1024)
        .optional(),
    })
    .strict(),
  z.object({ type: z.literal("shutdown") }).strict(),
]);
export type HostCommand = z.infer<typeof HostCommandSchemaZ>;

// ---------------------------------------------------------------- host → daemon

export const LogLevelSchemaZ = z.enum(["debug", "info", "warn", "error"]);
export type PluginLogLevel = z.infer<typeof LogLevelSchemaZ>;

export const TripKindSchemaZ = z.enum(["timeout", "memory", "abort"]);
export type PluginTripKind = z.infer<typeof TripKindSchemaZ>;

export const HostEventSchemaZ = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      protocolVersion: z.literal(PLUGIN_HOST_PROTOCOL_VERSION),
      pid: z.number().int(),
    })
    .strict(),
  z.object({ type: z.literal("heartbeat"), seq: z.number().int() }).strict(),
  /** A Lua slice for `plugin` is about to run synchronously. */
  z.object({ type: z.literal("busy"), plugin: z.string() }).strict(),
  z.object({ type: z.literal("idle"), plugin: z.string() }).strict(),
  z
    .object({
      type: z.literal("log"),
      plugin: z.string(),
      level: LogLevelSchemaZ,
      message: z.string(),
      fields: z.record(z.string(), z.json()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("loaded"),
      plugin: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      memoryBytes: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ type: z.literal("trip"), plugin: z.string(), kind: TripKindSchemaZ }).strict(),
  z
    .object({
      type: z.literal("call"),
      id: z.string().min(1).max(64),
      plugin: z.string().min(1).max(64),
      method: z.string().min(1).max(64),
      /** JSON text of the argument list. */
      args: z.string().max(4 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("actions"),
      plugin: z.string(),
      /** JSON text of the plugin's plain action descriptors. */
      actions: z.string().max(4 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      type: z.literal("invoke-result"),
      id: z.string(),
      ok: z.boolean(),
      /** JSON text: an array whose first element is the action's result. */
      value: z.string().optional(),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("param-options-result"),
      id: z.string(),
      ok: z.boolean(),
      /** JSON text `{ choices?, default? }`. */
      options: z.string().optional(),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("run-result"),
      id: z.string(),
      ok: z.boolean(),
      /** JSON text of the returned values, as an array. */
      values: z.string().optional(),
      error: z.string().optional(),
      logs: z.array(z.object({ level: LogLevelSchemaZ, message: z.string() }).strict()),
    })
    .strict(),
]);
export type HostEvent = z.infer<typeof HostEventSchemaZ>;

/** Longest single protocol line either side accepts. */
export const MAX_PROTOCOL_LINE_BYTES = 4 * 1024 * 1024;
