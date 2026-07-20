/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { ActionChip } from "./recipes.tsx";
import { recipePalette } from "./recipes.ts";
import { terminalChromeHitTest, type TerminalPaneChromeProjection } from "./terminal-surface.ts";

export interface TerminalPaneChromeProps {
  theme: SemanticThemeSnapshot;
  projection: TerminalPaneChromeProjection;
  children?: unknown;
}

export function TerminalPaneChrome(props: TerminalPaneChromeProps) {
  const palette = () =>
    recipePalette(props.theme, {
      focused: props.projection.focused,
      attention: props.projection.attention,
    });
  return (
    <box
      width={props.projection.width}
      height={props.projection.height}
      position="relative"
      overflow="hidden"
      backgroundColor={props.theme.colors.background}
    >
      <box
        position="absolute"
        left={0}
        top={props.projection.header.y}
        width={props.projection.header.width}
        height={props.projection.header.height}
        backgroundColor={palette().background}
        overflow="hidden"
      >
        <text fg={palette().accent}>{` ${props.projection.title}`}</text>
        <For each={props.projection.actions}>
          {(action) => (
            <box position="absolute" left={action.start} top={0} width={action.width} height={1}>
              <ActionChip
                theme={props.theme}
                label={action.label}
                width={action.width}
                hovered={action.hovered}
                selected={action.active}
                disabled={action.disabled}
              />
            </box>
          )}
        </For>
      </box>
      <box
        position="absolute"
        left={props.projection.body.x}
        top={props.projection.body.y}
        width={props.projection.body.width}
        height={props.projection.body.height}
        overflow="hidden"
      >
        <Show
          when={props.children}
          fallback={<text fg={props.theme.colors.mutedForeground}>terminal framebuffer</text>}
        >
          {props.children as never}
        </Show>
      </box>
      <Show when={props.projection.footer.height > 0}>
        <box
          position="absolute"
          left={0}
          top={props.projection.footer.y}
          width={props.projection.footer.width}
          height={props.projection.footer.height}
          overflow="hidden"
        >
          <text fg={props.theme.colors.mutedForeground}>{` ${props.projection.status}`}</text>
        </box>
      </Show>
    </box>
  );
}

export { terminalChromeHitTest };
