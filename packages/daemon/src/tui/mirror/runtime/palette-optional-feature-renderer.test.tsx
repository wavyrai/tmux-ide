/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";

import type { PaletteFeatureSession } from "../features/palette/contract.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { AgentTerminalCanvas } from "../workspace/agent-terminal-canvas-view.tsx";
import { projectAgentTerminalCanvas } from "../workspace/agent-terminal-canvas.ts";
import {
  createApplicationOptionalFeatureRegistry,
  type ApplicationOptionalFeatures,
} from "./application-optional-features.ts";
import { ModalAdmissionCoordinator } from "./modal-admission-coordinator.ts";
import {
  createPaletteProductionController,
  type PaletteProductionLoadState,
} from "./palette-production-controller.ts";
import { PaletteProductionOverlay } from "./palette-production-overlay.tsx";

describe("production Palette controller OpenTUI assembly", () => {
  it("drives the real root seam without replacing the resident terminal canvas", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const canvas = projectAgentTerminalCanvas({ width: 60, height: 16, chromeRows: 2 });
    const registry = createApplicationOptionalFeatureRegistry();
    const admission = new ModalAdmissionCoordinator<"dialogs" | "settings" | "palette">();
    registry.admit();
    const phases: PaletteProductionLoadState[] = [];
    const events: string[] = [];
    let usageCount = 0;
    let repoAttempt = 0;
    const [open, setOpen] = createSignal(false);
    const [loadState, setLoadState] = createSignal<PaletteProductionLoadState>("idle");
    const [loadError, setLoadError] = createSignal("");
    const [feature, setFeature] = createSignal<ApplicationOptionalFeatures["palette"]>();
    const [session, setSession] = createSignal<PaletteFeatureSession>();
    const [currentSession, setCurrentSession] = createSignal("alpha");
    const [generation, setGeneration] = createSignal(1);
    const controller = createPaletteProductionController({
      registry,
      admission,
      reserveAdmission: () => admission.reserve("palette"),
      sources: {
        width: () => 60,
        height: () => 16,
        identity: () => ({
          workspaceName: currentSession(),
          directory: "/repo",
          projectRoot: "/repo",
          daemonIdentity: "daemon:4000",
          generation: generation(),
        }),
        facts: () => ({
          terminal: true,
          surface: "terminal",
          currentSurface: "terminals",
          currentViewId: "terminals",
          currentSession: currentSession(),
          sessions: ["alpha", "beta"],
          agents: [],
          panes: [],
          sizeMismatch: false,
          appMousePane: false,
          againName: null,
          usage: {},
          keycaps: {},
          views: [],
          syncOn: false,
          saveState: { hasBuffer: false, hasPath: false, readOnlyReason: null },
          multiplexerFacts: {
            workspaceConnected: true,
            sessionWindowCount: 1,
            windowPaneCount: 1,
          },
        }),
        loadRepoFiles: async () => {
          repoAttempt += 1;
          if (repoAttempt === 1) throw new Error("repository temporarily unavailable");
          return ["src/recovered.ts"];
        },
        loadBuffers: async () => [],
      },
      publish: {
        open: setOpen,
        loadState: (state) => {
          phases.push(state);
          setLoadState(state);
        },
        loadError: setLoadError,
        feature: (loaded) => setFeature(() => loaded),
        session: (owned) => setSession(() => owned),
        clearHover: () => events.push("hover:cleared"),
      },
      execute: {
        recordUsage: () => {
          usageCount += 1;
        },
        action: (intent) => events.push(`action:${intent.action.kind}`),
        settings: (intent) =>
          events.push(`settings:${intent.command}:${admission.snapshot().phase}`),
        pasteBuffer: (name) => events.push(`buffer:${name}`),
      },
    });

    function ProductionAssembly() {
      return (
        <box id="palette-shell" width={60} height={16}>
          <AgentTerminalCanvas
            theme={theme}
            projection={canvas}
            chrome={<text>workspace alpha</text>}
            framebuffer={<text id="palette-terminal">tmux framebuffer</text>}
          />
          <PaletteProductionOverlay
            open={open()}
            width={60}
            height={16}
            overlayWidth={52}
            loadState={loadState()}
            loadError={loadError()}
            feature={feature()}
            session={session()}
            theme={theme}
          />
        </box>
      );
    }

    const setup = await renderForTest(() => <ProductionAssembly />, { width: 60, height: 16 });
    await setup.renderOnce();
    const shell = setup.renderer.root.findDescendantById("palette-shell");
    const terminal = setup.renderer.root.findDescendantById("palette-terminal");
    controller.open();
    expect(admission.snapshot()).toMatchObject({ kind: "palette", reserved: true });
    expect(phases).toContain("loading");
    for (let attempt = 0; attempt < 20 && !controller.currentSession(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (
      let attempt = 0;
      attempt < 20 && controller.currentSession()?.snapshot().repo.phase !== "error";
      attempt += 1
    ) {
      await Promise.resolve();
    }
    await setup.renderOnce();
    const owned = controller.currentSession()!;
    expect(owned).toBe(session());
    expect(stableFrame(setup.captureCharFrame())).toContain("repository temporarily unavailable");
    const retry = owned
      .projection()
      .rows.find((row) => row.kind === "state" && row.state === "retry")!;
    owned.handlePointer({ kind: "down", x: retry.rect.x, y: retry.rect.y });
    for (let attempt = 0; attempt < 20 && owned.snapshot().repo.phase !== "ready"; attempt += 1) {
      await Promise.resolve();
    }
    await setup.renderOnce();
    expect(owned.snapshot().repo).toEqual({ phase: "ready", value: ["src/recovered.ts"] });

    setCurrentSession("beta");
    setGeneration(2);
    controller.switchWorkspace({
      workspaceName: "beta",
      directory: "/repo",
      projectRoot: "/repo",
      daemonIdentity: "daemon:4000",
      generation: 2,
    });
    expect(
      owned
        .entries()
        .find((entry) => entry.action.kind === "attach" && entry.action.session === "beta")
        ?.descriptor.current,
    ).toBe(true);

    const settings = owned
      .entries()
      .find((entry) => entry.action.kind === "settings" && entry.action.id === "settings-keys")!;
    while (owned.snapshot().selectedCommandId !== settings.id) {
      owned.handleKey({ name: "down", ctrl: false, meta: false, shift: false });
    }
    owned.handleKey({ name: "return", ctrl: false, meta: false, shift: false });
    await setup.renderOnce();
    expect(usageCount).toBe(1);
    expect(events).toContain("settings:settings-keys:idle");
    expect(open()).toBe(false);
    expect(setup.renderer.root.findDescendantById("palette-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("palette-terminal")).toBe(terminal);

    controller.dispose();
    registry.dispose();
    admission.dispose();
    destroyTestRenderer(setup);
  });
});
