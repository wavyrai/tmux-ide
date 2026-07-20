/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { For, Show } from "solid-js";
import {
  recipePalette,
  rowParts,
  scrollbarGlyphs,
  type RecipeInteractionState,
  type RecipeTone,
} from "./recipes.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { clipTerminal } from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";

interface ThemeProps {
  theme: SemanticThemeSnapshot;
}

export interface SurfaceProps extends ThemeProps {
  title?: string;
  height?: number;
  width?: number;
  focused?: boolean;
  attention?: boolean;
  children?: JSX.Element;
}

export function Surface(props: SurfaceProps) {
  const palette = () =>
    recipePalette(props.theme, { focused: props.focused, attention: props.attention });
  return (
    <box
      width={props.width}
      height={props.height}
      border
      borderColor={palette().border}
      borderStyle={props.focused ? props.theme.borders.focusedStyle : props.theme.borders.style}
      backgroundColor={props.theme.colors.background}
      flexDirection="column"
      overflow="hidden"
    >
      <Show when={props.title}>
        {(title) => <SectionHeader theme={props.theme} title={title()} focused={props.focused} />}
      </Show>
      {props.children}
    </box>
  );
}

export interface SectionHeaderProps extends ThemeProps {
  title: string;
  detail?: string;
  focused?: boolean;
  width?: number;
}

export function SectionHeader(props: SectionHeaderProps) {
  const palette = () => recipePalette(props.theme, { focused: props.focused });
  const body = () => {
    const detail = props.detail ? ` · ${props.detail}` : "";
    return clipTerminal(` ${props.title}${detail}`, Math.max(0, (props.width ?? 200) - 3));
  };
  return (
    <box height={1} backgroundColor={palette().background} overflow="hidden" flexDirection="row">
      <text fg={palette().accent}>{` ${palette().marker}`}</text>
      <text fg={palette().foreground}>{body()}</text>
    </box>
  );
}

export interface SelectableRowProps extends ThemeProps, RecipeInteractionState {
  label: string;
  meta?: string;
  width: number;
  tone?: RecipeTone;
}

export function SelectableRow(props: SelectableRowProps) {
  const palette = () => recipePalette(props.theme, props, props.tone);
  const parts = () => rowParts(palette().marker, props.label, props.meta ?? "", props.width);
  return (
    <box height={1} backgroundColor={palette().background} overflow="hidden" flexDirection="row">
      <text fg={palette().accent}>{parts().marker}</text>
      <text fg={palette().foreground}>{parts().body}</text>
    </box>
  );
}

export interface ButtonProps extends ThemeProps, RecipeInteractionState {
  label: string;
  tone?: RecipeTone;
  width?: number;
}

export function Button(props: ButtonProps) {
  const palette = () => recipePalette(props.theme, props, props.tone ?? "accent");
  const marker = () => (props.loading ? "…" : palette().marker);
  const body = () => {
    const width = props.width ?? props.label.length + 4;
    return `${clipTerminal(` ${props.label}`, Math.max(0, width - 3))} `;
  };
  return (
    <box
      height={1}
      width={props.width}
      backgroundColor={palette().background}
      overflow="hidden"
      flexDirection="row"
    >
      <text fg={palette().accent}>{` ${marker()}`}</text>
      <text fg={palette().foreground}>{body()}</text>
    </box>
  );
}

export const ActionChip = Button;

export interface BadgeProps extends ThemeProps {
  label: string;
  tone?: RecipeTone;
  width?: number;
  state?: RecipeInteractionState;
}

export function Badge(props: BadgeProps) {
  const state = (): RecipeInteractionState => {
    if (props.state) return props.state;
    if (props.tone && props.tone !== "neutral" && props.tone !== "accent") {
      return { status: props.tone };
    }
    return {};
  };
  const palette = () => recipePalette(props.theme, state(), props.tone);
  const label = () =>
    ` ${clipTerminal(props.label, Math.max(0, (props.width ?? props.label.length + 2) - 2))} `;
  return (
    <box height={1} width={props.width} backgroundColor={palette().accent} overflow="hidden">
      <text fg={props.theme.colors.selectionForeground}>{label()}</text>
    </box>
  );
}

