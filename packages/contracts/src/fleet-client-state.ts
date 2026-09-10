import { z } from "zod";
import { SavedMachineIdSchema } from "./saved-machines.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

const key = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const label = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
export const FleetCacheRouteIdSchema = z.union([z.literal("local"), SavedMachineIdSchema]);
export const FleetCachedSessionSchema = z.strictObject({
  id: key,
  liveSessionId: key.optional(),
  name: label,
  paneCount: z.number().int().min(0).max(4096),
});
export const FleetCachedRouteSchema = z.strictObject({
  routeId: FleetCacheRouteIdSchema,
  environmentId: z.uuid().nullable(),
  generation: key.nullable(),
  seenAt: z.number().int().nonnegative(),
  sessions: z.array(FleetCachedSessionSchema).max(64),
});
export const FleetClientStateSchema = z.strictObject({
  version: z.literal(1),
  favorites: z.array(key).max(128),
  collapsed: z.array(key).max(64),
  recent: z.array(key).max(64),
  catalog: z.array(FleetCachedRouteSchema).max(64),
});
export type FleetClientState = z.infer<typeof FleetClientStateSchema>;
export type FleetCachedRoute = z.infer<typeof FleetCachedRouteSchema>;
export const FleetClientStateChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("cache"), route: FleetCachedRouteSchema }),
  z.strictObject({ type: z.literal("favorite"), key, enabled: z.boolean() }),
  z.strictObject({ type: z.literal("collapse"), key, enabled: z.boolean() }),
  z.strictObject({ type: z.literal("visit"), key }),
  z.strictObject({ type: z.literal("forget-route"), routeId: FleetCacheRouteIdSchema }),
]);
export type FleetClientStateChange = z.infer<typeof FleetClientStateChangeSchema>;
export const FleetClientStateRequestSchema = z.strictObject({
  expectedInstanceId: z.uuid(),
  change: FleetClientStateChangeSchema,
});
export const FleetClientStateResponseSchema = z.strictObject({
  daemon: DaemonInstanceIdentitySchemaZ,
  state: FleetClientStateSchema,
});
