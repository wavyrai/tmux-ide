import {
  APPLICATION_SHELL_COMMAND_IDS,
  CANONICAL_SURFACE_REGISTRY,
  applicationShellCommandInvocation,
  commandsToOpenSurface,
  projectApplicationShellV1,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionV1,
  type ApplicationShellReplayStateV1,
  type ApplicationShellDockMode,
  type CommandInvocation,
  type CommandSource,
  type DockToolId,
  type FocusZone,
  type PrimaryWorkspaceModeId,
  type ProductSurfaceId,
  type SemanticFocusTarget,
} from "@tmux-ide/contracts";
import {
  applicationShellReplayStateFromProjection,
  reduceApplicationShellTransaction,
} from "@tmux-ide/core";
import {
  RENDERER_COMMAND_IDS,
  rendererCommandInvocation,
  rendererInvocationForCanvas,
  rendererInvocationForDock,
} from "../renderer-commands.ts";

export type OpenTuiSessionStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface OpenTuiPaneIdentity {
  readonly runtimePaneId: string;
  readonly semanticPaneId: string | null;
}

export interface OpenTuiApplicationShellInput {
  projectName: string;
  rootLabel: string;
  workspaceName: string;
  activeMode: PrimaryWorkspaceModeId;
  dockMode: ApplicationShellDockMode;
  activeDockTool: DockToolId;
  focusZone: FocusZone;
  focusedPaneId: string | null;
  terminalInputPaneId: string | null;
  /** Durable daemon ids discovered for live tmux pane ids. */
  paneIdentities?: readonly OpenTuiPaneIdentity[];
  paletteOpen: boolean;
  /** Captured when the palette opens. While it is open, live tmux focus may move. */
  paletteFocusReturnTarget?: SemanticFocusTarget | null;
  sessions: readonly { name: string; status: OpenTuiSessionStatus }[];
  activeSession: string;
  agents: readonly {
    paneId: string;
    name: string;
    kind: string;
    status: OpenTuiSessionStatus;
  }[];
  fileCount?: number;
  changeCount?: number;
  missionTitle?: string;
  activityCount?: number;
  notification?: string | null;
  connectionState?: "connected" | "reconnecting" | "disconnected" | "recovering";
}

function sameFocusTarget(
  left: SemanticFocusTarget | null | undefined,
  right: SemanticFocusTarget | null | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "pane" && right.kind === "pane") {
    return left.paneId === right.paneId && left.input === right.input;
  }
  if (left.kind === "dock-tool" && right.kind === "dock-tool") return left.tool === right.tool;
  return left.kind === "zone" && right.kind === "zone" && left.zone === right.zone;
}

/**
 * Equality for the slow semantic lane. Terminal cells and geometry are absent
 * by design, so framebuffer ticks cannot invalidate application-shell state.
 */
export function sameOpenTuiApplicationShellInput(
  left: OpenTuiApplicationShellInput,
  right: OpenTuiApplicationShellInput,
): boolean {
  if (
    left.projectName !== right.projectName ||
    left.rootLabel !== right.rootLabel ||
    left.workspaceName !== right.workspaceName ||
    left.activeMode !== right.activeMode ||
    left.dockMode !== right.dockMode ||
    left.activeDockTool !== right.activeDockTool ||
    left.focusZone !== right.focusZone ||
    left.focusedPaneId !== right.focusedPaneId ||
    left.terminalInputPaneId !== right.terminalInputPaneId ||
    left.paletteOpen !== right.paletteOpen ||
    !sameFocusTarget(left.paletteFocusReturnTarget, right.paletteFocusReturnTarget) ||
    left.activeSession !== right.activeSession ||
    left.fileCount !== right.fileCount ||
    left.changeCount !== right.changeCount ||
    left.missionTitle !== right.missionTitle ||
    left.activityCount !== right.activityCount ||
    left.notification !== right.notification ||
    left.connectionState !== right.connectionState ||
    left.sessions.length !== right.sessions.length ||
    left.agents.length !== right.agents.length ||
    (left.paneIdentities?.length ?? 0) !== (right.paneIdentities?.length ?? 0)
  ) {
    return false;
  }
  return (
    left.sessions.every(
      (session, index) =>
        session.name === right.sessions[index]!.name &&
        session.status === right.sessions[index]!.status,
    ) &&
    left.agents.every((agent, index) => {
      const other = right.agents[index]!;
      return (
        agent.paneId === other.paneId &&
        agent.name === other.name &&
        agent.kind === other.kind &&
        agent.status === other.status
      );
    }) &&
    (left.paneIdentities ?? []).every((identity, index) => {
      const other = right.paneIdentities?.[index];
      return (
        identity.runtimePaneId === other?.runtimePaneId &&
        identity.semanticPaneId === other?.semanticPaneId
      );
    })
  );
}

