import {
  InteractionJournalEntrySchemaZ,
  type InteractionJournalEntry,
  type InteractionEvidenceRecord,
  type NativePaneIdentity,
  type InteractionReceipt,
  type InteractionPaneEndpoint,
  type InteractionEffectEvidence,
  type InteractionSafeSummary,
  type PaneSendSafeSummary,
} from "@tmux-ide/contracts";

import { canEnrichInteractionEvidence } from "./interaction-evidence.ts";

type NativePaneEndpoint = Extract<InteractionPaneEndpoint, { kind: "native-pane" }>;
type ResolvedInteractionEndpoint = Extract<InteractionPaneEndpoint, { kind: "pane" }>;
/** Physical evidence keys never include a mutable session/semantic alias. */
export function interactionNativePaneEndpointKey(
  endpoint: Extract<InteractionPaneEndpoint, { kind: "native-pane" }>,
): string {
  return JSON.stringify([
    "native-pane",
    endpoint.environmentId,
    endpoint.serverScope.serverId,
    endpoint.serverScope.generation,
    endpoint.serverEpoch,
    endpoint.paneBirthId,
  ]);
}
export function interactionPaneEndpointKey(endpoint: ResolvedInteractionEndpoint): string {
  return JSON.stringify([
    endpoint.environmentId,
    endpoint.serverScope.serverId,
    endpoint.serverScope.generation,
    endpoint.workspaceName,
    endpoint.paneLifetimeId,
    endpoint.semanticPaneId,
  ]);
}
function receiptOwnerKey(receipt: InteractionJournalEntry): string {
  const endpoint = receipt.evidence?.endpoints.destination;
  return endpoint
    ? JSON.stringify([
        endpoint.environmentId,
        endpoint.serverScope.serverId,
        endpoint.serverScope.generation,
      ])
    : "structural";
}
function receiptOperationKey(receipt: InteractionJournalEntry): string {
  return `${receiptOwnerKey(receipt)}:${receipt.type === "interaction.evidence" ? "native:" + receipt.evidence.interactionId : receipt.operationId}`;
}

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
  readonly endpoint: ResolvedInteractionEndpoint;
  readonly sourceEndpoint: ResolvedInteractionEndpoint | null;
  readonly destinationEndpoint: ResolvedInteractionEndpoint | NativePaneEndpoint;
  /** Current alias used only for display, never a claim of historical placement. */
  readonly displayDestinationEndpoint?: ResolvedInteractionEndpoint;
  readonly effect: InteractionEffectEvidence;
  readonly operationKey: string;
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
  const failed = interaction.phase === "rejected" || interaction.phase === "timed-out";
  let badge: string;
  if (failed) badge = "FAILED";
  else if (kind === "read")
    badge =
      interaction.phase === "accepted"
        ? "READING"
        : interaction.effect.kind === "snapshot-produced"
          ? "READ"
          : "READ OBSERVED";
  else if (interaction.phase === "accepted") badge = endpoint === "source" ? "SENDING" : "INPUT";
  else if (interaction.effect.kind !== "input-enqueued") badge = "INPUT OBSERVED";
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
  readonly cursors: Readonly<Record<string, number>>;
  /** One latest receipt per operation, newest first and strictly bounded. */
  readonly activity: readonly InteractionJournalEntry[];
  /** Latest visible interaction for each semantic pane. */
  readonly panes: Readonly<Record<string, PaneInteractionProjection>>;
}

