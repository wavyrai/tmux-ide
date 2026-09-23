import { z } from "zod";

/**
 * Version of the daemon wire contract spoken by canonical daemon discovery,
 * health responses, REST resources, and WebSocket transports. This is
 * intentionally independent from npm/package marketing versions.
 */
// v3 requires link-aware terminal topology and actions; v2 peers must upgrade.
export const DAEMON_WIRE_PROTOCOL_VERSION = 3 as const;

/**
 * Discovery must retain unknown positive versions so a client can report an
 * incompatible live owner instead of mistaking its daemon file for corrupt or
 * absent. Compatibility is intentionally checked separately.
 */
export const DaemonWireProtocolVersionSchema = z.number().int().positive();

export function isDaemonWireProtocolCompatible(protocolVersion: number): boolean {
  return protocolVersion === DAEMON_WIRE_PROTOCOL_VERSION;
}

/**
 * Random per-process identity. This is deliberately a nonce rather than a
 * durable machine or installation identifier: clients compare daemon.json to
 * the unauthenticated identity probe before sending credentials.
 */
export const DaemonInstanceIdSchema = z.uuid();

/**
 * Stable environment identity: minted once per daemon state home and
 * preserved across restarts, unlike the per-process instance nonce. Clients
 * keep their own catalog of access endpoints keyed by this id. It is carried
 * additively (optional everywhere) and plays no part in generation checks —
 * instanceId/startedAt keep sole authority over those.
 */
export const EnvironmentIdSchema = z.uuid();

/**
 * Browser-safe identity stamped onto authenticated REST resources and the
 * unified event socket hello. Clients compare every field with the canonical
 * descriptor supplied by their desktop host before trusting payloads.
 */
export const DaemonInstanceIdentitySchemaZ = z
  .object({
    protocolVersion: DaemonWireProtocolVersionSchema,
    productVersion: z.string().trim().min(1),
    instanceId: DaemonInstanceIdSchema,
    startedAt: z.iso.datetime({ offset: true }),
    environmentId: EnvironmentIdSchema.optional(),
  })
  .strict();
export type DaemonInstanceIdentity = z.infer<typeof DaemonInstanceIdentitySchemaZ>;

/** Explicit private namespace binding; not an OS service identity assertion. */
export const DaemonSupervisionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const CanonicalDaemonReservationSchema = z
  .object({
    kind: z.literal("supervised-reservation"),
    version: z.literal(1),
    supervisionId: DaemonSupervisionIdSchema,
    reservationId: z.uuid(),
    reservedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CanonicalDaemonReservation = z.infer<typeof CanonicalDaemonReservationSchema>;

/**
 * Where a daemon's stdout/stderr actually go, captured by the running process
 * at startup. `dev`/`ino` identify a regular file even when its path could not
 * be resolved, so a provenance report can match on-disk log files against the
 * live destination instead of guessing from file names.
 */
export const DaemonLogStreamSchema = z.object({
  kind: z.enum(["file", "tty", "pipe", "socket", "null", "unknown"]),
  path: z.string().min(1).max(4096).optional(),
  dev: z.number().int().nonnegative().optional(),
  ino: z.number().int().nonnegative().optional(),
  detail: z.string().max(256).optional(),
});
export type DaemonLogStream = z.infer<typeof DaemonLogStreamSchema>;

export const DaemonSupervisorKindSchema = z.enum(["manual", "launchd", "systemd", "embedded"]);
export type DaemonSupervisorKind = z.infer<typeof DaemonSupervisorKindSchema>;

/** Startup provenance stamped into the daemon record; never carries credentials. */
export const DaemonProvenanceSchema = z.object({
  launcher: z.enum(["headless", "embedded"]),
  supervisor: DaemonSupervisorKindSchema,
  parentPid: z.number().int().nonnegative(),
  stdout: DaemonLogStreamSchema,
  stderr: DaemonLogStreamSchema,
  warnings: z.array(z.string().max(256)).max(8).optional(),
});
export type DaemonProvenance = z.infer<typeof DaemonProvenanceSchema>;

export const TmuxServerProofSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["live", "unbound-name"]),
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const CanonicalDaemonInfoSchema = z.object({
  tmuxServerProofVersion: z.literal(1).optional(),
  supervisionId: DaemonSupervisionIdSchema.optional(),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  protocolVersion: DaemonWireProtocolVersionSchema,
  productVersion: z.string().trim().min(1),
  instanceId: DaemonInstanceIdSchema,
  startedAt: z.iso.datetime({ offset: true }),
  environmentId: EnvironmentIdSchema.optional(),
  bindHostname: z.string().trim().min(1),
  authToken: z.string().min(1).nullable(),
  provenance: DaemonProvenanceSchema.optional(),
});
export type CanonicalDaemonInfo = z.infer<typeof CanonicalDaemonInfoSchema>;

export const DaemonHealthSchema = z.object({
  ok: z.literal(true),
  protocolVersion: DaemonWireProtocolVersionSchema,
  productVersion: z.string().trim().min(1),
  uptime: z.number().nonnegative(),
});
export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

export const DaemonHealthzSchema = z.object({
  ok: z.literal(true),
  protocolVersion: DaemonWireProtocolVersionSchema,
  productVersion: z.string().trim().min(1),
  uptimeMs: z.number().nonnegative(),
});
export type DaemonHealthz = z.infer<typeof DaemonHealthzSchema>;

/**
 * Credential-free endpoint identity. It intentionally contains no auth token
 * or local bypass token; possession only proves that the endpoint reached by a
 * daemon.json record is the process instance which published that record.
 */
export const DaemonIdentitySchema = z.object({
  tmuxServerProof: TmuxServerProofSchema.nullable().optional(),
  ok: z.literal(true),
  pid: z.number().int().positive(),
  protocolVersion: DaemonWireProtocolVersionSchema,
  productVersion: z.string().trim().min(1),
  instanceId: DaemonInstanceIdSchema,
  startedAt: z.iso.datetime({ offset: true }),
  environmentId: EnvironmentIdSchema.optional(),
});
export type DaemonIdentity = z.infer<typeof DaemonIdentitySchema>;
