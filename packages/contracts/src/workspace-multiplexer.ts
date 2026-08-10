/**
 * Contracts for the multiplexer mutation routes — split, kill, rename, zoom and
 * select.
 *
 * These are the authority the m48 audit found missing. Before them the desktop
 * app could ask the daemon to change the world in four ways, only two of which
 * reached tmux, so the whole middle of a multiplexer's vocabulary had no route
 * to run on at all.
 *
 * Every shape here follows the `workspace.pane.create` discipline: the renderer
 * authors an `intent` naming only semantic identities, a trusted host wraps it
 * with retry and daemon-generation metadata, and the daemon answers with stable
 * semantic facts. tmux target syntax, socket paths and runtime `%`/`@`/`$` ids
 * appear nowhere on this wire — resolving a semantic id to a live pane is the
 * daemon's private business, and keeping it private is what stops a renderer
 * bug from addressing a pane that has since been replaced.
 */
import { z } from "zod";

import { DesktopDaemonCapabilityErrorSchemaZ } from "./desktop-host.ts";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
} from "./semantic-identity.ts";
import {
  WorkspacePaneCreationWorkspaceNameSchemaZ,
  WorkspacePaneDisplayTitleSchemaZ,
} from "./workspace-pane-creation.ts";
import { AuthoredInteractionOriginSchemaZ } from "./interaction-receipts.ts";

/**
 * A tmux window named either by its own durable stamp or by a pane inside it.
 *
 * Both forms are necessary, and the reason is historical rather than a matter
 * of taste: panes have carried `@tmux_ide_pane_id` since creation shipped, but
 * `@tmux_ide_window_id` is applied lazily, so a window created before the
 * mirror ever discovered it has no stamp of its own. Accepting a pane as the
 * way to name its window means window verbs work on every window that exists
 * today, not only on the ones that happen to have been stamped.
 */
export const WorkspaceMultiplexerWindowTargetSchemaZ = z.discriminatedUnion("by", [
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
export type WorkspaceMultiplexerWindowTarget = z.infer<
  typeof WorkspaceMultiplexerWindowTargetSchemaZ
>;

export const WorkspaceSplitDirectionSchemaZ = z.enum(["right", "down"]);
export type WorkspaceSplitDirection = z.infer<typeof WorkspaceSplitDirectionSchemaZ>;

/** A tmux object name: the same safety bar as a pane display title. */
export const WorkspaceMultiplexerNameSchemaZ = WorkspacePaneDisplayTitleSchemaZ;

const WorkspaceScopedSchemaZ = z.object({
  workspaceName: WorkspacePaneCreationWorkspaceNameSchemaZ,
});

// ---------------------------------------------------------------------------
// Intents — one per route, verb-less. The action name IS the verb.
// ---------------------------------------------------------------------------

export const WorkspaceWindowSplitArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  direction: WorkspaceSplitDirectionSchemaZ,
  displayTitle: WorkspacePaneDisplayTitleSchemaZ.optional(),
}).strict();
export type WorkspaceWindowSplitArguments = z.infer<typeof WorkspaceWindowSplitArgumentsSchemaZ>;

export const WorkspaceWindowKillArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  target: WorkspaceMultiplexerWindowTargetSchemaZ,
}).strict();
export type WorkspaceWindowKillArguments = z.infer<typeof WorkspaceWindowKillArgumentsSchemaZ>;

export const WorkspacePaneKillArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
}).strict();
export type WorkspacePaneKillArguments = z.infer<typeof WorkspacePaneKillArgumentsSchemaZ>;

export const WorkspaceSessionKillArgumentsSchemaZ = WorkspaceScopedSchemaZ.strict();
export type WorkspaceSessionKillArguments = z.infer<typeof WorkspaceSessionKillArgumentsSchemaZ>;

