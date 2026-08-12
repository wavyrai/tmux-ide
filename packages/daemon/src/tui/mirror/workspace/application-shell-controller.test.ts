import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemo, createRoot, createSignal } from "solid-js";
import {
  APPLICATION_SHELL_COMMAND_IDS,
  CANONICAL_SURFACE_REGISTRY,
  COHESION_FIXTURE_V1,
  applicationShellActionTraceV1,
  applicationShellCommandInvocation,
  replayApplicationShellActionTraceV1,
} from "@tmux-ide/contracts";
import {
  applicationShellPaletteInvocation,
  applicationShellSurfaceInvocations,
  openTuiApplicationShellAuthorityInput,
  openTuiRuntimePaneId,
  openTuiSemanticPaneId,
  projectOpenTuiApplicationShell,
  reduceOpenTuiApplicationShellCommand,
  reduceOpenTuiApplicationShellCommands,
  sameOpenTuiApplicationShellInput,
} from "./application-shell-controller.ts";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../../../test-support/opentui-production-root-manifest.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const productionRootSource = () =>
  OPENTUI_PRODUCTION_ROOT_SOURCES.map((path) => readFileSync(join(repoRoot, path), "utf8")).join(
    "\n",
  );

function projection(
  overrides: {
    paletteOpen?: boolean;
    focusZone?: "canvas" | "dock-tabs";
    dockMode?: "collapsed" | "open" | "maximized";
  } = {},
) {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName: "main",
    activeMode: "terminals",
    dockMode: overrides.dockMode ?? "open",
    activeDockTool: "missions",
    focusZone: overrides.focusZone ?? "dock-tabs",
    focusedPaneId: null,
    terminalInputPaneId: null,
    paletteOpen: overrides.paletteOpen ?? false,
    sessions: [{ name: "main", status: "working" }],
    activeSession: "main",
    agents: [
      { paneId: "%7", name: "Codex", kind: "codex", status: "working" },
      { paneId: "%8", name: "Fable", kind: "claude", status: "blocked" },
    ],
    notification: "live",
  });
}

