/* @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js";
import {
  contextStatusPresentation,
  meaningfulStatusMessage,
  developmentChromeLabel,
  shellNavigationPresentation,
  shellSurfaceTabs,
  shellVisualPalette,
  type ShellChromeLayout,
  type ShellChromeView,
  type ShellChromeVariant,
  type ShellSidebarHint,
} from "./shell-chrome.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
import { clipTerminal, terminalDisplayWidth } from "./terminal-text.ts";
import { Badge } from "./ui/badge.tsx";
import { KeyHint } from "./ui/key-hint.tsx";
import { NavigationRow, type NavigationRowInputSource } from "./ui/navigation-row.tsx";
import { StatusBar, StatusBarGroup, StatusSegment } from "./ui/status-bar.tsx";
import { Surface } from "./ui/surface.tsx";
import { Tabs } from "./ui/tabs.tsx";

export interface ShellTabBarProps {
  theme: SemanticThemeSnapshot;
  width: number;
  variant: ShellChromeVariant;
  views: readonly ShellChromeView[];
  activeViewId: string;
  hoveredIndex: number | null;
  attentionViewIds?: ReadonlySet<string>;
  note?: string | null;
  rightChips?: readonly {
    id: string;
    label: string;
    hovered?: boolean;
    context?: boolean;
    textColor?: string;
    attention?: boolean;
  }[];
  navigationFocused?: boolean;
  onSelectView?: (viewId: string) => void;
}

export function ShellTabBar(props: ShellTabBarProps) {
  const development = developmentChromeLabel(process.env);
  const navigation = () =>
    shellNavigationPresentation(props.variant, props.navigationFocused ?? false);
  const tabs = () =>
    shellSurfaceTabs(
      props.views,
      props.activeViewId,
      props.variant,
      props.hoveredIndex,
      props.attentionViewIds,
      { startX: navigation().width, navigationFocused: props.navigationFocused },
    );
  const tabItems = () =>
    tabs().map((tab) => ({
      id: tab.id,
      label: props.views.find((view) => view.id === tab.id)?.title ?? tab.id,
      presentation: tab.label,
      attention: tab.attention,
    }));
  const focusedTab = () => tabs().find((tab) => tab.focused)?.id ?? props.activeViewId;
  return (
    <Surface
      theme={props.theme}
      variant="header"
      height={1}
      width={props.width}
      flexDirection="row"
      overflow="hidden"
    >
      <For each={navigation().width > 0 ? [navigation()] : []}>
        {(item) => (
          <Badge
            theme={props.theme}
            label={item.label.trim()}
            width={item.width}
            presentation={item.label}
            surface="header"
            focused={item.focused}
          />
        )}
      </For>
      <Tabs
        theme={props.theme}
        variant="header"
        items={tabItems()}
        activeId={props.activeViewId}
        hoveredId={tabs()[props.hoveredIndex ?? -1]?.id ?? null}
        focusedId={focusedTab()}
        focused={props.navigationFocused}
        {...(props.onSelectView ? { onSelect: props.onSelectView } : {})}
      />
      <box flexGrow={1} />
      <For each={development ? [development] : []}>
        {(label) => (
          <Badge
            theme={props.theme}
            label={label}
            presentation={`${label} `}
            width={label.length + 1}
            surface="header"
            tone="warning"
          />
        )}
      </For>
      <For
        each={
          meaningfulStatusMessage(props.note) &&
          /read.only|reconnect|disconnect|recover|unavailable|failed/iu.test(props.note ?? "")
            ? [props.note!]
            : []
        }
      >
        {(note) => (
          <Badge
            theme={props.theme}
            label={clipTerminal(note, Math.max(0, Math.floor(props.width / 3) - 2))}
            presentation={`${note} `}
            surface="header"
            width={Math.max(
              1,
              Math.min(Math.floor(props.width / 3), terminalDisplayWidth(note) + 1),
            )}
            tone="warning"
          />
        )}
      </For>
      <For each={props.rightChips ?? []}>
        {(chip) => (
          <text
            width={Math.min(
              Math.max(1, Math.floor(props.width / 3)),
              terminalDisplayWidth(chip.label),
            )}
            flexShrink={0}
            fg={
              chip.attention
                ? props.theme.roles.statusTone.warning
                : (chip.textColor ?? props.theme.roles.text.muted)
            }
            bg={props.theme.roles.surfaces.panel}
            overflow="hidden"
          >
            {clipTerminal(chip.label, Math.max(1, Math.floor(props.width / 3)))}
          </text>
        )}
      </For>
    </Surface>
  );
}

export interface ShellStatusStripProps {
  theme: SemanticThemeSnapshot;
  layout: ShellChromeLayout;
  project: string;
  session?: string;
  pane?: string | null;
  mode: string;
  inputMode?: string | null;
  tool?: string | null;
  dockMode?: string | null;
  focus?: string | null;
  onFooterAction?: (key: "F6" | "F7" | "F10") => void;
  scrollback?: boolean;
  notification: string | null;
  transient?: string | null;
  connectionState?: "connected" | "reconnecting" | "disconnected" | "recovering";
  help: string;
  onHelp?: () => void;
}

export function ContextStatusBar(props: ShellStatusStripProps) {
  const presentation = () =>
    contextStatusPresentation({
      variant: props.layout.variant,
      project: props.project,
      session: props.session ?? props.project,
      mode: props.mode,
      pane: props.pane,
      focus: props.focus,
      connectionState: props.connectionState ?? "connected",
      notification: props.notification,
      transient: props.transient,
    });
  const commandWidth = () =>
    Math.min(props.layout.status.width, props.layout.status.width >= 24 ? 13 : 4);
  const available = () => Math.max(0, props.layout.status.width - commandWidth());
  const activity = () => presentation().activity;
  const showMessage = () => !/^(?:Live|\d+ sessions? live)$/iu.test(activity().label);
  const hints = () => {
    const candidates = props.scrollback
      ? [{ keys: "Esc", label: "Back to live" }]
      : /^home$/iu.test(props.mode)
        ? [
            { keys: "↑↓", label: "Select" },
            { keys: "Enter", label: "Open" },
            { keys: "/", label: "Search" },
          ]
        : [
            { keys: "F6", label: "Sessions" },
            { keys: "F7", label: "Attention" },
            { keys: "F10", label: "Sidebar" },
          ];
    let remaining = available();
    return candidates.filter((hint) => {
      const width = terminalDisplayWidth(`${hint.keys} ${hint.label}`) + 2;
      if (width > remaining) return false;
      remaining -= width;
      return true;
    });
  };
  return (
    <StatusBar theme={props.theme} width={props.layout.status.width}>
      <StatusBarGroup width={available()} grow>
        <Show
          when={showMessage()}
          fallback={
            <For each={hints()}>
              {(hint) => {
                const action = () =>
                  hint.keys === "F6" || hint.keys === "F7" || hint.keys === "F10"
                    ? hint.keys
                    : null;
                return (
                  <KeyHint
                    theme={props.theme}
                    keys={hint.keys}
                    label={hint.label}
                    quiet
                    button={action() !== null}
                    onPress={
                      action() && props.onFooterAction
                        ? () => props.onFooterAction?.(action()!)
                        : undefined
                    }
                  />
                );
              }}
            </For>
          }
        >
          <StatusSegment
            theme={props.theme}
            label={activity().label}
            width={available()}
            tone={activity().tone}
            attention={activity().attention}
            loading={activity().tone === "working"}
            marker={activity().attention ? "!" : activity().tone === "done" ? "✓" : undefined}
          />
        </Show>
      </StatusBarGroup>
      <StatusBarGroup width={commandWidth()} align="end">
        <KeyHint
          theme={props.theme}
          keys="F5"
          label={props.layout.status.width >= 24 ? "Commands" : undefined}
          width={commandWidth()}
          quiet
          button
          onPress={props.onHelp}
        />
      </StatusBarGroup>
    </StatusBar>
  );
}

/** @deprecated Production callers should use the contextual name. */
export const ShellStatusStrip = ContextStatusBar;

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
      <text fg={palette().border} bg={palette().bg}>
        {palette().marker}
      </text>
      <text fg={palette().fg} bg={palette().bg} attributes={palette().attributes}>
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
  focused?: boolean;
  onSelectSession?: (session: string, source: NavigationRowInputSource) => void;
}