export const APPLICATION_SHELL_PALETTE_OVERLAY_ID = "overlay.command-palette";

function semanticId(namespace: string, value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return `${namespace}.${normalized || "unknown"}`;
}

/** Host-only correlation: raw tmux pane ids never enter the shared contract. */
export function openTuiSemanticPaneId(runtimePaneId: string): string {
  return semanticId("pane", runtimePaneId);
}

/** Resolve a runtime pane through daemon-owned durable identity when available. */
export function openTuiSemanticPaneIdForRuntime(
  runtimePaneId: string,
  paneIdentities: readonly OpenTuiPaneIdentity[] | undefined = [],
): string {
  return (
    paneIdentities?.find((identity) => identity.runtimePaneId === runtimePaneId)?.semanticPaneId ??
    openTuiSemanticPaneId(runtimePaneId)
  );
}

export function openTuiRuntimePaneId(
  semanticPaneId: string,
  liveRuntimePaneIds: readonly string[],
  paneIdentities: readonly OpenTuiPaneIdentity[] = [],
): string | null {
  const durableRuntimePaneId = paneIdentities.find(
    (identity) => identity.semanticPaneId === semanticPaneId,
  )?.runtimePaneId;
  if (durableRuntimePaneId && liveRuntimePaneIds.includes(durableRuntimePaneId)) {
    return durableRuntimePaneId;
  }
  return (
    liveRuntimePaneIds.find(
      (runtimePaneId) => openTuiSemanticPaneId(runtimePaneId) === semanticPaneId,
    ) ?? null
  );
}

function sessionConnection(status: OpenTuiSessionStatus) {
  if (status === "unknown") return "disconnected" as const;
  if (status === "blocked") return "reconnecting" as const;
  return "connected" as const;
}

function agentActivity(status: OpenTuiSessionStatus) {
  if (status === "working") return "running" as const;
  if (status === "done") return "complete" as const;
  if (status === "blocked") return "waiting" as const;
  if (status === "unknown") return "disconnected" as const;
  return "idle" as const;
}

function agentHarness(kind: string): "codex" | "claude-code" | "custom" {
  const lower = kind.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude-code";
  return "custom";
}

function focusReturnTarget(input: OpenTuiApplicationShellInput): SemanticFocusTarget {
  if (input.terminalInputPaneId) {
    return {
      kind: "pane",
      paneId: openTuiSemanticPaneIdForRuntime(input.terminalInputPaneId, input.paneIdentities),
      input: "terminal",
    };
  }
  if (input.focusZone === "dock-tabs" || input.focusZone === "dock-body") {
    return { kind: "dock-tool", tool: input.activeDockTool };
  }
  return { kind: "zone", zone: input.focusZone };
}

