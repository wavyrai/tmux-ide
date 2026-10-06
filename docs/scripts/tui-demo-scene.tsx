/* @jsxImportSource @opentui/solid */
/**
 * Renders one frame of the production `tmux-ide app` shell headlessly.
 *
 * Every pixel of chrome comes from ApplicationShellView — the composition the
 * app mounts — fed with the same models the app builds: the machine sidebar,
 * the Home fleet projection, the palette command list and a tmux layout. Only
 * the terminal *contents* are fixture text, blitted through the real pane
 * surface with the theme's own terminal palette.
 */
import { RGBA, type CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/solid";

import {
  registerPaneSurface,
  type TerminalPaneRenderSource,
} from "../../packages/daemon/src/tui/mirror/pane-surface.tsx";
import {
  createSemanticThemeSnapshot,
  createTerminalPaletteProjection,
} from "../../packages/daemon/src/tui/mirror/theme.ts";
import { projectOpenTuiApplicationShell } from "../../packages/daemon/src/tui/mirror/workspace/application-shell-controller.ts";
import type { PaneScopedTerminalAdapter } from "../../packages/daemon/src/tui/mirror/runtime/pane-scoped-terminal-surface.tsx";
import { ApplicationShellView } from "../../packages/daemon/src/tui/mirror/runtime/application-shell-view.tsx";
import type { ApplicationMachineSidebarModel } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-sidebar.tsx";
import type { ApplicationHomeAgentPresentation } from "../../packages/daemon/src/tui/mirror/runtime/application-home-agents-owner.ts";
import type { ApplicationMachineAgent } from "../../packages/daemon/src/tui/mirror/runtime/application-machine-agents.ts";
import { projectHomeFleet } from "../../packages/daemon/src/tui/mirror/runtime/application-home-fleet.ts";
import {
  applicationPaletteCommands,
  type ApplicationPaletteCommand,
} from "../../packages/daemon/src/tui/mirror/runtime/application-palette-input.ts";

import {
  ACTIVE_SESSION,
  INK,
  MACHINE,
  OTHER_AGENTS,
  PANES,
  SESSIONS,
  WINDOW,
  type DemoLine,
  type DemoPane,
} from "./tui-demo-fixture.ts";

export type ThemeMode = "dark" | "light";

export interface Scene {
  readonly cols: number;
  readonly rows: number;
  readonly surface: "home" | "terminals";
  readonly mode?: ThemeMode;
  readonly panes?: readonly DemoPane[];
  readonly focusedPane?: string;
  /** Extra windows after "agents", for the window strip. */
  readonly windows?: readonly string[];
  /** Index into ["agents", ...windows]; its window shows `panes`. */
  readonly activeWindow?: number;
  /** The "agents" window's panes while another window is active. */
  readonly backgroundPanes?: readonly DemoPane[];
  readonly sidebar?: boolean;
  readonly paletteOpen?: boolean;
  readonly rename?: { readonly paneId: string; readonly value: string };
  readonly homeSelection?: string;
}

registerPaneSurface();

const linkId = (index: number) => `window-link.${index.toString(16).padStart(32, "0")}`;

function semantic(scene: Scene, panes: readonly DemoPane[], focused: string) {
  return projectOpenTuiApplicationShell({
    projectName: ACTIVE_SESSION,
    rootLabel: `~/src/${ACTIVE_SESSION}`,
    workspaceName: ACTIVE_SESSION,
    activeMode: "terminals",
    dockMode: "collapsed",
    activeDockTool: "files",
    focusZone: "terminal",
    focusedPaneId: focused,
    terminalInputPaneId: focused,
    paletteOpen: false,
    sessions: SESSIONS.map(({ name, status }) => ({ name, status })),
    activeSession: ACTIVE_SESSION,
    agents: panes.flatMap((pane) =>
      pane.agent
        ? [
            {
              paneId: pane.id,
              name: pane.agent.name,
              kind: pane.agent.harness,
              status: pane.agent.status,
            },
          ]
        : [],
    ),
    paneIdentities: panes.map((pane) => ({ runtimePaneId: pane.id, semanticPaneId: pane.id })),
    notification: null,
    connectionState: "connected",
  });
}

function layout(scene: Scene, panes: readonly DemoPane[], focused: string) {
  // Every window of a session shares the client's size.
  const cols = Math.max(...panes.map((pane) => pane.left + pane.width));
  const rows = Math.max(...panes.map((pane) => pane.top + pane.height));
  const window = (name: string, index: number, active: boolean, members: readonly DemoPane[]) => ({
    type: "layout" as const,
    semanticWindowId: index === 0 ? WINDOW.id : `window.${name}`,
    windowName: name,
    currentWindow: active,
    cols,
    rows,
    zoomed: false,
    paneBorderStatus: "top" as const,
    panes: members.map((pane) => ({
      pane: pane.id,
      displayName: pane.title,
      displayNameSource: pane.nameSource ?? "title",
      left: pane.left,
      top: pane.top,
      width: pane.width,
      height: pane.height,
      active: active && pane.id === focused,
    })),
  });
  const active = scene.activeWindow ?? 0;
  const windows = [WINDOW.name, ...(scene.windows ?? [])].map((name, index) =>
    window(
      name,
      index,
      index === active,
      index === active ? panes : index === 0 ? (scene.backgroundPanes ?? []) : [],
    ),
  );
  return {
    current: windows[active]!,
    windows,
    windowLinks: {
      liveSessionId: `$${ACTIVE_SESSION}`,
      linkRevision: 1,
      activeLinkId: linkId(active),
      links: windows.map((window, index) => ({
        linkId: linkId(index),
        semanticWindowId: window.semanticWindowId,
        displayIndex: index,
      })),
    },
  };
}

function machineAgents(panes: readonly DemoPane[]): ApplicationMachineAgent[] {
  return [
    ...panes.flatMap((pane) =>
      pane.agent
        ? [
            {
              id: `${ACTIVE_SESSION}:${pane.title}`,
              sessionName: ACTIVE_SESSION,
              paneId: pane.id,
              name: pane.agent.name,
              harness: pane.agent.harness,
              activity: pane.agent.activity,
              attention: pane.agent.attention,
            },
          ]
        : [],
    ),
    ...OTHER_AGENTS,
  ].map((agent) => ({
    ...agent,
    key: agent.id,
    machineId: MACHINE.id,
    machineLabel: MACHINE.label,
    disabled: false,
    sessionKey: agent.sessionName,
    liveSessionId: `$${agent.sessionName}`,
    daemonInstanceId: "daemon.local",
    agentId: agent.id,
    projectName: agent.sessionName,
    nativeIdentity: null,
    interactionEndpoint: null,
  }));
}

const sessionRows = SESSIONS.map((session) => ({
  id: session.name,
  name: session.name,
  paneCount: session.panes,
  liveSessionId: `$${session.name}`,
  machineId: MACHINE.id,
  sourceId: MACHINE.id,
  disabled: false,
}));

function machineSidebar(
  agents: readonly ApplicationMachineAgent[],
  focused: string,
): ApplicationMachineSidebarModel {
  return {
    groups: () => [
      {
        id: MACHINE.id,
        label: MACHINE.label,
        state: "ready",
        sessions: sessionRows,
        agents,
        agentsAvailable: true,
      },
    ],
    activeMachineId: () => MACHINE.id,
    activeSessionName: () => ACTIVE_SESSION,
    activePaneId: () => focused,
    onOpen: () => undefined,
    onSelectMachine: () => undefined,
    onOpenSwitcher: () => undefined,
    onOpenAttention: () => undefined,
    onAddMachine: () => undefined,
  };
}

function homeAgents(
  agents: readonly ApplicationMachineAgent[],
  selection?: string,
): ApplicationHomeAgentPresentation {
  const roster = projectHomeFleet(
    {
      selectedMachineId: MACHINE.id,
      groups: [
        { id: MACHINE.id, label: MACHINE.label, state: "ready", sessions: sessionRows, note: null },
      ],
    },
    [{ machineId: MACHINE.id, available: true, agents }],
    { machineId: null, attentionOnly: false },
  );
  return {
    agentQuery: "",
    agentFilterLabel: "All machines · All agents",
    agentActivityFilter: "all",
    agentRoster: roster,
    agentSelection: {
      selectedKey: selection ?? roster.rows[0]?.key ?? null,
      scrollOffset: 0,
    },
    agentInputActive: true,
    onAgentQueryChange: () => undefined,
    onSetAgentActivityFilter: () => undefined,
    onCycleAgentMachine: () => undefined,
    onToggleAgentAttention: () => undefined,
    onSelectAgent: () => undefined,
    onMoveAgent: () => undefined,
    onAgentViewport: () => undefined,
    onOpenAgent: () => undefined,
  };
}

function setColor(buffer: Uint16Array, cell: number, color: number): void {
  const offset = cell * 4;
  buffer[offset] = (color >> 16) & 0xff;
  buffer[offset + 1] = (color >> 8) & 0xff;
  buffer[offset + 2] = color & 0xff;
  buffer[offset + 3] = 0xff;
}

function terminalAdapter(
  panes: readonly DemoPane[],
  ansi: readonly number[],
): PaneScopedTerminalAdapter {
  const byId = new Map(panes.map((pane) => [pane.id, pane]));
  const renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: () => 0,
    cursorState: () => null,
    blitPane: (paneId, buffers, width, height, _scroll, foreground, background, options) => {
      buffers.char.fill(32);
      buffers.attributes.fill(0);
      for (let cell = 0; cell < width * height; cell += 1) {
        setColor(buffers.fg, cell, foreground);
        setColor(buffers.bg, cell, background);
      }
      for (const [row, line] of (byId.get(paneId)?.lines ?? []).entries()) {
        if (row >= height) break;
        let column = 0;
        for (const [text, ink] of line.segments)
          for (const char of text) {
            if (column >= width) break;
            const cell = row * width + column;
            const color = ink ? INK[ink] : null;
            buffers.char[cell] = char.codePointAt(0) ?? 32;
            setColor(
              buffers.fg,
              cell,
              !color ? foreground : "ansi" in color ? ansi[color.ansi]! : color.rgb,
            );
            if (line.bold) buffers.attributes[cell] = 1;
            column += 1;
          }
      }
      for (let row = 0; row < height; row += 1) options.dirtyRows.push(row);
      return null;
    },
  };
  return {
    renderSource,
    paneSelectionSnapshot: () => null,
    paneVersion: () => 1,
    paneSourceEpoch: () => 1,
    subscribePaneVersion: () => () => undefined,
  };
}

