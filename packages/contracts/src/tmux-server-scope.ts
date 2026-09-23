import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
} from "./semantic-identity.ts";
import { WorkspaceCatalogLiveSessionIdSchemaZ } from "./workspace-catalog-resource.ts";

/** Stable registration identity. Never derive it from a socket path or native ID. */
export const TmuxServerIdSchemaZ = z.string().regex(/^tmux-server\.[a-f0-9]{32}$/u);
/** Fresh live authority incarnation, independently retired for each server owner. */
export const TmuxServerGenerationSchemaZ = z.uuid();
export const TmuxServerScopeSchemaZ = z
  .object({ serverId: TmuxServerIdSchemaZ, generation: TmuxServerGenerationSchemaZ })
  .strict();

const descriptorShape = {
  serverId: TmuxServerIdSchemaZ,
  label: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      "server label contains control characters",
    ),
};
export const TmuxServerDescriptorSchemaZ = z.discriminatedUnion("state", [
  z
    .object({
      ...descriptorShape,
      state: z.literal("online"),
      generation: TmuxServerGenerationSchemaZ,
    })
    .strict(),
  z.object({ ...descriptorShape, state: z.literal("offline"), generation: z.null() }).strict(),
]);

/** Explicitly versioned endpoint; this is not an additive field on legacy wire resources. */
export const TMUX_SERVERS_API_PATH = "/api/v1/tmux-servers" as const;
export const TmuxServersResourceSchemaZ = z
  .object({
    version: z.literal(1),
    servers: z.array(TmuxServerDescriptorSchemaZ),
  })
  .strict()
  .superRefine((resource, context) => {
    const seen = new Set<string>();
    for (const [index, server] of resource.servers.entries()) {
      if (seen.has(server.serverId))
        context.addIssue({
          code: "custom",
          path: ["servers", index, "serverId"],
          message: "Server registrations must be unique",
        });
      seen.add(server.serverId);
    }
  });
export const TmuxServerSessionTargetSchemaZ = z
  .object({
    server: TmuxServerScopeSchemaZ,
    liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
  })
  .strict();
export const TmuxServerWindowTargetSchemaZ = TmuxServerSessionTargetSchemaZ.extend({
  semanticWindowId: TerminalAttachmentSemanticWindowIdSchemaZ,
});
export const TmuxServerPaneTargetSchemaZ = TmuxServerSessionTargetSchemaZ.extend({
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
});

export type TmuxServerId = z.infer<typeof TmuxServerIdSchemaZ>;
export type TmuxServerGeneration = z.infer<typeof TmuxServerGenerationSchemaZ>;
export type TmuxServerScope = z.infer<typeof TmuxServerScopeSchemaZ>;
export type TmuxServerDescriptor = z.infer<typeof TmuxServerDescriptorSchemaZ>;
export type TmuxServersResource = z.infer<typeof TmuxServersResourceSchemaZ>;
export type TmuxServerSessionTarget = z.infer<typeof TmuxServerSessionTargetSchemaZ>;
export type TmuxServerWindowTarget = z.infer<typeof TmuxServerWindowTargetSchemaZ>;
export type TmuxServerPaneTarget = z.infer<typeof TmuxServerPaneTargetSchemaZ>;

export type TmuxServerScopeResolution =
  | { status: "matched"; scope: TmuxServerScope }
  | { status: "not-found" | "offline" | "stale-generation" | "ambiguous" };

/**
 * Legacy adaptation considers every registration, including offline ones. Losing
 * one connection must not redirect an old unscoped request to a different server.
 * Explicit callers never fall back when their registration or incarnation is gone.
 */
export function resolveTmuxServerScope(
  registrations: readonly TmuxServerDescriptor[],
  requested?: TmuxServerScope,
): TmuxServerScopeResolution {
  const candidates = requested
    ? registrations.filter((entry) => entry.serverId === requested.serverId)
    : registrations;
  if (candidates.length === 0) return { status: "not-found" };
  if (candidates.length !== 1) return { status: "ambiguous" };
  const candidate = candidates[0]!;
  if (candidate.state === "offline") return { status: "offline" };
  if (requested && requested.generation !== candidate.generation) {
    return { status: "stale-generation" };
  }
  return {
    status: "matched",
    scope: { serverId: candidate.serverId, generation: candidate.generation },
  };
}

/** Namespaces copied stamps/native IDs and retires keys on authority replacement. */
export function tmuxServerScopedResourceKey(
  scope: TmuxServerScope,
  kind: string,
  resourceId: string,
): string {
  return JSON.stringify([scope.serverId, scope.generation, kind, resourceId]);
}

/** Server and generation are part of the upgrade address, never query authority. */
export function tmuxServerPaneStreamPath(scope: TmuxServerScope): string {
  const parsed = TmuxServerScopeSchemaZ.parse(scope);
  return `/v2/tmux-servers/${parsed.serverId}/${parsed.generation}/pane-streams/redeem`;
}

export function isTmuxServerPaneStreamPath(path: string): boolean {
  const match = /^\/v2\/tmux-servers\/([^/]+)\/([^/]+)\/pane-streams\/redeem$/u.exec(path);
  if (!match) return false;
  return TmuxServerScopeSchemaZ.safeParse({ serverId: match[1], generation: match[2] }).success;
}

export const TmuxServerSessionsResourceSchemaZ = z
  .object({
    version: z.literal(1),
    server: TmuxServerScopeSchemaZ,
    sessions: z.array(
      z
        .object({
          liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
          sessionName: z.string().min(1).max(160),
          workspaceName: z.string().min(1).max(160).nullable(),
          paneCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

/** Selector intent is interpreted only by the daemon on its own host. */
export const TmuxServerRegistrationRequestSchemaZ = z
  .object({
    label: descriptorShape.label.max(128),
    selector: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("path"),
          path: z
            .string()
            .min(1)
            .max(4096)
            .refine((path) => path.startsWith("/") && !/[\0\r\n]/u.test(path)),
        })
        .strict(),
      z
        .object({ kind: z.literal("name"), name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/u) })
        .strict(),
    ]),
  })
  .strict();
export type TmuxServerRegistrationRequest = z.infer<typeof TmuxServerRegistrationRequestSchemaZ>;
