/* @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { componentPalette, type ComponentInteractionState, type ComponentTone } from "./state.ts";
import { Surface } from "./surface.tsx";

export type NavigationRowInputSource = "keyboard" | "mouse";

export interface NavigationRowProps extends ComponentInteractionState {
  readonly theme: SemanticThemeSnapshot;
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly marker?: string;
  readonly detail?: string;
  readonly detailMarker?: string;
  readonly detailAlign?: "adjacent" | "end";
  readonly tone?: ComponentTone;
  readonly onActivate?: (source: NavigationRowInputSource) => void;
}

/**
 * Shared one-row navigation control for catalog, session, and agent lists.
 * State precedence, colors, pointer capture, and Enter/Space activation live
 * here so sidebars only project semantic labels and typed intents.
 */
export function NavigationRow(props: NavigationRowProps) {
  const palette = () => componentPalette(props.theme, props, props.tone);
  const width = () => Math.max(1, Math.floor(props.width));
  const marker = () => props.marker ?? palette().marker;
  const markerWidth = () => Math.min(width(), Math.max(1, terminalDisplayWidth(marker()) + 1));
  const detail = () => props.detail ?? "";
  const detailPresentation = () =>
    `${props.detailMarker ? `${props.detailMarker} ` : ""}${detail()}`;
  const detailWidth = () =>
    detail().length > 0
      ? Math.min(
          Math.max(0, width() - markerWidth()),
          terminalDisplayWidth(detailPresentation()) + 1,
        )
      : 0;
  const labelWidth = () => {
    const available = Math.max(0, width() - markerWidth() - detailWidth());
    return props.detailAlign === "adjacent"
      ? Math.min(available, terminalDisplayWidth(props.label))
      : available;
  };
  const activate = (source: NavigationRowInputSource) => {
    if (props.disabled || !props.onActivate) return;
    props.onActivate(source);
  };

  useKeyboard((event) => {
    const key = event.name.toLowerCase();
    if (
      !props.focused ||
      props.disabled ||
      !props.onActivate ||
      event.eventType !== "press" ||
      (key !== "enter" && key !== "return" && key !== "space")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    activate("keyboard");
  });

  return (
    <Surface
      id={`ui-navigation-row:${props.id}`}
      theme={props.theme}
      width={width()}
      height={1}
      flexDirection="row"
      overflow="hidden"
      selected={props.selected}
      focused={props.focused}
      hovered={props.hovered}
      pressed={props.pressed}
      disabled={props.disabled}
      attention={props.attention}
      loading={props.loading}
      empty={props.empty}
      status={props.status}
      tone={props.tone}
      focusable={Boolean(props.onActivate) && !props.disabled}
      onMouseDown={(event) => {
        if (event.button !== 0 || !props.onActivate) return;
        event.preventDefault();
        event.stopPropagation();
        activate("mouse");
      }}
    >
      <text width={markerWidth()} fg={palette().accent} bg={palette().background}>
        {clipTerminal(`${marker()} `, markerWidth())}
      </text>
      <text width={labelWidth()} fg={palette().foreground} bg={palette().background}>
        {props.selected || props.focused ? (
          <strong>{clipTerminal(props.label, labelWidth())}</strong>
        ) : (
          clipTerminal(props.label, labelWidth())
        )}
      </text>
      {detailWidth() > 0 ? (
        <text width={detailWidth()} fg={palette().accent} bg={palette().background}>
          {clipTerminal(` ${detailPresentation()}`, detailWidth())}
        </text>
      ) : null}
    </Surface>
  );
}
