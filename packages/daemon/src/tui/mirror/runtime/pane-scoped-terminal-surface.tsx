/* @jsxImportSource @opentui/solid */
import { createRenderEffect, onCleanup } from "solid-js";

import type {
  PaneSearchHighlight,
  PaneSurfaceHostFocusTransitionOwner,
  PaneSurfaceRenderable,
} from "../pane-surface.tsx";
import type { TerminalPaletteProjection } from "../theme.ts";
import type { Cell } from "../selection.ts";

export interface PaneScopedTerminalAdapter {
  readonly renderSource: import("../pane-surface.tsx").TerminalPaneRenderSource;
  paneVersion(paneId: string): number;
  paneSourceEpoch(): number;
  subscribePaneVersion(
    paneId: string,
    listener: (version: number, sourceEpoch: number) => void,
  ): () => void;
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
  readonly sourceEpoch: number;
  readonly hostFocusTransitionOwner?: PaneSurfaceHostFocusTransitionOwner;
  readonly selRange: { readonly start: Cell; readonly end: Cell } | null;
  readonly search: PaneSearchHighlight | null;
}

/** One Solid owner per terminal pane; terminal output never wakes the root shell. */
export function PaneScopedTerminalSurface(props: PaneScopedTerminalSurfaceProps) {
  let surface: PaneSurfaceRenderable | undefined;

  // This subscription is part of renderer ownership, so install it in the
  // synchronous render phase. A deferred effect can miss publications between
  // the initial blit and the first effect flush (and OpenTUI's deterministic
  // renderer does not promise an extra idle frame just to flush effects).
  createRenderEffect(() => {
    const adapter = props.adapter;
    const paneId = props.paneId;
    const rendererEpoch = props.sourceEpoch;
    if (surface) {
      surface.contentVersion = adapter.paneVersion(paneId);
      surface.sourceEpoch = rendererEpoch + adapter.paneSourceEpoch();
    }
    const unsubscribe = adapter.subscribePaneVersion(paneId, (version, sourceEpoch) => {
      if (!surface) return;
      surface.contentVersion = version;
      surface.sourceEpoch = rendererEpoch + sourceEpoch;
    });
    onCleanup(unsubscribe);
  });

  return (
    <pane_surface
      ref={(renderable: PaneSurfaceRenderable) => {
        surface = renderable;
        renderable.contentVersion = props.adapter.paneVersion(props.paneId);
        renderable.sourceEpoch = props.sourceEpoch + props.adapter.paneSourceEpoch();
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
      sourceEpoch={props.sourceEpoch + props.adapter.paneSourceEpoch()}
      rendererEpoch={props.sourceEpoch}
      hostFocusTransitionOwner={props.hostFocusTransitionOwner}
      selRange={props.selRange}
      search={props.search}
    />
  );
}
