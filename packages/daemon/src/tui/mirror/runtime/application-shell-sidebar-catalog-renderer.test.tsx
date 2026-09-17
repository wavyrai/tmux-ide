/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";

import { createSemanticThemeSnapshot } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { projectApplicationShell } from "../workspace/application-shell.ts";
import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import {
  ApplicationShellSidebar,
  type ApplicationSidebarIntent,
} from "./application-shell-sidebar.tsx";

describe("connected sidebar live catalog", () => {
  it("shows and opens beta when the connected shell only knows alpha", async () => {
    const semantic = projectOpenTuiApplicationShell({
      projectName: "Project",
      rootLabel: "/project",
      workspaceName: "alpha",
      activeMode: "terminals",
      dockMode: "collapsed",
      activeDockTool: "missions",
      focusZone: "terminal",
      focusedPaneId: null,
      terminalInputPaneId: null,
      paletteOpen: false,
      sessions: [{ name: "alpha", status: "idle" }],
      activeSession: "alpha",
      agents: [],
    });
    const shell = projectApplicationShell({
      width: 80,
      height: 24,
      preferredSidebarWidth: 22,
      shell: semantic,
      hoveredTabIndex: null,
      quitHint: "Ctrl+Q",
    });
    const intents: ApplicationSidebarIntent[] = [];
    const setup = await renderForTest(
      () => (
        <ApplicationShellSidebar
          shell={shell}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          liveSessions={["alpha", "beta workspace", "alpha"]}
          onIntent={(intent) => intents.push(intent)}
        />
      ),
      { width: 22, height: 24 },
    );
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const betaY = lines.findIndex((line) => line.includes("beta workspace"));
    expect(betaY).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes("alpha"))).toHaveLength(1);
    await setup.mockMouse.click(6, betaY, MouseButtons.LEFT);
    expect(intents).toEqual([
      { type: "session.open", sessionName: "beta workspace", source: "mouse" },
    ]);
    setup.renderer.destroy();
  });
});

// Exercise the actual pre-connection Home and post-retirement terminal surfaces.
import { ApplicationCatalogShell } from "./application-shell-catalog.tsx";
import { createApplicationConnectionFeedback } from "../workspace/connection-feedback.ts";
for (const surface of ["home", "terminals"] as const) {
  it(`shows actionable rejected inventory from ${surface} at 80 columns`, async () => {
    const feedback = createApplicationConnectionFeedback();
    feedback.note("opening shared");
    feedback.progress("shared", "startup-failed", {
      reason: "missing-semantic-stamp",
      daemonGeneration: "daemon-b",
    });
    const setup = await renderForTest(
      () => (
        <ApplicationCatalogShell
          dimensions={() => ({ width: 80, height: 24 })}
          surface={() => surface}
          sessions={["shared", "recreated"]}
          selectedSession={() => 0}
          bootstrapNote={feedback.text}
          connectionFeedback={feedback.snapshot}
          paletteOpen={() => false}
          theme={createSemanticThemeSnapshot({ mode: "dark" })}
          onOpenSurface={() => {}}
          onOpenSession={() => {}}
          onSetPaletteOpen={() => {}}
        />
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("needs attention");
    expect(frame).toContain("missing-semantic-stamp");
    expect(frame).toContain("registered session");
    expect(frame).toContain("different session");
    expect(frame).toContain("Choose another session");
    expect(frame).toContain("Copy connection details");
    feedback.dispose();
    setup.renderer.destroy();
  });
}
