/* @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { componentPalette, type ComponentInteractionState } from "./state.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "compact" | "default";

export interface TuiButtonProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  label: string;
  shortcut?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: number;
  /** Opaque surface used by neutral/ghost controls embedded in custom chrome. */
  background?: RGBA;
  onPress?: () => void;
}

/** Compatibility name retained while production callers migrate to `TuiButton`. */
export type ButtonProps = TuiButtonProps;

function naturalButtonWidth(label: string, shortcut: string | undefined, size: ButtonSize): number {
  const inset = size === "compact" ? 2 : 4;
  return terminalDisplayWidth(label) + (shortcut ? terminalDisplayWidth(shortcut) + 1 : 0) + inset;
}

export function TuiButton(props: TuiButtonProps) {
  const variant = () => props.variant ?? "secondary";
  const size = () => props.size ?? "default";
  const palette = () =>
    componentPalette(
      props.theme,
      {
        selected: props.selected || variant() === "primary",
        focused: props.focused,
        hovered: props.hovered,
        pressed: props.pressed,
        disabled: props.disabled,
        attention: props.attention,
        loading: props.loading,
      },
      variant() === "danger" ? "destructive" : variant() === "primary" ? "accent" : "neutral",
    );
  const width = () =>
    Math.max(1, Math.floor(props.width ?? naturalButtonWidth(props.label, props.shortcut, size())));
  const content = () => {
    const marker = props.loading ? "…" : size() === "compact" ? "" : `${palette().marker} `;
    const shortcut = props.shortcut ? ` ${props.shortcut}` : "";
    const inset = size() === "compact" ? 1 : 1;
    return clipTerminal(`${" ".repeat(inset)}${marker}${props.label}${shortcut} `, width());
  };
  const background = () =>
    variant() === "ghost" && palette().state === "base"
      ? (props.background ?? props.theme.roles.surfaces.panel)
      : palette().background;
  const activate = () => {
    if (props.disabled || props.loading || !props.onPress) return;
    props.onPress();
  };

  useKeyboard((event) => {
    if (!props.focused || props.disabled || props.loading || !props.onPress) return;
    const key = event.name.toLowerCase();
    if (event.eventType !== "press" || (key !== "enter" && key !== "return" && key !== "space"))
      return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  });

  return (
    <box
      id={`ui-button:${props.label}`}
      width={width()}
      height={1}
      flexDirection="row"
      backgroundColor={background()}
      overflow="hidden"
      focusable={Boolean(props.onPress) && !props.disabled}
      focused={Boolean(props.focused)}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (props.disabled || props.loading || !props.onPress) return;
        activate();
      }}
    >
      <text
        bg={background()}
        fg={
          variant() === "ghost" && palette().state === "base"
            ? props.theme.roles.text.muted
            : palette().foreground
        }
      >
        {variant() === "primary" || props.focused ? <strong>{content()}</strong> : content()}
      </text>
    </box>
  );
}

/** @deprecated Prefer the repository-scoped `TuiButton` name for new component work. */
export const Button = TuiButton;

export interface IconButtonProps extends Omit<TuiButtonProps, "label" | "size"> {
  icon: string;
  label: string;
}

export function IconButton(props: IconButtonProps) {
  return (
    <TuiButton
      {...props}
      label={props.icon}
      size="compact"
      width={props.width ?? 3}
      shortcut={undefined}
    />
  );
}
