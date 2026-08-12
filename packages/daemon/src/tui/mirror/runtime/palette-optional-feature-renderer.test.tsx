/* @jsxImportSource @opentui/solid */
import { Dynamic } from "@opentui/solid";
import { describe, expect, it } from "bun:test";
import { Show, createSignal, onCleanup } from "solid-js";

import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { AgentTerminalCanvas } from "../workspace/agent-terminal-canvas-view.tsx";
import { projectAgentTerminalCanvas } from "../workspace/agent-terminal-canvas.ts";
import type { PaletteFeatureSession } from "../features/palette/contract.ts";

type PaletteFeature = typeof import("../features/palette/feature.ts");

describe("deferred Palette assembled OpenTUI boundary", () => {
  it("retains terminal identity through loading/error/retry/open/close/settings transfer", async () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const canvas = projectAgentTerminalCanvas({ width: 60, height: 16, chromeRows: 2 });
    let fail = true;
    let open!: () => Promise<void>;
    let close!: () => void;
    let transferSettings!: () => void;

    function Harness() {
      const [phase, setPhase] = createSignal<"closed" | "loading" | "error" | "ready" | "settings">(
        "closed",
      );
      const [feature, setFeature] = createSignal<PaletteFeature>();
      const [session, setSession] = createSignal<PaletteFeatureSession>();
      open = async () => {
        setPhase("loading");
        await Promise.resolve();
        if (fail) {
          fail = false;
          setPhase("error");
          return;
        }
        const loaded = await import("../features/palette/feature.ts");
        const owned = loaded.createPaletteFeatureSession({
          width: () => 60,
          height: () => 16,
          identity: () => ({
            workspaceName: "alpha",
            directory: "/repo",
            projectRoot: "/repo",
            daemonIdentity: "daemon",
            generation: 1,
          }),
          facts: () => ({
            terminal: true,
            surface: "terminal",
            currentSurface: "terminals",
            currentViewId: "terminals",
            currentSession: "alpha",
            sessions: ["alpha"],
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
          dispatch: () => undefined,
        });
        owned.openPalette();
        setFeature(() => loaded);
        setSession(() => owned);
        setPhase("ready");
      };
      close = () => {
        session()?.close();
        setPhase("closed");
      };
      transferSettings = () => setPhase("settings");
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
    await open();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Navigator");
    close();
    transferSettings();
    await setup.renderOnce();
    expect(setup.renderer.root.findDescendantById("palette-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("palette-terminal")).toBe(terminal);
    destroyTestRenderer(setup);
  });
});
