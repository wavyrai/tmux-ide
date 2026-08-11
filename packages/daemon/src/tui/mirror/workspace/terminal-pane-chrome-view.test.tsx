/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import type { PaneInteractionProjection } from "@tmux-ide/core";
import { projectPaneChromeState, type PaneChromeState } from "../pane-frame-state.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest, stableFrame } from "../testing/renderer-harness.test.ts";
import { projectAgentTerminalCanvas } from "./agent-terminal-canvas.ts";
import { projectTerminalPaneChrome } from "./terminal-pane-chrome.ts";
import { TerminalPaneCommunicationLayer } from "./terminal-pane-chrome-view.tsx";

function interaction(
  operationKind: "workspace.pane.read" | "workspace.pane.send",
): PaneInteractionProjection {
  return {
    paneId: "pane.tests",
    direction: "incoming",
    sourcePaneId: "pane.editor",
    destinationPaneId: "pane.tests",
    operationKind,
    operationId: "00000000-0000-4000-8000-000000000001",
    phase: operationKind === "workspace.pane.read" ? "observed" : "accepted",
    origin: "tui",
    label: "canonical interaction",
    sequence: 1,
    at: "2026-08-11T18:00:00.000Z",
  };
}

describe("terminal pane chrome OpenTUI view", () => {
  it("renders read/send rails distinctly without touching pane body cells", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const canvas = projectAgentTerminalCanvas({ width: 48, height: 6, chromeRows: 2 });
    const read = projectPaneChromeState({
      keyboardFocused: false,
      inputOwned: false,
      interaction: interaction("workspace.pane.read"),
    });
    const send = projectPaneChromeState({
      keyboardFocused: false,
      inputOwned: false,
      interaction: interaction("workspace.pane.send"),
    });
    const focus = projectPaneChromeState({ keyboardFocused: true, inputOwned: false });
    const controller = projectPaneChromeState({ keyboardFocused: false, inputOwned: true });
    const renderState = async (state: PaneChromeState) => {
      const layout = projectTerminalPaneChrome({
        canvas,
        panes: [
          { id: "%1", left: 0, top: 0, width: 23, height: 4, active: false, zoomed: false },
          { id: "%2", left: 24, top: 0, width: 24, height: 4, active: false, zoomed: false },
        ],
        metadataByPane: new Map([["%1", { title: "Tests", chromeState: state }]]),
      });
      const setup = await renderForTest(
        () => (
          <box width={48} height={4}>
            <text position="absolute" left={0} top={0}>
              A
            </text>
            <text position="absolute" left={24} top={0}>
              B
            </text>
            <TerminalPaneCommunicationLayer theme={theme} layout={layout} />
          </box>
        ),
        { width: 48, height: 4 },
      );
      await setup.renderOnce();
      const frame = stableFrame(setup.captureCharFrame());
      setup.renderer.destroy();
      return frame;
    };

    expect(await renderState(read)).toContain("A                      ┊B");
    expect(await renderState(send)).toContain("A                      ┃B");
    expect(await renderState(focus)).toContain("A                       B");
    expect(await renderState(controller)).toContain("A                       B");
  });
});