export const WorkspaceRenameArgumentsSchemaZ = z.discriminatedUnion("scope", [
  WorkspaceScopedSchemaZ.extend({
    scope: z.literal("session"),
    name: WorkspaceMultiplexerNameSchemaZ,
  }).strict(),
  WorkspaceScopedSchemaZ.extend({
    scope: z.literal("window"),
    target: WorkspaceMultiplexerWindowTargetSchemaZ,
    name: WorkspaceMultiplexerNameSchemaZ,
  }).strict(),
]);
export type WorkspaceRenameArguments = z.infer<typeof WorkspaceRenameArgumentsSchemaZ>;

export const WorkspacePaneZoomToggleArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  /**
   * `toggle` flips whatever tmux currently reports. The absolute forms exist so
   * a surface that renders a zoom state as a checkbox can be idempotent: a
   * double-delivered `zoomed` leaves the window zoomed rather than flipping it
   * back, which a blind toggle cannot promise.
   */
  desired: z.enum(["toggle", "zoomed", "unzoomed"]).default("toggle"),
}).strict();
export type WorkspacePaneZoomToggleArguments = z.infer<
  typeof WorkspacePaneZoomToggleArgumentsSchemaZ
>;

export const WorkspacePaneSelectArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
}).strict();
export type WorkspacePaneSelectArguments = z.infer<typeof WorkspacePaneSelectArgumentsSchemaZ>;

/**
 * Deliver literal terminal input through daemon authority. The text exists only
 * on the mutation request; neither the result nor the interaction receipt can
 * carry it back to another client.
 */
export const WorkspacePaneSendArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  /**
   * Optional owner-authenticated assertion that the send originated in this
   * workspace pane. The daemon verifies the semantic stamp against live tmux
   * state before returning it on the mutation result or interaction receipt.
   */
  sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ.optional(),
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  text: z.string().min(1).max(1_048_576),
  submit: z.boolean().default(true),
  origin: AuthoredInteractionOriginSchemaZ,
}).strict();
export type WorkspacePaneSendArguments = z.infer<typeof WorkspacePaneSendArgumentsSchemaZ>;

/**
 * Exchange the positions of two panes in one tmux window.
 *
 * Both ends are semantic identities. Runtime pane ids and tmux target syntax
 * remain daemon-private, and the daemon refuses panes from different windows
 * rather than turning a card drop into a cross-window tmux mutation.
 */
export const WorkspacePaneSwapArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  targetSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
}).strict();
export type WorkspacePaneSwapArguments = z.infer<typeof WorkspacePaneSwapArgumentsSchemaZ>;

/**
 * The bound on a resize request, in cells.
 *
 * tmux clamps a resize to what the window can give, so an out-of-range request
 * is not dangerous — but an unbounded one is a way to spend the daemon's tmux
 * budget on arithmetic no user asked for. 4096 is the same grid ceiling the
 * pane-stream layout frame is bounded by, so a request can address any pane
 * geometry the renderer could have been told about and nothing wider.
 */
const RESIZE_CELL_MAXIMUM = 4096;

export const WorkspaceResizeAxisSchemaZ = z.enum(["cols", "rows"]);
export type WorkspaceResizeAxis = z.infer<typeof WorkspaceResizeAxisSchemaZ>;

/**
 * Resize one pane along ONE axis.
 *
 * A single axis rather than a size, because a border drag moves one edge. Asking
 * for both would make the renderer re-assert a dimension the user did not touch,
 * and in a layout that moved between the grab and the release, re-asserting an
 * unchanged number is itself a change.
 */
export const WorkspacePaneResizeArgumentsSchemaZ = WorkspaceScopedSchemaZ.extend({
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  axis: WorkspaceResizeAxisSchemaZ,
  cells: z.number().int().min(1).max(RESIZE_CELL_MAXIMUM),
}).strict();
export type WorkspacePaneResizeArguments = z.infer<typeof WorkspacePaneResizeArgumentsSchemaZ>;

