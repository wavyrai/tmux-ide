import {
  ApplicationShellProjectionV1SchemaZ,
  resolvePaneAppearance,
  type AgentActivity,
  type ApplicationShellProjectionV1,
  type CanonicalDomainStatus,
  type CohesionFixtureV1,
  type PaneAttention,
  type PaneStructure,
  type PaneVisualStateV1,
  type SemanticProductId,
} from "@tmux-ide/contracts";
import type { PaneFrameAction, PaneFrameModel } from "./presenter.js";

export type CohesionPaneFixture = CohesionFixtureV1["panes"][number];

export const APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS = Object.freeze({
  maximizeToggle: "zoom",
  menu: "menu",
} as const);

export interface ApplicationShellAgentTerminalLocalState {
  /** Renderer-owned structure only; live terminal geometry stays outside this adapter. */
  readonly structure?: PaneStructure;
  readonly layoutEditable?: boolean;
  readonly controlInteraction?: Partial<PaneVisualStateV1["controlInteraction"]>;
}

export interface ApplicationShellAgentTerminalAdapterOptions {
  /** Optional renderer state keyed exclusively by the durable semantic pane id. */
  readonly localStateByPaneId?: ReadonlyMap<
    SemanticProductId,
    ApplicationShellAgentTerminalLocalState
  >;
}

type ApplicationShellAgent = ApplicationShellProjectionV1["sidebar"]["agents"][number];

type ApplicationShellTerminalStatus =
  | "needs-you"
  | "reconnecting"
  | "error"
  | "running"
  | "unread-complete"
  | "idle";

interface ResolvedApplicationShellTerminalStatus {
  readonly id: ApplicationShellTerminalStatus;
  readonly label: string;
  readonly activity: AgentActivity;
  readonly domainStatus: CanonicalDomainStatus;
  readonly attention: PaneAttention;
}

const DEFAULT_CONTROL_INTERACTION: PaneVisualStateV1["controlInteraction"] = Object.freeze({
  hover: false,
  focusVisible: false,
  pressed: false,
  disabled: false,
  loading: false,
});

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Derive a bounded semantic child id without exposing any host/runtime identity. */
function paneChildId(paneId: SemanticProductId, child: string): SemanticProductId {
  const direct = `${paneId}:${child}`;
  if (direct.length <= 128) return direct as SemanticProductId;
  const suffix = `:${stableHash(paneId)}:${child}`;
  return `${paneId.slice(0, 128 - suffix.length)}${suffix}` as SemanticProductId;
}

function harnessLabel(harness: ApplicationShellAgent["harness"]): string {
  if (harness === "claude-code") return "Claude Code";
  if (harness === "codex") return "Codex";
  return "Custom harness";
}

/**
 * Product status precedence for an agent-backed terminal tile.
 *
 * Explicit attention comes first, followed by reconnect/error safety state,
 * active work, unread completion, and idle. The present contract has no
 * `waiting-for-user` discriminator, so `waiting` alone remains honestly idle.
 */
function terminalStatus(
  shell: ApplicationShellProjectionV1,
  agent: ApplicationShellAgent,
): ResolvedApplicationShellTerminalStatus {
  if (agent.attention) {
    return {
      id: "needs-you",
      label: "Needs you",
      activity: agent.activity,
      domainStatus: "blocked",
      attention: "requested",
    };
  }
  if (shell.statusStrip.state !== "connected" || agent.activity === "disconnected") {
    const error = shell.statusStrip.state === "disconnected" || agent.activity === "disconnected";
    return {
      id: error ? "error" : "reconnecting",
      label: error ? "Error" : "Reconnecting",
      activity: agent.activity === "disconnected" ? "disconnected" : agent.activity,
      domainStatus: error ? "disconnected" : "recovering",
      attention: "recovery",
    };
  }
  if (agent.activity === "failed") {
    return {
      id: "error",
      label: "Error",
      activity: "failed",
      domainStatus: "blocked",
      attention: "warning",
    };
  }
  if (agent.activity === "running") {
    return {
      id: "running",
      label: "Running",
      activity: "running",
      domainStatus: "running",
      attention: "none",
    };
  }
  if (agent.activity === "complete") {
    return {
      id: "unread-complete",
      label: "Unread · complete",
      activity: "complete",
      domainStatus: "done",
      attention: "unread",
    };
  }
  return {
    id: "idle",
    label: "Idle",
    activity: agent.activity,
    domainStatus: "idle",
    attention: "none",
  };
}

/** Existing semantic terminal controls; hosts retain all effect ownership. */
export function applicationShellAgentTerminalActions(
  structure: PaneStructure,
): readonly PaneFrameAction[] {
  const maximized = structure === "maximized";
  return [
    {
      id: APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS.maximizeToggle,
      commandId: "workspace.windowMode.maximize.toggle",
      behavior: "toggle",
      icon: maximized ? "restore" : "maximize",
      label: maximized ? "Restore" : "Maximize",
      description: maximized ? "Restore pane layout" : "Maximize this pane",
      available: true,
      disabledReason: null,
      pressed: maximized,
      busy: false,
    },
    {
      id: APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS.menu,
      commandId: "workspace.pane.menu.open",
      behavior: "action",
      icon: "more",
      label: "Pane actions",
      description: "Open pane actions",
      available: true,
      disabledReason: null,
      pressed: false,
      busy: false,
    },
  ];
}

