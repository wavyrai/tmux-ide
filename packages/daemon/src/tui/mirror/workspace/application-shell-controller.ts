import {
  APPLICATION_SHELL_COMMAND_IDS,
  CANONICAL_SURFACE_REGISTRY,
  applicationShellCommandInvocation,
  applyApplicationShellInvocationV1,
  commandsToOpenSurface,
  projectApplicationShellV1,
  type ApplicationShellCommandInvocation,
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
  RENDERER_COMMAND_IDS,
  rendererCommandInvocation,
  rendererInvocationForCanvas,
  rendererInvocationForDock,
} from "../renderer-commands.ts";

export type OpenTuiSessionStatus = "idle" | "working" | "blocked" | "done" | "unknown";

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

export function openTuiRuntimePaneId(
  semanticPaneId: string,
  liveRuntimePaneIds: readonly string[],
): string | null {
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
      paneId: openTuiSemanticPaneId(input.terminalInputPaneId),
      input: "terminal",
    };
  }
  if (input.focusZone === "dock-tabs" || input.focusZone === "dock-body") {
    return { kind: "dock-tool", tool: input.activeDockTool };
  }
  return { kind: "zone", zone: input.focusZone };
}

/** Build the renderer-neutral shell from live OpenTUI state without a second store. */
export function projectOpenTuiApplicationShell(
  input: OpenTuiApplicationShellInput,
): ApplicationShellProjectionV1 {
  const sessions =
    input.sessions.length > 0
      ? input.sessions
      : [{ name: input.activeSession || input.workspaceName, status: "unknown" as const }];
  const activeName = sessions.some(({ name }) => name === input.activeSession)
    ? input.activeSession
    : sessions[0]!.name;
  const focusedPaneId = input.focusedPaneId
    ? openTuiSemanticPaneId(input.focusedPaneId)
    : input.terminalInputPaneId
      ? openTuiSemanticPaneId(input.terminalInputPaneId)
      : null;
  const terminalInputPaneId = input.terminalInputPaneId
    ? openTuiSemanticPaneId(input.terminalInputPaneId)
    : null;
  const returnTarget = input.paletteFocusReturnTarget ?? focusReturnTarget(input);
  const notification = input.notification?.trim() || "Workspace ready";

  return projectApplicationShellV1({
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
          paneId: openTuiSemanticPaneId(agent.paneId),
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
  });
}

export function applicationShellReplayState(
  projection: ApplicationShellProjectionV1,
): ApplicationShellReplayStateV1 {
  return {
    activeMode: projection.workspaceCanvas.activeMode,
    dockMode: projection.bottomDock.mode,
    activeDockTool: projection.bottomDock.activeTool,
    focus: {
      windowActivity: projection.focus.windowActivity,
      focusZone: projection.focus.zone,
      appFocusedPaneId: projection.focus.appFocusedPaneId,
      terminalInputPaneId: projection.focus.terminalInputPaneId,
      layoutSelectedPaneId: projection.focus.layoutSelectedPaneId,
      overlays: projection.focus.overlays.map((overlay) => ({
        ...overlay,
        focusReturnTarget: { ...overlay.focusReturnTarget },
      })),
    },
    selectedResources: [],
  };
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
  const next = applyApplicationShellInvocationV1(previous, invocation);
  return { next, effect: applicationShellEffect(invocation, next, previous) };
}

/** Reduce a semantic command transaction in order and expose host effects in the same order. */
export function reduceOpenTuiApplicationShellCommands(
  projection: ApplicationShellProjectionV1,
  invocations: readonly ApplicationShellCommandInvocation[],
): { next: ApplicationShellReplayStateV1; effects: readonly OpenTuiApplicationShellEffect[] } {
  let next = applicationShellReplayState(projection);
  const effects: OpenTuiApplicationShellEffect[] = [];
  for (const invocation of invocations) {
    const previous = next;
    next = applyApplicationShellInvocationV1(previous, invocation);
    effects.push(applicationShellEffect(invocation, next, previous));
  }
  return { next, effects };
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