export async function renderScene(scene: Scene): Promise<CapturedFrame> {
  const panes = scene.panes ?? PANES;
  const focused = scene.focusedPane ?? panes[0]!.id;
  const theme = createSemanticThemeSnapshot({ mode: scene.mode ?? "dark" });
  const palette = createTerminalPaletteProjection(theme);
  const session = [...panes, ...(scene.backgroundPanes ?? [])];
  const shell = semantic(scene, session, focused);
  const agents = machineAgents(session);
  const commands = (): readonly ApplicationPaletteCommand[] => [
    ...applicationPaletteCommands(shell).filter((command) => typeof command === "string"),
    scene.sidebar === false ? "show-sidebar" : "hide-sidebar",
  ];
  const terminals = scene.surface === "terminals";
  const setup = await testRender(
    () => (
      <ApplicationShellView
        machineSidebar={machineSidebar(agents, focused)}
        sidebarVisible={scene.sidebar !== false}
        machineLabel={MACHINE.label}
        homeAgents={homeAgents(
          agents,
          scene.homeSelection && `${ACTIVE_SESSION}:${scene.homeSelection}`,
        )}
        dimensions={() => ({ width: scene.cols, height: scene.rows })}
        surface={() => scene.surface}
        semantic={() => shell}
        generationStatus={() => "live"}
        sessions={SESSIONS.map((session) => session.name)}
        selectedSession={() => 0}
        bootstrapNote={() => null}
        catalogPhase={() => "live"}
        paletteOpen={() => scene.paletteOpen === true}
        paletteCommands={commands}
        paletteSelection={() => 0}
        paletteQuery={() => ""}
        paneRenameDialog={() => scene.rename ?? null}
        terminalRendererSource={() =>
          terminals
            ? { adapter: terminalAdapter(panes, palette.ansiForeground), rendererEpoch: 1 }
            : null
        }
        layout={() => layout(scene, panes, focused)}
        focusedPane={() => (terminals ? focused : null)}
        rendererFocused={() => terminals}
        theme={theme}
        palette={palette}
        tutorialLabel="Learn tmux-ide"
        onOpenTutorial={() => undefined}
        onCycleTheme={() => undefined}
        onCreateWindow={() => undefined}
        onOpenSurface={() => undefined}
        onOpenSession={() => undefined}
        onSetPaletteOpen={() => undefined}
        onSelectPane={() => undefined}
        onResizePreview={() => undefined}
        onResizePane={() => undefined}
      />
    ),
    { width: scene.cols, height: scene.rows },
  );
  await setup.renderOnce();
  await setup.renderOnce();
  const frame = setup.captureSpans();
  setup.renderer.destroy();
  return frame;
}

