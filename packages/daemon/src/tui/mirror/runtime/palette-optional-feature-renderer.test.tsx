/* @jsxImportSource @opentui/solid */
import { Dynamic } from "@opentui/solid";
import { describe, expect, it } from "bun:test";
import { Show, createSignal, onCleanup } from "solid-js";

import type { PaletteFeatureSession } from "../features/palette/contract.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { AgentTerminalCanvas } from "../workspace/agent-terminal-canvas-view.tsx";
import { projectAgentTerminalCanvas } from "../workspace/agent-terminal-canvas.ts";
import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";
import { ModalAdmissionCoordinator } from "./modal-admission-coordinator.ts";

type PaletteFeature = typeof import("../features/palette/feature.ts");

describe("deferred Palette production OpenTUI boundary", () => {
  it("assembles loader, admission, session, host adapter, and resident canvas", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const canvas = projectAgentTerminalCanvas({ width: 60, height: 16, chromeRows: 2 });
    const registry = createApplicationOptionalFeatureRegistry();
    const admission = new ModalAdmissionCoordinator<"palette" | "settings">();
    registry.admit();
    const events: string[] = [];
    let usageCount = 0;
    let open!: () => Promise<void>;
    let ownedSession!: PaletteFeatureSession;

    function Harness() {
      const [phase, setPhase] = createSignal<"closed" | "loading" | "ready" | "settings">("closed");
      const [feature, setFeature] = createSignal<PaletteFeature>();
      const [session, setSession] = createSignal<PaletteFeatureSession>();
      const [currentSession, setCurrentSession] = createSignal("alpha");
      open = async () => {
        const token = admission.reserve("palette");
        if (!token) return;
        events.push("palette:reserved");
        admission.markLoading(token);
        setPhase("loading");
        const loaded = await registry.request("palette");
        if (!loaded || !admission.isCurrent(token)) return;
        const owned = loaded.createPaletteFeatureSession({
          width: () => 60,
          height: () => 16,
          identity: () => ({
            workspaceName: currentSession(),
            directory: "/repo",
            projectRoot: "/repo",
            daemonIdentity: "daemon:4000",
            generation: 1,
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
          loadRepoFiles: async () => [],
          loadBuffers: async () => [],
          dispatch: (intent) => {
            if (intent.kind === "close") {
              events.push("palette:released");
              admission.release(token);
              setPhase("closed");
            } else if (intent.kind === "settings") {
              usageCount += 1;
              events.push(`settings:${admission.snapshot().phase}`);
              setPhase("settings");
            }
          },
        });
        owned.openPalette();
        ownedSession = owned;
        setFeature(() => loaded);
        setSession(() => owned);
        setPhase("ready");
        admission.markReady(token);
        setCurrentSession("beta");
      };
      onCleanup(() => session()?.dispose());
      return (
        <box id="palette-shell" width={60} height={16}>
          <AgentTerminalCanvas
            theme={theme}
            projection={canvas}
            chrome={<text>workspace alpha</text>}
            framebuffer={<text id="palette-terminal">tmux framebuffer</text>}
          />
          <text position="absolute" right={0} top={0}>
            {phase()}
          </text>
          <Show when={phase() === "ready" && feature() && session()}>
            <Dynamic
              component={feature()!.PaletteFeatureSurface}
              session={session()!}
              theme={theme}
            />
          </Show>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 60, height: 16 });
    await setup.renderOnce();
    const shell = setup.renderer.root.findDescendantById("palette-shell");
    const terminal = setup.renderer.root.findDescendantById("palette-terminal");
    await open();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Navigator");
    expect(
      ownedSession
        .entries()
        .find((entry) => entry.action.kind === "attach" && entry.action.session === "beta")
        ?.descriptor.current,
    ).toBe(true);
    const settings = ownedSession
      .entries()
      .find((entry) => entry.action.kind === "settings" && entry.action.id === "settings-keys")!;
    while (ownedSession.snapshot().selectedCommandId !== settings.id) {
      ownedSession.handleKey({ name: "down", ctrl: false, meta: false, shift: false });
    }
    ownedSession.handleKey({ name: "return", ctrl: false, meta: false, shift: false });
    await setup.renderOnce();
    expect(events).toEqual(["palette:reserved", "palette:released", "settings:idle"]);
    expect(usageCount).toBe(1);
    expect(setup.renderer.root.findDescendantById("palette-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("palette-terminal")).toBe(terminal);
    registry.dispose();
    admission.dispose();
    destroyTestRenderer(setup);
  });
});
