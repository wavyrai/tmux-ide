/* @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";
import { NavigationRow } from "../ui/navigation-row.tsx";
import { KeyHint } from "../ui/key-hint.tsx";
import { TuiButton } from "../ui/button.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";
import {
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
} from "./application-pane-rename-input.ts";
import { HomeAgentSearch } from "../ui/home-agent-search.tsx";
import { createAgentStatusMarker } from "../ui/agent-status-marker.ts";
import { ActivityIndicator } from "../ui/activity-indicator.tsx";
import { componentPalette, type ComponentInteractionState } from "../ui/state.ts";
import {
  homeAgentStatusLabel,
  type HomeAgentRow,
  type HomeAgentSnapshot,
} from "./application-home-agents.ts";
import type { HomeAgentSelectionSnapshot } from "./application-home-agent-selection.ts";

export interface HomeAgentRosterProps {
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly filterLabel?: string;
  readonly activityFilter?: "all" | "working" | "attention";
  readonly onSetActivityFilter?: (value: "all" | "working" | "attention") => void;
  readonly onCycleMachine?: () => void;
  readonly onToggleAttention?: () => void;
  readonly theme: SemanticThemeSnapshot;
  readonly width: number;
  readonly height: number;
  readonly snapshot: HomeAgentSnapshot;
  readonly selection: HomeAgentSelectionSnapshot;
  readonly inputActive: boolean;
  readonly onSelect: (key: string) => void;
  readonly onMove: (delta: number) => void;
  readonly onViewport: (rows: number) => void;
  readonly onOpen: (row: HomeAgentRow, source: "keyboard" | "mouse") => void;
  readonly onRetry?: () => void;
  readonly onLoadMore?: () => void;
}

function padCells(text: string, width: number): string {
  const clipped = clipTerminal(text, Math.max(0, width));
  return clipped + " ".repeat(Math.max(0, width - terminalDisplayWidth(clipped)));
}

function statusTone(row: HomeAgentRow): ComponentInteractionState["status"] {
  if (row.activity === "waiting" || row.activity === "failed") return "blocked";
  if (row.activity === "running") return "working";
  if (row.activity === "complete") return "done";
  return row.activity === "idle" ? "idle" : "unknown";
}

/** A flat projected roster; no subscriptions, navigation effects, or terminal input ingress. */
export function HomeAgentRoster(props: HomeAgentRosterProps) {
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal(false);
  const width = () => Math.max(0, Math.floor(props.width));
  const height = () => Math.max(0, Math.floor(props.height));
  const stale = (row: HomeAgentRow) =>
    row.disabled ||
    (props.snapshot.refreshingSessionKeys ?? []).includes(row.sessionKey) ||
    (props.snapshot.unavailableSessionKeys ?? []).includes(row.sessionKey);
  const showRecovery = () =>
    Boolean(
      ((props.snapshot.phase === "unavailable" || props.snapshot.unavailableSessions > 0) &&
        props.onRetry) ||
      (props.snapshot.truncatedSessions > 0 && props.onLoadMore),
    );
  const rowHeight = () => (width() >= 60 && height() >= 16 ? 2 : 1);
  const filterRows = () => (props.onSetActivityFilter && width() < 70 ? 2 : 1);
  const searchRows = () => (props.onQueryChange ? 2 : 0);
  const visibleCount = () =>
    Math.max(
      0,
      Math.floor(
        (height() - 4 - filterRows() - searchRows() - (showRecovery() ? 1 : 0)) / rowHeight(),
      ),
    );
  const openSelected = (source: "keyboard" | "mouse" = "keyboard") => {
    const row = props.snapshot.rows.find((row) => row.key === props.selection.selectedKey);
    if (props.inputActive && visibleCount() > 0 && row?.paneId && !stale(row))
      props.onOpen(row, source);
  };
  createEffect(() => props.onViewport(visibleCount()));
  const offset = () =>
    Math.max(
      0,
      Math.min(
        props.selection.scrollOffset,
        Math.max(0, props.snapshot.rows.length - visibleCount()),
      ),
    );
  const visible = createMemo(() => props.snapshot.rows.slice(offset(), offset() + visibleCount()));
  const byKey = createMemo(() => new Map(visible().map((row) => [row.key, row])));
  const keys = createMemo(() => visible().map((row) => row.key), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  });
  const columns = () => {
    const status = Math.min(12, Math.max(0, width() - 4));
    const label = Math.max(0, width() - status - 3);
    const session = width() >= 44 ? Math.floor(label * 0.43) : 0;
    return { status, agent: label - session, session };
  };
  const filtered = () =>
    Boolean(props.query || (props.activityFilter && props.activityFilter !== "all"));
  const title = () => {
    if (props.snapshot.phase === "unavailable") return "Agent overview unavailable";
    if (props.snapshot.phase === "loading" && props.snapshot.rows.length === 0)
      return "Loading agent overview…";
    if (filtered() && props.snapshot.rows.length === 0) return "No matching agents";
    if (props.snapshot.phase === "live" && props.snapshot.rows.length === 0)
      return "No agents reported";
    const count = props.snapshot.rows.length;
    const attention = props.snapshot.rows.filter(
      (row) =>
        !stale(row) && (row.attention || row.activity === "waiting" || row.activity === "failed"),
    ).length;
    const working = props.snapshot.rows.filter(
      (row) => !stale(row) && row.activity === "running",
    ).length;
    return `${count} observed ${count === 1 ? "agent" : "agents"} · ${attention} ${attention === 1 ? "needs" : "need"} attention · ${working} working`;
  };
  const coverage = () =>
    `Scope: ${props.snapshot.observedSessions} of ${props.snapshot.totalSessions} sessions observed${props.snapshot.phase === "partial" ? " · partial" : ""}${props.snapshot.loadingSessions ? ` · ${props.snapshot.loadingSessions} loading` : ""}${props.snapshot.unavailableSessions ? ` · ${props.snapshot.unavailableSessions} unavailable` : ""}${props.snapshot.truncatedSessions ? ` · ${props.snapshot.truncatedSessions} not loaded` : ""}`;
  const footer = () => {
    if (props.snapshot.note) return props.snapshot.note;
    if (props.query && props.snapshot.rows.length === 0)
      return "Search covers loaded observations · Esc clears search";
    if (props.snapshot.rows.length === 0) {
      if (props.snapshot.phase === "live")
        return "Observed sessions have no agent entries. F2 opens terminals.";
      if (props.snapshot.phase === "unavailable")
        return "Observation unavailable; this is not an empty fleet.";
      return "Waiting for session observations. F2 opens terminals.";
    }
    if (visibleCount() === 0) return "Enlarge the terminal to view agents.";
    const selected = props.snapshot.rows.find((row) => row.key === props.selection.selectedKey);
    if (selected && stale(selected))
      return `${[selected.machineLabel, selected.serverLabel, selected.sessionName].filter(Boolean).join(" / ")} · last observed; waiting for fresh signals`;
    if (selected?.machineLabel || (width() < 44 && selected))
      return `${[selected?.machineLabel, selected?.serverLabel, selected?.sessionName].filter(Boolean).join(" / ")} · Enter open`;
    return `${offset() + 1}–${Math.min(props.snapshot.rows.length, offset() + visibleCount())} of ${props.snapshot.rows.length} · ↑↓ select · Enter open`;
  };
  useKeyboardRoute((event) => {
    if (!props.inputActive || event.eventType !== "press" || event.ctrl || event.meta) return false;
    const key = event.name.toLowerCase();
    const filter =
      !editing() &&
      (key === "f"
        ? props.onCycleMachine
        : key === "a"
          ? props.onToggleAttention
          : key === "w" && props.onSetActivityFilter
            ? () => props.onSetActivityFilter?.("working")
            : key === "0" && props.onSetActivityFilter
              ? () => props.onSetActivityFilter?.("all")
              : undefined);
    if (filter) {
      event.preventDefault();
      event.stopPropagation();
      filter();
      return true;
    }
    const retry =
      !editing() &&
      key === "r" &&
      (props.snapshot.phase === "unavailable" || props.snapshot.unavailableSessions > 0) &&
      props.onRetry;
    const more =
      !editing() && key === "m" && props.snapshot.truncatedSessions > 0 && props.onLoadMore;
    const recovery = retry || more;
    if (recovery) {
      event.preventDefault();
      event.stopPropagation();
      recovery();
      return true;
    }
    const delta = (
      {
        up: -1,
        down: 1,
        pageup: -Math.max(1, visibleCount()),
        pagedown: Math.max(1, visibleCount()),
        home: -Infinity,
        end: Infinity,
      } as Record<string, number>
    )[key];
    if (delta === undefined || props.snapshot.rows.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    props.onMove(delta);
    return true;
  });
  return (
    <box
      position="relative"
      width={width()}
      height={height()}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
      onMouseScroll={(event) => {
        if (!props.inputActive) return;
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        event.preventDefault();
        event.stopPropagation();
        props.onMove(direction === "up" ? -1 : 1);
      }}
      onMouseOut={() => setHovered(null)}
    >
      <box height={searchRows()} flexShrink={0} />
      <box width={width()} height={1} flexShrink={0} flexDirection="row">
        <Show when={props.snapshot.phase === "loading" || props.snapshot.loadingSessions > 0}>
          <ActivityIndicator theme={props.theme} active={props.inputActive} />
        </Show>
        <text height={1} flexGrow={1} fg={props.theme.roles.text.muted}>
          {clipTerminal(title(), width())}
        </text>
      </box>
      <box
        width={width()}
        height={filterRows()}
        flexShrink={0}
        flexDirection={filterRows() > 1 ? "column" : "row"}
        overflow="hidden"
      >
        <KeyHint
          theme={props.theme}
          keys="f"
          label={props.filterLabel?.split(" · ")[0] ?? "All machines"}
          width={
            props.onSetActivityFilter && filterRows() === 1
              ? Math.max(1, width() - 47)
              : props.onSetActivityFilter
                ? Math.min(width(), 28)
                : Math.max(1, Math.min(28, width() - 16))
          }
          quiet
          button
          onPress={() => {
            if (props.inputActive) props.onCycleMachine?.();
          }}
        />
        <box
          height={1}
          flexShrink={0}
          flexDirection="row"
          overflow="hidden"
          width={Math.min(width(), 47)}
        >
          <Show
            when={props.onSetActivityFilter}
            fallback={
              <KeyHint
                theme={props.theme}
                keys="a"
                label="Attention"
                quiet
                button
                onPress={() => {
                  if (props.inputActive) props.onToggleAttention?.();
                }}
              />
            }
          >
            <For
              each={
                [
                  { key: "0", label: "All", value: "all" },
                  { key: "w", label: "Working", value: "working" },
                  { key: "a", label: "Needs attention", value: "attention" },
                ] as const
              }
            >
              {(filter) => (
                <KeyHint
                  theme={props.theme}
                  keys={filter.key}
                  label={filter.value === "attention" && width() < 47 ? "Attention" : filter.label}
                  quiet
                  button
                  selected={(props.activityFilter ?? "all") === filter.value}
                  onPress={() => {
                    if (props.inputActive) props.onSetActivityFilter?.(filter.value);
                  }}
                />
              )}
            </For>
          </Show>
        </box>
      </box>
      <Show
        when={props.snapshot.rows.length > 0}
        fallback={
          <box
            height={Math.max(0, visibleCount() * rowHeight() + 1)}
            flexShrink={0}
            flexDirection="column"
            overflow="hidden"
          >
            <Show when={props.snapshot.phase === "live" && !props.query}>
              <text height={1} width={width()} fg={props.theme.roles.text.primary}>
                {clipTerminal(
                  filtered() ? "No agents match these filters" : "Your next session starts here",
                  width(),
                )}
              </text>
              <text height={1} width={width()} fg={props.theme.roles.text.muted}>
                {clipTerminal(
                  filtered()
                    ? "Choose All or change the machine filter to see more agents."
                    : "Open terminals, or use Commands to connect a machine.",
                  width(),
                )}
              </text>
            </Show>
          </box>
        }
      >
        <box height={1} flexShrink={0} />
        <box
          height={visibleCount() * rowHeight()}
          width={width()}
          flexShrink={0}
          flexDirection="column"
          overflow="hidden"
        >
          <For each={keys()}>
            {(key) => {
              const row = () => byKey().get(key)!;
              const marker = createAgentStatusMarker({
                theme: () => props.theme,
                status: () => row().activity,
                attention: () => row().attention,
                unavailable: () => stale(row()),
              });
              return (
                <box
                  height={rowHeight()}
                  flexDirection="column"
                  backgroundColor={
                    componentPalette(props.theme, {
                      selected: props.selection.selectedKey === key,
                      hovered: hovered() === key,
                      disabled: row().paneId === null || stale(row()),
                    }).background
                  }
                  width={width()}
                  flexShrink={0}
                  onMouseDown={(event) => {
                    if (!props.inputActive || event.button !== 0 || !row().paneId || stale(row()))
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    props.onSelect(key);
                    props.onOpen(row(), "mouse");
                  }}
                  onMouseOver={() => setHovered(key)}
                  onMouseMove={() => setHovered(key)}
                >
                  <NavigationRow
                    theme={props.theme}
                    id={`home-agent:${key}`}
                    width={width()}
                    label={
                      rowHeight() > 1
                        ? row().name
                        : padCells(row().name, columns().agent) +
                          padCells(
                            [row().machineLabel, row().serverLabel, row().sessionName]
                              .filter(Boolean)
                              .join(" / "),
                            columns().session,
                          )
                    }
                    detail={padCells(
                      `${marker()} ${stale(row()) ? "last seen" : homeAgentStatusLabel(row().activity).toLowerCase()}`,
                      columns().status,
                    )}
                    detailAlign="end"
                    marker=" "
                    selected={props.selection.selectedKey === key}
                    focused={props.inputActive && !editing() && props.selection.selectedKey === key}
                    hovered={hovered() === key}
                    status={stale(row()) ? "unknown" : statusTone(row())}
                    disabled={row().paneId === null || stale(row())}
                    onActivate={(source) => {
                      if (!props.inputActive || row().paneId === null || stale(row())) return;
                      props.onSelect(key);
                      props.onOpen(row(), source);
                    }}
                  />
                  <Show when={rowHeight() > 1}>
                    <text
                      width={width()}
                      height={1}
                      fg={
                        props.selection.selectedKey === key
                          ? props.theme.roles.selection.selectionText
                          : props.theme.roles.text.muted
                      }
                      bg={
                        componentPalette(props.theme, {
                          selected: props.selection.selectedKey === key,
                          hovered: hovered() === key,
                          disabled: row().paneId === null || stale(row()),
                        }).background
                      }
                    >
                      {clipTerminal(
                        `  ${[row().sessionName, row().machineLabel, row().serverLabel, row().harness].filter(Boolean).join(" · ")}`,
                        width(),
                      )}
                    </text>
                  </Show>
                </box>
              );
            }}
          </For>
        </box>
      </Show>
      <Show when={props.onQueryChange}>
        {(onQueryChange) => (
          <box position="absolute" top={0} left={0} width={width()} height={1}>
            <HomeAgentSearch
              theme={props.theme}
              width={width()}
              query={props.query ?? ""}
              active={props.inputActive}
              onChange={onQueryChange()}
              onEdit={(event) => {
                const action = applicationPaneRenameKeyAction(event, props.query ?? "");
                if (action.kind === "update") onQueryChange()(action.value);
              }}
              onPaste={(bytes) =>
                onQueryChange()(applicationPaneRenamePaste(props.query ?? "", bytes))
              }
              onEditing={setEditing}
              onSubmit={() => openSelected()}
            />
          </box>
        )}
      </Show>
      <text width={width()} height={1} flexShrink={0} fg={props.theme.roles.text.muted}>
        {clipTerminal(coverage(), width())}
      </text>
      <box width={width()} height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        <text
          width={Math.min(
            Math.max(0, width() - (footer().endsWith("Enter open") && width() >= 20 ? 12 : 0)),
            terminalDisplayWidth(footer().replace(/ Enter open$/u, "")),
          )}
          fg={props.theme.roles.text.muted}
        >
          {clipTerminal(footer().replace(/ Enter open$/u, ""), width())}
        </text>
        <Show when={footer().endsWith("Enter open") && width() >= 20}>
          <KeyHint
            theme={props.theme}
            keys="Enter"
            label="open"
            quiet
            button
            onPress={() => openSelected("mouse")}
          />
        </Show>
      </box>
      <Show when={showRecovery()}>
        <box height={1} width={width()} flexShrink={0} flexDirection="row" gap={1}>
          <Show
            when={
              (props.snapshot.phase === "unavailable" || props.snapshot.unavailableSessions > 0) &&
              props.onRetry
            }
          >
            {(retry) => (
              <TuiButton
                theme={props.theme}
                label="Retry"
                shortcut="r"
                size="compact"
                width={Math.min(width(), 9)}
                onPress={() => {
                  if (props.inputActive) retry()();
                }}
              />
            )}
          </Show>
          <Show when={props.snapshot.truncatedSessions > 0 && props.onLoadMore}>
            {(loadMore) => (
              <TuiButton
                theme={props.theme}
                label="Load more"
                shortcut="m"
                size="compact"
                width={Math.min(
                  Math.max(
                    0,
                    width() -
                      (props.onRetry &&
                      (props.snapshot.unavailableSessions || props.snapshot.phase === "unavailable")
                        ? 10
                        : 0),
                  ),
                  13,
                )}
                onPress={() => {
                  if (props.inputActive) loadMore()();
                }}
              />
            )}
          </Show>
        </box>
      </Show>
    </box>
  );
}
