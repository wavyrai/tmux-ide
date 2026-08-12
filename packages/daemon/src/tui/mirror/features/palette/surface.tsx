/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";

import type { SemanticThemeSnapshot } from "../../theme.ts";
import { palettePos } from "../../palette.ts";
import { CommandPaletteSurface } from "../../workspace/command-palette-surface.tsx";
import type { PaletteFeatureSession } from "./contract.ts";

export interface PaletteFeatureSurfaceProps {
  readonly session: PaletteFeatureSession;
  readonly theme: SemanticThemeSnapshot;
}

export function PaletteFeatureSurface(props: PaletteFeatureSurfaceProps) {
  const snapshot = () => props.session.snapshot();
  const bufferError = () => {
    const state = snapshot().buffers;
    return state.phase === "error" ? state.message : "";
  };
  const bufferWidth = () => Math.min(64, Math.max(12, snapshot().projection.width - 4));
  const position = () =>
    palettePos(snapshot().projection.width, snapshot().projection.height, bufferWidth());
  return (
    <Show
      when={snapshot().level === "buffers"}
      fallback={
        <CommandPaletteSurface theme={props.theme} projection={props.session.projection()} />
      }
    >
      <box
        position="absolute"
        left={position().left}
        top={position().top}
        width={bufferWidth()}
        flexDirection="column"
        backgroundColor={props.theme.roles.surfaces.command}
        border
        borderColor={props.theme.roles.borders.focused}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row">
          <text fg={props.theme.roles.text.link} attributes={1}>
            {"⎘ Paste buffer"}
          </text>
          <box flexGrow={1} />
          <text fg={props.theme.roles.text.muted}>{"esc back"}</text>
        </box>
        <text fg={props.theme.roles.borders.subtle}>
          {"─".repeat(Math.max(0, bufferWidth() - 4))}
        </text>
        <Show when={snapshot().buffers.phase === "loading"}>
          <text fg={props.theme.roles.text.muted}>Loading tmux buffers…</text>
        </Show>
        <Show when={snapshot().buffers.phase === "error"}>
          <text fg={props.theme.roles.statusTone.danger}>{bufferError()}</text>
          <text fg={props.theme.roles.text.muted}>r retry · esc back</text>
        </Show>
        <For each={snapshot().buffers.value.slice(snapshot().scrollTop, snapshot().scrollTop + 10)}>
          {(buffer, index) => {
            const selected = () =>
              snapshot().scrollTop + index() === snapshot().selectedBufferIndex;
            return (
              <box
                height={1}
                flexDirection="row"
                backgroundColor={
                  selected()
                    ? props.theme.roles.selection.selection
                    : props.theme.roles.surfaces.command
                }
              >
                <text
                  fg={
                    selected()
                      ? props.theme.roles.selection.selectionText
                      : props.theme.roles.text.secondary
                  }
                >
                  {`${selected() ? "›" : " "} ${buffer.name}  ${buffer.preview}`.slice(
                    0,
                    Math.max(0, bufferWidth() - 4),
                  )}
                </text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
