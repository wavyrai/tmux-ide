import {
  InteractionReceiptSchemaZ,
  type InteractionReceipt,
  type InteractionSafeSummary,
  type PaneSendSafeSummary,
} from "@tmux-ide/contracts";

export const INTERACTION_ACTIVITY_LIMIT = 64;
/** One shared transient presence window for DOM and OpenTUI chrome. */
export const INTERACTION_PRESENCE_MS = 3_200;

/**
 * Replay restores Activity history, not transient visual presence. Keeping the
 * time check in core prevents a reconnect from making every old pane read or
 * send look live again in one renderer but not another.
 */
export function interactionPresenceIsFresh(
  interaction: Pick<PaneInteractionProjection, "at"> | Pick<InteractionReceipt, "at">,
  nowMs = Date.now(),
  presenceMs = INTERACTION_PRESENCE_MS,
): boolean {
  const occurredAt = Date.parse(interaction.at);
  if (!Number.isFinite(occurredAt)) return false;
  const ageMs = nowMs - occurredAt;
  return ageMs >= 0 && ageMs <= presenceMs;
}

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

/**
 * Renderer-neutral presence semantics shared by the web and OpenTUI hosts.
 *
 * Focus is intentionally absent: an interaction is evidence that one pane was
 * observed or received input, never evidence that the user activated it.
 */
export type PaneInteractionPresenceRole =
  | "read-source"
  | "read-target"
  | "send-source"
  | "send-target";

export interface PaneInteractionPresence {
  readonly role: PaneInteractionPresenceRole;
  readonly kind: "read" | "send";
  readonly endpoint: "source" | "target";
  readonly treatment: "observation" | "transfer";
  readonly tone: "info" | "success" | "danger";
  readonly badge: string;
}

/**
 * Convert one pane projection into the single visual vocabulary every host
 * consumes. Labels are deliberately terse enough for pane chrome; the full,
 * privacy-safe relationship remains available through
 * {@link paneInteractionRelationshipLabel} and the Activity feed.
 */
export function paneInteractionPresence(
  interaction: PaneInteractionProjection,
): PaneInteractionPresence {
  const kind = interaction.operationKind === "workspace.pane.read" ? "read" : "send";
  const endpoint = interaction.direction === "outgoing" ? "source" : "target";
  const role: PaneInteractionPresenceRole = `${kind}-${endpoint}`;
  const failed = ["failed", "rejected", "timed-out"].includes(interaction.phase);
  let badge: string;
  if (failed) badge = "FAILED";
  else if (kind === "read") badge = endpoint === "source" ? "READING" : "READ";
  else if (interaction.phase === "accepted") badge = endpoint === "source" ? "SENDING" : "INPUT";
  else badge = endpoint === "source" ? "SENT" : "RECEIVED";
  return {
    role,
    kind,
    endpoint,
    treatment: kind === "read" ? "observation" : "transfer",
    tone: failed ? "danger" : kind === "read" ? "info" : "success",
    badge,
  };
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
  if (receipt.phase === "rejected") return `${receipt.origin} rejected · ${action}`;
  if (receipt.phase === "timed-out") return `${receipt.origin} timed out · ${action}`;
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
