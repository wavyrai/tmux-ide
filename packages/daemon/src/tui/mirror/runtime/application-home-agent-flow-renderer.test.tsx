/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { useKeyboard } from "@opentui/solid";
import { describe, expect, it } from "bun:test";
import { createSignal, onCleanup } from "solid-js";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { terminalDisplayWidth } from "../terminal-text.ts";
import { expectFrameBounds, renderForTest } from "../testing/renderer-harness.test.ts";
import { createKeyboardRouteOwner, KeyboardRouteProvider } from "../ui/keyboard-router.tsx";
import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import { ApplicationShellView, applicationShellKeyAction } from "./application-shell-view.tsx";
import { createHomeAgentSelectionOwner } from "./application-home-agent-selection.ts";
import type { ApplicationHomeAgentPresentation } from "./application-home-agents-owner.ts";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";

function shellSemantic() {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName: "main",
    activeMode: "terminals",
    dockMode: "collapsed",
    activeDockTool: "missions",
    focusZone: "terminal",
    focusedPaneId: "pane.main",
    terminalInputPaneId: "pane.main",
    paletteOpen: false,
    sessions: [{ name: "main", status: "working" }],
    activeSession: "main",
    agents: [{ paneId: "pane.main", name: "Codex", kind: "codex", status: "working" }],
    paneIdentities: [{ runtimePaneId: "pane.main", semanticPaneId: "pane.main" }],
    notification: "ready",
  });
}

const rows: readonly HomeAgentRow[] = Array.from({ length: 80 }, (_, index) => ({
  key: `identity-${index}`,
  sessionKey: `session-${index % 3}`,
  sessionName: `workspace-${index % 3}`,
  liveSessionId: `$${index % 3}`,
  daemonInstanceId: "daemon-1",
  agentId: `agent-${index}`,
  paneId: `pane.${index}`,
  name: `Agent-${index} 分析 Café 👨‍💻`,
  harness: "codex",
  activity: index === 0 ? "waiting" : "running",
  attention: index === 0,
  projectName: "tmux-ide",
}));
const snapshot: HomeAgentSnapshot = {
  phase: "live",
  rows,
  observedSessions: 3,
  totalSessions: 3,
  loadingSessions: 0,
  unavailableSessions: 0,
  truncatedSessions: 0,
  refreshingSessionKeys: [],
  unavailableSessionKeys: [],
  note: null,
};

