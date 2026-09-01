/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { useKeyboard } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { componentPalette, type ComponentInteractionState, type ComponentTone } from "./state.ts";

export interface StatusBarProps {
  theme: SemanticThemeSnapshot;
  width: number;
  children?: JSX.Element;
}

export function StatusBar(props: StatusBarProps) {
  return (
    <box
      id="ui-status-bar"
      width={props.width}
      height={1}
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={props.theme.roles.surfaces.header}
      overflow="hidden"
    >
      {props.children}
    </box>
  );
}

export interface StatusBarGroupProps {
  width?: number;
  grow?: boolean;
  align?: "start" | "end";
  children?: JSX.Element;
}

export function StatusBarGroup(props: StatusBarGroupProps) {
  return (
    <box
      id="ui-status-bar-group"
      width={props.width}
      flexGrow={props.grow ? 1 : 0}
      flexShrink={props.grow ? 1 : 0}
      height={1}
      flexDirection="row"
      justifyContent={props.align === "end" ? "flex-end" : "flex-start"}
      overflow="hidden"
    >
      {props.children}
    </box>
  );
}

export interface StatusSegmentProps extends ComponentInteractionState {
  theme: SemanticThemeSnapshot;
  label: string;
  width?: number;
  tone?: ComponentTone;
  marker?: string;
  active?: boolean;
  strong?: boolean;
  onPress?: () => void;
}

/** Compatibility props name retained while production callers migrate. */
export type StatusBarSegmentProps = StatusSegmentProps;

export interface StatusBarActionProps {
  theme: SemanticThemeSnapshot;
  label: string;
  shortcut?: string;
  width?: number;
  primary?: boolean;
  focused?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/** A real status-bar control: compact, mouse-addressable, and visually distinct from status text. */
export function StatusBarAction(props: StatusBarActionProps) {
  const content = () => ` ${props.label}${props.shortcut ? ` ${props.shortcut}` : ""} `;
  const background = () =>
    props.primary ? props.theme.roles.selection.selection : props.theme.roles.surfaces.panelRaised;
  const activate = () => {
    if (!props.disabled) props.onPress();
  };
  useKeyboard((event) => {
    const key = event.name.toLowerCase();
    if (
      !props.focused ||
      props.disabled ||
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
      id={`ui-status-action:${props.label}`}
      height={1}
      width={props.width}
      backgroundColor={background()}
      overflow="hidden"
      focusable={!props.disabled}
      focused={Boolean(props.focused)}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (props.disabled) return;
        activate();
      }}
    >
      <text
        bg={background()}
        fg={
          props.primary
            ? props.theme.roles.selection.selectionText
            : props.theme.roles.text.secondary
        }
      >
        {props.primary || props.focused ? (
          <strong>{clipTerminal(content(), props.width ?? 200)}</strong>
        ) : (
          clipTerminal(content(), props.width ?? 200)
        )}
      </text>
    </box>
  );
}

export function StatusSegment(props: StatusSegmentProps) {
  const palette = () =>
    componentPalette(
      props.theme,
      {
        selected: props.selected || props.active,
        focused: props.focused,
        hovered: props.hovered,
        pressed: props.pressed,
        disabled: props.disabled,
        attention: props.attention,
        loading: props.loading,
        empty: props.empty,
      },
      props.tone,
    );
  const background = () =>
    palette().state === "base" ? props.theme.roles.surfaces.header : palette().background;
  const foreground = () => {
    if (palette().state !== "base") return palette().foreground;
    if (props.tone && props.tone !== "neutral") return palette().accent;
    return props.theme.roles.text.muted;
  };
  const content = () => ` ${props.marker ? `${props.marker} ` : ""}${props.label} `;
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
      id={`ui-status-segment:${props.label}`}
      height={1}
      width={props.width}
      backgroundColor={background()}
      overflow="hidden"
      focusable={Boolean(props.onPress) && !props.disabled}
      focused={Boolean(props.focused)}
      onMouseDown={(event) => {
        if (event.button !== 0 || !props.onPress) return;
        event.preventDefault();
        event.stopPropagation();
        if (props.disabled) return;
        activate();
      }}
    >
      <text fg={foreground()} bg={background()}>
        {props.strong || props.active || props.focused ? (
          <strong>{clipTerminal(content(), props.width ?? 200)}</strong>
        ) : (
          clipTerminal(content(), props.width ?? 200)
        )}
      </text>
    </box>
  );
}

/** @deprecated Prefer `StatusSegment` for new component work. */
export const StatusBarSegment = StatusSegment;
