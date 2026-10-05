import { groupApplicationTeamRows } from "./application-team-groups.ts";
import type { PaneTeamMembership } from "@tmux-ide/contracts";
import type { NativePaneIdentity } from "@tmux-ide/contracts";
import type { PaneInteractionEndpoint } from "../ui/pane-interaction-presentation.ts";
import type { InteractionPaneEndpoint } from "@tmux-ide/contracts";
import type { PaneInteractionEvent } from "../ui/pane-interaction-presentation.ts";
import { CHROME_ACTIONS, SIDEBAR_ACTIONS } from "../workspace/application-action-descriptions.ts";
import { AgentRow } from "../ui/agent-row.tsx";
import type { TmuxServerDescriptor, TmuxServerScope } from "@tmux-ide/contracts";
import { fleetHostColor } from "./fleet-presentation.ts";
import type { SessionRowModel } from "../ui/session-row.tsx";
/* @jsxImportSource @opentui/solid */
import {
  fleetConnectionMessage,
  type FleetConnectionStatus,
} from "@tmux-ide/daemon-client/fleet-connection-status";
import type { AgentActivity } from "@tmux-ide/contracts";
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
import { friendlySessionLabel, wrapText } from "../terminal-text.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import { KeyHint } from "../ui/key-hint.tsx";
import { NavigationRow } from "../ui/navigation-row.tsx";
import { Surface } from "../ui/surface.tsx";
import { useKeyboardRoute } from "../ui/keyboard-router.tsx";

