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

export const WorkspaceMultiplexerMutationResultSchemaZ = z.discriminatedUnion("verb", [
  WorkspaceWindowSplitResultSchemaZ,
  WorkspaceWindowKillResultSchemaZ,
  WorkspacePaneKillResultSchemaZ,
  WorkspaceSessionKillResultSchemaZ,
  WorkspaceRenameResultSchemaZ,
  WorkspacePaneZoomToggleResultSchemaZ,
  WorkspacePaneSelectResultSchemaZ,
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
