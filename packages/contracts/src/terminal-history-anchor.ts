import { z } from "zod";
import { WorkspaceIdSchemaZ } from "./workspace-state.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";
import { TmuxServerScopeSchemaZ } from "./tmux-server-scope.ts";
import { WorkspaceCatalogLiveSessionIdSchemaZ } from "./workspace-catalog-resource.ts";
export const HistoryAnchorProofSchemaZ = z
  .object({
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    generation: z.uuid(),
    incarnation: z.string().min(1).max(256),
    revision: z.number().int().nonnegative().safe(),
    stateHash: z.string().regex(/^[0-9a-f]{16}$/u),
  })
  .strict();
export const HistoryAnchorIdentitySchemaZ = HistoryAnchorProofSchemaZ.omit({
  revision: true,
  stateHash: true,
});
export const HistoryAnchorRequestSchemaZ = z.union([
  z
    .object({
      version: z.literal(1),
      liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
      proof: HistoryAnchorProofSchemaZ,
      operation: z
        .object({ kind: z.literal("capture"), historyIndex: z.number().int().nonnegative().safe() })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
      proof: HistoryAnchorIdentitySchemaZ,
      operation: z.object({ kind: z.literal("resolve"), token: z.uuid() }).strict(),
    })
    .strict(),
]);
export const HistoryAnchorResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("captured"), token: z.uuid() }).strict(),
  z
    .object({
      status: z.literal("resolved"),
      proof: HistoryAnchorProofSchemaZ,
      historyIndex: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({ status: z.literal("stale") }).strict(),
  z.object({ status: z.literal("lost") }).strict(),
]);
export const HistoryAnchorResponseSchemaZ = z
  .object({
    version: z.literal(1),
    server: TmuxServerScopeSchemaZ,
    result: HistoryAnchorResultSchemaZ,
  })
  .strict();
export type HistoryAnchorRequest = z.infer<typeof HistoryAnchorRequestSchemaZ>;
export type HistoryAnchorResult = z.infer<typeof HistoryAnchorResultSchemaZ>;