export function initialInteractionFeedState(): InteractionFeedState {
  return { sequence: 0, cursors: Object.freeze({}), activity: [], panes: Object.freeze({}) };
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
    case "workspace.window.split.resize":
      return observed ? "divider resized" : "resize divider";
    case "workspace.window.link.select":
      return observed ? "window link selected" : "select window link";
    case "workspace.window.link.unlink":
      return observed ? "window unlinked" : "unlink window";
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

export function interactionActivityAt(entry: InteractionJournalEntry): string {
  return entry.type === "interaction.evidence" ? entry.evidence.receivedAt : entry.at;
}
/** Verified viewer operations remain in history but are not agent activity. */
export function interactionIsViewerActivity(entry: InteractionJournalEntry): boolean {
  if (entry.type !== "interaction.evidence") return false;
  const actor = entry.evidence.actor;
  return (
    entry.evidence.observation.kind === "native-journal" &&
    actor.kind === "native" &&
    actor.identity === "connection" &&
    actor.classification.kind === "viewer"
  );
}
export function interactionActivityOperationKind(
  entry: InteractionJournalEntry,
): InteractionReceipt["operationKind"] | null {
  if (entry.type === "interaction.receipt") return entry.operationKind;
  const evidence = entry.evidence;
  if (evidence.effect.kind === "snapshot-produced") return "workspace.pane.read";
  if (evidence.effect.kind === "input-enqueued" || evidence.effect.kind === "no-input")
    return "workspace.pane.send";
  if (evidence.observation.kind !== "native-journal" || evidence.observation.command === "unknown")
    return null;
  return evidence.observation.command === "capture-pane"
    ? "workspace.pane.read"
    : "workspace.pane.send";
}
export function interactionReceiptLabel(receipt: InteractionJournalEntry): string {
  if (receipt.type === "interaction.evidence") {
    const effect = receipt.evidence.effect.kind;
    if (effect === "input-enqueued") return "External input enqueued";
    if (effect === "snapshot-produced") return "External snapshot produced";
    if (effect === "no-input") return "External command · no input";
    const kind = interactionActivityOperationKind(receipt);
    return kind === "workspace.pane.read"
      ? "External read command observed"
      : kind === "workspace.pane.send"
        ? "External input command observed"
        : "External activity observed";
  }
  const commandOnly = receipt.phase === "observed" && receipt.evidence?.effect.kind === "unknown";
  const action =
    commandOnly && receipt.operationKind === "workspace.pane.send"
      ? "input command observed"
      : commandOnly && receipt.operationKind === "workspace.pane.read"
        ? "read command observed"
        : interactionSummaryLabel(receipt.operationKind, receipt.summary, receipt.phase);
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
    destination: receipt.evidence?.endpoints.destination ?? null,
  });
}

export function interactionReceiptTargetLabel(
  receipt:
    | Pick<InteractionReceipt, "operationKind" | "origin" | "target" | "evidence">
    | InteractionEvidenceRecord,
  paneLabel: (endpoint: ResolvedInteractionEndpoint) => string = (endpoint) =>
    endpoint.semanticPaneId,
): string {
  const destination = receipt.evidence?.endpoints.destination;
  const source = receipt.evidence?.endpoints.source;
  if ("type" in receipt && receipt.type === "interaction.evidence") {
    if (destination?.kind !== "pane")
      return destination?.kind === "native-pane" ? "Native pane" : "Unresolved pane";
    const kind = interactionActivityOperationKind(receipt);
    if (kind === null) return paneLabel(destination);
    return paneInteractionRelationshipLabel(
      {
        origin: "external",
        sourceEndpoint: source?.kind === "pane" ? source : null,
        destinationEndpoint: destination,
        operationKind: kind,
      },
      paneLabel,
    );
  }
  const authored = receipt as Pick<
    InteractionReceipt,
    "operationKind" | "origin" | "target" | "evidence"
  >;
  if (
    destination?.kind === "pane" &&
    (authored.operationKind === "workspace.pane.send" ||
      authored.operationKind === "workspace.pane.read")
  ) {
    return paneInteractionRelationshipLabel(
      {
        origin: authored.origin,
        sourceEndpoint: source?.kind === "pane" ? source : null,
        destinationEndpoint: destination,
        operationKind: authored.operationKind,
      },
      paneLabel,
    );
  }
  if (destination?.kind === "pane") return paneLabel(destination);
  return authored.target.kind === "window"
    ? "Window"
    : authored.target.kind === "pane"
      ? "Pane"
      : "Session";
}
export interface PaneInteractionRelationship {
  readonly origin: InteractionReceipt["origin"];
  readonly sourceEndpoint: ResolvedInteractionEndpoint | null;
  readonly destinationEndpoint: ResolvedInteractionEndpoint | NativePaneEndpoint;
  readonly displayDestinationEndpoint?: ResolvedInteractionEndpoint;
  readonly operationKind?: InteractionReceipt["operationKind"];
}
/** Names are resolved only from authoritative current endpoint metadata. */
export function paneInteractionRelationshipLabel(
  interaction: PaneInteractionRelationship,
  paneLabel: (endpoint: ResolvedInteractionEndpoint) => string = (endpoint) =>
    endpoint.semanticPaneId,
): string {
  const read = interaction.operationKind === "workspace.pane.read";
  const source = interaction.sourceEndpoint
    ? paneLabel(interaction.sourceEndpoint)
    : interaction.origin === "external"
      ? read
        ? "External reader"
        : "External input"
      : `${interaction.origin.toUpperCase()} ${read ? "reader" : "input"}`;
  const display =
    interaction.displayDestinationEndpoint ??
    (interaction.destinationEndpoint.kind === "pane" ? interaction.destinationEndpoint : null);
  return `${source}${read ? " reads " : " → "}${display ? paneLabel(display) : "Native pane"}`;
}

