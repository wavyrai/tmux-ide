/* @jsxImportSource @opentui/solid */
import { useKeyboard } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { componentPalette, type ComponentInteractionState } from "./state.ts";

export interface KeyHintProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  keys: string;
  label?: string;
  width?: number;
  /** Exact cell projection for compact chrome that already owns spacing. */
  presentation?: string;
  onPress?: () => void;
}

/** A one-row, cell-aligned keyboard affordance with optional pointer/keyboard activation. */
export function KeyHint(props: KeyHintProps) {
  const palette = () => componentPalette(props.theme, props, "neutral");
  const text = () => props.presentation ?? `${props.keys}${props.label ? ` ${props.label}` : ""}`;
  const width = () => Math.max(1, Math.floor(props.width ?? terminalDisplayWidth(text()) + 2));
  const content = () => clipTerminal(props.presentation ?? ` ${text()} `, width());
  const activate = () => {
    if (!props.disabled) props.onPress?.();
  };
  useKeyboard((event) => {
    const key = event.name.toLowerCase();
    if (
      !props.focused ||
      props.disabled ||
      !props.onPress ||
      event.eventType !== "press" ||
      (key !== "enter" && key !== "return" && key !== "space")
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
  return (
    <box
      id={`ui-key-hint:${props.keys}`}
      width={width()}
      height={1}
      overflow="hidden"
      backgroundColor={palette().background}
      focusable={Boolean(props.onPress) && !props.disabled}
      focused={Boolean(props.focused)}
      onMouseDown={(event) => {
        if (event.button !== 0 || !props.onPress) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
    >
      <text fg={palette().foreground} bg={palette().background}>
        {props.focused || props.selected ? <strong>{content()}</strong> : content()}
      </text>
    </box>
  );
}
