import { z } from "zod";

import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import { FleetSessionIdSchemaZ, type FleetSessionId } from "./fleet-catalog.ts";

export const WORKSPACE_CATALOG_RESOURCE_VERSION = 1 as const;

/**
 * Minimal daemon-private workspace routing record. The session name is needed
 * by trusted transports, but project paths and configuration metadata are not.
 */
export const WorkspaceCatalogEntryV1SchemaZ = z
  .object({
    workspaceName: z.string().min(1),
    sessionName: z.string().min(1),
  })
  .strict();

/**
 * Generation-stamped catalog used by trusted hosts before they retain any
 * workspace-to-session routing decision.
 */
export const WorkspaceCatalogResourceV1SchemaZ = z
  .object({
    version: z.literal(WORKSPACE_CATALOG_RESOURCE_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    workspaces: z.array(WorkspaceCatalogEntryV1SchemaZ),
  })
  .strict();

export type WorkspaceCatalogEntryV1 = z.infer<typeof WorkspaceCatalogEntryV1SchemaZ>;
export type WorkspaceCatalogResourceV1 = z.infer<typeof WorkspaceCatalogResourceV1SchemaZ>;

export const WORKSPACE_CATALOG_RESOURCE_V2_VERSION = 2 as const;

/** Durable user intent. It remains present when no tmux server is running. */
export const WorkspaceCatalogIntentV2SchemaZ = z
  .object({
    workspaceName: z.string().min(1),
    sessionName: z.string().min(1),
    source: z.enum(["project", "workspace"]),
    availability: z.enum(["live", "stopped"]),
  })
  .strict();

/**
 * Observed tmux truth. Nothing persisted is allowed to synthesize this row.
 * `sessionName` is the trusted routing fact; `fleetSessionId` is the daemon's
 * opaque mutation identity for that exact same live session.
 */
export const WorkspaceCatalogLiveSessionV2SchemaZ = z
  .object({
    sessionName: z.string().min(1),
    /** Daemon-minted promotion identity for this exact observed session. */
    fleetSessionId: FleetSessionIdSchemaZ,
    paneCount: z.number().int().nonnegative(),
  })
  .strict();

export const WorkspaceCatalogResourceV2SchemaZ = z
  .object({
    version: z.literal(WORKSPACE_CATALOG_RESOURCE_V2_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    intents: z.array(WorkspaceCatalogIntentV2SchemaZ),
    liveSessions: z.array(WorkspaceCatalogLiveSessionV2SchemaZ),
  })
  .strict();

export type WorkspaceCatalogIntentV2 = z.infer<typeof WorkspaceCatalogIntentV2SchemaZ>;
export type WorkspaceCatalogLiveSessionV2 = z.infer<typeof WorkspaceCatalogLiveSessionV2SchemaZ>;
export type WorkspaceCatalogResourceV2 = z.infer<typeof WorkspaceCatalogResourceV2SchemaZ>;

export const WORKSPACE_CATALOG_RESOURCE_V3_VERSION = 3 as const;

/**
 * Opaque identity of one observed tmux session incarnation. Unlike the
 * name-derived fleet mutation id, this value survives a rename and changes
 * when the same display name is recreated.
 */
export const WorkspaceCatalogLiveSessionIdSchemaZ = z
  .string()
  .regex(/^live-session\.[a-f0-9]{20}$/u);

export const WorkspaceCatalogLiveSessionV3SchemaZ = WorkspaceCatalogLiveSessionV2SchemaZ.extend({
  liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
}).strict();

/**
 * Live Home catalog. V2 remains available for existing workspace clients;
 * V3 adds the tmux-incarnation identity needed by a long-lived selector.
 */
export const WorkspaceCatalogResourceV3SchemaZ = z
  .object({
    version: z.literal(WORKSPACE_CATALOG_RESOURCE_V3_VERSION),
    daemon: DaemonInstanceIdentitySchemaZ,
    intents: z.array(WorkspaceCatalogIntentV2SchemaZ),
    liveSessions: z.array(WorkspaceCatalogLiveSessionV3SchemaZ),
  })
  .strict()
  .superRefine((resource, context) => {
    const names = new Set<string>();
    const identities = new Set<string>();
    for (const [index, session] of resource.liveSessions.entries()) {
      if (names.has(session.sessionName)) {
        context.addIssue({
          code: "custom",
          message: "duplicate live session name",
          path: ["liveSessions", index, "sessionName"],
        });
      }
      if (identities.has(session.liveSessionId)) {
        context.addIssue({
          code: "custom",
          message: "duplicate live session identity",
          path: ["liveSessions", index, "liveSessionId"],
        });
      }
      names.add(session.sessionName);
      identities.add(session.liveSessionId);
    }
  });

export type WorkspaceCatalogLiveSessionId = z.infer<typeof WorkspaceCatalogLiveSessionIdSchemaZ>;
export type WorkspaceCatalogLiveSessionV3 = z.infer<typeof WorkspaceCatalogLiveSessionV3SchemaZ>;
export type WorkspaceCatalogResourceV3 = z.infer<typeof WorkspaceCatalogResourceV3SchemaZ>;

export interface WorkspaceCatalogIntentInput {
  readonly workspaceName: string;
  readonly sessionName: string;
  readonly source: "project" | "workspace";
}

export interface WorkspaceCatalogLiveSessionInput {
  readonly sessionName: string;
  readonly fleetSessionId: FleetSessionId;
  readonly paneCount: number;
}

export interface WorkspaceCatalogLiveSessionV3Input extends WorkspaceCatalogLiveSessionInput {
  readonly liveSessionId: WorkspaceCatalogLiveSessionId;
}

/**
 * Host-neutral catalog/live join. Durable intent and observed tmux state stay
 * in separate collections; availability is only a convenience projection of
 * an exact session-name match and never turns intent into live state.
 */
export function projectWorkspaceCatalogV2(
  daemon: z.input<typeof DaemonInstanceIdentitySchemaZ>,
  intents: readonly WorkspaceCatalogIntentInput[],
  liveSessions: readonly WorkspaceCatalogLiveSessionInput[],
): WorkspaceCatalogResourceV2 {
  const observed = new Set(liveSessions.map(({ sessionName }) => sessionName));
  return WorkspaceCatalogResourceV2SchemaZ.parse({
    version: WORKSPACE_CATALOG_RESOURCE_V2_VERSION,
    daemon,
    intents: intents.map((intent) => ({
      ...intent,
      availability: observed.has(intent.sessionName) ? "live" : "stopped",
    })),
    liveSessions,
  });
}

export function projectWorkspaceCatalogV3(
  daemon: z.input<typeof DaemonInstanceIdentitySchemaZ>,
  intents: readonly WorkspaceCatalogIntentInput[],
  liveSessions: readonly WorkspaceCatalogLiveSessionV3Input[],
): WorkspaceCatalogResourceV3 {
  const observed = new Set(liveSessions.map(({ sessionName }) => sessionName));
  return WorkspaceCatalogResourceV3SchemaZ.parse({
    version: WORKSPACE_CATALOG_RESOURCE_V3_VERSION,
    daemon,
    intents: intents.map((intent) => ({
      ...intent,
      availability: observed.has(intent.sessionName) ? "live" : "stopped",
    })),
    liveSessions,
  });
}
