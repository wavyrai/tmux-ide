/* @jsxImportSource @opentui/solid */
import { For } from "solid-js";
import {
  contextStatusPresentation,
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
    attention?: boolean;
  }[];
  navigationFocused?: boolean;
  onSelectView?: (viewId: string) => void;
}

export function ShellTabBar(props: ShellTabBarProps) {
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
      <For each={props.note ? [props.note] : []}>
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
            tone="accent"
          />
        )}
      </For>
      <For each={props.rightChips ?? []}>
        {(chip) => (
          <Badge
            theme={props.theme}
            label={chip.label.trim()}
            width={Math.max(1, terminalDisplayWidth(chip.label) + (chip.context ? 1 : 0))}
            presentation={`${chip.label}${chip.context ? " " : ""}`}
            surface="header"
            hovered={chip.hovered}
            context={chip.context}
            attention={chip.attention}
            tone={chip.attention ? "warning" : chip.context ? "accent" : "neutral"}
          />
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
  const hintsWidth = () =>
    presentation().hints.reduce(
      (width, hint) =>
        width + terminalDisplayWidth(`${hint.keys}${hint.label ? ` ${hint.label}` : ""}`) + 2,
      0,
    );
  const locationBudget = () =>
    Math.max(
      1,
      Math.min(
        Math.floor(props.layout.status.width * (props.layout.variant === "wide" ? 0.5 : 0.4)),
        props.layout.status.width - hintsWidth() - (props.layout.variant === "compact" ? 10 : 16),
      ),
    );
  const visibleLocation = () => {
    const candidates = presentation().location.map((segment, index) => ({
      segment,
      index,
      width: terminalDisplayWidth(segment.label) + 2,
      priority:
        segment.id === "session"
          ? 100
          : segment.id === "pane"
            ? 80
            : segment.id === "mode"
              ? 60
              : 40,
    }));
    const chosen: typeof candidates = [];
    let remaining = locationBudget();
    for (const candidate of [...candidates].sort((a, b) => b.priority - a.priority)) {
      if (candidate.width <= remaining || candidate.segment.essential) {
        const width = Math.max(1, Math.min(candidate.width, remaining));
        if (width <= 0) continue;
        chosen.push({ ...candidate, width });
        remaining -= width;
      }
      if (remaining <= 0) break;
    }
    return chosen.sort((a, b) => a.index - b.index);
  };
  const contextWidth = () => visibleLocation().reduce((width, item) => width + item.width, 0);
  return (
    <StatusBar theme={props.theme} width={props.layout.status.width}>
      <StatusBarGroup width={contextWidth()}>
        <For each={visibleLocation()}>
          {(item) => (
            <StatusSegment
              theme={props.theme}
              label={item.segment.label}
              width={item.width}
              selected={item.segment.id === "session"}
              strong={item.segment.essential}
            />
          )}
        </For>
      </StatusBarGroup>
      <StatusBarGroup grow>
        <StatusSegment
          theme={props.theme}
          label={presentation().activity.label}
          tone={presentation().activity.tone}
          attention={presentation().activity.attention}
          loading={presentation().activity.tone === "working"}
          marker={
            presentation().activity.attention
              ? "!"
              : presentation().activity.tone === "done"
                ? "✓"
                : undefined
          }
        />
      </StatusBarGroup>
      <StatusBarGroup width={hintsWidth()} align="end">
        <For each={presentation().hints}>
          {(hint) => (
            <KeyHint
              theme={props.theme}
              keys={hint.keys}
              selected={hint.command === "commands"}
              {...(hint.label ? { label: hint.label } : {})}
              {...(hint.command === "commands" && props.onHelp ? { onPress: props.onHelp } : {})}
            />
          )}
        </For>
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
