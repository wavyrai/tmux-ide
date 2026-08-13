/* @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup } from "solid-js";

import type { PaneSearchHighlight } from "../pane-surface.tsx";
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
  readonly selRange: { readonly start: Cell; readonly end: Cell } | null;
  readonly search: PaneSearchHighlight | null;
}

/** One Solid owner per terminal pane; terminal output never wakes the root shell. */
export function PaneScopedTerminalSurface(props: PaneScopedTerminalSurfaceProps) {
  const [contentVersion, setContentVersion] = createSignal(0);
  const [paneSourceEpoch, setPaneSourceEpoch] = createSignal(0);

  createEffect(() => {
    const adapter = props.adapter;
    const paneId = props.paneId;
    setContentVersion(adapter.paneVersion(paneId));
    setPaneSourceEpoch(adapter.paneSourceEpoch());
    const unsubscribe = adapter.subscribePaneVersion(paneId, (version, sourceEpoch) => {
      setContentVersion(version);
      setPaneSourceEpoch(sourceEpoch);
    });
    onCleanup(unsubscribe);
  });

  return (
    <pane_surface
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
      contentVersion={contentVersion()}
      sourceEpoch={props.sourceEpoch + paneSourceEpoch()}
      selRange={props.selRange}
      search={props.search}
    />
  );
}