/**
 * Reduce a replayed/live receipt into the one renderer-neutral feed shared by
 * DOM and OpenTUI. Duplicate/older frames are harmless and each operation
 * occupies one Activity row as it advances through phases.
 */
export function reduceInteractionReceipt(
  previous: InteractionFeedState,
  raw: InteractionJournalEntry,
  project: (entry: InteractionJournalEntry) => boolean = () => true,
): InteractionFeedState {
  const receipt = InteractionJournalEntrySchemaZ.parse(raw);
  const ownerKey = receiptOwnerKey(receipt);
  if (receipt.sequence <= (previous.cursors[ownerKey] ?? 0)) return previous;
  const sequence = Math.max(previous.sequence, receipt.sequence);
  const nextCursors = { ...previous.cursors, [ownerKey]: receipt.sequence };
  const ownerKeys = Object.keys(nextCursors);
  for (const expired of ownerKeys.slice(0, Math.max(0, ownerKeys.length - 128)))
    delete nextCursors[expired];
  const cursors = Object.freeze(nextCursors);
  const operationKey = receiptOperationKey(receipt);
  const existing = previous.activity.find((entry) => receiptOperationKey(entry) === operationKey);
  if (existing) {
    const enriches =
      existing.evidence !== null &&
      receipt.evidence !== null &&
      canEnrichInteractionEvidence(existing.evidence, receipt.evidence);
    const native =
      existing.type === "interaction.evidence" && receipt.type === "interaction.evidence";
    const validTransition = native
      ? enriches
      : existing.type === "interaction.receipt" &&
        receipt.type === "interaction.receipt" &&
        (interactionPhaseCanAdvance(existing.phase, receipt.phase) ||
          (existing.phase === receipt.phase && enriches));
    if (
      (!native &&
        (existing.type !== "interaction.receipt" ||
          receipt.type !== "interaction.receipt" ||
          interactionReceiptIdentity(existing) !== interactionReceiptIdentity(receipt))) ||
      !validTransition ||
      (existing.evidence !== null && receipt.evidence !== null && !enriches)
    )
      return { ...previous, sequence, cursors };
  }
  const activity = [
    receipt,
    ...previous.activity.filter((entry) => receiptOperationKey(entry) !== operationKey),
  ].slice(0, INTERACTION_ACTIVITY_LIMIT);
  const panes: Record<string, PaneInteractionProjection> = Object.fromEntries(
    Object.entries(previous.panes).filter(
      ([, projection]) => projection.operationKey !== operationKey,
    ),
  );
  const evidence = receipt.evidence;
  const destination = evidence?.endpoints.destination;
  const operationKind = interactionActivityOperationKind(receipt);
  if (
    !project(receipt) ||
    interactionIsViewerActivity(receipt) ||
    (receipt.type === "interaction.receipt" && receipt.target.kind !== "pane") ||
    (operationKind !== "workspace.pane.send" && operationKind !== "workspace.pane.read") ||
    !evidence ||
    destination?.kind !== "pane"
  )
    return { sequence, cursors, activity, panes: Object.freeze(panes) };
  const source = evidence.endpoints.source?.kind === "pane" ? evidence.endpoints.source : null;
  const projection = (
    endpoint: ResolvedInteractionEndpoint,
    direction: PaneInteractionProjection["direction"],
  ): PaneInteractionProjection => ({
    endpoint,
    sourceEndpoint: source,
    destinationEndpoint: destination,
    displayDestinationEndpoint: destination,
    effect: evidence.effect,
    operationKey,
    paneId: endpoint.semanticPaneId,
    direction,
    sourcePaneId: source?.semanticPaneId ?? null,
    destinationPaneId: destination.semanticPaneId,
    operationKind,
    operationId:
      receipt.type === "interaction.evidence" ? evidence.interactionId : receipt.operationId,
    phase: receipt.type === "interaction.evidence" ? "observed" : receipt.phase,
    origin: receipt.type === "interaction.evidence" ? "external" : receipt.origin,
    label: interactionReceiptLabel(receipt),
    sequence: receipt.sequence,
    at: interactionActivityAt(receipt),
  });
  panes[interactionPaneEndpointKey(destination)] = projection(destination, "incoming");
  if (source && interactionPaneEndpointKey(source) !== interactionPaneEndpointKey(destination))
    panes[interactionPaneEndpointKey(source)] = projection(source, "outgoing");
  return { sequence, cursors, activity, panes: Object.freeze(panes) };
}

