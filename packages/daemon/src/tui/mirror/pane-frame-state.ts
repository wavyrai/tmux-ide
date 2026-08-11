import type { PaneAttention } from "@tmux-ide/contracts";
import {
  paneInteractionPresence,
  paneInteractionRelationshipLabel,
  type PaneInteractionPresence,
  type PaneInteractionPresenceRole,
  type PaneInteractionProjection,
} from "@tmux-ide/core";
import type { LivePane } from "./semantic-session-view.ts";

export type PaneChromeKeyboardFocus = "focused" | "blurred";
export type PaneChromeInputOwnership = "controller" | "viewer";

export interface PaneChromeInteractionState extends PaneInteractionPresence {
  /** Privacy-safe relationship text produced by the shared receipt vocabulary. */
  readonly label: string;
}

export interface PaneChromeState {
  /** Keyboard routing. This is never inferred from receipt activity. */
  readonly keyboardFocus: PaneChromeKeyboardFocus;
  /** SessionRuntime controller/input authority, independent from keyboard routing. */
  readonly inputOwnership: PaneChromeInputOwnership;
  /** Read and send remain orthogonal even if two transient operations overlap. */
  readonly reading: PaneChromeInteractionState | null;
  readonly sending: PaneChromeInteractionState | null;
  readonly attention: PaneAttention;
}

export interface PaneChromeStateInput {
  readonly keyboardFocused: boolean;
  readonly inputOwned: boolean;
  readonly attention?: PaneAttention;
  readonly interaction?: PaneInteractionProjection | null;
  readonly paneLabel?: (semanticPaneId: string) => string;
}

export type PaneChromePrimaryMarker = "input-owner" | "attention" | "keyboard-focus" | "idle";

export interface PaneChromeVisualState {
  /** Marker precedence is independent from the communication treatment. */
  readonly primaryMarker: PaneChromePrimaryMarker;
  /** Transfer is stronger than observation when their short presence windows overlap. */
  readonly communication: PaneChromeInteractionState | null;
}

/**
 * Project receipt-backed pane chrome state without reinterpreting operation
 * kinds, phases, labels, badges, or tones locally. Those facts belong to core
 * so DOM and OpenTUI surfaces cannot drift.
 */
export function projectPaneChromeState(input: PaneChromeStateInput): PaneChromeState {
  const interaction = input.interaction
    ? paneChromeInteractionState(input.interaction, input.paneLabel)
    : null;
  return Object.freeze({
    keyboardFocus: input.keyboardFocused ? "focused" : "blurred",
    inputOwnership: input.inputOwned ? "controller" : "viewer",
    reading: interaction?.kind === "read" ? interaction : null,
    sending: interaction?.kind === "send" ? interaction : null,
    attention: input.attention ?? "none",
  });
}

export function paneChromeInteractionState(
  interaction: PaneInteractionProjection,
  paneLabel?: (semanticPaneId: string) => string,
): PaneChromeInteractionState {
  const presence = paneInteractionPresence(interaction);
  return Object.freeze({
    ...presence,
    label: paneInteractionRelationshipLabel(interaction, paneLabel),
  });
}

/**
 * Deterministic visual precedence. Input ownership, attention and keyboard
 * focus share the marker channel; read/send use a separate badge/rail channel
 * and therefore can never masquerade as focus.
 */
export function resolvePaneChromeVisualState(state: PaneChromeState): PaneChromeVisualState {
  const primaryMarker: PaneChromePrimaryMarker =
    state.inputOwnership === "controller"
      ? "input-owner"
      : state.attention !== "none"
        ? "attention"
        : state.keyboardFocus === "focused"
          ? "keyboard-focus"
          : "idle";
  return Object.freeze({
    primaryMarker,
    communication: state.sending ?? state.reading,
  });
}

export function samePaneChromeState(left: PaneChromeState, right: PaneChromeState): boolean {
  return (
    left.keyboardFocus === right.keyboardFocus &&
    left.inputOwnership === right.inputOwnership &&
    samePaneChromeInteraction(left.reading, right.reading) &&
    samePaneChromeInteraction(left.sending, right.sending) &&
    left.attention === right.attention
  );
}

function samePaneChromeInteraction(
  left: PaneChromeInteractionState | null,
  right: PaneChromeInteractionState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.role === right.role &&
    left.kind === right.kind &&
    left.endpoint === right.endpoint &&
    left.treatment === right.treatment &&
    left.tone === right.tone &&
    left.badge === right.badge &&
    left.label === right.label
  );
}

export type { PaneInteractionPresenceRole };

/**
 * Pane layout state is deliberately separate from terminal cells and focus.
 * A busy pane changes `version` on every parsed chunk, while focus has its own
 * synchronous control-plane signal; neither should invalidate shell geometry.
 */
export function sameLivePaneStructure(
  previous: readonly LivePane[],
  next: readonly LivePane[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index++) {
    const left = previous[index]!;
    const right = next[index]!;
    if (
      left.id !== right.id ||
      left.left !== right.left ||
      left.top !== right.top ||
      left.width !== right.width ||
      left.height !== right.height ||
      left.appMouse !== right.appMouse ||
      left.zoomed !== right.zoomed ||
      left.snapshot.scrollOffset !== right.snapshot.scrollOffset
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the pane that owns terminal input and chrome. Explicit control-plane
 * focus wins while it belongs to the visible window; the geometry snapshot is
 * only the bootstrap/fallback authority.
 */
export function activeLivePaneId(
  panes: readonly LivePane[],
  focusedPaneId: string | null,
): string | null {
  if (focusedPaneId && panes.some((pane) => pane.id === focusedPaneId)) return focusedPaneId;
  return panes.find((pane) => pane.active)?.id ?? null;
}

/** Project focus into pane chrome without coupling it to terminal pixels. */
export function withLivePaneFocus(
  panes: readonly LivePane[],
  focusedPaneId: string | null,
): LivePane[] {
  const activeId = activeLivePaneId(panes, focusedPaneId);
  return panes.map((pane) => {
    const active = pane.id === activeId;
    return pane.active === active ? pane : { ...pane, active };
  });
}

export interface LivePaneRuntime {
  readonly version: number;
  readonly scrollbackDepth: number;
}

export function livePaneRuntime(panes: readonly LivePane[]): ReadonlyMap<string, LivePaneRuntime> {
  return new Map(
    panes.map((pane) => [
      pane.id,
      { version: pane.version, scrollbackDepth: pane.scrollbackDepth },
    ]),
  );
}

export function sameLivePaneRuntime(
  previous: ReadonlyMap<string, LivePaneRuntime>,
  next: ReadonlyMap<string, LivePaneRuntime>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [paneId, runtime] of previous) {
    const candidate = next.get(paneId);
    if (
      !candidate ||
      candidate.version !== runtime.version ||
      candidate.scrollbackDepth !== runtime.scrollbackDepth
    ) {
      return false;
    }
  }
  return true;
}