describe("OpenTUI canonical application-shell controller", () => {
  it("keeps terminal paint churn off the semantic application-shell lane", () => {
    const base = {
      projectName: "tmux-ide",
      rootLabel: "/workspace/tmux-ide",
      workspaceName: "main",
      activeMode: "terminals" as const,
      dockMode: "open" as const,
      activeDockTool: "files" as const,
      focusZone: "terminal" as const,
      focusedPaneId: "%7",
      terminalInputPaneId: "%7",
      paletteOpen: false,
      sessions: [{ name: "main", status: "working" as const }],
      activeSession: "main",
      agents: [{ paneId: "%7", name: "Codex", kind: "codex", status: "working" as const }],
      notification: "live",
      connectionState: "connected" as const,
    };

    expect(
      sameOpenTuiApplicationShellInput(base, {
        ...base,
        sessions: base.sessions.map((session) => ({ ...session })),
        agents: base.agents.map((agent) => ({ ...agent })),
      }),
    ).toBe(true);
    expect(
      sameOpenTuiApplicationShellInput(base, {
        ...base,
        focusedPaneId: "%8",
        terminalInputPaneId: "%8",
      }),
    ).toBe(false);

    createRoot((dispose) => {
      const [semanticInput, setSemanticInput] = createSignal(base, {
        equals: sameOpenTuiApplicationShellInput,
      });
      let projectionCount = 0;
      const projected = createMemo(() => {
        projectionCount += 1;
        return projectOpenTuiApplicationShell(semanticInput());
      });
      expect(projected().focus.appFocusedPaneId).toBe(openTuiSemanticPaneId("%7"));
      for (let tick = 0; tick < 1_000; tick += 1) {
        setSemanticInput({
          ...base,
          sessions: base.sessions.map((session) => ({ ...session })),
          agents: base.agents.map((agent) => ({ ...agent })),
        });
        projected();
      }
      expect(projectionCount).toBe(1);
      setSemanticInput({ ...base, focusedPaneId: "%8", terminalInputPaneId: "%8" });
      expect(projected().focus.appFocusedPaneId).toBe(openTuiSemanticPaneId("%8"));
      expect(projectionCount).toBe(2);
      dispose();
    });
  });

  it("projects exactly the canonical surface identity, order, shortcuts, and commands", () => {
    const shell = projection();
    const projected = [...shell.primaryNavigation.items, ...shell.bottomDock.tools].map(
      ({ id, icon, label, order, shortcut, activation }) => ({
        id,
        icon,
        label,
        order,
        shortcut,
        activation,
      }),
    );
    expect(projected).toEqual(
      CANONICAL_SURFACE_REGISTRY.map(({ id, icon, label, order, shortcut, activation }) => ({
        id,
        icon,
        label,
        order,
        shortcut,
        activation,
      })),
    );
    expect(shell.sidebar.agents.map(({ harness }) => harness)).toEqual(["codex", "claude-code"]);
  });

  it.each(["collapsed", "maximized"] as const)(
    "opens every canonical surface from a %s dock through the complete semantic transaction",
    (dockMode) => {
      const shell = projection({ dockMode });
      for (const surface of CANONICAL_SURFACE_REGISTRY) {
        const source = { kind: "palette" as const, surface: "command-palette" };
        const invocations = applicationShellSurfaceInvocations(shell, surface.id, source);
        expect(invocations.map(({ id }) => id)).toEqual(
          surface.kind === "primary-mode"
            ? [APPLICATION_SHELL_COMMAND_IDS.activateMode, APPLICATION_SHELL_COMMAND_IDS.moveFocus]
            : [
                APPLICATION_SHELL_COMMAND_IDS.activateMode,
                APPLICATION_SHELL_COMMAND_IDS.setDockMode,
                APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
                APPLICATION_SHELL_COMMAND_IDS.moveFocus,
              ],
        );
        expect(invocations.map(({ source: invocationSource }) => invocationSource)).toEqual(
          invocations.map(() => source),
        );

        const reduced = reduceOpenTuiApplicationShellCommands(shell, invocations);
        expect(reduced.next.activeMode).toBe(surface.owningMode);
        if (surface.kind === "primary-mode") {
          expect(reduced.next.focus.focusZone).toBe("canvas");
        } else {
          expect(reduced.next.dockMode).toBe("open");
          expect(reduced.next.activeDockTool).toBe(surface.id);
          expect(reduced.next.focus.focusZone).toBe("dock-body");
        }
      }
    },
  );

  it("opens the palette as the sole overlay owner and restores focus on close", () => {
    const closed = projection({ focusZone: "dock-tabs" });
    const opened = reduceOpenTuiApplicationShellCommand(
      closed,
      applicationShellPaletteInvocation(closed, true, {
        kind: "keyboard",
        surface: "application-bar",
      }),
    );
    expect(opened.next.focus.overlays).toEqual([
      expect.objectContaining({ kind: "command-palette" }),
    ]);
    expect(opened.effect).toMatchObject({
      kind: "renderer-command",
      invocation: { id: "app.palette.open", args: {} },
    });

    const openProjection = projection({ paletteOpen: true, focusZone: "dock-tabs" });
    const closedAgain = reduceOpenTuiApplicationShellCommand(
      openProjection,
      applicationShellPaletteInvocation(openProjection, false, {
        kind: "keyboard",
        surface: "command-palette",
      }),
    );
    expect(closedAgain.next.focus.overlays).toEqual([]);
    expect(closedAgain.effect).toEqual({
      kind: "palette-close",
      restore: { kind: "dock-tool", tool: "missions" },
    });
  });

  it("correlates terminal palette return to the same live pane and rejects stale panes", () => {
    const terminalProjection = (
      paletteOpen: boolean,
      paneId: string,
      paletteFocusReturnTarget?: { kind: "pane"; paneId: string; input: "terminal" },
    ) =>
      projectOpenTuiApplicationShell({
        projectName: "tmux-ide",
        rootLabel: "/workspace/tmux-ide",
        workspaceName: "main",
        activeMode: "terminals",
        dockMode: "open",
        activeDockTool: "files",
        focusZone: "terminal",
        focusedPaneId: paneId,
        terminalInputPaneId: paneId,
        paletteOpen,
        paletteFocusReturnTarget,
        sessions: [{ name: "main", status: "working" }],
        activeSession: "main",
        agents: [],
      });
    const closed = terminalProjection(false, "%7");
    const opened = reduceOpenTuiApplicationShellCommand(
      closed,
      applicationShellPaletteInvocation(closed, true, {
        kind: "keyboard",
        surface: "terminal",
      }),
    );
    expect(opened.next.focus.overlays[0]?.focusReturnTarget).toEqual({
      kind: "pane",
      paneId: openTuiSemanticPaneId("%7"),
      input: "terminal",
    });

    const captured = opened.next.focus.overlays[0]!.focusReturnTarget as {
      kind: "pane";
      paneId: string;
      input: "terminal";
    };
    // tmux focus moved while the modal was open; close still targets the pane
    // captured at open, never the newly focused pane.
    const open = terminalProjection(true, "%8", captured);
    const close = reduceOpenTuiApplicationShellCommand(
      open,
      applicationShellPaletteInvocation(open, false, {
        kind: "keyboard",
        surface: "command-palette",
      }),
    );
    expect(close.effect).toEqual({
      kind: "palette-close",
      restore: {
        kind: "pane",
        paneId: openTuiSemanticPaneId("%7"),
        input: "terminal",
      },
    });
    expect(openTuiRuntimePaneId(openTuiSemanticPaneId("%7"), ["%6", "%7"])).toBe("%7");
    expect(openTuiRuntimePaneId(openTuiSemanticPaneId("%7"), ["%6"])).toBeNull();
  });

  it("uses daemon-owned pane identity in both authority projection and reverse focus routing", () => {
    const paneIdentities = [
      { runtimePaneId: "%7", semanticPaneId: "pane.01K2Y24E9Q9Y8ZHP7M4E2XH2AV" },
    ] as const;
    const input = {
      projectName: "tmux-ide",
      rootLabel: "/workspace/tmux-ide",
      workspaceName: "main",
      activeMode: "terminals" as const,
      dockMode: "open" as const,
      activeDockTool: "files" as const,
      focusZone: "terminal" as const,
      focusedPaneId: "%7",
      terminalInputPaneId: "%7",
      paneIdentities,
      paletteOpen: false,
      sessions: [{ name: "main", status: "working" as const }],
      activeSession: "main",
      agents: [{ paneId: "%7", name: "Codex", kind: "codex", status: "working" as const }],
    };

    const authority = openTuiApplicationShellAuthorityInput(input);
    expect(authority.focus.appFocusedPaneId).toBe(paneIdentities[0].semanticPaneId);
    expect(authority.workspace.sidebar.agents[0]?.paneId).toBe(paneIdentities[0].semanticPaneId);
    expect(
      openTuiRuntimePaneId(paneIdentities[0].semanticPaneId, ["%6", "%7"], paneIdentities),
    ).toBe("%7");
    expect(
      openTuiRuntimePaneId(paneIdentities[0].semanticPaneId, ["%6"], paneIdentities),
    ).toBeNull();
  });

  it("replays the shared canonical trace deterministically", () => {
    const input = {
      project: COHESION_FIXTURE_V1.project,
      workspace: COHESION_FIXTURE_V1.workspace,
      dock: COHESION_FIXTURE_V1.dock,
      focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
      connection: COHESION_FIXTURE_V1.connection,
    };
    const trace = applicationShellActionTraceV1(input, {
      kind: "program",
      surface: "opentui",
    });
    expect(replayApplicationShellActionTraceV1(trace)).toEqual(trace.finalState);
    expect(trace.invocations.map(({ id }) => id)).toContain(
      APPLICATION_SHELL_COMMAND_IDS.openPalette,
    );
    expect(trace.invocations.map(({ id }) => id)).toContain(
      APPLICATION_SHELL_COMMAND_IDS.closePalette,
    );
  });

  it("audits removal of every former local shell registry/activation owner", () => {
    const workbench = readFileSync(
      fileURLToPath(new URL("./workbench-shell.ts", import.meta.url)),
      "utf8",
    );
    const app = productionRootSource();
    expect(workbench).not.toContain("const DOCK_TABS");
    expect(app).not.toContain("<ShellTabBar");
    expect(app).not.toContain("RENDERER_COMMAND_IDS.openPalette");
    expect(app).not.toContain("rendererInvocationForCanvas(");
    expect(app).not.toContain("rendererInvocationForDock(");
    expect(app).toContain("submitSemanticPaneFocus(runtimePaneId)");
    expect(app).toContain('verb: "workspace.pane.select"');
    expect(app).toContain("mirror={semanticReplica()!.adapter.renderSource}");
    expect(app).not.toContain("semanticView={semanticReplica()?.lane.source");
    expect(app).toContain("semanticViewportAcknowledged()");
    expect(app).not.toMatch(
      /semanticView\?*\.(?:command|commandList|switchWindow|sendTextTo|sendKey)\(/u,
    );
    expect(app.match(/<ApplicationShell\b/gu)).toHaveLength(1);
    expect(app.match(/<WorkbenchShell\b/gu)).toHaveLength(1);
    expect(app.match(/\buseKeyboard\(/gu)).toHaveLength(1);
    expect(app.match(/\busePaste\(/gu)).toHaveLength(1);

    const canonicalIds = new Set(Object.values(APPLICATION_SHELL_COMMAND_IDS));
    expect(canonicalIds.size).toBe(Object.values(APPLICATION_SHELL_COMMAND_IDS).length);
    expect(
      applicationShellCommandInvocation(
        APPLICATION_SHELL_COMMAND_IDS.setDockMode,
        { mode: "maximized" },
        { kind: "program", surface: "audit" },
      ).id,
    ).toBe("application.shell.dock.mode.set");
  });
});
