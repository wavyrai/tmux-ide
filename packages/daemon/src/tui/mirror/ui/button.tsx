/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { componentPalette, type ComponentInteractionState } from "./state.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "compact" | "default";

export interface ButtonProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  label: string;
  shortcut?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: number;
  onPress?: () => void;
}

function naturalButtonWidth(label: string, shortcut: string | undefined, size: ButtonSize): number {
  const inset = size === "compact" ? 2 : 4;
  return terminalDisplayWidth(label) + (shortcut ? terminalDisplayWidth(shortcut) + 1 : 0) + inset;
}

export function Button(props: ButtonProps) {
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
        attention: props.attention || variant() === "danger",
        loading: props.loading,
      },
      variant() === "danger" ? "blocked" : variant() === "primary" ? "accent" : "neutral",
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
    variant() === "ghost" && palette().state === "base" ? undefined : palette().background;

  return (
    <box
      id={`ui-button:${props.label}`}
      width={width()}
      height={1}
      flexDirection="row"
      backgroundColor={background()}
      overflow="hidden"
      onMouseDown={(event) => {
        if (event.button !== 0 || props.disabled || !props.onPress) return;
        event.stopPropagation();
        props.onPress();
      }}
    >
      <text
        fg={
          variant() === "ghost" && palette().state === "base"
            ? props.theme.roles.text.muted
            : palette().foreground
        }
        attributes={variant() === "primary" || props.focused ? 1 : 0}
      >
        {content()}
      </text>
    </box>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, "label" | "size"> {
  icon: string;
  label: string;
}

export function IconButton(props: IconButtonProps) {
  return (
    <Button
      {...props}
      label={props.icon}
      size="compact"
      width={props.width ?? 3}
      shortcut={undefined}
    />
  );
}
