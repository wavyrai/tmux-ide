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

type TestChangesFeature = { readonly ChangesSurface: () => ReturnType<typeof ChangesSurface> };
type TestFeatures = { readonly changes: TestChangesFeature };

function ChangesSurface() {
  return <text id="optional-changes-surface">Changes ready</text>;
}

describe("deferred Changes OpenTUI boundary", () => {
  it("retains shell and terminal renderable identity while Changes resolves and caches reopen", async () => {
    let resolveLoad!: (feature: TestChangesFeature) => void;
    const physicalLoad = new Promise<TestChangesFeature>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = mock(() => physicalLoad);
    const registry = new OptionalFeatureRegistry<TestFeatures>({ changes: loader });
    let setOpen!: (open: boolean) => void;

    function Harness() {
      const [open, updateOpen] = createSignal(true);
      const [feature, setFeature] = createSignal<TestChangesFeature>();
      setOpen = updateOpen;
      const request = registry.request("changes");
      void request.then(
        (loaded) => {
          if (loaded) setFeature(() => loaded);
        },
        () => undefined,
      );
      onCleanup(() => registry.dispose());
      return (
        <box id="optional-changes-shell" width={36} height={4} flexDirection="column">
          <text id="optional-changes-terminal">terminal frame</text>
          <Show when={open()}>
            <Show
              when={feature()}
              fallback={<text id="optional-changes-loading">Loading Changes…</text>}
            >
              {(loaded) => <Dynamic component={loaded().ChangesSurface} />}
            </Show>
          </Show>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 36, height: 4 });
    await setup.renderOnce();
    const shell = setup.renderer.root.findDescendantById("optional-changes-shell");
    const terminal = setup.renderer.root.findDescendantById("optional-changes-terminal");
    expect(stableFrame(setup.captureCharFrame())).toContain("Loading Changes…");
    expect(loader).not.toHaveBeenCalled();

    registry.admit();
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoad({ ChangesSurface });
    await physicalLoad;
    await Promise.resolve();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Changes ready");
    expect(setup.renderer.root.findDescendantById("optional-changes-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("optional-changes-terminal")).toBe(terminal);

    setOpen(false);
    await setup.renderOnce();
    setOpen(true);
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Changes ready");
    await expect(registry.request("changes")).resolves.toEqual({ ChangesSurface });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(setup.renderer.root.findDescendantById("optional-changes-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("optional-changes-terminal")).toBe(terminal);
    expect(registry.getMetrics()).toMatchObject({ loadsStarted: 1, cacheHits: 1 });

    destroyTestRenderer(setup);
  });
});
