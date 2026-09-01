/* @jsxImportSource @opentui/solid */
import { For, createMemo, createSignal } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import type { Accessor } from "solid-js";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import {
  AgentBadge,
  Surface,
  TuiButton,
  componentPalette,
  type AgentBadgeStatus,
} from "../ui/index.ts";

export interface TerminalWindowTab {
  index: number;
  name: string;
  active: boolean;
  sync: boolean;
  semanticWindowId: string | null;
  activePaneId: string | null;
  status?: string;
  attention?: boolean;
}

export interface WindowTabItem {
  readonly id: string;
  readonly windowIndex: number;
  readonly title: string;
  readonly agentStatus?: AgentBadgeStatus;
  readonly attention?: boolean;
  readonly disabled?: boolean;
  readonly secondaryAction?: boolean;
}

export interface WindowTabLayoutItem {
  readonly item: WindowTabItem;
  readonly width: number;
  readonly preferredWidth: number;
}

export interface WindowTabLayout {
  readonly visible: readonly WindowTabLayoutItem[];
  readonly hiddenCount: number;
  readonly overflowWidth: number;
  readonly addWidth: number;
}

export interface WindowTabBarProps {
  readonly theme: SemanticThemeSnapshot;
  readonly width: number;
  readonly items: readonly WindowTabItem[] | Accessor<readonly WindowTabItem[]>;
  readonly activeId: string | null | Accessor<string | null>;
  readonly hoveredId?: string | null | Accessor<string | null>;
  readonly focusedId?: string | null | Accessor<string | null>;
  readonly focused?: boolean;
  readonly addDisabled?: boolean;
  readonly onActivateIntent: (id: string) => void;
  readonly onAddIntent: () => void;
  readonly onSecondaryIntent?: (id: string) => void;
}

export interface TerminalWindowStripProps {
  theme: SemanticThemeSnapshot;
  tabs: readonly TerminalWindowTab[] | Accessor<readonly TerminalWindowTab[]>;
  hoveredIndex: number | null;
  width?: number;
  focused?: boolean;
  focusedIndex?: number | null;
  onActivate: (windowIndex: number) => void;
  onNewWindow: () => void;
  onWindowActions?: (windowIndex: number) => void;
}

export const WINDOW_TAB_MIN_WIDTH = 8;
export const WINDOW_TAB_MAX_WIDTH = 32;
const WINDOW_TAB_OVERFLOW_WIDTH = 4;
const WINDOW_TAB_ACTION_WIDTH = 3;

function boundedNaturalWidth(item: WindowTabItem): number {
  const markerWidth = 2;
  const titleWidth = terminalDisplayWidth(item.title) + 2;
  const badgeWidth = item.agentStatus ? terminalDisplayWidth(item.agentStatus) + 4 : 0;
  const actionWidth = item.secondaryAction ? WINDOW_TAB_ACTION_WIDTH : 0;
  return Math.max(
    WINDOW_TAB_MIN_WIDTH,
    Math.min(WINDOW_TAB_MAX_WIDTH, markerWidth + titleWidth + badgeWidth + actionWidth),
  );
}

function adjacentPriority(length: number, activeIndex: number): number[] {
  const result = [activeIndex];
  for (let distance = 1; result.length < length; distance += 1) {
    const right = activeIndex + distance;
    const left = activeIndex - distance;
    if (right < length) result.push(right);
    if (left >= 0) result.push(left);
  }
  return result;
}

/**
 * Deterministic one-row projection for the real window tab bar.
 *
 * Natural content widths are bounded instead of dividing the viewport equally.
 * When the row overflows, the active window is admitted first, followed by its
 * nearest neighbours. Remaining cells grow visible tabs toward their preferred
 * widths without ever consuming the reserved new-window affordance.
 */
