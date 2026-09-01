/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { componentPalette, type ComponentInteractionState, type ComponentTone } from "./state.ts";

export interface BadgeProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  label: string;
  tone?: ComponentTone;
  width?: number;
  marker?: string;
  /** Exact cell projection for compound chrome that already owns spacing. */
  presentation?: string;
  surface?: "panel" | "header";
}

export function Badge(props: BadgeProps) {
  const palette = () => componentPalette(props.theme, props, props.tone);
  const background = () =>
    props.surface === "header" && palette().state === "base"
      ? props.theme.roles.surfaces.header
      : palette().background;
  const width = () => Math.max(1, Math.floor(props.width ?? terminalDisplayWidth(props.label) + 2));
  const content = () =>
    clipTerminal(
      props.presentation ?? ` ${props.marker ? `${props.marker} ` : ""}${props.label} `,
      width(),
    );
  return (
    <box
      id={`ui-badge:${props.label}`}
      height={1}
      width={width()}
      backgroundColor={background()}
      overflow="hidden"
    >
      <text fg={palette().accent} bg={background()}>
        {props.attention ? <strong>{content()}</strong> : content()}
      </text>
    </box>
  );
}
