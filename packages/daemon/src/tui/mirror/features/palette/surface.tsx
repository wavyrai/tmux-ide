/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";

import type { SemanticThemeSnapshot } from "../../theme.ts";
import { clipTerminal } from "../../terminal-text.ts";
import { CommandPaletteSurface } from "../../workspace/command-palette-surface-view.tsx";
import type { PaletteFeatureSession } from "./contract.ts";
import { bufferPickerGeometry } from "./buffer-geometry.ts";

export interface PaletteFeatureSurfaceProps {
  readonly session: PaletteFeatureSession;
  readonly theme: SemanticThemeSnapshot;
}

export function PaletteFeatureSurface(props: PaletteFeatureSurfaceProps) {
  const snapshot = () => props.session.snapshot();
  const geometry = () =>
    bufferPickerGeometry(
      snapshot().projection.width,
      snapshot().projection.height,
      snapshot().buffers.phase === "ready" ? snapshot().buffers.value.length : 0,
      snapshot().scrollTop,
    );
  const message = () => {
    const state = snapshot().buffers;
    return state.phase === "loading"
      ? "Loading tmux buffers…"
      : state.phase === "error"
        ? state.message
        : "No tmux buffers";
  };
  return (
    <Show
      when={snapshot().level === "buffers"}
      fallback={
        <CommandPaletteSurface theme={props.theme} projection={props.session.projection()} />
      }
    >
      <box
        position="absolute"
        left={geometry().left}
        top={geometry().top}
        width={geometry().width}
        height={geometry().height}
        backgroundColor={props.theme.roles.surfaces.command}
        border={geometry().bordered ? true : []}
        borderColor={props.theme.roles.borders.focused}
        overflow="hidden"
      >
        <Show when={geometry().headerRows > 0}>
          <text
            position="absolute"
            left={0}
            top={0}
            width={geometry().contentWidth}
            height={1}
            overflow="hidden"
            fg={props.theme.roles.text.link}
            attributes={1}
          >
            {clipTerminal(
              snapshot().buffers.phase === "error"
                ? "r retry · esc back"
                : "⎘ Paste buffer · esc back",
              geometry().contentWidth,
            )}
          </text>
        </Show>
        <Show when={geometry().bordered}>
          <text
            position="absolute"
            left={0}
            top={1}
            width={geometry().contentWidth}
            height={1}
            fg={props.theme.roles.borders.subtle}
          >
            {"─".repeat(geometry().contentWidth)}
          </text>
        </Show>
        <Show when={snapshot().buffers.phase !== "ready" || snapshot().buffers.value.length === 0}>
          <text
            position="absolute"
            left={0}
            top={geometry().headerRows - geometry().inset}
            width={geometry().contentWidth}
            height={1}
            overflow="hidden"
            fg={props.theme.roles.text.secondary}
          >
            {clipTerminal(message(), geometry().contentWidth)}
          </text>
        </Show>
        <For
          each={(snapshot().buffers.phase === "ready" ? snapshot().buffers.value : []).slice(
            geometry().scrollTop,
            geometry().scrollTop + geometry().capacity,
          )}
        >
          {(buffer, index) => {
            const selected = () =>
              geometry().scrollTop + index() === snapshot().selectedBufferIndex;
            return (
              <text
                position="absolute"
                left={0}
                top={geometry().headerRows - geometry().inset + index()}
                width={geometry().contentWidth}
                height={1}
                overflow="hidden"
                bg={
                  selected()
                    ? props.theme.roles.selection.selection
                    : props.theme.roles.surfaces.command
                }
                fg={
                  selected()
                    ? props.theme.roles.selection.selectionText
                    : props.theme.roles.text.secondary
                }
              >
                {clipTerminal(
                  `${selected() ? "›" : " "} ${buffer.name}  ${buffer.preview}`,
                  geometry().contentWidth,
                )}
              </text>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