export interface ApplicationMachineAgent {
  readonly team?: PaneTeamMembership;
  readonly nativeIdentity: NativePaneIdentity | null;
  readonly interactionEndpoint: Extract<InteractionPaneEndpoint, { kind: "pane" }> | null;
  readonly daemonInstanceId?: string;
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
  readonly tabs?: Accessor<readonly SessionRowModel[]>;
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
  serverHeading?: string;
  server?: TmuxServerDescriptor;
};
/** Pure machine navigation. All connection and session authority stays with the caller. */
export function ApplicationMachineSidebar(props: {
  readonly interactionForAgent?: (
    agent: ApplicationMachineAgent,
  ) => PaneInteractionEvent | undefined;
  readonly paneName?: (endpoint: PaneInteractionEndpoint) => string | undefined;
  readonly model: ApplicationMachineSidebarModel;
  readonly width: number;
  readonly height: number;
  readonly theme: SemanticThemeSnapshot;
  readonly agents?: JSX.Element;
  readonly agentRows?: number;
  readonly onHelp?: (source: "keyboard" | "mouse") => void;
}) {
  // All visible sections share one projection for the current reactive inputs.
  // Event handlers retain the model's fresh authority checks at action time.
  const groups = createMemo(() => props.model.groups());
  const [localFocused, setLocalFocused] = createSignal(false);
  const focused = () => props.model.focused?.() ?? localFocused();
  const [localCollapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const collapsed = () =>
    props.model.collapsed ? new Set(props.model.collapsed()) : localCollapsed();
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  let scroll: ScrollBoxRenderable | undefined;
  const agentHeight = () =>
    (props.agentRows ?? 0) > 0
      ? Math.min(
          (props.agentRows ?? 0) + 2,
          Math.max(0, Math.floor(props.height / 2)),
          Math.max(0, props.height - fixedHeight() - controlsHeight() - 2),
        )
      : 0;
  const controlsHeight = () => (props.height >= 8 && controlGroup() ? controlTextHeight() + 2 : 0);
  const searchHeight = () =>
    (props.model.onOpenSwitcher ? 1 : 0) + (props.model.onOpenAttention ? 1 : 0);
  const fixedHeight = () => 1 + (props.model.onAddMachine ? 1 : 0) + searchHeight();
  // Keep both action rows and at least two machine rows available on short terminals.
  const controlTextHeight = () =>
    Math.min(controlTextLines().length, Math.max(1, props.height - fixedHeight() - 4));

  const machineHeight = () =>
    Math.max(0, props.height - fixedHeight() - agentHeight() - controlsHeight());
  const active = (row: Row) =>
    row.group.id === props.model.activeMachineId() &&
    (row.agent
      ? row.group.state === "ready" &&
        row.group.agentsAvailable !== false &&
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
  const rows = createMemo<readonly Row[]>(() => [
    ...groups().flatMap((group) =>
      groupApplicationTeamRows(group.agents ?? []).map((agent) => ({
        key: JSON.stringify([
          group.id,
          "agent",
          agent.server?.serverId,
          agent.server?.generation,
          agent.id,
        ]),
        group,
        agent,
      })),
    ),
    ...groups().flatMap((group) => [
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
    ]),
  ]);
  const hasAgents = createMemo(() => rows().some((row) => row.agent));
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
  const controlTextLines = createMemo(() => {
    const group = controlGroup();
    return group
      ? wrapText(
          group.diagnostic ? fleetConnectionMessage(group.diagnostic) : connectionDetail(group),
          Math.max(1, props.width),
        )
      : [];
  });
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
        row.group.agentsAvailable !== false &&
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
  const sectionGap = (row: Row) => (!row.session && !row.agent && !row.server ? 1 : 0);
  const rowHeight = (row: Row) =>
    (row.agent ? 2 : row.serverHeading ? 2 : 1) +
    sectionGap(row) +
    (hasAgents() && row.key === JSON.stringify([groups()[0]?.id]) ? 1 : 0);
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
    if (key === "tab") {
      const target = rows()[index()]?.agent
        ? rows().find((row) => !row.agent)
        : rows().find((row) => row.agent);
      if (target) setSelectedKey(target.key);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
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
            [SIDEBAR_ACTIONS.help.key]: "help",
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
        SIDEBAR_ACTIONS.add.key,
        SIDEBAR_ACTIONS.retry.key,
        SIDEBAR_ACTIONS.disconnect.key,
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
    if (key === SIDEBAR_ACTIONS.add.key) {
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
    if (key === SIDEBAR_ACTIONS.retry.key || key === SIDEBAR_ACTIONS.disconnect.key) {
      if (row.group.id !== "local") {
        if (key === SIDEBAR_ACTIONS.retry.key) props.model.onRetryMachine?.(row.group.id);
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
        <text fg={props.theme.roles.text.secondary}>{hasAgents() ? " Agents" : " Machines"}</text>
        <box flexGrow={1} />
        <KeyHint
          theme={props.theme}
          keys={SIDEBAR_ACTIONS.help.keys}
          label={props.width >= 20 ? SIDEBAR_ACTIONS.help.label : undefined}
          quiet
          button
          onPress={() => props.onHelp?.("mouse")}
        />
      </box>
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
            };
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
                <Show when={hasAgents() && row.key === JSON.stringify([groups()[0]?.id])}>
                  <text height={1} fg={props.theme.roles.text.secondary}>
                    {" "}
                    Machines
                  </text>
                </Show>
                <Show
                  when={row.agent}
                  fallback={
                    <NavigationRow
                      theme={props.theme}
                      id={`machine:${row.key}`}
                      width={Math.max(1, props.width - 1)}
                      labelColor={!row.session ? fleetHostColor(row.group) : undefined}
                      label={
                        row.server
                          ? `  ${row.server.label} · ${row.server.serverId.slice(-6)}`
                          : row.session
                            ? friendlySessionLabel(row.session.name)
                            : row.group.label
                      }
                      marker={
                        row.server
                          ? "  "
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
                          : row.session
                            ? row.group.state !== "ready" || row.session.disabled
                              ? "unavailable"
                              : `${row.session.paneCount}p`
                            : row.group.state === "ready"
                              ? undefined
                              : connectionDetail(row.group)
                      }
                      selected={Boolean(row.session && active(row))}
                      focused={focused() && row.key === selectedKey()}
                      onActivate={(source) => activate(row, source)}
                    />
                  }
                >
                  {(agent) => (
                    <AgentRow
                      theme={props.theme}
                      id={`machine:${row.key}`}
                      name={agent().name}
                      team={agent().team}
                      context={[
                        row.group.label,
                        row.group.sessions.find(
                          (session) => session.server?.serverId === agent().server?.serverId,
                        )?.serverLabel,
                        friendlySessionLabel(agent().sessionName),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      width={Math.max(1, props.width - 1)}
                      interaction={props.interactionForAgent?.(agent())}
                      paneName={props.paneName}
                      activity={agent().activity}
                      attention={agent().attention}
                      unavailable={
                        row.group.state !== "ready" ||
                        row.group.agentsAvailable === false ||
                        !!agent().disabled ||
                        !agent().paneId
                      }
                      selected={active(row)}
                      focused={focused() && row.key === selectedKey()}
                      onOpen={(source) => activate(row, source)}
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
          keys={CHROME_ACTIONS.sessions.keys}
          label="Browse all sessions"
          width={props.width}
          quiet
          button
          onPress={() => props.model.onOpenSwitcher?.()}
        />
      </Show>
      <Show when={props.model.onOpenAttention}>
        <KeyHint
          theme={props.theme}
          keys={CHROME_ACTIONS.attention.keys}
          label={`${CHROME_ACTIONS.attention.label} (${groups().reduce((sum, group) => sum + (group.state === "ready" ? (group.agents ?? []).filter((agent) => agent.attention && !agent.disabled).length : 0), 0)})`}
          width={props.width}
          quiet
          button
          onPress={() => props.model.onOpenAttention?.()}
        />
      </Show>
      <Show when={controlsHeight() > 0 && controlGroup()}>
        {(group) => (
          <>
            <text height={controlTextHeight()} flexShrink={0} fg={props.theme.roles.text.secondary}>
              {controlTextLines().join("\n")}
            </text>
            <KeyHint
              theme={props.theme}
              keys={SIDEBAR_ACTIONS.retry.keys}
              label={SIDEBAR_ACTIONS.retry.label}
              width={props.width}
              quiet
              button
              onPress={() => props.model.onRetryMachine?.(group().id)}
            />
            <KeyHint
              theme={props.theme}
              keys={SIDEBAR_ACTIONS.disconnect.keys}
              label={SIDEBAR_ACTIONS.disconnect.label}
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
            keys={SIDEBAR_ACTIONS.add.keys}
            label={SIDEBAR_ACTIONS.add.label}
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
