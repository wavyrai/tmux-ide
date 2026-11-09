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
    /** Log lines a plugin may emit per second before lines are dropped. */
    logLinesPerSecond: z.number().int().min(1).max(10_000),
  })
  .strict();
export type PluginLimits = z.infer<typeof PluginLimitsSchemaZ>;

export const DEFAULT_PLUGIN_LIMITS: PluginLimits = Object.freeze({
  callbackBudgetMs: 250,
  memoryBytes: 64 * 1024 * 1024,
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
  })
  .strict();
export type PluginSpec = z.infer<typeof PluginSpecSchemaZ>;

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