/**
 * A plain terminal after the app has quit: the fixture lines on the theme's
 * terminal palette, exactly as the app's pane surface would colour them.
 */
export function renderShell(
  lines: readonly DemoLine[],
  size: { readonly cols: number; readonly rows: number; readonly mode?: ThemeMode },
): CapturedFrame {
  const palette = createTerminalPaletteProjection(
    createSemanticThemeSnapshot({ mode: size.mode ?? "dark" }),
  );
  const rgba = (color: number) =>
    RGBA.fromInts((color >> 16) & 255, (color >> 8) & 255, color & 255, 255);
  const background = rgba(palette.background);
  return {
    cols: size.cols,
    rows: size.rows,
    cursor: [0, 0],
    lines: Array.from({ length: size.rows }, (_, row) => {
      const spans = (lines[row]?.segments ?? []).map(([text, ink]) => {
        const color = ink ? INK[ink] : null;
        return {
          text,
          width: [...text].length,
          fg: rgba(
            !color
              ? palette.foreground
              : "ansi" in color
                ? palette.ansiForeground[color.ansi]!
                : color.rgb,
          ),
          bg: background,
          attributes: lines[row]?.bold ? 1 : 0,
        };
      });
      const used = spans.reduce((sum, span) => sum + span.width, 0);
      spans.push({
        text: " ".repeat(Math.max(0, size.cols - used)),
        width: Math.max(0, size.cols - used),
        fg: rgba(palette.foreground),
        bg: background,
        attributes: 0,
      });
      return { spans };
    }),
  } as CapturedFrame;
}

/** Plain-text view of a frame, for `--text` review. */
export function frameText(frame: CapturedFrame): string {
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n");
}