describe("production shell Home agent flow", () => {
  for (const connected of [true, false]) {
    for (const mode of ["dark", "light"] as const) {
      it.each([
        [80, 24],
        [120, 40],
        [200, 60],
      ])(
        `${connected ? "connected" : "catalog"} ${mode}: retains selection through terminal and palette at %ix%i`,
        async (width, height) => {
          const selection = createHomeAgentSelectionOwner();
          selection.setRows(rows);
          selection.select("identity-30");
          const calls: {
            key: string;
            paneId: string | null;
            sessionName: string;
            source: string;
          }[] = [];
          const theme = createSemanticThemeSnapshot({ mode });
          let currentSurface = () => "home";
          const setup = await renderForTest(
            () => {
              const keyboard = createKeyboardRouteOwner();
              const [surface, setSurface] = createSignal<"home" | "terminals">("home");
              const [palette, setPalette] = createSignal(false);
              const [selected, setSelected] = createSignal(selection.snapshot());
              currentSurface = surface;
              const unsubscribe = selection.subscribe(setSelected);
              onCleanup(() => {
                unsubscribe();
                keyboard.dispose();
              });
              // The production root owns low-level ingress. This harness preserves
              // its palette/chrome/component admission order, without a live PTY.
              useKeyboard((event) => {
                const action = applicationShellKeyAction(event, palette());
                if (action === "palette-close") {
                  setPalette(false);
                  return;
                }
                if (palette()) return;
                if (action === "palette-open") {
                  setPalette(true);
                  return;
                }
                if (action === "home" || action === "terminals") {
                  setSurface(action);
                  return;
                }
                keyboard.route(event);
              });
              const homeAgents: ApplicationHomeAgentPresentation = {
                agentRoster: snapshot,
                get agentSelection() {
                  return selected();
                },
                get agentInputActive() {
                  return surface() === "home" && !palette();
                },
                onSelectAgent: selection.select,
                onMoveAgent: selection.move,
                onAgentViewport: selection.setViewport,
                onOpenAgent(row, source) {
                  calls.push({
                    key: row.key,
                    paneId: row.paneId,
                    sessionName: row.sessionName,
                    source,
                  });
                  setSurface("terminals");
                },
              };
              return (
                <KeyboardRouteProvider owner={keyboard}>
                  <ApplicationShellView
                    homeAgents={homeAgents}
                    dimensions={() => ({ width, height })}
                    surface={surface}
                    semantic={() => (connected ? shellSemantic() : null)}
                    generationStatus={() => (connected ? "live" : "idle")}
                    sessions={["main", "workspace-0", "workspace-1", "workspace-2"]}
                    selectedSession={() => 0}
                    bootstrapNote={() => null}
                    catalogPhase={() => "live"}
                    paletteOpen={palette}
                    terminalRendererSource={() => null}
                    layout={() => ({ current: null, windows: [] })}
                    focusedPane={() => null}
                    theme={theme}
                    palette={createTerminalPaletteProjection(theme)}
                    onOpenSurface={(next) => setSurface(next)}
                    onOpenSession={() => undefined}
                    onSetPaletteOpen={(open) => setPalette(open)}
                    onSelectPane={() => undefined}
                    onResizePreview={() => undefined}
                    onResizePane={() => undefined}
                  />
                </KeyboardRouteProvider>
              );
            },
            { width, height },
          );
          await setup.renderOnce();
          let frame = setup.captureCharFrame();
          expectFrameBounds(frame, width, height);
          expect(frame).toContain("Scope: 3 of 3 sessions observed");
          expect(frame).toContain("Agent-30 分析 Café 👨‍💻");
          expect(frame).toContain("STATUS");
          expect(frame).toContain("Commands F5");
          const returnState = selection.snapshot();
          await setup.mockInput.pressEnter();
          await setup.renderOnce();
          expect(currentSurface()).toBe("terminals");
          expect(calls).toEqual([
            {
              key: "identity-30",
              paneId: "pane.30",
              sessionName: "workspace-0",
              source: "keyboard",
            },
          ]);
          await setup.mockInput.pressKey("F1");
          await setup.renderOnce();
          expect(currentSurface()).toBe("home");
          expect(selection.snapshot()).toEqual(returnState);
          expect(setup.captureCharFrame()).toContain("Agent-30 分析 Café 👨‍💻");
          await setup.mockInput.pressKey("F5");
          await setup.renderOnce();
          expect(setup.captureCharFrame()).toContain("Command palette");
          await setup.mockInput.pressEnter();
          await setup.mockInput.pressArrow("down");
          expect(calls).toHaveLength(1);
          expect(selection.snapshot()).toEqual(returnState);
          await setup.mockInput.pressEscape();
          // A lone ESC is intentionally buffered to distinguish an escape
          // sequence; let the terminal parser emit that key before repaint.
          await new Promise((resolve) => setTimeout(resolve, 50));
          await setup.renderOnce();
          frame = setup.captureCharFrame();
          expect(frame).not.toContain("Command palette");
          const lines = frame.split("\n");
          const y = lines.findIndex((line) => line.includes("Agent-30 分析 Café 👨‍💻"));
          const x = terminalDisplayWidth(lines[y]!.slice(0, lines[y]!.indexOf("Agent-30")));
          await setup.mockMouse.click(x, y, MouseButtons.LEFT);
          expect(calls[1]).toEqual({
            key: "identity-30",
            paneId: "pane.30",
            sessionName: "workspace-0",
            source: "mouse",
          });
          expect(currentSurface()).toBe("terminals");
          setup.renderer.destroy();
          selection.dispose();
        },
      );
    }
  }
});