/** Every multiplexer intent, discriminated by the route that carries it. */
export const WorkspaceMultiplexerIntentSchemaZ = z.discriminatedUnion("verb", [
  WorkspaceWindowSplitArgumentsSchemaZ.extend({
    verb: z.literal("workspace.window.split"),
  }).strict(),
  WorkspaceWindowKillArgumentsSchemaZ.extend({ verb: z.literal("workspace.window.kill") }).strict(),
  WorkspacePaneKillArgumentsSchemaZ.extend({ verb: z.literal("workspace.pane.kill") }).strict(),
  WorkspaceSessionKillArgumentsSchemaZ.extend({
    verb: z.literal("workspace.session.kill"),
  }).strict(),
  z.discriminatedUnion("scope", [
    WorkspaceScopedSchemaZ.extend({
      verb: z.literal("workspace.rename"),
      scope: z.literal("session"),
      name: WorkspaceMultiplexerNameSchemaZ,
    }).strict(),
    WorkspaceScopedSchemaZ.extend({
      verb: z.literal("workspace.rename"),
      scope: z.literal("window"),
      target: WorkspaceMultiplexerWindowTargetSchemaZ,
      name: WorkspaceMultiplexerNameSchemaZ,
    }).strict(),
  ]),
  WorkspacePaneZoomToggleArgumentsSchemaZ.extend({
    verb: z.literal("workspace.pane.zoom.toggle"),
  }).strict(),
  WorkspacePaneSelectArgumentsSchemaZ.extend({
    verb: z.literal("workspace.pane.select"),
  }).strict(),
  WorkspacePaneSendArgumentsSchemaZ.extend({
    verb: z.literal("workspace.pane.send"),
  }).strict(),
  WorkspacePaneSwapArgumentsSchemaZ.extend({
    verb: z.literal("workspace.pane.swap"),
  }).strict(),
  WorkspacePaneResizeArgumentsSchemaZ.extend({
    verb: z.literal("workspace.pane.resize"),
  }).strict(),
]);
export type WorkspaceMultiplexerIntent = z.infer<typeof WorkspaceMultiplexerIntentSchemaZ>;
export type WorkspaceMultiplexerVerb = WorkspaceMultiplexerIntent["verb"];

/** Host-to-daemon envelope. The renderer authors only `intent`. */
export const WorkspaceMultiplexerMutationRequestSchemaZ = z
  .object({
    operationId: z.uuid(),
    expectedDaemonInstanceId: z.uuid(),
    intent: WorkspaceMultiplexerIntentSchemaZ,
  })
  .strict();
export type WorkspaceMultiplexerMutationRequest = z.infer<
  typeof WorkspaceMultiplexerMutationRequestSchemaZ
>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const MutationEnvelopeSchemaZ = z.object({
  operationId: z.uuid(),
  daemonInstanceId: z.uuid(),
  /**
   * `applied` mutated tmux now; `unchanged` found the world already in the
   * requested state; `replayed` answered a repeat of an operation id that had
   * already been performed. A surface that reports "done" for all three is
   * telling the truth, and one that wants to explain why nothing moved has the
   * distinction available.
   */
  outcome: z.enum(["applied", "unchanged", "replayed"]),
  workspaceName: WorkspacePaneCreationWorkspaceNameSchemaZ,
});

export const WorkspaceWindowSplitResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.window.split"),
  direction: WorkspaceSplitDirectionSchemaZ,
  /** The pane the split produced, stamped and addressable like any created pane. */
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  displayTitle: WorkspacePaneDisplayTitleSchemaZ,
}).strict();
export type WorkspaceWindowSplitResult = z.infer<typeof WorkspaceWindowSplitResultSchemaZ>;

export const WorkspaceWindowKillResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.window.kill"),
  /** Windows remaining in the session after the kill. Never zero: see the refusal. */
  remainingWindowCount: z.number().int().positive(),
}).strict();
export type WorkspaceWindowKillResult = z.infer<typeof WorkspaceWindowKillResultSchemaZ>;

