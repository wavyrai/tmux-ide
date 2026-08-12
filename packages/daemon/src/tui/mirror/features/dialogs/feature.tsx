/* @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core";
import { For, Show, createMemo } from "solid-js";

import {
  confirmFooter,
  confirmOptions,
  dialogInnerW,
  dialogMarker,
  dialogRowText,
  promptFooter,
  selectFooter,
  wrapText,
  type DialogConfirmSpec,
  type DialogPromptSpec,
  type DialogSelectSpec,
} from "../../dialog-model.ts";
import type { SemanticThemeSnapshot } from "../../theme.ts";
import type { DialogFeatureSession, OpenDialogFeatureSnapshot } from "./contract.ts";
import { createDialogFeatureSession } from "./session.ts";

export { createDialogFeatureSession } from "./session.ts";
export type * from "./contract.ts";

export interface DialogFeatureSurfaceProps {
  readonly session: DialogFeatureSession;
  readonly theme: SemanticThemeSnapshot;
  readonly accent?: RGBA | null;
}

/** Passive overlay; the application root remains the single input owner. */
export function DialogFeatureSurface(props: DialogFeatureSurfaceProps) {
  const snapshot = createMemo(() => props.session.snapshot());
  const open = () => snapshot() as OpenDialogFeatureSnapshot;
  const innerWidth = () => dialogInnerW(open().geometry.width);
  const accent = () => props.accent ?? props.theme.roles.text.link;

  return (
    <Show when={snapshot().phase === "open"}>
      <Show when={open().spec.kind === "select"}>
        <box
          id="dialog-feature-surface"
          position="absolute"
          left={open().geometry.left}
          top={open().geometry.top}
          width={open().geometry.width}
          flexDirection="column"
          backgroundColor={props.theme.roles.surfaces.command}
          border
          borderColor={accent()}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={accent()} attributes={1}>
            {(open().spec as DialogSelectSpec).title.slice(0, innerWidth()).padEnd(innerWidth())}
          </text>
          <Show when={(open().spec as DialogSelectSpec).filterable !== false}>
            <box flexDirection="row">
              <text fg={accent()} attributes={1}>
                {"▸ "}
              </text>
              <text fg={props.theme.roles.text.primary}>{`${open().state.query}▏`}</text>
            </box>
          </Show>
          <text fg={props.theme.roles.borders.subtle}>{"─".repeat(innerWidth())}</text>
          <For each={open().visibleItems}>
            {(item, index) => {
              const absolute = () => open().state.top + index();
              const selected = () => absolute() === open().state.sel;
              const armed = () => absolute() === open().state.armed;
              const body = () =>
                dialogRowText(item, {
                  selected: selected(),
                  armed: armed(),
                  innerW: item.swatch ? innerWidth() - 2 : innerWidth(),
                }).slice(2);
              const markerColor = () =>
                item.current
                  ? accent()
                  : selected()
                    ? props.theme.roles.selection.selectionText
                    : props.theme.roles.text.secondary;
              const bodyColor = () =>
                armed()
                  ? props.theme.roles.statusTone.danger
                  : selected()
                    ? props.theme.roles.selection.selectionText
                    : props.theme.roles.text.secondary;
              return (
                <box
                  height={1}
                  flexDirection="row"
                  backgroundColor={
                    selected() || armed()
                      ? props.theme.roles.selection.selection
                      : props.theme.roles.surfaces.command
                  }
                >
                  <text fg={markerColor()}>{dialogMarker(item, selected())}</text>
                  <Show when={item.swatch}>
                    <text
                      fg={RGBA.fromInts(item.swatch![0], item.swatch![1], item.swatch![2], 255)}
                    >
                      {"● "}
                    </text>
                  </Show>
                  <text fg={bodyColor()}>{body()}</text>
                </box>
              );
            }}
          </For>
          <Show when={open().visibleItems.length === 0}>
            <text fg={props.theme.roles.text.muted}>{"  no matches"}</text>
          </Show>
          <text fg={props.theme.roles.text.muted}>
            {selectFooter(open().spec as DialogSelectSpec).slice(0, innerWidth())}
          </text>
        </box>
      </Show>

      <Show when={open().spec.kind === "prompt"}>
        <box
          id="dialog-feature-surface"
          position="absolute"
          left={open().geometry.left}
          top={open().geometry.top}
          width={open().geometry.width}
          flexDirection="column"
          backgroundColor={props.theme.roles.surfaces.command}
          border
          borderColor={accent()}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={accent()} attributes={1}>
            {(open().spec as DialogPromptSpec).title.slice(0, innerWidth()).padEnd(innerWidth())}
          </text>
          <text fg={props.theme.roles.borders.subtle}>{"─".repeat(innerWidth())}</text>
          <box flexDirection="row">
            <text fg={accent()} attributes={1}>
              {"▸ "}
            </text>
            <Show
              when={
                open().state.input.length === 0 && (open().spec as DialogPromptSpec).placeholder
              }
              fallback={<text fg={props.theme.roles.text.primary}>{`${open().state.input}▏`}</text>}
            >
              <text fg={props.theme.roles.text.primary}>{"▏"}</text>
              <text fg={props.theme.roles.text.muted}>
                {` ${(open().spec as DialogPromptSpec).placeholder}`}
              </text>
            </Show>
          </box>
          <text
            fg={
              promptFooter(open().spec as DialogPromptSpec, open().state).error
                ? props.theme.roles.statusTone.danger
                : props.theme.roles.text.muted
            }
          >
            {promptFooter(open().spec as DialogPromptSpec, open().state).text.slice(
              0,
              innerWidth(),
            )}
          </text>
        </box>
      </Show>

      <Show when={open().spec.kind === "confirm"}>
        <box
          id="dialog-feature-surface"
          position="absolute"
          left={open().geometry.left}
          top={open().geometry.top}
          width={open().geometry.width}
          flexDirection="column"
          backgroundColor={props.theme.roles.surfaces.command}
          border
          borderColor={accent()}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={accent()} attributes={1}>
            {(open().spec as DialogConfirmSpec).title.slice(0, innerWidth()).padEnd(innerWidth())}
          </text>
          <text fg={props.theme.roles.borders.subtle}>{"─".repeat(innerWidth())}</text>
          <For
            each={
              (open().spec as DialogConfirmSpec).body
                ? wrapText((open().spec as DialogConfirmSpec).body!, innerWidth())
                : []
            }
          >
            {(line) => <text fg={props.theme.roles.text.secondary}>{line || " "}</text>}
          </For>
          <For each={confirmOptions(open().spec as DialogConfirmSpec)}>
            {(label, index) => {
              const selected = () => open().state.sel === index();
              return (
                <box
                  height={1}
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
                    {`${selected() ? "› " : "  "}${label}`.slice(0, innerWidth())}
                  </text>
                </box>
              );
            }}
          </For>
          <text fg={props.theme.roles.text.muted}>{confirmFooter()}</text>
        </box>
      </Show>
    </Show>
  );
}