export function windowTabBarLayout(
  items: readonly WindowTabItem[],
  activeId: string | null,
  width: number,
  addLabel: string,
): WindowTabLayout {
  const safeWidth = Math.max(0, Math.floor(width));
  const naturalAddWidth = terminalDisplayWidth(addLabel) + 2;
  const addWidth = safeWidth === 0 ? 0 : Math.min(safeWidth, Math.max(1, naturalAddWidth));
  const tabBudget = Math.max(0, safeWidth - addWidth);
  if (items.length === 0 || tabBudget === 0)
    return Object.freeze({
      visible: Object.freeze([]),
      hiddenCount: items.length,
      overflowWidth: 0,
      addWidth,
    });

  const preferred = items.map(boundedNaturalWidth);
  const allPreferred = preferred.reduce((sum, value) => sum + value, 0);
  if (allPreferred <= tabBudget) {
    return Object.freeze({
      visible: Object.freeze(
        items.map((item, index) =>
          Object.freeze({ item, width: preferred[index]!, preferredWidth: preferred[index]! }),
        ),
      ),
      hiddenCount: 0,
      overflowWidth: 0,
      addWidth,
    });
  }

  const overflowWidth = Math.min(WINDOW_TAB_OVERFLOW_WIDTH, Math.max(0, tabBudget - 1));
  const visibleBudget = Math.max(1, tabBudget - overflowWidth);
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === activeId),
  );
  const selected = new Set<number>();
  let reserved = 0;
  for (const index of adjacentPriority(items.length, activeIndex)) {
    const minimum = Math.min(WINDOW_TAB_MIN_WIDTH, preferred[index]!, visibleBudget);
    if (selected.size > 0 && reserved + minimum > visibleBudget) continue;
    selected.add(index);
    reserved += minimum;
  }

  const ordered = [...selected].sort((left, right) => left - right);
  const widths = new Map<number, number>();
  for (const index of ordered)
    widths.set(index, Math.min(WINDOW_TAB_MIN_WIDTH, preferred[index]!, visibleBudget));
  let remaining = Math.max(0, visibleBudget - [...widths.values()].reduce((a, b) => a + b, 0));
  for (const index of adjacentPriority(items.length, activeIndex)) {
    if (!selected.has(index) || remaining === 0) continue;
    const current = widths.get(index)!;
    const growth = Math.min(remaining, preferred[index]! - current);
    widths.set(index, current + growth);
    remaining -= growth;
  }

  return Object.freeze({
    visible: Object.freeze(
      ordered.map((index) =>
        Object.freeze({
          item: items[index]!,
          width: widths.get(index)!,
          preferredWidth: preferred[index]!,
        }),
      ),
    ),
    hiddenCount: items.length - ordered.length,
    overflowWidth,
    addWidth,
  });
}

function tabBadgeWidth(item: WindowTabItem): number {
  return item.agentStatus ? Math.min(10, terminalDisplayWidth(item.agentStatus) + 4) : 0;
}

function tabTitleWidth(
  layout: WindowTabLayoutItem,
  showBadge: boolean,
  showAction: boolean,
): number {
  return Math.max(
    1,
    layout.width -
      2 -
      (showBadge ? tabBadgeWidth(layout.item) : 0) -
      (showAction ? WINDOW_TAB_ACTION_WIDTH : 0),
  );
}

