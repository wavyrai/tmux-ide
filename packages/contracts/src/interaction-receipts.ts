import { z } from "zod";

import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "./semantic-identity.ts";

/** The trusted product surface that submitted an interaction. */
export const InteractionOriginSchemaZ = z.enum(["gui", "tui", "cli", "sdk", "external"]);
export type InteractionOrigin = z.infer<typeof InteractionOriginSchemaZ>;
export const AuthoredInteractionOriginSchemaZ = z.enum(["gui", "tui", "cli", "sdk"]);
export type AuthoredInteractionOrigin = z.infer<typeof AuthoredInteractionOriginSchemaZ>;

/** Closed vocabulary carried by the shared interaction spine. */
export const InteractionOperationKindSchemaZ = z.enum([
  "workspace.pane.send",
  "workspace.pane.read",
]);
export type InteractionOperationKind = z.infer<typeof InteractionOperationKindSchemaZ>;

export const InteractionPhaseSchemaZ = z.enum(["accepted", "applied", "observed", "failed"]);
export type InteractionPhase = z.infer<typeof InteractionPhaseSchemaZ>;

/**
 * A deliberately non-extensible summary of pane input. It proves what class of
 * interaction happened without ever carrying the literal input, a prefix, a
 * hash, or a filesystem path that could disclose prompt content.
 */
const KnownPaneSendSafeSummarySchemaZ = z
  .object({
    characterCount: z.number().int().nonnegative().max(1_048_576),
    byteCount: z.number().int().nonnegative().max(4_194_304),
    submitted: z.boolean(),
  })
  .strict();

/**
 * tmux's `after-send-keys` hook proves that input was delivered to a pane but
 * deliberately does not expose the command's arguments. External observation
 * therefore records presence only rather than inventing counts or retaining
 * terminal input anywhere in the daemon.
 */
export const ObservedPaneSendSafeSummarySchemaZ = z
  .object({
    observedOnly: z.literal(true),
  })
  .strict();

export const PaneSendSafeSummarySchemaZ = z.union([
  KnownPaneSendSafeSummarySchemaZ,
  ObservedPaneSendSafeSummarySchemaZ,
]);
export type PaneSendSafeSummary = z.infer<typeof PaneSendSafeSummarySchemaZ>;

/**
 * A pane read never carries captured terminal content through the interaction
 * journal. Raw tmux hooks can prove only that a capture occurred, so the first
 * read summary is deliberately presence-only.
 */
export const PaneReadSafeSummarySchemaZ = ObservedPaneSendSafeSummarySchemaZ;
export type PaneReadSafeSummary = z.infer<typeof PaneReadSafeSummarySchemaZ>;
export const InteractionSafeSummarySchemaZ = z.union([
  PaneSendSafeSummarySchemaZ,
  PaneReadSafeSummarySchemaZ,
]);
export type InteractionSafeSummary = z.infer<typeof InteractionSafeSummarySchemaZ>;

/**
 * Replayable, privacy-safe evidence that an interaction crossed daemon
 * authority. `sequence` belongs to the daemon generation's shared event
 * journal, alongside resource.changed frames.
 */
export const InteractionReceiptSchemaZ = z
  .object({
    type: z.literal("interaction.receipt"),
    sequence: z.number().int().positive(),
    operationId: z.uuid(),
    origin: InteractionOriginSchemaZ,
    workspaceName: DesktopWorkspaceNameSchemaZ,
    /**
     * Authenticated source identity for an authored pane-to-pane send. This is
     * null for raw tmux traffic and for authored sends that did not originate
     * inside a pane. Daemon authority, never a renderer, decides when a claimed
     * source may be copied onto an applied receipt.
     */
    sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ.nullable().default(null),
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    operationKind: InteractionOperationKindSchemaZ,
    phase: InteractionPhaseSchemaZ,
    summary: InteractionSafeSummarySchemaZ,
    at: z.iso.datetime({ offset: true }),
    resourceRevision: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.origin === "external") {
      if (receipt.sourceSemanticPaneId !== null) {
        context.addIssue({
          code: "custom",
          path: ["sourceSemanticPaneId"],
          message: "external tmux observations cannot claim a source pane",
        });
      }
      if (receipt.phase !== "observed" || !("observedOnly" in receipt.summary)) {
        context.addIssue({
          code: "custom",
          path: ["phase"],
          message: "external tmux traffic is observation-only",
        });
      }
    }
    if (receipt.operationKind === "workspace.pane.read" && !("observedOnly" in receipt.summary)) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "pane reads are presence-only and may not retain captured content",
      });
    }
    if (receipt.sourceSemanticPaneId !== null && receipt.phase !== "applied") {
      context.addIssue({
        code: "custom",
        path: ["sourceSemanticPaneId"],
        message: "source pane identity is published only after authority applies the send",
      });
    }
  });
export type InteractionReceipt = z.infer<typeof InteractionReceiptSchemaZ>;