function paneFrameModelFromApplicationShellAgent(
  shell: ApplicationShellProjectionV1,
  agent: ApplicationShellAgent & { readonly paneId: SemanticProductId },
  local: ApplicationShellAgentTerminalLocalState,
): PaneFrameModel {
  const status = terminalStatus(shell, agent);
  const structure = local.structure ?? "docked";
  const paneId = agent.paneId;
  const visualState: PaneVisualStateV1 = {
    structure,
    applicationFocus: {
      pane: shell.focus.appFocusedPaneId === paneId,
      terminalInput: shell.focus.terminalInputPaneId === paneId,
      windowActive: shell.focus.windowActivity === "active",
    },
    agentActivity: status.activity,
    domainStatus: status.domainStatus,
    attention: status.attention,
    layoutInteraction: {
      editable: local.layoutEditable ?? true,
      selected: shell.focus.layoutSelectedPaneId === paneId,
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      ...DEFAULT_CONTROL_INTERACTION,
      ...local.controlInteraction,
    },
  };
  const appearance = resolvePaneAppearance(visualState);
  const harness = harnessLabel(agent.harness);
  const attentionChip =
    status.attention === "none"
      ? []
      : [
          {
            id: paneChildId(paneId, "attention"),
            kind: "attention" as const,
            label: status.label,
            description: `${agent.name} ${status.label.toLowerCase()}`,
            tone: appearance.status.attentionTone,
          },
        ];
  return {
    pane: { id: paneId, kind: "terminal" },
    appearance,
    title: agent.name,
    subtitle: harness,
    status: {
      // The status value changes; its semantic slot identity never does.
      id: paneChildId(paneId, "status"),
      label: status.label,
      description: appearance.accessibility.description,
      tone: appearance.status.tone,
      busy: appearance.accessibility.busy,
    },
    chips: [
      {
        id: paneChildId(paneId, "agent"),
        kind: "agent",
        label: `${harness}: ${status.activity}`,
        description: `${agent.name} uses ${harness}`,
        tone: appearance.status.domainTone,
      },
      ...attentionChip,
    ],
    actions: applicationShellAgentTerminalActions(structure),
  };
}

/**
 * Canonical live application-shell agent terminals -> shared PaneFrame input.
 *
 * This boundary deliberately selects only semantic agent/focus/connection
 * fields. It cannot carry raw tmux ids, commands, paths, secrets, attachment
 * tickets, terminal bytes, or geometry into either renderer host.
 */
export function paneFrameModelsFromApplicationShellAgents(
  rawShell: ApplicationShellProjectionV1,
  options: ApplicationShellAgentTerminalAdapterOptions = {},
): readonly PaneFrameModel[] {
  const shell = ApplicationShellProjectionV1SchemaZ.parse(rawShell);
  const seen = new Set<SemanticProductId>();
  return shell.sidebar.agents.flatMap((agent) => {
    if (agent.paneId === null) return [];
    if (seen.has(agent.paneId)) {
      throw new Error(
        `Application shell contains duplicate semantic pane identity: ${agent.paneId}`,
      );
    }
    seen.add(agent.paneId);
    return [
      paneFrameModelFromApplicationShellAgent(
        shell,
        agent as ApplicationShellAgent & { readonly paneId: SemanticProductId },
        options.localStateByPaneId?.get(agent.paneId) ?? {},
      ),
    ];
  });
}

/** Canonical fixture/resource adapter shared by every PaneFrame host. */
export function paneFrameModelFromCohesionPane(pane: CohesionPaneFixture): PaneFrameModel {
  const appearance = resolvePaneAppearance(pane.state);
  return {
    pane: { id: pane.id, kind: pane.role },
    appearance,
    title: pane.title,
    subtitle: pane.subtitle,
    status: {
      id: paneChildId(pane.id, "status"),
      label: pane.state.domainStatus,
      description: appearance.accessibility.description,
      tone: appearance.status.tone,
      busy: appearance.accessibility.busy,
    },
    chips: [
      {
        id: paneChildId(pane.id, "agent"),
        kind: "agent",
        label: `${pane.subtitle ?? "Agent"}: ${pane.state.agentActivity}`,
        tone: appearance.status.domainTone,
      },
      ...(pane.state.attention === "none"
        ? []
        : [
            {
              id: paneChildId(pane.id, "attention"),
              kind: "attention" as const,
              label: pane.state.attention,
              tone: appearance.status.attentionTone,
            },
          ]),
    ],
    actions: pane.actions.map((action) => ({
      id: action.id,
      commandId: action.commandId,
      behavior:
        action.id === "maximize-toggle" || action.id === "float-toggle" ? "toggle" : "action",
      icon: action.icon,
      label: action.label,
      description: action.disabledReason ?? action.label,
      available: action.available,
      disabledReason: action.disabledReason,
      pressed:
        (action.id === "maximize-toggle" && appearance.structure === "maximized") ||
        (action.id === "float-toggle" && appearance.structure === "floating"),
      busy: false,
    })),
  };
}
