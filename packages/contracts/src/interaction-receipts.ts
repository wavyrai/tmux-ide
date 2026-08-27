import { z } from "zod";

import { DesktopWorkspaceNameSchemaZ } from "./desktop-workspace-name.ts";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
} from "./semantic-identity.ts";

/** The trusted product surface that submitted an interaction. */
export const InteractionOriginSchemaZ = z.enum(["gui", "tui", "cli", "sdk", "external"]);
export type InteractionOrigin = z.infer<typeof InteractionOriginSchemaZ>;
export const AuthoredInteractionOriginSchemaZ = z.enum(["gui", "tui", "cli", "sdk"]);
export type AuthoredInteractionOrigin = z.infer<typeof AuthoredInteractionOriginSchemaZ>;

/** Every semantic session-runtime verb; raw tmux addresses never enter this vocabulary. */
export const InteractionOperationKindSchemaZ = z.enum([
  "workspace.window.split",
  "workspace.window.kill",
  "workspace.pane.kill",
  "workspace.session.kill",
  "workspace.rename",
  "workspace.pane.zoom.toggle",
  "workspace.pane.select",
  "workspace.pane.send",
  "workspace.pane.swap",
  "workspace.pane.resize",
  "workspace.pane.read",
]);
export type InteractionOperationKind = z.infer<typeof InteractionOperationKindSchemaZ>;

/** One lifecycle vocabulary: admission, verified completion, or a terminal refusal. */
export const InteractionPhaseSchemaZ = z.enum(["accepted", "observed", "rejected", "timed-out"]);
export type InteractionPhase = z.infer<typeof InteractionPhaseSchemaZ>;

const InteractionWindowReferenceSchemaZ = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("window"),
      semanticWindowId: TerminalAttachmentSemanticWindowIdSchemaZ,
    })
    .strict(),
  z
    .object({ by: z.literal("pane"), semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ })
    .strict(),
]);

/** Stable semantic target retained even when the operation removes or renames it. */
export const InteractionTargetSchemaZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("window"), target: InteractionWindowReferenceSchemaZ }).strict(),
  z
    .object({ kind: z.literal("pane"), semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ })
    .strict(),
]);
export type InteractionTarget = z.infer<typeof InteractionTargetSchemaZ>;

const MutationOutcomeSchemaZ = z.enum(["applied", "unchanged", "replayed"]);

/**
 * Privacy-safe request metadata. Names, terminal input, captured output, paths,
 * tmux runtime ids, credentials, and hashes of any of them are deliberately
 * absent. The discriminant makes a summary impossible to reinterpret as a
 * different verb.
 */
export const InteractionSafeSummarySchemaZ = z.union([
  z
    .object({
      operationKind: z.literal("workspace.window.split"),
      direction: z.enum(["right", "down"]),
    })
    .strict(),
  z.object({ operationKind: z.literal("workspace.window.kill") }).strict(),
  z.object({ operationKind: z.literal("workspace.pane.kill") }).strict(),
  z.object({ operationKind: z.literal("workspace.session.kill") }).strict(),
  z
    .object({
      operationKind: z.literal("workspace.rename"),
      scope: z.enum(["session", "window", "pane"]),
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.zoom.toggle"),
      desired: z.enum(["toggle", "zoomed", "unzoomed"]),
    })
    .strict(),
  z.object({ operationKind: z.literal("workspace.pane.select") }).strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.send"),
      characterCount: z.number().int().nonnegative().max(1_048_576),
      byteCount: z.number().int().nonnegative().max(4_194_304),
      submitted: z.boolean(),
    })
    .strict(),
  z
    .object({ operationKind: z.literal("workspace.pane.send"), observedOnly: z.literal(true) })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.swap"),
      targetSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.resize"),
      axis: z.enum(["cols", "rows"]),
      cells: z.number().int().min(1).max(4096),
    })
    .strict(),
  z
    .object({ operationKind: z.literal("workspace.pane.read"), observedOnly: z.literal(true) })
    .strict(),
]);
export type InteractionSafeSummary = z.infer<typeof InteractionSafeSummarySchemaZ>;
export type PaneSendSafeSummary = Extract<
  InteractionSafeSummary,
  { operationKind: "workspace.pane.send" }