export const StatusChip = Badge;

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps extends ThemeProps {
  items: readonly TabItem[];
  activeId: string;
  focusedId?: string;
  width: number;
}

export function SegmentedControl(props: SegmentedControlProps) {
  return (
    <box height={1} width={props.width} flexDirection="row" overflow="hidden">
      <For each={props.items}>
        {(item) => {
          const palette = () =>
            recipePalette(props.theme, {
              selected: item.id === props.activeId,
              focused: item.id === props.focusedId,
              disabled: item.disabled,
            });
          const label = () => ` ${clipTerminal(item.label, 10)} `;
          return (
            <box height={1} backgroundColor={palette().background}>
              <text fg={palette().foreground}>{label()}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

export const Tabs = SegmentedControl;

export interface InputShellProps extends ThemeProps {
  value: string;
  placeholder?: string;
  focused?: boolean;
  disabled?: boolean;
  width: number;
}

export function InputShell(props: InputShellProps) {
  const palette = () =>
    recipePalette(props.theme, { focused: props.focused, disabled: props.disabled });
  const value = () => props.value || props.placeholder || "";
  const content = () => {
    const cursor = props.focused && !props.disabled ? "▏" : "";
    const width = Math.max(0, props.width - 4);
    const clipped = clipTerminal(`${value()}${cursor}`, width);
    return `${clipped}${" ".repeat(Math.max(0, width - terminalDisplayWidth(clipped)))}`;
  };
  return (
    <box
      height={1}
      width={props.width}
      backgroundColor={palette().background}
      overflow="hidden"
      flexDirection="row"
    >
      <text fg={palette().border}>│</text>
      <text fg={props.value ? palette().foreground : props.theme.colors.mutedForeground}>
        {` ${content()} `}
      </text>
      <text fg={palette().border}>│</text>
    </box>
  );
}

export interface KeyHintProps extends ThemeProps {
  keys: string;
  label: string;
  width?: number;
}

export function KeyHint(props: KeyHintProps) {
  return (
    <box height={1} width={props.width} overflow="hidden" flexDirection="row">
      <text fg={props.theme.colors.accent}>{props.keys}</text>
      <text fg={props.theme.colors.mutedForeground}> {clipTerminal(props.label, 40)}</text>
    </box>
  );
}

export interface EmptyStateProps extends ThemeProps {
  title: string;
  detail?: string;
  width: number;
}

export function EmptyState(props: EmptyStateProps) {
  const palette = () => recipePalette(props.theme, { empty: true });
  return (
    <box width={props.width} height={2} flexDirection="column" overflow="hidden">
      <box height={1} flexDirection="row" overflow="hidden">
        <text fg={palette().accent}>{` ${palette().marker}`}</text>
        <text fg={palette().foreground}>
          {clipTerminal(` ${props.title}`, Math.max(0, props.width - 2))}
        </text>
      </box>
      <text fg={props.theme.colors.mutedForeground}>
        {clipTerminal(`   ${props.detail ?? ""}`, props.width)}
      </text>
    </box>
  );
}

export interface ScrollbarProps extends ThemeProps {
  contentRows: number;
  viewportRows: number;
  top: number;
  height: number;
}

export function Scrollbar(props: ScrollbarProps) {
  return (
    <box width={1} height={props.height} flexDirection="column" overflow="hidden">
      <For each={scrollbarGlyphs(props.contentRows, props.viewportRows, props.top, props.height)}>
        {(glyph) => (
          <text fg={glyph === "█" ? props.theme.colors.accent : props.theme.colors.border}>
            {glyph}
          </text>
        )}
      </For>
    </box>
  );
}
