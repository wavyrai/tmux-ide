/* @jsxImportSource @opentui/solid */
import { createMemo, For } from "solid-js";
import { actionChipWidth, recipePalette } from "../recipes.ts";
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

function NarrowTerminalAction(props: {
  theme: SemanticThemeSnapshot;
  action: NonNullable<TerminalPaneChromeProjection["frame"]>["actions"][number];
}) {
  const palette = () =>
    recipePalette(props.theme, {
      hovered: props.action.hovered,
      pressed: props.action.pressed,
      selected: props.action.active,
      disabled: props.action.disabled,
      attention: props.action.attention,
    });
  const text = () => props.action.label.slice(0, props.action.width).padEnd(props.action.width);
  return (
    <box
      position="absolute"
      left={props.action.start}
      top={0}
      width={props.action.width}
      height={1}
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <text fg={palette().foreground}>{text()}</text>
    </box>
  );
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
        const narrowActionIds = createMemo(
          () =>
            frame()
              .actions.filter(
                (action) => action.id === "zoom" && action.width < actionChipWidth(action.label),
              )
              .map((action) => action.id),
          undefined,
          { equals: sameIds },
        );
        const actionsById = createMemo(
          () => new Map(frame().actions.map((action) => [action.id, action])),
        );
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
            {/* The shared ActionChip reserves two marker cells. At widths 1–4
                  that would leave a correct hit target but no visible Z/R. Keep
                  the shared recipe untouched and overlay only terminal zoom's
                  literal glyph inside the exact same projected action span. */}
            <For each={narrowActionIds()}>
              {(actionId) => (
                <NarrowTerminalAction theme={props.theme} action={actionsById().get(actionId)!} />
              )}
            </For>
          </box>
        );
      }}
    </For>
  );
}
