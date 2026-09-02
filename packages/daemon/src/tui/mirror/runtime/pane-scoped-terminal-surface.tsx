/* @jsxImportSource @opentui/solid */
import { createRenderEffect, onCleanup, untrack, type Accessor } from "solid-js";

import type {
  PaneSearchHighlight,
  PaneSurfaceHostFocusTransitionOwner,
  PaneSurfaceRenderable,
} from "../pane-surface.tsx";
import type { TerminalPaletteProjection } from "../theme.ts";
import type { Cell } from "../selection.ts";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";

export interface PaneScopedTerminalAdapter {
  readonly renderSource: import("../pane-surface.tsx").TerminalPaneRenderSource;
  paneVersion(paneId: string): number;
  panePresentationVersion?(paneId: string): number;
  paneSourceEpoch(): number;
  /** Coalesced exceptional recovery when a formerly coherent snapshot is absent. */
  requestPaneReseed?(paneId: string): boolean;
  subscribePaneVersion(
    paneId: string,
    listener: (
      version: number,
      sourceEpoch: number,
      presentationVersion: number,
      kind: "content" | "presentation",
    ) => void,
  ): () => void;
  /** Immutable canonical state used only by explicit selection/copy gestures. */
  paneSelectionSnapshot(paneId: string): TerminalReplicaSnapshot | null;
}

export interface PaneScopedTerminalSurfaceProps {
  readonly adapter: PaneScopedTerminalAdapter;
  readonly paneId: string;
  readonly width: number;
  readonly height: number;
  readonly defaultFg: number;
  readonly defaultBg: number;
  readonly terminalPalette: TerminalPaletteProjection;
  readonly searchHl: number;
  readonly searchCur: number;
  readonly scrollOffset: number;
  readonly paneFocused: boolean;
  /** Renderer-owned identity for the current native framebuffer presentation. */
  readonly presentationGeneration?: string;
  /** Retain inactive-window native surfaces without scheduling hidden paints. */
  readonly active?: boolean | Accessor<boolean>;
  readonly sourceEpoch: number;
  readonly hostFocusTransitionOwner?: PaneSurfaceHostFocusTransitionOwner;
  readonly selRange: { readonly start: Cell; readonly end: Cell } | null;
  readonly search: PaneSearchHighlight | null;
}

/** One Solid owner per terminal pane; terminal output never wakes the root shell. */
export function PaneScopedTerminalSurface(props: PaneScopedTerminalSurfaceProps) {
  let surface: PaneSurfaceRenderable | undefined;
  let activationEpoch = 0;
  let wasActive = false;
  let hadCanonicalSnapshot = false;
  const isActive = (): boolean =>
    typeof props.active === "function" ? props.active() : props.active !== false;
  const currentPresentationGeneration = (): string =>
    `${props.presentationGeneration ?? "stable"}:activation-${activationEpoch}`;
  const ensureRetainedCanonicalState = (
    adapter: PaneScopedTerminalAdapter,
    paneId: string,
  ): void => {
    const identity = adapter.renderSource.paneCanonicalIdentity?.(paneId) ?? null;
    if (identity) {
      hadCanonicalSnapshot = true;
      return;
    }
    if (hadCanonicalSnapshot) adapter.requestPaneReseed?.(paneId);
  };

  // This subscription is part of renderer ownership, so install it in the
  // synchronous render phase. A deferred effect can miss publications between
  // the initial blit and the first effect flush (and OpenTUI's deterministic
  // renderer does not promise an extra idle frame just to flush effects).
  createRenderEffect(() => {
    const adapter = untrack(() => props.adapter);
    const paneId = untrack(() => props.paneId);
    const rendererEpoch = untrack(() => props.sourceEpoch);
    if (surface && untrack(isActive)) {
      surface.contentVersion = adapter.paneVersion(paneId);
      surface.presentationVersion = adapter.panePresentationVersion?.(paneId) ?? 0;
      surface.sourceEpoch = rendererEpoch + adapter.paneSourceEpoch();
    }
    const unsubscribe = adapter.subscribePaneVersion(
      paneId,
      (version, sourceEpoch, presentationVersion, kind) => {
        if (!surface || !untrack(isActive)) return;
        if (kind === "presentation") surface.presentationVersion = presentationVersion;
        else surface.contentVersion = version;
        surface.sourceEpoch = rendererEpoch + sourceEpoch;
        ensureRetainedCanonicalState(adapter, paneId);
      },
    );
    onCleanup(unsubscribe);
  });

  createRenderEffect(() => {
    const active = isActive();
    if (active && !wasActive) activationEpoch += 1;
    wasActive = active;
    const presentationGeneration = currentPresentationGeneration();
    if (!active || !surface) return;
    surface.presentationGeneration = presentationGeneration;
    surface.contentVersion = props.adapter.paneVersion(props.paneId);
    surface.presentationVersion = props.adapter.panePresentationVersion?.(props.paneId) ?? 0;
    surface.sourceEpoch = props.sourceEpoch + props.adapter.paneSourceEpoch();
    ensureRetainedCanonicalState(props.adapter, props.paneId);
  });

  return (
    <pane_surface
      ref={(renderable: PaneSurfaceRenderable) => {
        surface = renderable;
        renderable.contentVersion = props.adapter.paneVersion(props.paneId);
        renderable.presentationVersion = props.adapter.panePresentationVersion?.(props.paneId) ?? 0;
        renderable.sourceEpoch = props.sourceEpoch + props.adapter.paneSourceEpoch();
        renderable.presentationGeneration = currentPresentationGeneration();
        ensureRetainedCanonicalState(props.adapter, props.paneId);
      }}
      width={props.width}
      height={props.height}
      mirror={props.adapter.renderSource}
      paneId={props.paneId}
      defaultFg={props.defaultFg}
      defaultBg={props.defaultBg}
      terminalPalette={props.terminalPalette}
      searchHl={props.searchHl}
      searchCur={props.searchCur}
      scrollOffset={props.scrollOffset}
      paneFocused={props.paneFocused}
      contentVersion={props.adapter.paneVersion(props.paneId)}
      presentationVersion={props.adapter.panePresentationVersion?.(props.paneId) ?? 0}
      sourceEpoch={props.sourceEpoch + props.adapter.paneSourceEpoch()}
      rendererEpoch={props.sourceEpoch}
      hostFocusTransitionOwner={props.hostFocusTransitionOwner}
      selRange={props.selRange}
      search={props.search}
    />
  );
}
