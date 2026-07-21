import { z } from "zod";

/**
 * Version of the daemon wire contract spoken by canonical daemon discovery,
 * health responses, REST resources, and WebSocket transports. This is
 * intentionally independent from npm/package marketing versions.
 */
export const DAEMON_WIRE_PROTOCOL_VERSION = 1 as const;

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
  })
  .strict();
export type DaemonInstanceIdentity = z.infer<typeof DaemonInstanceIdentitySchemaZ>;

export const CanonicalDaemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  protocolVersion: DaemonWireProtocolVersionSchema,
  productVersion: z.string().trim().min(1),
  instanceId: DaemonInstanceIdSchema,
  startedAt: z.iso.datetime({ offset: true }),
  bindHostname: z.string().trim().min(1),
  authToken: z.string().min(1).nullable(),
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
  ok: z.literal(true),
  pid: z.number().int().positive(),
  protocolVersion: DaemonWireProtocolVersionSchema,
  productVersion: z.string().trim().min(1),
  instanceId: DaemonInstanceIdSchema,
  startedAt: z.iso.datetime({ offset: true }),
});
export type DaemonIdentity = z.infer<typeof DaemonIdentitySchema>;
