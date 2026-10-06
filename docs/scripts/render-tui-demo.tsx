/* @jsxImportSource @opentui/solid */
/**
 * Renders docs/public/tui-demo.svg from the production `tmux-ide app` shell.
 *
 *   pnpm demo:tui            regenerate the SVG and its source fingerprint
 *   pnpm demo:tui --text     also print each frame as plain text (for review)
 *
 * The frames are the real ApplicationShellView composition — machine sidebar,
 * Home agent roster, palette commands, pane headers, footer hints — rendered
 * headlessly with OpenTUI's test renderer over the fixture fleet in
 * tui-demo-fixture.ts. Only the terminal *contents* are invented. Glyphs ship
 * inside the SVG as a Geist Mono subset so it looks the same on every OS.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CapturedFrame } from "@opentui/core";
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

import { demoFingerprint, RECORD } from "./tui-demo-sources.mjs";
import { svgDocument, type DemoFrame } from "./tui-demo-svg.ts";
import {
  ACTIVE_SESSION,
  INK,
  MACHINE,
  OTHER_AGENTS,
  PANES,
  SESSIONS,
  WINDOW,
} from "./tui-demo-fixture.ts";

const COLS = 160;
const ROWS = 44;
const OUTPUT = resolve("docs/public/tui-demo.svg");
const FOCUSED_PANE = "pane.claude";

type Surface = "home" | "terminals";

function semantic() {
  return projectOpenTuiApplicationShell({
    projectName: ACTIVE_SESSION,
    rootLabel: `~/src/${ACTIVE_SESSION}`,
    workspaceName: ACTIVE_SESSION,
    activeMode: "terminals",
    dockMode: "collapsed",
    activeDockTool: "files",
    focusZone: "terminal",
    focusedPaneId: FOCUSED_PANE,
    terminalInputPaneId: FOCUSED_PANE,
    paletteOpen: false,
    sessions: SESSIONS.map(({ name, status }) => ({ name, status })),
    activeSession: ACTIVE_SESSION,
    agents: PANES.flatMap((pane) =>
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
    paneIdentities: PANES.map((pane) => ({ runtimePaneId: pane.id, semanticPaneId: pane.id })),
    notification: null,
    connectionState: "connected",
  });
}

function layout() {
  const current = {
    type: "layout" as const,
    semanticWindowId: WINDOW.id,
    windowName: WINDOW.name,
    currentWindow: true,
    cols: Math.max(...PANES.map((pane) => pane.left + pane.width)),
    rows: Math.max(...PANES.map((pane) => pane.top + pane.height)),
    zoomed: false,
    paneBorderStatus: "top" as const,
    panes: PANES.map((pane) => ({
      pane: pane.id,
      displayName: pane.title,
      displayNameSource: "title" as const,
      left: pane.left,
      top: pane.top,
      width: pane.width,
      height: pane.height,
      active: pane.id === FOCUSED_PANE,
    })),
  };
  const linkId = `window-link.${"a".repeat(32)}`;
  return {
    current,
    windows: [current],
    windowLinks: {
      liveSessionId: `$${ACTIVE_SESSION}`,
      linkRevision: 1,
      activeLinkId: linkId,
      links: [{ linkId, semanticWindowId: WINDOW.id, displayIndex: 0 }],
    },
  };
}

const machineAgents: ApplicationMachineAgent[] = [
  ...PANES.flatMap((pane) =>
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

const sessionRows = SESSIONS.map((session) => ({
  id: session.name,
  name: session.name,
  paneCount: session.panes,
  liveSessionId: `$${session.name}`,
  machineId: MACHINE.id,
  sourceId: MACHINE.id,
  disabled: false,
}));

function machineSidebar(): ApplicationMachineSidebarModel {
  return {
    groups: () => [
      {
        id: MACHINE.id,
        label: MACHINE.label,
        state: "ready",
        sessions: sessionRows,
        agents: machineAgents,
        agentsAvailable: true,
      },
    ],
    activeMachineId: () => MACHINE.id,
    activeSessionName: () => ACTIVE_SESSION,
    activePaneId: () => FOCUSED_PANE,
    onOpen: () => undefined,
    onSelectMachine: () => undefined,
    onOpenSwitcher: () => undefined,
    onOpenAttention: () => undefined,
    onAddMachine: () => undefined,
  };
}

function homeAgents(): ApplicationHomeAgentPresentation {
  const roster = projectHomeFleet(
    {
      selectedMachineId: MACHINE.id,
      groups: [
        { id: MACHINE.id, label: MACHINE.label, state: "ready", sessions: sessionRows, note: null },
      ],
    },
    [{ machineId: MACHINE.id, available: true, agents: machineAgents }],
    { machineId: null, attentionOnly: false },
  );
  return {
    agentQuery: "",
    agentFilterLabel: "All machines · All agents",
    agentActivityFilter: "all",
    agentRoster: roster,
    agentSelection: { selectedKey: roster.rows[0]?.key ?? null, scrollOffset: 0 },
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

/** The production palette composition: shell commands, then the sidebar toggle. */
function paletteCommands(): readonly ApplicationPaletteCommand[] {
  return [
    ...applicationPaletteCommands(semantic()).filter((command) => typeof command === "string"),
    "hide-sidebar",
  ];
}