/** Build the renderer-neutral authority input from live standalone OpenTUI state. */
export function openTuiApplicationShellAuthorityInput(
  input: OpenTuiApplicationShellInput,
): ApplicationShellProjectionInputV1 {
  const sessions =
    input.sessions.length > 0
      ? input.sessions
      : [{ name: input.activeSession || input.workspaceName, status: "unknown" as const }];
  const activeName = sessions.some(({ name }) => name === input.activeSession)
    ? input.activeSession
    : sessions[0]!.name;
  const focusedPaneId = input.focusedPaneId
    ? openTuiSemanticPaneIdForRuntime(input.focusedPaneId, input.paneIdentities)
    : input.terminalInputPaneId
      ? openTuiSemanticPaneIdForRuntime(input.terminalInputPaneId, input.paneIdentities)
      : null;
  const terminalInputPaneId = input.terminalInputPaneId
    ? openTuiSemanticPaneIdForRuntime(input.terminalInputPaneId, input.paneIdentities)
    : null;
  const returnTarget = input.paletteFocusReturnTarget ?? focusReturnTarget(input);
  const notification = input.notification?.trim() || "Workspace ready";

  return {
    project: {
      id: semanticId("project", input.projectName),
      name: input.projectName || "tmux-ide",
      rootLabel: input.rootLabel || input.projectName || "tmux-ide",
      readiness: { state: "ready", facts: [notification], warnings: [] },
    },
    workspace: {
      id: semanticId("workspace", input.workspaceName),
      name: input.workspaceName || input.projectName || "Workspace",
      activeMode: input.activeMode,
      session: {
        id: semanticId("session", activeName),
        label: activeName,
        state: sessionConnection(sessions.find(({ name }) => name === activeName)!.status),
        active: true,
      },
      sidebar: {
        sessions: sessions.map((session) => ({
          id: semanticId("session", session.name),
          label: session.name,
          state: sessionConnection(session.status),
          active: session.name === activeName,
        })),
        agents: input.agents.map((agent) => ({
          id: semanticId("agent", `${agent.paneId}.${agent.name}`),
          name: agent.name || agent.kind,
          harness: agentHarness(agent.kind),
          activity: agentActivity(agent.status),
          paneId: openTuiSemanticPaneIdForRuntime(agent.paneId, input.paneIdentities),
          attention: agent.status === "blocked",
        })),
      },
    },
    dock: {
      mode: input.dockMode,
      activeTool: input.activeDockTool,
      tools: CANONICAL_SURFACE_REGISTRY.filter((surface) => surface.kind === "dock-tool").map(
        (surface) => ({
          id: surface.id as DockToolId,
          label: surface.label,
          shortcut: surface.shortcut,
          unreadCount: 0,
          disabledReason: null,
          data:
            surface.id === "files"
              ? {
                  kind: "files" as const,
                  selectedResourceId: null,
                  fileCount: input.fileCount ?? 0,
                }
              : surface.id === "changes"
                ? {
                    kind: "changes" as const,
                    selectedResourceId: null,
                    changeCount: input.changeCount ?? 0,
                  }
                : surface.id === "missions"
                  ? {
                      kind: "missions" as const,
                      missionId: "mission.workspace",
                      title: input.missionTitle || "Workspace missions",
                      status: "running" as const,
                      goalCount: 0,
                      taskCount: 0,
                    }
                  : {
                      kind: "activity" as const,
                      eventCount: input.activityCount ?? 0,
                      latestEventLabel: input.notification ?? null,
                    },
        }),
      ),
    },
    focus: {
      windowActivity: "active",
      focusZone: input.focusZone,
      appFocusedPaneId: focusedPaneId,
      terminalInputPaneId,
      layoutSelectedPaneId: null,
      overlays: input.paletteOpen
        ? [
            {
              id: APPLICATION_SHELL_PALETTE_OVERLAY_ID,
              kind: "command-palette" as const,
              focusReturnTarget: returnTarget,
            },
          ]
        : [],
    },
    connection: {
      state: input.connectionState ?? "connected",
      message: notification,
      safeState: "The tmux session and agent processes remain active",
      nextAction: "Open the command palette for workspace actions",
    },
  };
}

/** Build the renderer-neutral shell from live OpenTUI state without a second store. */
export function projectOpenTuiApplicationShell(
  input: OpenTuiApplicationShellInput,
): ApplicationShellProjectionV1 {
  return projectApplicationShellV1(openTuiApplicationShellAuthorityInput(input));
}

export function applicationShellReplayState(
  projection: ApplicationShellProjectionV1,
): ApplicationShellReplayStateV1 {
  return applicationShellReplayStateFromProjection(projection);
}

export type OpenTuiApplicationShellEffect =
  | { kind: "renderer-command"; invocation: CommandInvocation }
  | { kind: "dock-mode"; mode: ApplicationShellDockMode }
  | { kind: "focus"; target: SemanticFocusTarget }
  | { kind: "palette-close"; restore: SemanticFocusTarget }
  | { kind: "resource-select"; surface: string; resourceId: string };

