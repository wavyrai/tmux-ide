import { createAgentStatusMarker } from "../ui/agent-status-marker.ts";
import type { TmuxServerDescriptor, TmuxServerScope } from "@tmux-ide/contracts";
import { fleetHostColor, summarizeFleetActivity } from "./fleet-presentation.ts";
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
import { KeyHint } from "../ui/key-hint.tsx";
import { NavigationRow } from "../ui/navigation-row.tsx";
import { Surface } from "../ui/surface.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";

export interface ApplicationMachineAgent {
  readonly server?: TmuxServerScope;
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
  readonly agentsAvailable?: boolean;
  readonly id: string;
  readonly label: string;
  readonly state: "ready" | "connecting" | "disconnected";
  readonly servers?: readonly TmuxServerDescriptor[];
  readonly sessions: readonly {
    readonly id: string;
    readonly server?: TmuxServerScope;
    readonly serverLabel?: string;
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
  readonly activeSessionKey?: Accessor<string | null>;
  readonly activePaneId?: Accessor<string | null>;
  readonly onOpen: (
    machineId: string,
    sessionName: string,
    source: "keyboard" | "mouse",
    sessionKey?: string,
  ) => void;
  readonly onSelectServer?: (machineId: string, server: TmuxServerScope) => void;
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
  serverHeading?: string;
  server?: TmuxServerDescriptor;
};
/** Pure machine navigation. All connection and session authority stays with the caller. */
export function ApplicationMachineSidebar(props: {
  readonly model: ApplicationMachineSidebarModel;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
  readonly agents?: JSX.Element;
  readonly agentRows?: number;
  readonly onHelp?: (source: "keyboard" | "mouse") => void;
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
        (!props.model.activeSessionKey ||
          row.group.sessions.some(
            (session) =>
              session.id === props.model.activeSessionKey?.() &&
              session.server?.serverId === row.agent?.server?.serverId &&
              session.server?.generation === row.agent?.server?.generation,
          )) &&
        row.agent.paneId !== null &&
        row.agent.paneId === props.model.activePaneId?.()
      : props.model.activeSessionKey
        ? row.session?.id === props.model.activeSessionKey()
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
              (props.model.activeSessionKey
                ? session.id === props.model.activeSessionKey()
                : session.name === props.model.activeSessionName())),
        )
        .map((session, index, sessions) => ({
          serverHeading:
            (group.servers?.length ??
              new Set(group.sessions.map((row) => row.server?.serverId)).size) > 1 &&
            session.server &&
            (index === 0 || sessions[index - 1]?.server?.serverId !== session.server.serverId)
              ? `${session.serverLabel ?? "Server"} · ${session.server.serverId.slice(-6)}`
              : undefined,
          key: JSON.stringify([group.id, "session", session.id]),
          group,
          session,
        })),
      ...(collapsed().has(preferenceKey(group))
        ? []
        : (group.servers ?? [])
            .filter(
              (server) =>
                !group.sessions.some((session) => session.server?.serverId === server.serverId),
            )
            .map((server) => ({
              key: JSON.stringify([group.id, "server", server.serverId]),
              group,
              server,
            }))),
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
  const rowsByKey = createMemo(() => new Map(rows().map((row) => [row.key, row])));
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
  const activity = (row: Row) =>
    summarizeFleetActivity(
      (row.group.agents ?? []).filter(
        (agent) =>
          !row.session ||
          (agent.sessionName === row.session.name &&
            agent.server?.serverId === row.session.server?.serverId &&
            agent.server?.generation === row.session.server?.generation),
      ),
      row.group.state === "ready" && row.group.agentsAvailable !== false && !row.session?.disabled,
    );
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
    if (row.server) {
      if (row.server.state === "online")
        props.model.onSelectServer?.(row.group.id, {
          serverId: row.server.serverId,
          generation: row.server.generation,
        });
      return;
    }
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
        props.model.onOpen(row.group.id, row.session.name, source, row.session.id);
    } else if (
      row.group.state !== "ready" ||
      (row.group.sessions.length === 0 && !row.group.agents?.length)
    )
      props.model.onSelectMachine(row.group.id, source);
    else toggle(row.group);
  };
  const sectionGap = (row: Row) =>
    !row.session && !row.agent && !row.server && row.group.id !== props.model.groups()[0]?.id
      ? 1
      : 0;
  const rowHeight = (row: Row) =>
    (row.agent ? (row.agentHeading ? 3 : 2) : row.serverHeading ? 2 : 1) + sectionGap(row);
  const revealFocusedRow = () => {
    if (!focused() || !scroll) return;
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
    if (!focused() || event.eventType !== "press" || event.meta) return false;
    let key = event.name.toLowerCase();
    if (event.ctrl && key === "d") key = "halfdown";
    else if (event.ctrl && key === "u") key = "halfup";
    else if (!event.ctrl && !event.meta)
      key =
        (
          {
            j: "down",
            k: "up",
            h: "left",
            l: "right",
            g: event.shift ? "end" : "home",
            "/": "search",
            "?": "help",
            question: "help",
          } as Record<string, string>
        )[key] ?? key;
    if (event.ctrl && !["halfdown", "halfup"].includes(key)) return false;
    if (
      ![
        "up",
        "down",
        "pageup",
        "pagedown",
        "halfup",
        "halfdown",
        "help",
        "search",
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
    if (key === "help") {
      props.onHelp?.("keyboard");
      return true;
    }
    if (key === "search") {
      props.model.onOpenSwitcher?.();
      return true;
    }
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
    if (
      key === "up" ||
      key === "down" ||
      key === "home" ||
      key === "end" ||
      ["pageup", "pagedown", "halfup", "halfdown"].includes(key)
    ) {
      const next =
        key === "home"
          ? 0
          : key === "end"
            ? list.length - 1
            : Math.min(
                list.length - 1,
                Math.max(
                  0,
                  index() +
                    (key === "up" || key.endsWith("up") ? -1 : 1) *
                      (key.startsWith("page")
                        ? Math.max(1, machineHeight())
                        : key.startsWith("half")
                          ? Math.max(1, Math.floor(machineHeight() / 2))
                          : 1),
                ),
              );
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
      <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        <text fg={props.theme.roles.text.secondary}>{" Machines"}</text>
        <box flexGrow={1} />
        <Show when={props.model.tabs?.().length && props.width >= 28}>
          <KeyHint theme={props.theme} keys="F9" label="Tabs" quiet />
        </Show>
        <KeyHint
          theme={props.theme}
          keys="?"
          label={props.width >= 20 ? "Help" : undefined}
          quiet
          button
          onPress={() => props.onHelp?.("mouse")}
        />
      </box>
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
        <For each={rows().map((row) => row.key)}>
          {(key) => {
            // The semantic key owns the native row; fresh snapshots update its
            // props instead of destroying and recreating identical renderables.
            const current = createMemo<Row>(
              (previous) => rowsByKey().get(key) ?? previous,
              rowsByKey().get(key)!,
            );
            const row: Row = {
              key,
              get group() {
                return current().group;
              },
              get session() {
                return current().session;
              },
              get agent() {
                return current().agent;
              },
              get server() {
                return current().server;
              },
              get serverHeading() {
                return current().serverHeading;
              },
              get agentHeading() {
                return current().agentHeading;
              },
            };
            const agentMarker = createAgentStatusMarker({
              theme: () => props.theme,
              status: () => row.agent?.activity,
              attention: () => Boolean(row.agent?.attention),
              unavailable: () => row.group.state !== "ready" || Boolean(row.agent?.disabled),
            });
            return (
              <box
                width={Math.max(1, props.width - 1)}
                height={rowHeight(row)}
                flexShrink={0}
                flexDirection="column"
              >
                <box height={sectionGap(row)} flexShrink={0} />
                <Show when={row.serverHeading}>
                  <NavigationRow
                    theme={props.theme}
                    width={Math.max(1, props.width - 1)}
                    id={`server:${row.group.id}:${row.session?.server?.serverId}`}
                    label={row.serverHeading ?? "Server"}
                    marker=" ▾"
                    onActivate={() => {
                      if (row.session?.server)
                        props.model.onSelectServer?.(row.group.id, row.session.server);
                    }}
                  />
                </Show>
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
                  labelColor={!row.agent && !row.session ? fleetHostColor(row.group) : undefined}
                  label={
                    row.server
                      ? `  ${row.server.label} · ${row.server.serverId.slice(-6)}`
                      : row.agent
                        ? row.agent.name
                        : row.session
                          ? friendlySessionLabel(row.session.name)
                          : row.group.label
                  }
                  marker={
                    row.server
                      ? "  "
                      : row.agent
                        ? agentMarker()
                        : row.session
                          ? props.model.favorites?.().includes(row.session.id)
                            ? " ★"
                            : "  "
                          : collapsed().has(preferenceKey(row.group))
                            ? "▸"
                            : "▾"
                  }
                  detail={
                    row.server
                      ? row.server.state === "offline"
                        ? "offline"
                        : "empty"
                      : row.agent
                        ? row.group.state !== "ready" || row.agent.disabled
                          ? "unavailable"
                          : terminalAgentStatusLabel(row.agent.activity).toLowerCase()
                        : row.session
                          ? row.group.state !== "ready" || row.session.disabled
                            ? "unavailable"
                            : `${row.session.paneCount}p${row.group.agents?.length ? ` ${activity(row).label}` : ""}`
                          : row.group.agents?.length && row.group.state === "ready"
                            ? activity(row).label
                            : `${connectionDetail(row.group)}${row.group.agents?.length ? " ?" : ""}`
                  }
                  selected={Boolean((row.session || row.agent) && active(row))}
                  focused={Boolean(focused() && row.key === selectedKey())}
                  status={
                    (row.agent?.attention ?? activity(row).kind === "attention")
                      ? "blocked"
                      : undefined
                  }
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
            );
          }}
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
        <KeyHint
          theme={props.theme}
          keys="F6"
          label="Sessions"
          width={props.width}
          quiet
          button
          onPress={() => props.model.onOpenSwitcher?.()}
        />
      </Show>
      <Show when={props.model.onOpenAttention}>
        <KeyHint
          theme={props.theme}
          keys="F7"
          label={`Attention (${props.model.groups().reduce((sum, group) => sum + (group.state === "ready" ? (group.agents ?? []).filter((agent) => agent.attention && !agent.disabled).length : 0), 0)})`}
          width={props.width}
          quiet
          button
          onPress={() => props.model.onOpenAttention?.()}
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
            <KeyHint
              theme={props.theme}
              keys="R"
              label="Retry connection"
              width={props.width}
              quiet
              button
              onPress={() => props.model.onRetryMachine?.(group().id)}
            />
            <KeyHint
              theme={props.theme}
              keys="D"
              label="Disconnect"
              width={props.width}
              quiet
              button
              onPress={() => props.model.onDisconnectMachine?.(group().id)}
            />
          </>
        )}
      </Show>
      <For each={props.model.onAddMachine ? [props.model.onAddMachine] : []}>
        {(add) => (
          <KeyHint
            theme={props.theme}
            keys="A"
            label="Add machine"
            width={props.width}
            quiet
            button
            onPress={add}
          />
        )}
      </For>
    </Surface>
  );
}