/** Product compound: presentation and direct hit targets only; tmux remains the caller's authority. */
export function WindowTabBar(props: WindowTabBarProps) {
  const items = () => (typeof props.items === "function" ? props.items() : props.items);
  const activeId = () => (typeof props.activeId === "function" ? props.activeId() : props.activeId);
  const controlledHoveredId = () =>
    typeof props.hoveredId === "function" ? props.hoveredId() : props.hoveredId;
  const controlledFocusedId = () =>
    typeof props.focusedId === "function" ? props.focusedId() : props.focusedId;
  const addLabel = () => (props.width >= 72 ? "+ New window" : "+");
  const projection = createMemo(() =>
    windowTabBarLayout(items(), activeId(), props.width, addLabel()),
  );
  const visibleIds = createMemo(() => projection().visible.map(({ item }) => item.id), undefined, {
    equals: (previous, next) =>
      previous.length === next.length && previous.every((id, index) => id === next[index]),
  });
  const [pointerHoveredId, setPointerHoveredId] = createSignal<string | null>(null);
  const hoveredId = () =>
    controlledHoveredId() === undefined || controlledHoveredId() === null
      ? pointerHoveredId()
      : controlledHoveredId();
  const focusedId = () => controlledFocusedId() ?? activeId();

  useKeyboard((event) => {
    if (!props.focused || event.eventType !== "press") return;
    const key = event.name.toLowerCase();
    if (key !== "enter" && key !== "return" && key !== "space") return;
    const item = items().find((candidate) => candidate.id === focusedId());
    if (!item || item.disabled) return;
    event.preventDefault();
    event.stopPropagation();
    props.onActivateIntent(item.id);
  });

  return (
    <Surface
      id="window-tab-bar"
      theme={props.theme}
      variant="header"
      width={props.width}
      height={1}
      flexDirection="row"
      overflow="hidden"
      onMouseMove={() => setPointerHoveredId(null)}
    >
      <For each={visibleIds()}>
        {(id) => {
          const entry = () => projection().visible.find(({ item }) => item.id === id)!;
          const selected = () => entry().item.id === activeId();
          const focused = () => Boolean(props.focused && entry().item.id === focusedId());
          const hovered = () => entry().item.id === hoveredId();
          const showBadge = () =>
            Boolean(
              entry().item.agentStatus && entry().width >= 2 + tabBadgeWidth(entry().item) + 4,
            );
          const showAction = () =>
            Boolean(
              props.onSecondaryIntent &&
              (selected() || focused() || hovered()) &&
              entry().width >=
                2 + 4 + (showBadge() ? tabBadgeWidth(entry().item) : 0) + WINDOW_TAB_ACTION_WIDTH,
            );
          const palette = () =>
            componentPalette(props.theme, {
              selected: selected(),
              focused: focused(),
              hovered: hovered(),
              attention: entry().item.attention,
              disabled: entry().item.disabled,
              status: entry().item.agentStatus,
            });
          return (
            <Surface
              id={`window-tab:${entry().item.id}`}
              theme={props.theme}
              width={entry().width}
              height={1}
              flexDirection="row"
              overflow="hidden"
              selected={selected()}
              focused={focused()}
              hovered={hovered()}
              attention={entry().item.attention}
              disabled={entry().item.disabled}
              status={entry().item.agentStatus}
              focusable={!entry().item.disabled}
              onMouseMove={(event) => {
                event.stopPropagation();
                setPointerHoveredId(entry().item.id);
              }}
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                if (!entry().item.disabled) props.onActivateIntent(entry().item.id);
              }}
            >
              <text fg={palette().accent} bg={palette().background} width={2}>
                {`${palette().marker} `}
              </text>
              <text
                fg={palette().foreground}
                bg={palette().background}
                width={tabTitleWidth(entry(), showBadge(), showAction())}
              >
                {selected() || focused() ? (
                  <strong>
                    {clipTerminal(
                      entry().item.title,
                      tabTitleWidth(entry(), showBadge(), showAction()),
                    )}
                  </strong>
                ) : (
                  clipTerminal(
                    entry().item.title,
                    tabTitleWidth(entry(), showBadge(), showAction()),
                  )
                )}
              </text>
              <For
                each={
                  showBadge() && entry().item.agentStatus
                    ? [entry().item.agentStatus as AgentBadgeStatus]
                    : []
                }
              >
                {(status) => (
                  <AgentBadge
                    theme={props.theme}
                    label={status}
                    status={status}
                    width={tabBadgeWidth(entry().item)}
                    selected={selected()}
                    focused={focused()}
                    hovered={hovered()}
                    attention={entry().item.attention}
                  />
                )}
              </For>
              <For each={showAction() ? [true] : []}>
                {() => (
                  <TuiButton
                    theme={props.theme}
                    label="…"
                    variant="ghost"
                    size="compact"
                    width={WINDOW_TAB_ACTION_WIDTH}
                    background={palette().background}
                    onPress={() => props.onSecondaryIntent?.(entry().item.id)}
                  />
                )}
              </For>
            </Surface>
          );
        }}
      </For>
      <For each={projection().hiddenCount > 0 ? [projection().hiddenCount] : []}>
        {(hiddenCount) => (
          <Surface
            theme={props.theme}
            variant="header"
            width={projection().overflowWidth}
            height={1}
            overflow="hidden"
          >
            <text fg={props.theme.roles.text.muted} bg={props.theme.roles.surfaces.header}>
              {clipTerminal(` …${hiddenCount} `, projection().overflowWidth)}
            </text>
          </Surface>
        )}
      </For>
      <box flexGrow={1} height={1} />
      <TuiButton
        theme={props.theme}
        label={addLabel()}
        variant="ghost"
        size="compact"
        width={projection().addWidth}
        disabled={props.addDisabled}
        background={props.theme.roles.surfaces.header}
        onPress={props.onAddIntent}
      />
    </Surface>
  );
}

