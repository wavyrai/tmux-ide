/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import type { ComponentTone } from "./state.ts";

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

export interface StatusBarSegmentProps {
  theme: SemanticThemeSnapshot;
  label: string;
  width?: number;
  tone?: ComponentTone;
  active?: boolean;
  strong?: boolean;
}

export interface StatusBarActionProps {
  theme: SemanticThemeSnapshot;
  label: string;
  shortcut?: string;
  width?: number;
  primary?: boolean;
  onPress: () => void;
}

/** A real status-bar control: compact, mouse-addressable, and visually distinct from status text. */
export function StatusBarAction(props: StatusBarActionProps) {
  const content = () => ` ${props.label}${props.shortcut ? ` ${props.shortcut}` : ""} `;
  return (
    <box
      id={`ui-status-action:${props.label}`}
      height={1}
      width={props.width}
      backgroundColor={
        props.primary
          ? props.theme.roles.selection.selection
          : props.theme.roles.surfaces.panelRaised
      }
      overflow="hidden"
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        props.onPress();
      }}
    >
      <text
        fg={
          props.primary
            ? props.theme.roles.selection.selectionText
            : props.theme.roles.text.secondary
        }
        attributes={props.primary ? 1 : 0}
      >
        {clipTerminal(content(), props.width ?? 200)}
      </text>
    </box>
  );
}

export function StatusBarSegment(props: StatusBarSegmentProps) {
  const foreground = () => {
    if (props.tone === "blocked") return props.theme.roles.statusTone.warning;
    if (props.tone === "working") return props.theme.roles.statusTone.info;
    if (props.tone === "done") return props.theme.roles.statusTone.success;
    if (props.active) return props.theme.roles.text.link;
    return props.theme.roles.text.muted;
  };
  return (
    <box
      id={`ui-status-segment:${props.label}`}
      height={1}
      width={props.width}
      backgroundColor={
        props.active ? props.theme.roles.surfaces.panelRaised : props.theme.roles.surfaces.header
      }
      overflow="hidden"
    >
      <text fg={foreground()} attributes={props.strong || props.active ? 1 : 0}>
        {clipTerminal(` ${props.label} `, props.width ?? 200)}
      </text>
    </box>
  );
}
