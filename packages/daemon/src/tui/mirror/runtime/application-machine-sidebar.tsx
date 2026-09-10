import { TuiButton } from "../ui/button.tsx";
/* @jsxImportSource @opentui/solid */
import {
  fleetConnectionMessage,
  type FleetConnectionStatus,
} from "@tmux-ide/daemon-client/fleet-connection-status";
import type { AgentActivity } from "@tmux-ide/contracts";
import { terminalAgentStatusLabel } from "./application-terminal-workspace-policy.ts";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
  type JSX,
} from "solid-js";
import { clipTerminal, friendlySessionLabel } from "../terminal-text.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { NavigationRow } from "../ui/navigation-row.tsx";
import { Surface } from "../ui/surface.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";

export interface ApplicationMachineAgent {
  readonly id: string;
  readonly name: string;
  readonly sessionName: string;
  readonly paneId: string | null;
  readonly activity: AgentActivity;
  readonly attention: boolean;
  readonly disabled?: boolean;
}
export interface ApplicationMachineGroup {
  readonly environmentId?: string | null;
  readonly lastSeenAt?: number | null;
  readonly diagnostic?: FleetConnectionStatus;
  readonly agents?: readonly ApplicationMachineAgent[];
  readonly id: string;
  readonly label: string;
  readonly state: "ready" | "connecting" | "disconnected";
  readonly sessions: readonly {
    readonly id: string;
    readonly name: string;
    readonly paneCount: number;
    readonly disabled?: boolean;
  }[];
}
export interface ApplicationMachineSidebarModel {
  readonly groups: Accessor<readonly ApplicationMachineGroup[]>;
  readonly favorites?: Accessor<readonly string[]>;
  readonly collapsed?: Accessor<readonly string[]>;
  readonly onFavorite?: (key: string, enabled: boolean) => void;
  readonly onCollapse?: (key: string, enabled: boolean) => void;
  readonly activeMachineId: Accessor<string | null>;
  readonly activeSessionName: Accessor<string | null>;
  readonly activePaneId?: Accessor<string | null>;
  readonly onOpen: (machineId: string, sessionName: string, source: "keyboard" | "mouse") => void;
  readonly onSelectMachine: (machineId: string, source: "keyboard" | "mouse") => void;
  readonly onOpenAgent?: (
    machineId: string,
    sessionName: string,
    paneId: string,
    source: "keyboard" | "mouse",
  ) => void;
  readonly tabs?: Accessor<
    readonly {
      key: string;
      label: string;
      hostLabel: string;
      active: boolean;
      available: boolean;
    }[]
  >;
  readonly onOpenTab?: (key: string) => void;
  readonly onCloseTab?: (key: string) => void;
  readonly onOpenSwitcher?: () => void;
  readonly onOpenAttention?: () => void;
  readonly onRetryMachine?: (machineId: string) => void;
  readonly onDisconnectMachine?: (machineId: string) => void;
  readonly onAddMachine?: () => void;
  readonly focused?: Accessor<boolean>;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
}