function setColor(buffer: Uint16Array, cell: number, color: number): void {
  const offset = cell * 4;
  buffer[offset] = (color >> 16) & 0xff;
  buffer[offset + 1] = (color >> 8) & 0xff;
  buffer[offset + 2] = color & 0xff;
  buffer[offset + 3] = 0xff;
}

function terminalAdapter(): PaneScopedTerminalAdapter {
  const panes = new Map(PANES.map((pane) => [pane.id, pane]));
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
      for (const [row, line] of (panes.get(paneId)?.lines ?? []).entries()) {
        if (row >= height) break;
        let column = 0;
        for (const [text, ink] of line.segments)
          for (const char of text) {
            if (column >= width) break;
            const cell = row * width + column;
            buffers.char[cell] = char.codePointAt(0) ?? 32;
            setColor(buffers.fg, cell, ink ? INK[ink] : foreground);
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

async function renderFrame(surface: Surface, paletteOpen: boolean): Promise<CapturedFrame> {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const palette = createTerminalPaletteProjection(theme);
  const shell = semantic();
  const setup = await testRender(
    () => (
      <ApplicationShellView
        machineSidebar={machineSidebar()}
        sidebarVisible={true}
        machineLabel={MACHINE.label}
        homeAgents={homeAgents()}
        dimensions={() => ({ width: COLS, height: ROWS })}
        surface={() => surface}
        semantic={() => shell}
        generationStatus={() => "live"}
        sessions={SESSIONS.map((session) => session.name)}
        selectedSession={() => 0}
        bootstrapNote={() => null}
        catalogPhase={() => "live"}
        paletteOpen={() => paletteOpen}
        paletteCommands={paletteCommands}
        paletteSelection={() => 0}
        paletteQuery={() => ""}
        terminalRendererSource={() =>
          surface === "terminals" ? { adapter: terminalAdapter(), rendererEpoch: 1 } : null
        }
        layout={layout}
        focusedPane={() => (surface === "terminals" ? FOCUSED_PANE : null)}
        rendererFocused={() => surface === "terminals"}
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
    { width: COLS, height: ROWS },
  );
  await setup.renderOnce();
  await setup.renderOnce();
  const frame = setup.captureSpans();
  setup.renderer.destroy();
  return frame;
}

registerPaneSurface();
const frames: DemoFrame[] = [
  { label: "Home", frame: await renderFrame("home", false) },
  { label: "Terminals", frame: await renderFrame("terminals", false) },
  { label: "Commands", frame: await renderFrame("terminals", true) },
];
if (process.argv.includes("--text"))
  for (const { label, frame } of frames)
    process.stdout.write(
      `--- ${label}\n${frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")}\n`,
    );
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, await svgDocument(frames, { cols: COLS, rows: ROWS }, 1));
writeFileSync(
  RECORD,
  `${JSON.stringify({ regenerate: "pnpm demo:tui", sources: demoFingerprint() }, null, 2)}\n`,
);
process.stdout.write(`Rendered ${OUTPUT} from ${frames.length} production OpenTUI frames.\n`);