export const WorkspacePaneKillResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.pane.kill"),
  /** True when that pane was its window's last, so tmux closed the window too. */
  windowClosed: z.boolean(),
  remainingWindowCount: z.number().int().positive(),
}).strict();
export type WorkspacePaneKillResult = z.infer<typeof WorkspacePaneKillResultSchemaZ>;

export const WorkspaceSessionKillResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.session.kill"),
}).strict();
export type WorkspaceSessionKillResult = z.infer<typeof WorkspaceSessionKillResultSchemaZ>;

export const WorkspaceRenameResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.rename"),
  scope: z.enum(["session", "window"]),
  name: WorkspaceMultiplexerNameSchemaZ,
}).strict();
export type WorkspaceRenameResult = z.infer<typeof WorkspaceRenameResultSchemaZ>;

export const WorkspacePaneZoomToggleResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.pane.zoom.toggle"),
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  zoomed: z.boolean(),
}).strict();
export type WorkspacePaneZoomToggleResult = z.infer<typeof WorkspacePaneZoomToggleResultSchemaZ>;

export const WorkspacePaneSelectResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.pane.select"),
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
}).strict();
export type WorkspacePaneSelectResult = z.infer<typeof WorkspacePaneSelectResultSchemaZ>;

export const WorkspacePaneSendResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.pane.send"),
  sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ.nullable(),
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  origin: AuthoredInteractionOriginSchemaZ,
  characterCount: z.number().int().nonnegative().max(1_048_576),
  byteCount: z.number().int().nonnegative().max(4_194_304),
  submitted: z.boolean(),
}).strict();
export type WorkspacePaneSendResult = z.infer<typeof WorkspacePaneSendResultSchemaZ>;

export const WorkspacePaneSwapResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.pane.swap"),
  sourceSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  targetSemanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
}).strict();
export type WorkspacePaneSwapResult = z.infer<typeof WorkspacePaneSwapResultSchemaZ>;

export const WorkspacePaneResizeResultSchemaZ = MutationEnvelopeSchemaZ.extend({
  verb: z.literal("workspace.pane.resize"),
  semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  axis: WorkspaceResizeAxisSchemaZ,
  /**
   * The size tmux actually settled on, which is rarely the size that was asked
   * for: a layout has a minimum per pane and a fixed total, so tmux clamps. The
   * surface reports the observed number rather than the requested one, so a drag
   * that hit a floor reads as having stopped there instead of as having worked.
   */
  cells: z.number().int().positive(),
}).strict();
export type WorkspacePaneResizeResult = z.infer<typeof WorkspacePaneResizeResultSchemaZ>;

export const WorkspaceMultiplexerMutationResultSchemaZ = z.discriminatedUnion("verb", [
  WorkspaceWindowSplitResultSchemaZ,
  WorkspaceWindowKillResultSchemaZ,
  WorkspacePaneKillResultSchemaZ,
  WorkspaceSessionKillResultSchemaZ,
  WorkspaceRenameResultSchemaZ,
  WorkspacePaneZoomToggleResultSchemaZ,
  WorkspacePaneSelectResultSchemaZ,
  WorkspacePaneSendResultSchemaZ,
  WorkspacePaneSwapResultSchemaZ,
  WorkspacePaneResizeResultSchemaZ,
]);
export type WorkspaceMultiplexerMutationResult = z.infer<
  typeof WorkspaceMultiplexerMutationResultSchemaZ
>;

/** Narrow a result to the route that produced it. */
export type WorkspaceMultiplexerResultFor<V extends WorkspaceMultiplexerVerb> = Extract<
  WorkspaceMultiplexerMutationResult,
  { verb: V }
>;

export const WorkspaceMultiplexerHostResultSchemaZ = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: WorkspaceMultiplexerMutationResultSchemaZ }).strict(),
  z.object({ status: z.literal("error"), error: DesktopDaemonCapabilityErrorSchemaZ }).strict(),
]);
export type WorkspaceMultiplexerHostResult = z.infer<typeof WorkspaceMultiplexerHostResultSchemaZ>;
