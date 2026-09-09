/* @jsxImportSource @opentui/solid */
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
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  let scroll: ScrollBoxRenderable | undefined;
  const agentHeight = () =>
    (props.agentRows ?? 0) > 0
      ? Math.min((props.agentRows ?? 0) + 2, Math.max(0, Math.floor(props.height / 2)))
      : 0;
  const machineHeight = () =>
    Math.max(0, props.height - 1 - (props.model.onAddMachine ? 1 : 0) - agentHeight());
  const active = (row: Row) =>
    row.group.id === props.model.activeMachineId() &&
    (row.agent
      ? row.group.state === "ready" &&
        !row.agent.disabled &&
        row.agent.sessionName === props.model.activeSessionName() &&
        row.agent.paneId !== null &&
        row.agent.paneId === props.model.activePaneId?.()
      : row.session?.name === props.model.activeSessionName());
  const rows = createMemo<readonly Row[]>(() =>
    props.model.groups().flatMap((group) => [
      { key: JSON.stringify([group.id]), group },
      ...group.sessions
        .filter(
          (session) =>
            !collapsed().has(group.id) ||
            (group.id === props.model.activeMachineId() &&
              session.name === props.model.activeSessionName()),
        )
        .map((session) => ({
          key: JSON.stringify([group.id, "session", session.id]),
          group,
          session,
        })),
      ...(!collapsed().has(group.id)
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
  const toggle = (group: ApplicationMachineGroup, value = !collapsed().has(group.id)) => {
    const next = new Set(collapsed());
    if (value) next.add(group.id);
    else next.delete(group.id);
    setCollapsed(next);
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
        Machines
      </text>
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
                      ? active(row)
                        ? " ›"
                        : "  "
                      : collapsed().has(row.group.id)
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
                      : row.group.state === "ready"
                        ? "ready"
                        : row.group.state === "connecting"
                          ? "connecting"
                          : "offline"
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
