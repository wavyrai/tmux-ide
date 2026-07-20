/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
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
  return (
    <For each={projections()}>
      {(pane) => (
        <Show when={pane.frame}>
          {(frame) => (
            <box
              position="absolute"
              left={pane.layerRect.x}
              top={pane.layerRect.y}
              width={pane.layerRect.width}
              height={pane.layerRect.height}
              overflow="hidden"
            >
              <PaneFrameHeader theme={props.theme} projection={frame()} />
              {/* The shared ActionChip reserves two marker cells. At widths 1–4
                  that would leave a correct hit target but no visible Z/R. Keep
                  the shared recipe untouched and overlay only terminal zoom's
                  literal glyph inside the exact same projected action span. */}
              <For
                each={frame().actions.filter(
                  (action) => action.id === "zoom" && action.width < actionChipWidth(action.label),
                )}
              >
                {(action) => <NarrowTerminalAction theme={props.theme} action={action} />}
              </For>
            </box>
          )}
        </Show>
      )}
    </For>
  );
}
