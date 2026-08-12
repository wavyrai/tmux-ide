/* @jsxImportSource @opentui/solid */
import { Dynamic } from "@opentui/solid";
import { describe, expect, it, mock } from "bun:test";
import { Show, createSignal, onCleanup } from "solid-js";

import { DEFAULT_APP_CONFIG } from "../../../lib/app-config.ts";
import type { DialogFeatureSession } from "../features/dialogs/contract.ts";
import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  destroyTestRenderer,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { AgentTerminalCanvas } from "../workspace/agent-terminal-canvas-view.tsx";
import { projectAgentTerminalCanvas } from "../workspace/agent-terminal-canvas.ts";
import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

type DialogFeature = typeof import("../features/dialogs/feature.tsx");
type TestFeatures = { readonly dialogs: DialogFeature };

describe("deferred Dialog OpenTUI boundary", () => {
  it("keeps the real terminal resident through queued/loading/error/retry/close/settings", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveRetry!: (feature: DialogFeature) => void;
    const firstLoad = new Promise<DialogFeature>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const retryLoad = new Promise<DialogFeature>((resolve) => {
      resolveRetry = resolve;
    });
    const loader = mock(() => (loader.mock.calls.length === 1 ? firstLoad : retryLoad));
    const registry = new OptionalFeatureRegistry<TestFeatures>({ dialogs: loader });
    let retry!: () => Promise<void>;
    let dismiss!: () => void;
    let openSettings!: () => Promise<void>;

    function Harness() {
      const theme = createSemanticThemeSnapshot({ mode: "dark" });
      const projection = projectAgentTerminalCanvas({ width: 48, height: 10, chromeRows: 2 });
      const [phase, setPhase] = createSignal("queued");
      const [feature, setFeature] = createSignal<DialogFeature>();
      const [session, setSession] = createSignal<DialogFeatureSession>();
      const install = async () => {
        setPhase("loading");
        try {
          const loaded = await registry.request("dialogs");
          if (!loaded) return;
          const owned = loaded.createDialogFeatureSession({
            viewport: () => ({ width: 48, height: 10, dialogWidth: 40 }),
          });
          setFeature(() => loaded);
          setSession(() => owned);
          setPhase("ready");
          void owned.prompt({ title: "Deferred prompt", placeholder: "agent name" });
        } catch {
          setPhase("error");
        }
      };
      retry = install;
      dismiss = () => {
        session()?.dismiss();
        setPhase("closed");
      };
      openSettings = async () => {
        const dialogs = session();
        if (!dialogs) return;
        const settings = await import("../features/settings/feature.ts");
        const owned = settings.createSettingsFeatureSession({
          dialogs,
          readConfig: () => DEFAULT_APP_CONFIG,
          readNotificationPrefs: () => ({
            enabled: true,
            toast: true,
            macos: false,
            terminal: true,
            delaySeconds: 2,
            sound: "blocked",
            onBlocked: true,
            onDone: true,
            quietHours: null,
          }),
          writeConfig: () => undefined,
          configureTheme: () => undefined,
          setPreviewAccent: () => undefined,
          setStatusNote: () => undefined,
          kittyKeys: true,
        });
        setPhase("settings");
        void owned.run("settings-keys");
      };
      void install();
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
          <text id="dialog-phase" position="absolute" right={0} top={0}>
            {phase()}
          </text>
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
    expect(loader).toHaveBeenCalledTimes(1);
    rejectFirst(new Error("bundle unavailable"));
    await firstLoad.catch(() => undefined);
    await Promise.resolve();
    await setup.renderOnce();
    expect(loader).toHaveBeenCalledTimes(1);

    const retrying = retry();
    const loaded = await import("../features/dialogs/feature.tsx");
    resolveRetry(loaded);
    await retrying;
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Deferred prompt");

    dismiss();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).not.toContain("Deferred prompt");
    await openSettings();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Keyboard shortcuts");
    expect(setup.renderer.root.findDescendantById("dialog-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("dialog-terminal")).toBe(terminal);
    expect(loader).toHaveBeenCalledTimes(2);

    destroyTestRenderer(setup);
  });
});