export function interactionForPane(
  state: InteractionFeedState,
  endpoint: ResolvedInteractionEndpoint,
  nativeIdentity?: NativePaneIdentity | null,
  project: (entry: InteractionJournalEntry) => boolean = () => true,
): PaneInteractionProjection | null {
  const semantic = state.panes[interactionPaneEndpointKey(endpoint)] ?? null;
  if (!nativeIdentity) return semantic;
  const physical: NativePaneEndpoint = {
    kind: "native-pane",
    environmentId: endpoint.environmentId,
    serverScope: endpoint.serverScope,
    ...nativeIdentity,
  };
  const key = interactionNativePaneEndpointKey(physical);
  // At most INTERACTION_ACTIVITY_LIMIT entries. Current aliases are never written back
  // into retained history; a linked physical pane can appear in several sessions.
  for (const entry of state.activity) {
    if (
      entry.type !== "interaction.evidence" ||
      interactionIsViewerActivity(entry) ||
      !project(entry)
    )
      continue;
    const evidence = entry.evidence;
    const destination = evidence.endpoints.destination;
    if (destination.kind !== "native-pane" || interactionNativePaneEndpointKey(destination) !== key)
      continue;
    const operationKind = interactionActivityOperationKind(entry);
    if (operationKind !== "workspace.pane.read" && operationKind !== "workspace.pane.send")
      continue;
    if (semantic && semantic.sequence > entry.sequence) return semantic;
    const source = evidence.endpoints.source?.kind === "pane" ? evidence.endpoints.source : null;
    return {
      endpoint,
      sourceEndpoint: source,
      destinationEndpoint: destination,
      displayDestinationEndpoint: endpoint,
      effect: evidence.effect,
      operationKey: receiptOperationKey(entry),
      paneId: endpoint.semanticPaneId,
      direction: "incoming",
      sourcePaneId: source?.semanticPaneId ?? null,
      destinationPaneId: endpoint.semanticPaneId,
      operationKind,
      operationId: evidence.interactionId,
      phase: "observed",
      origin: "external",
      label: interactionReceiptLabel(entry),
      sequence: entry.sequence,
      at: interactionActivityAt(entry),
    };
  }
  return semantic;
}
