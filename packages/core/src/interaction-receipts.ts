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

type PaneInteractionReceipt = InteractionReceipt & {
  readonly operationKind: "workspace.pane.send" | "workspace.pane.read";
  readonly target: { readonly kind: "pane"; readonly semanticPaneId: string };
};

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
  const failed = interaction.phase === "rejected" || interaction.phase === "timed-out";
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

export function paneSendSummaryLabel(summary: PaneSendSafeSummary, observed = false): string {
  if ("observedOnly" in summary) return "input observed";
  const unit = summary.characterCount === 1 ? "character" : "characters";
  return `${observed ? "delivered" : "send"} ${summary.characterCount} ${unit}${summary.submitted ? " + Enter" : ""}`;
}

export function interactionSummaryLabel(
  operationKind: InteractionReceipt["operationKind"],
  summary: InteractionSafeSummary,
  phase: InteractionReceipt["phase"] = "accepted",
): string {
  const observed = phase === "observed";
  switch (operationKind) {
    case "workspace.window.split":
      return `split ${summary.operationKind === operationKind ? summary.direction : "window"}`;
    case "workspace.window.kill":
      return observed ? "window closed" : "close window";
    case "workspace.pane.kill":
      return observed ? "pane closed" : "close pane";
    case "workspace.session.kill":
      return observed ? "session closed" : "close session";
    case "workspace.rename":
      return observed
        ? `${summary.operationKind === operationKind ? summary.scope : "workspace"} renamed`
        : `rename ${summary.operationKind === operationKind ? summary.scope : "workspace"}`;
    case "workspace.pane.zoom.toggle":
      return `zoom ${summary.operationKind === operationKind ? summary.desired : "changed"}`;
    case "workspace.pane.select":
      return observed ? "pane selected" : "select pane";
    case "workspace.pane.send":
      return summary.operationKind === operationKind
        ? paneSendSummaryLabel(summary, observed)
        : observed
          ? "pane input delivered"
          : "send pane input";
    case "workspace.pane.swap":
      return observed ? "panes swapped" : "swap panes";
    case "workspace.pane.resize":
      return summary.operationKind === operationKind
        ? `resize request · ${summary.cells} ${summary.axis}`
        : "resize pane";
    case "workspace.pane.read":
      return observed ? "pane read observed" : "read pane";
  }
}

export function interactionReceiptLabel(receipt: InteractionReceipt): string {
  const action = interactionSummaryLabel(receipt.operationKind, receipt.summary, receipt.phase);
  if (receipt.phase === "accepted") return `${receipt.origin} accepted · ${action}`;
  if (receipt.phase === "rejected") return `${receipt.origin} rejected · ${action}`;
  if (receipt.phase === "timed-out") return `${receipt.origin} timed out · ${action}`;
  return `${receipt.origin} observed · ${action}`;
}

const TERMINAL_INTERACTION_PHASES = new Set<InteractionReceipt["phase"]>([
  "observed",
  "rejected",
  "timed-out",
]);

/** One operation may advance exactly once from admission to a terminal verdict. */
export function interactionPhaseCanAdvance(
  previous: InteractionReceipt["phase"],
  next: InteractionReceipt["phase"],
): boolean {
  return previous === "accepted" && TERMINAL_INTERACTION_PHASES.has(next);
}

/** Immutable request identity; authenticated source and proof arrive only at observation. */
export function interactionReceiptIdentity(receipt: InteractionReceipt): string {
  return JSON.stringify({
    operationId: receipt.operationId,
    origin: receipt.origin,
    workspaceName: receipt.workspaceName,
    target: receipt.target,
    operationKind: receipt.operationKind,
    summary: receipt.summary,
  });
}

export function interactionReceiptTargetLabel(
  receipt: Pick<InteractionReceipt, "operationKind" | "origin" | "sourceSemanticPaneId" | "target">,
  paneLabel: (semanticPaneId: string) => string = (semanticPaneId) => semanticPaneId,
): string {
  if (
    (receipt.operationKind === "workspace.pane.send" ||
      receipt.operationKind === "workspace.pane.read") &&
    receipt.target.kind === "pane"
  ) {
    return paneInteractionRelationshipLabel(
      {
        origin: receipt.origin,
        sourcePaneId: receipt.sourceSemanticPaneId,
        destinationPaneId: receipt.target.semanticPaneId,
        operationKind: receipt.operationKind,
      },
      paneLabel,
    );
  }
  if (receipt.target.kind === "pane") return paneLabel(receipt.target.semanticPaneId);
  if (receipt.target.kind === "window") {
    return receipt.target.target.by === "pane"
      ? `Window at ${paneLabel(receipt.target.target.semanticPaneId)}`
      : receipt.target.target.semanticWindowId;
  }
  return "Session";
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
  if (existing) {
    const invalidIdentity =
      interactionReceiptIdentity(existing) !== interactionReceiptIdentity(receipt);
    const invalidTransition = !interactionPhaseCanAdvance(existing.phase, receipt.phase);
    if (receipt.sequence <= existing.sequence || invalidIdentity || invalidTransition) {
      return { ...previous, sequence: receipt.sequence };
    }
  }

  const activity = [
    receipt,
    ...previous.activity.filter((entry) => entry.operationId !== receipt.operationId),
  ].slice(0, INTERACTION_ACTIVITY_LIMIT);
  const panesWithoutThisOperation = Object.fromEntries(
    Object.entries(previous.panes).filter(
      ([, projection]) => projection.operationId !== receipt.operationId,
    ),
  );
  const isPaneInteraction =
    (receipt.operationKind === "workspace.pane.send" ||
      receipt.operationKind === "workspace.pane.read") &&
    receipt.target.kind === "pane";
  if (!isPaneInteraction) {
    return {
      sequence: receipt.sequence,
      activity,
      panes: Object.freeze(panesWithoutThisOperation),
    };
  }
  const paneReceipt = receipt as PaneInteractionReceipt;
  const relationship = {
    sourcePaneId: paneReceipt.sourceSemanticPaneId,
    destinationPaneId: paneReceipt.target.semanticPaneId,
    operationKind: paneReceipt.operationKind,
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
    ...panesWithoutThisOperation,
    [paneReceipt.target.semanticPaneId]: projection(paneReceipt.target.semanticPaneId, "incoming"),
  };
  if (
    paneReceipt.sourceSemanticPaneId !== null &&
    paneReceipt.sourceSemanticPaneId !== paneReceipt.target.semanticPaneId
  ) {
    panes[paneReceipt.sourceSemanticPaneId] = projection(
      paneReceipt.sourceSemanticPaneId,
      "outgoing",
    );
  }

  return { sequence: receipt.sequence, activity, panes: Object.freeze(panes) };
}

export function interactionForPane(
  state: InteractionFeedState,
  semanticPaneId: string,
): PaneInteractionProjection | null {
  return state.panes[semanticPaneId] ?? null;
}