function agentStatus(status: string | undefined): AgentBadgeStatus | undefined {
  switch (status?.toUpperCase()) {
    case "WORKING":
      return "working";
    case "BLOCKED":
    case "FAILED":
      return "blocked";
    case "DONE":
      return "done";
    case "IDLE":
      return "idle";
    case "UNKNOWN":
      return "unknown";
    default:
      return undefined;
  }
}

/**
 * Adapter from authoritative retained tmux windows to the renderer-neutral tab
 * compound. Window indices are never parsed from display text.
 */
export function TerminalWindowStrip(props: TerminalWindowStripProps) {
  const tabs = () => (typeof props.tabs === "function" ? props.tabs() : props.tabs);
  const tabId = (tab: TerminalWindowTab) => tab.semanticWindowId ?? `window:${tab.index}`;
  const items = createMemo<readonly WindowTabItem[]>(() =>
    tabs().map((tab) => ({
      id: tabId(tab),
      windowIndex: tab.index,
      title: tab.name,
      agentStatus: agentStatus(tab.status),
      attention: tab.attention,
      secondaryAction: Boolean(props.onWindowActions),
    })),
  );
  const activeId = createMemo(() => {
    const active = tabs().find((tab) => tab.active);
    return active ? tabId(active) : null;
  });
  const hoveredId = createMemo(() => {
    if (props.hoveredIndex === null) return null;
    const hovered = tabs()[props.hoveredIndex];
    return hovered ? tabId(hovered) : null;
  });
  const focusedId = createMemo(() => {
    if (props.focusedIndex === null || props.focusedIndex === undefined) return activeId();
    const focused = tabs()[props.focusedIndex];
    return focused ? tabId(focused) : activeId();
  });
  return (
    <WindowTabBar
      theme={props.theme}
      width={props.width ?? items().reduce((sum, item) => sum + boundedNaturalWidth(item), 3)}
      items={items}
      activeId={activeId}
      hoveredId={hoveredId}
      focusedId={focusedId}
      focused={props.focused}
      onActivateIntent={(id) => {
        const tab = tabs().find((candidate) => tabId(candidate) === id);
        if (tab) props.onActivate(tab.index);
      }}
      onAddIntent={props.onNewWindow}
      onSecondaryIntent={
        props.onWindowActions
          ? (id) => {
              const tab = tabs().find((candidate) => tabId(candidate) === id);
              if (tab) props.onWindowActions?.(tab.index);
            }
          : undefined
      }
    />
  );
}