type Row = {
  key: string;
  group: ApplicationMachineGroup;
  session?: ApplicationMachineGroup["sessions"][number];
  agent?: ApplicationMachineAgent;
  agentHeading?: boolean;
};
/** Pure machine navigation. All connection and session authority stays with the caller. */
export function ApplicationMachineSidebar(props: {
  readonly model: ApplicationMachineSidebarModel;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
  readonly agents?: JSX.Element;
  readonly agentRows?: number;
}) {
  const [localFocused, setLocalFocused] = createSignal(false);
  const focused = () => props.model.focused?.() ?? localFocused();
  const [localCollapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const collapsed = () =>
    props.model.collapsed ? new Set(props.model.collapsed()) : localCollapsed();
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  let scroll: ScrollBoxRenderable | undefined;
  const agentHeight = () =>
    (props.agentRows ?? 0) > 0
      ? Math.min((props.agentRows ?? 0) + 2, Math.max(0, Math.floor(props.height / 2)))
      : 0;
  const controlsHeight = () => (props.height >= 8 && controlGroup() ? 4 : 0);
  const searchHeight = () =>
    (props.model.onOpenSwitcher ? 1 : 0) + (props.model.onOpenAttention ? 1 : 0);
  const tabHeight = () =>
    Math.min(props.model.tabs?.().length ?? 0, Math.max(0, Math.floor(props.height / 3)));
  const visibleTabs = () => {
    const tabs = props.model.tabs?.() ?? [];
    const active = tabs.findIndex((tab) => tab.active);
    const start = Math.max(0, active - tabHeight() + 1);
    return tabs.slice(start, start + tabHeight());
  };
  const machineHeight = () =>
    Math.max(
      0,
      props.height -
        1 -
        (props.model.onAddMachine ? 1 : 0) -
        agentHeight() -
        controlsHeight() -
        searchHeight() -
        tabHeight(),
    );
  const active = (row: Row) =>
    row.group.id === props.model.activeMachineId() &&
    (row.agent
      ? row.group.state === "ready" &&
        !row.agent.disabled &&
        row.agent.sessionName === props.model.activeSessionName() &&
        row.agent.paneId !== null &&
        row.agent.paneId === props.model.activePaneId?.()
      : row.session?.name === props.model.activeSessionName());
  const preferenceKey = (group: ApplicationMachineGroup) => group.environmentId ?? group.id;
  const rows = createMemo<readonly Row[]>(() =>
    props.model.groups().flatMap((group) => [
      { key: JSON.stringify([group.id]), group },
      ...group.sessions
        .filter(
          (session) =>
            !collapsed().has(preferenceKey(group)) ||
            props.model.favorites?.().includes(session.id) ||
            (group.id === props.model.activeMachineId() &&
              session.name === props.model.activeSessionName()),
        )
        .map((session) => ({
          key: JSON.stringify([group.id, "session", session.id]),
          group,
          session,
        })),
      ...(!collapsed().has(preferenceKey(group))
        ? (group.agents ?? []).map((agent, index) => ({
            key: JSON.stringify([group.id, "agent", agent.id]),
            group,
            agent,
            agentHeading: index === 0,
          }))
        : []),
    ]),
  );
  const index = () =>
    Math.max(
      0,
      rows().findIndex((row) => row.key === selectedKey()),
    );
  const controlGroup = () => {
    const group = rows()[index()]?.group;
    return group &&
      group.id !== "local" &&
      props.model.onRetryMachine &&
      props.model.onDisconnectMachine
      ? group
      : null;
  };
  const connectionDetail = (group: ApplicationMachineGroup) => {
    const diagnostic = group.diagnostic;
    if (!diagnostic)
      return group.state === "disconnected"
        ? group.lastSeenAt
          ? `offline · seen ${new Date(group.lastSeenAt).toLocaleTimeString()}`
          : "offline"
        : group.state;
    if (diagnostic.phase === "needs-attention")
      return diagnostic.failure === "incompatible" ? "update needed" : "check connection";
    if (diagnostic.nextRetryAt !== null)
      return `retry ${new Date(diagnostic.nextRetryAt).toLocaleTimeString([], { hour12: false })}`;
    return diagnostic.phase === "disconnected"
      ? group.lastSeenAt
        ? `offline · seen ${new Date(group.lastSeenAt).toLocaleTimeString()}`
        : "disconnected"
      : diagnostic.phase;
  };
  const toggle = (
    group: ApplicationMachineGroup,
    value = !collapsed().has(preferenceKey(group)),
  ) => {
    const next = new Set(collapsed());
    if (value) next.add(preferenceKey(group));
    else next.delete(preferenceKey(group));
    setCollapsed(next);
    props.model.onCollapse?.(preferenceKey(group), value);
  };
  const activate = (row: Row, source: "keyboard" | "mouse") => {
    setSelectedKey(row.key);
    setLocalFocused(true);
    props.model.onFocus?.();
    if (row.agent) {
      if (
        row.group.state === "ready" &&
        !row.agent.disabled &&
        row.agent.paneId &&
        props.model.onOpenAgent
      ) {
        setLocalFocused(false);
        props.model.onBlur?.();
        props.model.onOpenAgent(row.group.id, row.agent.sessionName, row.agent.paneId, source);
      }
    } else if (row.session) {
      if (row.group.state === "ready" && !row.session.disabled)
        props.model.onOpen(row.group.id, row.session.name, source);
    } else if (
      row.group.state !== "ready" ||
      (row.group.sessions.length === 0 && !row.group.agents?.length)
    )
      props.model.onSelectMachine(row.group.id, source);
    else toggle(row.group);
  };
  const revealFocusedRow = () => {
    if (!focused() || !scroll) return;
    const rowHeight = (row: Row) => (row.agent ? (row.agentHeading ? 3 : 2) : 1);
    const y = rows()
      .slice(0, index())
      .reduce((sum, row) => sum + rowHeight(row), 0);
    const bottom = y + (rows()[index()] ? rowHeight(rows()[index()]!) : 1);
    const height = Math.max(1, machineHeight());
    if (y < scroll.scrollTop) scroll.scrollTo(y);
    else if (bottom > scroll.scrollTop + height) scroll.scrollTo(Math.max(y, bottom - height));
  };
  createEffect(() => {
    const list = rows();
    if (!list.some((row) => row.key === selectedKey()))
      setSelectedKey((list.find(active) ?? list[0])?.key ?? null);
    revealFocusedRow();
  });
  useKeyboardRoute((event) => {
    if (!focused() || event.eventType !== "press") return false;
    const key = event.name.toLowerCase();
    if (
      ![
        "up",
        "down",
        "home",
        "end",
        "left",
        "right",
        "enter",
        "return",
        "space",
        "escape",
        "a",
        "r",
        "d",
        "f",
      ].includes(key)
    )
      return false;
    event.preventDefault();
    event.stopPropagation();
    if (key === "escape") {
      setLocalFocused(false);
      props.model.onBlur?.();
      return true;
    }
    if (key === "a") {
      props.model.onAddMachine?.();
      return true;
    }
    const list = rows();
    const row = list[index()];
    if (!row) return true;
    if (key === "f") {
      if (row.session)
        props.model.onFavorite?.(
          row.session.id,
          !props.model.favorites?.().includes(row.session.id),
        );
      return true;
    }
    if (key === "r" || key === "d") {
      if (row.group.id !== "local") {
        if (key === "r") props.model.onRetryMachine?.(row.group.id);
        else props.model.onDisconnectMachine?.(row.group.id);
      }
      return true;
    }
    if (key === "up" || key === "down" || key === "home" || key === "end") {
      const next =
        key === "home"
          ? 0
          : key === "end"
            ? list.length - 1
            : Math.min(list.length - 1, Math.max(0, index() + (key === "up" ? -1 : 1)));
      setSelectedKey(list[next]!.key);
    } else if (key === "left" || key === "right") {
      setSelectedKey(JSON.stringify([row.group.id]));
      toggle(row.group, key === "left");
    } else activate(row, "keyboard");
    return true;
  });
  return (
    <Surface
      id="application-machine-sidebar"
      theme={props.theme}
      variant="panel"
      width={props.width}
      height={props.height}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      <text height={1} fg={props.theme.roles.text.secondary}>
        {" "}
        {props.model.tabs?.().length ? "Machines · F9 tabs" : "Machines"}
      </text>
      <For each={visibleTabs()}>
        {(tab) => (
          <box height={1} flexDirection="row">
            <NavigationRow
              theme={props.theme}
              width={Math.max(1, props.width - 4)}
              id={`fleet-tab:${tab.key}`}
              label={`${tab.hostLabel} / ${tab.label}`}
              marker={tab.active ? "●" : "○"}
              detail={tab.available ? "" : "offline"}
              focused={false}
              onActivate={() => props.model.onOpenTab?.(tab.key)}
            />
            <TuiButton
              theme={props.theme}
              label="×"
              size="compact"
              width={3}
              onPress={() => props.model.onCloseTab?.(tab.key)}
            />
          </box>
        )}
      </For>
      <scrollbox
        ref={(value) => {
          scroll = value;
          const resized = value.content.onSizeChange;
          value.content.onSizeChange = () => {
            resized?.call(value.content);
            revealFocusedRow();
          };
        }}
        height={machineHeight()}
        width={props.width}
        scrollX={false}
        scrollY={true}
        horizontalScrollbarOptions={{ visible: false }}
      >
        <For each={rows()}>
          {(row) => (
            <box
              width={Math.max(1, props.width - 1)}
              height={row.agent ? (row.agentHeading ? 3 : 2) : 1}
              flexShrink={0}
              flexDirection="column"
            >
              <Show when={row.agentHeading}>
                <text height={1} fg={props.theme.roles.text.secondary}>
                  {" "}
                  Agents
                </text>
              </Show>
              <NavigationRow
                theme={props.theme}
                id={`machine:${row.key}`}
                width={Math.max(1, props.width - 1)}
                label={
                  row.agent
                    ? row.agent.name
                    : row.session
                      ? friendlySessionLabel(row.session.name)
                      : row.group.label
                }
                marker={
                  row.agent
                    ? active(row)
                      ? row.agent.attention
                        ? "›!"
                        : "›"
                      : row.agent.attention
                        ? "!"
                        : "•"
                    : row.session
                      ? props.model.favorites?.().includes(row.session.id)
                        ? " ★"
                        : active(row)
                          ? " ›"
                          : "  "
                      : collapsed().has(preferenceKey(row.group))
                        ? "▸"
                        : "▾"
                }
                detail={
                  row.agent
                    ? row.group.state !== "ready" || row.agent.disabled
                      ? "unavailable"
                      : `[${terminalAgentStatusLabel(row.agent.activity)}]`
                    : row.session
                      ? row.group.state !== "ready" || row.session.disabled
                        ? "unavailable"
                        : `${row.session.paneCount}p`
                      : connectionDetail(row.group)
                }
                selected={Boolean((row.session || row.agent) && active(row))}
                focused={Boolean(focused() && row.key === selectedKey())}
                attention={row.agent?.attention}
                onActivate={(source) => activate(row, source)}
              />
              <Show when={row.agent}>
                {(agent) => (
                  <text
                    height={1}
                    fg={props.theme.roles.text.muted}
                    content={clipTerminal(
                      `  ${friendlySessionLabel(agent().sessionName)}`,
                      Math.max(1, props.width - 1),
                    )}
                  />
                )}
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
      <For each={agentHeight() > 0 ? [true] : []}>
        {() => (
          <scrollbox
            width={props.width}
            height={agentHeight()}
            scrollX={false}
            scrollY={true}
            horizontalScrollbarOptions={{ visible: false }}
          >
            {props.agents}
          </scrollbox>
        )}
      </For>
      <Show when={props.model.onOpenSwitcher}>
        <NavigationRow
          theme={props.theme}
          id="machine:switcher"
          label="Search fleet (F6)"
          marker="/"
          width={props.width}
          onActivate={() => props.model.onOpenSwitcher?.()}
        />
      </Show>
      <Show when={props.model.onOpenAttention}>
        <NavigationRow
          theme={props.theme}
          id="machine:attention"
          label={`Attention (${props.model.groups().reduce((sum, group) => sum + (group.state === "ready" ? (group.agents ?? []).filter((agent) => agent.attention && !agent.disabled).length : 0), 0)}) · F7`}
          marker="!"
          width={props.width}
          onActivate={() => props.model.onOpenAttention?.()}
        />
      </Show>
      <Show when={controlsHeight() > 0 && controlGroup()}>
        {(group) => (
          <>
            <text height={2} fg={props.theme.roles.text.secondary}>
              {group().diagnostic
                ? fleetConnectionMessage(group().diagnostic!)
                : connectionDetail(group())}
            </text>
            <NavigationRow
              theme={props.theme}
              id="machine:retry"
              label="Retry connection (R)"
              marker="↻"
              width={props.width}
              onActivate={() => props.model.onRetryMachine?.(group().id)}
            />
            <NavigationRow
              theme={props.theme}
              id="machine:disconnect"
              label="Disconnect (D)"
              marker="×"
              width={props.width}
              onActivate={() => props.model.onDisconnectMachine?.(group().id)}
            />
          </>
        )}
      </Show>
      <For each={props.model.onAddMachine ? [props.model.onAddMachine] : []}>
        {(add) => (
          <NavigationRow
            theme={props.theme}
            id="machine:add"
            label="Add machine (A)"
            marker="+"
            width={props.width}
            onActivate={add}
          />
        )}
      </For>
    </Surface>
  );
}