>;
export type PaneReadSafeSummary = Extract<
  InteractionSafeSummary,
  { operationKind: "workspace.pane.read" }
>;

/**
 * Privacy-safe read-back evidence. Structural proofs contain only the bounded
 * semantic facts already present in mutation results; user-authored names and
 * terminal bytes never enter the replay journal.
 */
export const InteractionProofSchemaZ = z.discriminatedUnion("operationKind", [
  z
    .object({
      operationKind: z.literal("workspace.window.split"),
      outcome: MutationOutcomeSchemaZ,
      direction: z.enum(["right", "down"]),
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.window.kill"),
      outcome: MutationOutcomeSchemaZ,
      remainingWindowCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.kill"),
      outcome: MutationOutcomeSchemaZ,
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
      windowClosed: z.boolean(),
      remainingWindowCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.session.kill"),
      outcome: MutationOutcomeSchemaZ,
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.rename"),
      outcome: MutationOutcomeSchemaZ,
      scope: z.enum(["session", "window", "pane"]),
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.zoom.toggle"),
      outcome: MutationOutcomeSchemaZ,
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
      zoomed: z.boolean(),
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.select"),
      outcome: MutationOutcomeSchemaZ,
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.send"),
      observed: z.literal(true),
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.swap"),
      outcome: MutationOutcomeSchemaZ,
      sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
      targetSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.resize"),
      outcome: MutationOutcomeSchemaZ,
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
      axis: z.enum(["cols", "rows"]),
      cells: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      operationKind: z.literal("workspace.pane.read"),
      observed: z.literal(true),
      semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
    })
    .strict(),
]);
export type InteractionProof = z.infer<typeof InteractionProofSchemaZ>;

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
    /** Authenticated source identity, disclosed only for an observed authored send. */
    sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ.nullable().default(null),
    target: InteractionTargetSchemaZ,
    operationKind: InteractionOperationKindSchemaZ,
    phase: InteractionPhaseSchemaZ,
    summary: InteractionSafeSummarySchemaZ,
    proof: InteractionProofSchemaZ.nullable(),
    at: z.iso.datetime({ offset: true }),
    resourceRevision: z.number().int().nonnegative().nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.summary.operationKind !== receipt.operationKind) {
      context.addIssue({
        code: "custom",
        path: ["summary", "operationKind"],
        message: "interaction summary must match the receipt operation",
      });
    }
    if (
      receipt.proof?.operationKind !== undefined &&
      receipt.proof.operationKind !== receipt.operationKind
    ) {
      context.addIssue({
        code: "custom",
        path: ["proof", "operationKind"],
        message: "interaction proof must match the receipt operation",
      });
    }
    if (receipt.phase === "observed" && receipt.proof === null) {
      context.addIssue({
        code: "custom",
        path: ["proof"],
        message: "observed receipts require proof",
      });
    }
    if (receipt.phase !== "observed" && receipt.proof !== null) {
      context.addIssue({
        code: "custom",
        path: ["proof"],
        message: "only observed receipts may carry proof",
      });
    }
    if (
      receipt.origin === "external" &&
      !("observedOnly" in receipt.summary && receipt.summary.observedOnly)
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "external observations require a presence-only summary",
      });
    }
    const paneVerb = receipt.operationKind.startsWith("workspace.pane.");
    if (paneVerb && receipt.target.kind !== "pane") {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "pane verbs require a pane target",
      });
    }
    if (receipt.operationKind === "workspace.window.split" && receipt.target.kind !== "pane") {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "window split requires its anchor pane target",
      });
    }
    if (receipt.operationKind === "workspace.window.kill" && receipt.target.kind !== "window") {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "window kill requires a window target",
      });
    }
    if (receipt.operationKind === "workspace.session.kill" && receipt.target.kind !== "session") {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "session kill requires a session target",
      });
    }
    if (receipt.operationKind === "workspace.rename") {
      const renameSummary =
        receipt.summary.operationKind === "workspace.rename" ? receipt.summary : null;
      if (renameSummary !== null && receipt.target.kind !== renameSummary.scope) {
        context.addIssue({
          code: "custom",
          path: ["target"],
          message: "rename target must match its scope",
        });
      }
      const renameProof =
        receipt.proof?.operationKind === "workspace.rename" ? receipt.proof : null;
      if (
        renameSummary !== null &&
        renameProof !== null &&
        renameSummary.scope !== renameProof.scope
      ) {
        context.addIssue({
          code: "custom",
          path: ["proof", "scope"],
          message: "rename proof scope must match the request summary",
        });
      }
    }
    if (
      receipt.operationKind === "workspace.window.split" &&
      receipt.summary.operationKind === "workspace.window.split" &&
      receipt.proof?.operationKind === "workspace.window.split" &&
      receipt.summary.direction !== receipt.proof.direction
    ) {
      context.addIssue({
        code: "custom",
        path: ["proof", "direction"],
        message: "split proof direction must match the request summary",
      });
    }
    if (
      receipt.operationKind.startsWith("workspace.pane.") &&
      receipt.target.kind === "pane" &&
      receipt.proof !== null
    ) {
      const proofPaneId =
        "semanticPaneId" in receipt.proof
          ? receipt.proof.semanticPaneId
          : receipt.proof.operationKind === "workspace.pane.swap"
            ? receipt.proof.sourceSemanticPaneId
            : null;
      if (proofPaneId !== null && proofPaneId !== receipt.target.semanticPaneId) {
        context.addIssue({
          code: "custom",
          path: ["proof"],
          message: "interaction proof pane must match the semantic target",
        });
      }
    }
    if (
      receipt.operationKind === "workspace.pane.swap" &&
      receipt.summary.operationKind === "workspace.pane.swap" &&
      receipt.proof?.operationKind === "workspace.pane.swap" &&
      receipt.summary.targetSemanticPaneId !== receipt.proof.targetSemanticPaneId
    ) {
      context.addIssue({
        code: "custom",
        path: ["proof", "targetSemanticPaneId"],
        message: "swap proof target must match the request summary",
      });
    }
    if (
      receipt.operationKind === "workspace.pane.resize" &&
      receipt.summary.operationKind === "workspace.pane.resize" &&
      receipt.proof?.operationKind === "workspace.pane.resize" &&
      receipt.summary.axis !== receipt.proof.axis
    ) {
      context.addIssue({
        code: "custom",
        path: ["proof", "axis"],
        message: "resize proof axis must match the request summary",
      });
    }
    if (
      receipt.operationKind === "workspace.pane.zoom.toggle" &&
      receipt.summary.operationKind === "workspace.pane.zoom.toggle" &&
      receipt.proof?.operationKind === "workspace.pane.zoom.toggle" &&
      receipt.summary.desired !== "toggle" &&
      receipt.proof.zoomed !== (receipt.summary.desired === "zoomed")
    ) {
      context.addIssue({
        code: "custom",
        path: ["proof", "zoomed"],
        message: "absolute zoom proof must match the requested state",
      });
    }
    if (receipt.origin === "external") {
      if (receipt.sourceSemanticPaneId !== null) {
        context.addIssue({
          code: "custom",
          path: ["sourceSemanticPaneId"],
          message: "external tmux observations cannot claim a source pane",
        });
      }
      if (
        receipt.phase !== "observed" ||
        !["workspace.pane.send", "workspace.pane.read"].includes(receipt.operationKind)
      ) {
        context.addIssue({
          code: "custom",
          path: ["phase"],
          message: "external tmux traffic is an observed pane send or read only",
        });
      }
    }
    if (receipt.sourceSemanticPaneId !== null && receipt.phase !== "observed") {
      context.addIssue({
        code: "custom",
        path: ["sourceSemanticPaneId"],
        message: "source pane identity is published only after tmux observation",
      });
    }
    if (receipt.sourceSemanticPaneId !== null && receipt.operationKind !== "workspace.pane.send") {
      context.addIssue({
        code: "custom",
        path: ["sourceSemanticPaneId"],
        message: "source pane identity is valid only for authored pane sends",
      });
    }
  });
export type InteractionReceipt = z.infer<typeof InteractionReceiptSchemaZ>;
