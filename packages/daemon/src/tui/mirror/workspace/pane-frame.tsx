/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { For, Show } from "solid-js";
import { ActionChip, StatusChip } from "../recipes.tsx";
import { recipePalette } from "../recipes.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { PaneFrameProjection } from "./pane-frame.ts";

export interface PaneFrameHeaderProps {
  theme: SemanticThemeSnapshot;
  projection: PaneFrameProjection;
}

export function PaneFrameHeader(props: PaneFrameHeaderProps) {
  const palette = () =>
    recipePalette(props.theme, {
      focused: props.projection.focused || props.projection.terminalFocused,
      attention: props.projection.attention,
    });
  return (
    <box
      width={props.projection.header.width}
      height={props.projection.header.height}
      position="relative"
      backgroundColor={palette().background}
      overflow="hidden"
    >
      <text fg={palette().foreground} attributes={props.projection.focused ? 1 : 0}>
        {props.projection.title}
      </text>
      <For each={props.projection.chips}>
        {(chip) => (
          <box position="absolute" left={chip.start} top={0} width={chip.width} height={1}>
            <Show
              when={chip.kind === "action" ? chip : null}
              fallback={
                <StatusChip
                  theme={props.theme}
                  label={chip.label}
                  width={chip.width}
                  tone={chip.kind === "status" ? chip.tone : "unknown"}
                />
              }
            >
              {(action) => (
                <ActionChip
                  theme={props.theme}
                  label={action().label}
                  width={action().width}
                  hovered={action().hovered}
                  selected={action().active}
                  disabled={action().disabled}
                  attention={action().attention}
                />
              )}
            </Show>
          </box>
        )}
      </For>
    </box>
  );
}

export interface PaneFrameProps extends PaneFrameHeaderProps {
  children?: JSX.Element;
}

export function PaneFrame(props: PaneFrameProps) {
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      flexDirection="column"
      backgroundColor={props.theme.colors.background}
      overflow="hidden"
    >
      <PaneFrameHeader theme={props.theme} projection={props.projection} />
      <box
        width={props.projection.body.width}
        height={props.projection.body.height}
        flexDirection="column"
        overflow="hidden"
      >
        {props.children}
      </box>
    </box>
  );
}