export function ShellMiniSidebar(props: ShellMiniSidebarProps) {
  return (
    <Surface
      theme={props.theme}
      variant="panel"
      width={props.width}
      flexDirection="column"
      paddingLeft={1}
      overflow="hidden"
    >
      <text fg={props.theme.roles.text.link} bg={props.theme.roles.surfaces.panel} attributes={1}>
        {props.variant === "compact" ? " tmux" : " tmux-ide"}
      </text>
      <For each={props.sessions}>
        {(session) => (
          <NavigationRow
            theme={props.theme}
            id={`session:${session.name}`}
            label={session.name}
            width={Math.max(1, props.width - 1)}
            marker={session.name === props.active ? "●" : "○"}
            selected={session.name === props.active}
            focused={props.focused && session.name === props.active}
            status={session.status}
            attention={session.status === "blocked"}
            onActivate={
              props.onSelectSession
                ? (source) => props.onSelectSession?.(session.name, source)
                : undefined
            }
          />
        )}
      </For>
      <box flexGrow={1} />
      <Surface
        theme={props.theme}
        variant="panel"
        height={1}
        width={Math.max(1, props.width - 1)}
        flexDirection="row"
        overflow="hidden"
      >
        <KeyHint
          theme={props.theme}
          keys={props.hint.btn}
          presentation={` ${props.hint.label}`}
          width={Math.max(1, props.width - 1)}
        />
      </Surface>
    </Surface>
  );
}
