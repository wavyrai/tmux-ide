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

export const CanonicalDaemonInfoSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65_535),
  protocolVersion: DaemonWireProtocolVersionSchema,
  version: z.string().trim().min(1),
  startedAt: z.iso.datetime({ offset: true }),
  bindHostname: z.string().trim().min(1),
  authToken: z.string().min(1).nullable(),
});
export type CanonicalDaemonInfo = z.infer<typeof CanonicalDaemonInfoSchema>;

export const DaemonHealthSchema = z.object({
  ok: z.literal(true),
  protocolVersion: DaemonWireProtocolVersionSchema,
  version: z.string().trim().min(1),
  uptime: z.number().nonnegative(),
});
export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

export const DaemonHealthzSchema = z.object({
  ok: z.literal(true),
  protocolVersion: DaemonWireProtocolVersionSchema,
  version: z.string().trim().min(1),
  uptimeMs: z.number().nonnegative(),
});
export type DaemonHealthz = z.infer<typeof DaemonHealthzSchema>;
