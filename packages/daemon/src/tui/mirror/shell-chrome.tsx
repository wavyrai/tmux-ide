/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import type { HostedPanelView } from "./panel-host.ts";
import {
  shellStatusLine,
  shellSurfaceTabs,
  shellVisualPalette,
  type ShellChromeLayout,
  type ShellChromeVariant,
  type ShellSidebarHint,
} from "./shell-chrome.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { clipTerminal } from "./missions-workspace.ts";

export interface ShellTabBarProps {
  theme: SemanticThemeSnapshot;
  width: number;
  variant: ShellChromeVariant;
  views: readonly HostedPanelView[];
  activeViewId: string;
  hoveredIndex: number | null;
  attentionViewIds?: ReadonlySet<string>;
  note?: string | null;
  rightChips?: readonly {
    id: string;
    label: string;
    hovered?: boolean;
    context?: boolean;
    attention?: boolean;
  }[];
}

export function ShellTabBar(props: ShellTabBarProps) {
  const tabs = () =>
    shellSurfaceTabs(
      props.views,
      props.activeViewId,
      props.variant,
      props.hoveredIndex,
      props.attentionViewIds,
    );
  return (
    <box
      height={1}
      width={props.width}
      flexDirection="row"
      backgroundColor={props.theme.roles.surfaces.header}
      overflow="hidden"
    >
      <For each={tabs()}>
        {(tab) => {
          const palette = () =>
            shellVisualPalette(props.theme, {
              selected: tab.selected,
              focused: tab.focused,
              hovered: tab.hovered,
              attention: tab.attention,
            });
          return (
            <box height={1} backgroundColor={palette().bg} flexDirection="row">
              <Show
                when={tab.attention && tab.label.includes("!")}
                fallback={
                  <text fg={palette().fg} attributes={palette().attributes}>
                    {tab.label}
                  </text>
                }
              >
                {(() => {
                  const markerIndex = tab.label.indexOf("!");
                  const before = tab.label.slice(0, markerIndex);
                  const after = tab.label.slice(markerIndex + 1);
                  return (
                    <>
                      <text fg={palette().fg} attributes={palette().attributes}>
                        {before}
                      </text>
                      <text fg={props.theme.roles.statusTone.warning} attributes={1}>
                        !
                      </text>
                      <text fg={palette().fg} attributes={palette().attributes}>
                        {after}
                      </text>
                    </>
                  );
                })()}
              </Show>
            </box>
          );
        }}
      </For>
      <box flexGrow={1} />
      <Show when={props.note}>
        <text fg={props.theme.roles.text.link} attributes={1}>
          {clipTerminal(`${props.note} `, Math.max(0, Math.floor(props.width / 3)))}
        </text>
      </Show>
      <For each={props.rightChips ?? []}>
        {(chip) => {
          const palette = () =>
            shellVisualPalette(props.theme, {
              hovered: chip.hovered,
              context: chip.context,
              attention: chip.attention,
            });
          return (
            <>
              <Show
                when={chip.attention && chip.label.includes("!")}
                fallback={
                  <text fg={palette().fg} bg={palette().bg} attributes={palette().attributes}>
                    {chip.label}
                  </text>
                }
              >
                {(() => {
                  const markerIndex = chip.label.indexOf("!");
                  const before = chip.label.slice(0, markerIndex);
                  const after = chip.label.slice(markerIndex + 1);
                  return (
                    <>
                      <text fg={palette().fg} bg={palette().bg} attributes={palette().attributes}>
                        {before}
                      </text>
                      <text
                        fg={props.theme.roles.statusTone.warning}
                        bg={palette().bg}
                        attributes={1}
                      >
                        !
                      </text>
                      <text fg={palette().fg} bg={palette().bg} attributes={palette().attributes}>
                        {after}
                      </text>
                    </>
                  );
                })()}
              </Show>
            </>
          );
        }}
      </For>
    </box>
  );
}

export interface ShellStatusStripProps {
  theme: SemanticThemeSnapshot;
  layout: ShellChromeLayout;
  project: string;
  mode: string;
  notification: string | null;
  help: string;
}

export function ShellStatusStrip(props: ShellStatusStripProps) {
  return (
    <box
      height={props.layout.status.height}
      width={props.layout.status.width}
      backgroundColor={props.theme.roles.surfaces.header}
      overflow="hidden"
    >
      <text fg={props.theme.roles.text.muted}>
        {shellStatusLine(
          props.layout.variant,
          {
            project: props.project,
            mode: props.mode,
            notification: props.notification,
            help: props.help,
          },
          props.layout.status.width,
        )}
      </text>
    </box>
  );
}

export interface ShellCompositeLeafChromeProps {
  theme: SemanticThemeSnapshot;
  title: string;
  panel: string;
  width: number;
  focused: boolean;
  terminalFocused?: boolean;
  attention?: boolean;
}

export function ShellCompositeLeafChrome(props: ShellCompositeLeafChromeProps) {
  const palette = () =>
    shellVisualPalette(props.theme, {
      focused: props.focused,
      terminalFocus: props.terminalFocused,
      attention: props.attention,
    });
  return (
    <box height={1} flexDirection="row" backgroundColor={palette().bg} overflow="hidden">
      <text fg={palette().border}>{palette().marker}</text>
      <text fg={palette().fg} attributes={palette().attributes}>
        {clipTerminal(` ${props.title} · ${props.panel}`, Math.max(0, props.width - 1))}
      </text>
    </box>
  );
}

export interface ShellMiniSidebarProps {
  theme: SemanticThemeSnapshot;
  width: number;
  variant: ShellChromeVariant;
  sessions: readonly {
    name: string;
    status: "idle" | "working" | "blocked" | "done" | "unknown";
  }[];
  active: string;
  hint: ShellSidebarHint;
}

function shellSessionStatusColor(
  theme: SemanticThemeSnapshot,
  status: ShellMiniSidebarProps["sessions"][number]["status"],
) {
  if (status === "blocked") return theme.roles.statusTone.warning;
  if (status === "working") return theme.roles.statusTone.info;
  if (status === "done") return theme.roles.statusTone.success;
  return theme.roles.statusTone.neutral;
}

export function ShellMiniSidebar(props: ShellMiniSidebarProps) {
  return (
    <box
      width={props.width}
      flexDirection="column"
      backgroundColor={props.theme.roles.surfaces.panel}
      paddingLeft={1}
      overflow="hidden"
    >
      <text fg={props.theme.roles.text.link} attributes={1}>
        {props.variant === "compact" ? " tmux" : " tmux-ide"}
      </text>
      <For each={props.sessions}>
        {(session) => {
          const selected = () => session.name === props.active;
          const palette = () => shellVisualPalette(props.theme, { selected: selected() });
          return (
            <box height={1} flexDirection="row" backgroundColor={palette().bg}>
              <text fg={shellSessionStatusColor(props.theme, session.status)}>
                {selected() ? "●" : "○"}
              </text>
              <text fg={palette().fg}>
                {clipTerminal(` ${session.name}`, Math.max(0, props.width - 1))}
              </text>
            </box>
          );
        }}
      </For>
      <box flexGrow={1} />
      <box height={1} width={props.width} flexDirection="row" overflow="hidden">
        <text fg={props.theme.roles.text.muted}>{props.hint.pre}</text>
        <text fg={props.theme.roles.text.primary} bg={props.theme.roles.selection.hover}>
          {props.hint.btn}
        </text>
        <text fg={props.theme.roles.text.muted}>{props.hint.post}</text>
      </box>
    </box>
  );
}
