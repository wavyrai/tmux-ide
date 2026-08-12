/* @jsxImportSource @opentui/solid */
import { Dynamic } from "@opentui/solid";
import { describe, expect, it, mock } from "bun:test";
import { Show, createSignal, onCleanup } from "solid-js";

import type { DialogFeatureSession } from "../features/dialogs/contract.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";
import { projectAgentTerminalCanvas } from "../workspace/agent-terminal-canvas.ts";
import { AgentTerminalCanvas } from "../workspace/agent-terminal-canvas-view.tsx";

type DialogFeature = typeof import("../features/dialogs/feature.tsx");
type TestFeatures = { readonly dialogs: DialogFeature };

describe("deferred Dialog OpenTUI boundary", () => {
  it("keeps assembled shell and terminal identity while admission resolves and opens", async () => {
    let resolveLoad!: (feature: DialogFeature) => void;
    const physicalLoad = new Promise<DialogFeature>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = mock(() => physicalLoad);
    const registry = new OptionalFeatureRegistry<TestFeatures>({ dialogs: loader });

    function Harness() {
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const projection = projectAgentTerminalCanvas({ width: 48, height: 10, chromeRows: 2 });
      const [feature, setFeature] = createSignal<DialogFeature>();
      const [session, setSession] = createSignal<DialogFeatureSession>();
      void registry.request("dialogs").then((loaded) => {
        if (!loaded) return;
        const owned = loaded.createDialogFeatureSession({
          viewport: () => ({ width: 48, height: 10, dialogWidth: 40 }),
        });
        setFeature(() => loaded);
        setSession(() => owned);
        void owned.prompt({ title: "Deferred prompt", placeholder: "agent name" });
      });
      onCleanup(() => {
        session()?.dispose();
        registry.dispose();
      });
      return (
        <box id="dialog-shell" width={48} height={10} flexDirection="column">
          <AgentTerminalCanvas
            theme={theme}
            projection={projection}
            chrome={<text>workspace · terminal</text>}
            framebuffer={<text id="dialog-terminal">real tmux framebuffer identity</text>}
          />
          <Show when={feature() && session()?.open()}>
            <Dynamic
              component={feature()!.DialogFeatureSurface}
              session={session()!}
              theme={theme}
            />
          </Show>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 48, height: 10 });
    await setup.renderOnce();
    const shell = setup.renderer.root.findDescendantById("dialog-shell");
    const terminal = setup.renderer.root.findDescendantById("dialog-terminal");
    expect(loader).not.toHaveBeenCalled();

    registry.admit();
    const loaded = await import("../features/dialogs/feature.tsx");
    resolveLoad(loaded);
    await physicalLoad;
    await Promise.resolve();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Deferred prompt");
    expect(setup.renderer.root.findDescendantById("dialog-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("dialog-terminal")).toBe(terminal);
    expect(loader).toHaveBeenCalledTimes(1);

    destroyTestRenderer(setup);
  });
});
