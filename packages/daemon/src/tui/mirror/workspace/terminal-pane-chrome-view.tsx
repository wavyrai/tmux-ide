/* @jsxImportSource @opentui/solid */
import { createMemo, For } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { PaneFrame } from "./pane-frame.tsx";
import type {
  TerminalPaneChromeLayout,
  TerminalPaneChromeProjection,
} from "./terminal-pane-chrome.ts";

export interface SharedTerminalPaneChromeLayerProps {
  theme: SemanticThemeSnapshot;
  layout: TerminalPaneChromeLayout;
  layer: "native" | "framebuffer";
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Passive projection surface; the application root remains the only input owner. */
export function SharedTerminalPaneChromeLayer(props: SharedTerminalPaneChromeLayerProps) {
  const projections = (): readonly TerminalPaneChromeProjection[] =>
    props.layer === "native" ? props.layout.native : props.layout.framebuffer;
  // projectTerminalPaneChrome intentionally returns immutable value objects.
  // Keying Solid's <For> by those short-lived objects would tear down and
  // reinsert every header on visual-state ticks. Resolve fresh values through
  // pane ids so resident renderables survive focus/status/action changes.
  const projectionIds = createMemo(
    () =>
      projections()
        .filter((projection) => projection.frame !== null)
        .map((projection) => projection.paneId),
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
            id={`shared-terminal-pane-chrome:${props.layer}:${paneId}`}
            position="absolute"
            left={pane().layerRect.x}
            top={pane().layerRect.y}
            width={pane().layerRect.width}
            height={pane().layerRect.height}
            overflow="hidden"
          >
            <PaneFrame theme={props.theme} projection={frame()} />
          </box>
        );
      }}
    </For>
  );
}
