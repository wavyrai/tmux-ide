/* @jsxImportSource @opentui/solid */
import { createMemo, For } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { PaneFrameHeader } from "./pane-frame.tsx";
import type {
  TerminalPaneChromeLayout,
  TerminalPaneChromeProjection,
} from "./terminal-pane-chrome.ts";

export interface TerminalPaneChromeLayerProps {
  theme: SemanticThemeSnapshot;
  layout: TerminalPaneChromeLayout;
  layer: "native" | "framebuffer";
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Passive projection surface; the application root remains the only input owner. */
export function TerminalPaneChromeLayer(props: TerminalPaneChromeLayerProps) {
  const projections = (): readonly TerminalPaneChromeProjection[] =>
    props.layer === "native" ? props.layout.native : props.layout.framebuffer;
  // projectTerminalPaneChrome intentionally returns immutable value objects.
  // Keying Solid's <For> by those short-lived objects made every hover/focus
  // tick tear down and reinsert the complete pane header. Key by the tmux pane
  // id instead, then resolve the latest value through a memo. The renderables
  // now survive visual-state updates and only their properties change.
  const projectionIds = createMemo(
    () =>
      projections()
        .filter((projection) => projection.frame !== null)
        .map((p) => p.paneId),
    undefined,
    { equals: sameIds },
  );
  const projectionsById = createMemo(
    () => new Map(projections().map((projection) => [projection.paneId, projection])),
  );
  return (
    <For each={projectionIds()}>
      {(paneId) => {
        const pane = () => projectionsById().get(paneId)!;
        const frame = () => pane().frame!;
        return (
          <box
            id={`terminal-pane-chrome:${props.layer}:${paneId}`}
            position="absolute"
            left={pane().layerRect.x}
            top={pane().layerRect.y}
            width={pane().layerRect.width}
            height={pane().layerRect.height}
            overflow="hidden"
          >
            <PaneFrameHeader theme={props.theme} projection={frame()} />
          </box>
        );
      }}
    </For>
  );
}