export function applicationShellEffect(
  invocation: ApplicationShellCommandInvocation,
  next: ApplicationShellReplayStateV1,
  previous: ApplicationShellReplayStateV1,
): OpenTuiApplicationShellEffect {
  switch (invocation.id) {
    case APPLICATION_SHELL_COMMAND_IDS.activateMode:
      return {
        kind: "renderer-command",
        invocation: rendererInvocationForCanvas(invocation.args.mode, invocation.source),
      };
    case APPLICATION_SHELL_COMMAND_IDS.activateDockTool:
      return {
        kind: "renderer-command",
        invocation: rendererInvocationForDock(invocation.args.tool, invocation.source),
      };
    case APPLICATION_SHELL_COMMAND_IDS.setDockMode:
      return { kind: "dock-mode", mode: invocation.args.mode };
    case APPLICATION_SHELL_COMMAND_IDS.moveFocus:
      return { kind: "focus", target: invocation.args.target };
    case APPLICATION_SHELL_COMMAND_IDS.openPalette:
      return {
        kind: "renderer-command",
        invocation: rendererCommandInvocation(
          RENDERER_COMMAND_IDS.openPalette,
          {},
          invocation.source,
        ),
      };
    case APPLICATION_SHELL_COMMAND_IDS.closePalette:
      return {
        kind: "palette-close",
        restore: previous.focus.overlays.find(({ id }) => id === invocation.args.overlayId)!
          .focusReturnTarget,
      };
    case APPLICATION_SHELL_COMMAND_IDS.selectResource:
      return {
        kind: "resource-select",
        surface: invocation.args.surface,
        resourceId: invocation.args.resourceId,
      };
  }
}

/** Reduce first, then expose one explicit host effect. Invalid overlay transitions never run. */
export function reduceOpenTuiApplicationShellCommand(
  projection: ApplicationShellProjectionV1,
  invocation: ApplicationShellCommandInvocation,
): { next: ApplicationShellReplayStateV1; effect: OpenTuiApplicationShellEffect } {
  const previous = applicationShellReplayState(projection);
  const next = reduceApplicationShellTransaction(previous, [invocation]).state;
  return { next, effect: applicationShellEffect(invocation, next, previous) };
}

/** Reduce a semantic command transaction in order and expose host effects in the same order. */
export function reduceOpenTuiApplicationShellCommands(
  projection: ApplicationShellProjectionV1,
  invocations: readonly ApplicationShellCommandInvocation[],
): { next: ApplicationShellReplayStateV1; effects: readonly OpenTuiApplicationShellEffect[] } {
  const transaction = reduceApplicationShellTransaction(
    applicationShellReplayState(projection),
    invocations,
  );
  return {
    next: transaction.state,
    effects: transaction.steps.map(({ invocation, next, previous }) =>
      applicationShellEffect(invocation, next, previous),
    ),
  };
}

/**
 * The canonical open-surface transaction. Activation never owns focus or dock
 * visibility implicitly; those changes are explicit semantic commands.
 */
export function applicationShellSurfaceInvocations(
  projection: ApplicationShellProjectionV1,
  surfaceId: ProductSurfaceId,
  source: CommandSource,
): readonly ApplicationShellCommandInvocation[] {
  const surface = [...projection.primaryNavigation.items, ...projection.bottomDock.tools].find(
    ({ id }) => id === surfaceId,
  );
  if (!surface) throw new Error(`unknown canonical application surface: ${surfaceId}`);
  const open = commandsToOpenSurface({ surface: surfaceId }).map((command) =>
    applicationShellCommandInvocation(command.id, command.args, source),
  );
  return [
    ...open,
    applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      {
        target:
          surface.kind === "primary-mode"
            ? { kind: "zone", zone: "canvas" }
            : { kind: "zone", zone: "dock-body" },
      },
      source,
    ),
  ];
}

export function applicationShellPaletteInvocation(
  projection: ApplicationShellProjectionV1,
  open: boolean,
  source: CommandSource,
): ApplicationShellCommandInvocation {
  if (open) {
    const target: SemanticFocusTarget = projection.focus.terminalInputPaneId
      ? {
          kind: "pane",
          paneId: projection.focus.terminalInputPaneId,
          input: "terminal",
        }
      : projection.focus.zone === "dock-tabs" || projection.focus.zone === "dock-body"
        ? { kind: "dock-tool", tool: projection.bottomDock.activeTool }
        : { kind: "zone", zone: projection.focus.zone };
    return applicationShellCommandInvocation(
      APPLICATION_SHELL_COMMAND_IDS.openPalette,
      { overlayId: APPLICATION_SHELL_PALETTE_OVERLAY_ID, focusReturnTarget: target },
      source,
    );
  }
  return applicationShellCommandInvocation(
    APPLICATION_SHELL_COMMAND_IDS.closePalette,
    { overlayId: projection.focus.palette.overlayId ?? APPLICATION_SHELL_PALETTE_OVERLAY_ID },
    source,
  );
}
