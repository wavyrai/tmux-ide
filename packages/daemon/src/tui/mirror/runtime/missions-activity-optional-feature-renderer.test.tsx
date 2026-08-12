/* @jsxImportSource @opentui/solid */
import { Dynamic } from "@opentui/solid";
import { describe, expect, it, mock } from "bun:test";
import { Show, createSignal, onCleanup } from "solid-js";

import {
  destroyTestRenderer,
  renderForTest,
  stableFrame,
} from "../testing/renderer-harness.test.ts";
import { OptionalFeatureRegistry } from "./optional-feature-registry.ts";

type TestFeature = {
  readonly MissionsSurface: () => ReturnType<typeof MissionsSurface>;
  readonly ActivitySurface: () => ReturnType<typeof ActivitySurface>;
};
type TestFeatures = { readonly missionsActivity: TestFeature };

function MissionsSurface() {
  return <text id="optional-missions-surface">Missions ready</text>;
}

function ActivitySurface() {
  return <text id="optional-activity-surface">Activity ready</text>;
}

describe("deferred Missions and Activity OpenTUI boundary", () => {
  it("retains shell and terminal identity while one shared module resolves and reopens", async () => {
    let resolveLoad!: (feature: TestFeature) => void;
    const physicalLoad = new Promise<TestFeature>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = mock(() => physicalLoad);
    const registry = new OptionalFeatureRegistry<TestFeatures>({ missionsActivity: loader });
    let setOpen!: (open: boolean) => void;
    let setSurface!: (surface: "missions" | "activity") => void;

    function Harness() {
      const [open, updateOpen] = createSignal(true);
      const [surface, updateSurface] = createSignal<"missions" | "activity">("missions");
      const [feature, setFeature] = createSignal<TestFeature>();
      setOpen = updateOpen;
      setSurface = updateSurface;
      const request = registry.request("missionsActivity");
      void request.then(
        (loaded) => {
          if (loaded) setFeature(() => loaded);
        },
        () => undefined,
      );
      onCleanup(() => registry.dispose());
      return (
        <box id="optional-missions-activity-shell" width={40} height={4} flexDirection="column">
          <text id="optional-missions-activity-terminal">terminal frame</text>
          <Show when={open()}>
            <Show when={feature()} fallback={<text>Loading Missions and Activity…</text>}>
              {(loaded) => (
                <Dynamic
                  component={
                    surface() === "missions" ? loaded().MissionsSurface : loaded().ActivitySurface
                  }
                />
              )}
            </Show>
          </Show>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 40, height: 4 });
    await setup.renderOnce();
    const shell = setup.renderer.root.findDescendantById("optional-missions-activity-shell");
    const terminal = setup.renderer.root.findDescendantById("optional-missions-activity-terminal");
    expect(stableFrame(setup.captureCharFrame())).toContain("Loading Missions and Activity…");
    expect(loader).not.toHaveBeenCalled();

    registry.admit();
    resolveLoad({ MissionsSurface, ActivitySurface });
    await physicalLoad;
    await Promise.resolve();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Missions ready");

    setSurface("activity");
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Activity ready");
    setOpen(false);
    await setup.renderOnce();
    setOpen(true);
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Activity ready");
    await expect(registry.request("missionsActivity")).resolves.toEqual({
      MissionsSurface,
      ActivitySurface,
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(setup.renderer.root.findDescendantById("optional-missions-activity-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("optional-missions-activity-terminal")).toBe(
      terminal,
    );

    destroyTestRenderer(setup);
  });
});
