import {
  InteractionReceiptSchemaZ,
  type InteractionReceipt,
  type InteractionSafeSummary,
  type PaneSendSafeSummary,
} from "@tmux-ide/contracts";

export const INTERACTION_ACTIVITY_LIMIT = 64;
/** One shared transient presence window for DOM and OpenTUI chrome. */
export const INTERACTION_PRESENCE_MS = 3_200;

export interface PaneInteractionProjection {
  /** The pane whose chrome owns this projection. */
  readonly paneId: string;
  readonly direction: "incoming" | "outgoing";
  readonly sourcePaneId: string | null;
  readonly destinationPaneId: string;
  readonly operationKind: InteractionReceipt["operationKind"];
  readonly operationId: string;
  readonly phase: InteractionReceipt["phase"];
  readonly origin: InteractionReceipt["origin"];
  readonly label: string;
  readonly sequence: number;
  readonly at: string;
}

export interface InteractionFeedState {
  /** Last contiguous replay-journal sequence incorporated by this feed. */
  readonly sequence: number;
  /** One latest receipt per operation, newest first and strictly bounded. */
  readonly activity: readonly InteractionReceipt[];
  /** Latest visible interaction for each semantic pane. */
  readonly panes: Readonly<Record<string, PaneInteractionProjection>>;
}

export function initialInteractionFeedState(): InteractionFeedState {
  return { sequence: 0, activity: [], panes: Object.freeze({}) };
}

export function paneSendSummaryLabel(summary: PaneSendSafeSummary): string {
  if ("observedOnly" in summary) return "input observed";
  const unit = summary.characterCount === 1 ? "character" : "characters";
  return `delivered ${summary.characterCount} ${unit}${summary.submitted ? " + Enter" : ""}`;
}

export function interactionSummaryLabel(
  operationKind: InteractionReceipt["operationKind"],
  summary: InteractionSafeSummary,
): string {
  if (operationKind === "workspace.pane.read") return "pane read observed";
  return paneSendSummaryLabel(summary);
}

export function interactionReceiptLabel(receipt: InteractionReceipt): string {
  const action = interactionSummaryLabel(receipt.operationKind, receipt.summary);
  if (receipt.phase === "accepted") return `${receipt.origin} accepted · ${action}`;
  if (receipt.phase === "failed") return `${receipt.origin} failed · ${action}`;
  if (receipt.phase === "observed") return `${receipt.origin} observed · ${action}`;
  return `${receipt.origin} applied · ${action}`;
}

export interface PaneInteractionRelationship {
  readonly origin: InteractionReceipt["origin"];
  readonly sourcePaneId: string | null;
  readonly destinationPaneId: string;
  readonly operationKind?: InteractionReceipt["operationKind"];
}

/**
 * Honest relationship copy shared by DOM and OpenTUI. A pane source is shown
 * only when daemon authority authenticated it; raw tmux activity stays
 * explicitly external rather than being attributed to whichever pane happens
 * to be focused.
 */
export function paneInteractionRelationshipLabel(
  interaction: PaneInteractionRelationship,
  paneLabel: (semanticPaneId: string) => string = (semanticPaneId) => semanticPaneId,
): string {
  if (interaction.operationKind === "workspace.pane.read") {
    const reader = interaction.sourcePaneId
      ? paneLabel(interaction.sourcePaneId)
      : interaction.origin === "external"
        ? "External reader"
        : `${interaction.origin.toUpperCase()} reader`;
    return `${reader} reads ${paneLabel(interaction.destinationPaneId)}`;
  }
  const source = interaction.sourcePaneId
    ? paneLabel(interaction.sourcePaneId)
    : interaction.origin === "external"
      ? "External input"
      : `${interaction.origin.toUpperCase()} input`;
  return `${source} → ${paneLabel(interaction.destinationPaneId)}`;
}

/**
 * Reduce a replayed/live receipt into the one renderer-neutral feed shared by
 * DOM and OpenTUI. Duplicate/older frames are harmless and each operation
 * occupies one Activity row as it advances through phases.
 */
export function reduceInteractionReceipt(
  previous: InteractionFeedState,
  raw: InteractionReceipt,
): InteractionFeedState {
  const receipt = InteractionReceiptSchemaZ.parse(raw);
  if (receipt.sequence <= previous.sequence) return previous;

  const existing = previous.activity.find((entry) => entry.operationId === receipt.operationId);
  if (existing && receipt.sequence <= existing.sequence) {
    return { ...previous, sequence: receipt.sequence };
  }

  const activity = [
    receipt,
    ...previous.activity.filter((entry) => entry.operationId !== receipt.operationId),
  ].slice(0, INTERACTION_ACTIVITY_LIMIT);
  const relationship = {
    sourcePaneId: receipt.sourceSemanticPaneId,
    destinationPaneId: receipt.semanticPaneId,
    operationKind: receipt.operationKind,
  } as const;
  const projection = (
    paneId: string,
    direction: PaneInteractionProjection["direction"],
  ): PaneInteractionProjection => ({
    paneId,
    direction,
    ...relationship,
    operationId: receipt.operationId,
    phase: receipt.phase,
    origin: receipt.origin,
    label: interactionReceiptLabel(receipt),
    sequence: receipt.sequence,
    at: receipt.at,
  });
  const panes: Record<string, PaneInteractionProjection> = {
    ...previous.panes,
    [receipt.semanticPaneId]: projection(receipt.semanticPaneId, "incoming"),
  };
  if (
    receipt.sourceSemanticPaneId !== null &&
    receipt.sourceSemanticPaneId !== receipt.semanticPaneId
  ) {
    panes[receipt.sourceSemanticPaneId] = projection(receipt.sourceSemanticPaneId, "outgoing");
  }

  return { sequence: receipt.sequence, activity, panes: Object.freeze(panes) };
}

export function interactionForPane(
  state: InteractionFeedState,
  semanticPaneId: string,
): PaneInteractionProjection | null {
  return state.panes[semanticPaneId] ?? null;
}
