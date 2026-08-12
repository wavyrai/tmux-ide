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

type TestFilesFeature = { readonly FilesSurface: () => ReturnType<typeof FilesSurface> };
type TestFeatures = { readonly files: TestFilesFeature };

function FilesSurface() {
  return <text id="optional-files-surface">Files ready</text>;
}

describe("deferred Files OpenTUI boundary", () => {
  it("retains the shell and terminal renderables while Files resolves and caches reopen", async () => {
    let resolveLoad!: (feature: TestFilesFeature) => void;
    const physicalLoad = new Promise<TestFilesFeature>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = mock(() => physicalLoad);
    const registry = new OptionalFeatureRegistry<TestFeatures>({ files: loader });
    let setOpen!: (open: boolean) => void;

    function Harness() {
      const [open, updateOpen] = createSignal(true);
      const [feature, setFeature] = createSignal<TestFilesFeature>();
      setOpen = updateOpen;
      const request = registry.request("files");
      void request.then(
        (loaded) => {
          if (loaded) setFeature(() => loaded);
        },
        () => undefined,
      );
      onCleanup(() => registry.dispose());
      return (
        <box id="optional-files-shell" width={32} height={4} flexDirection="column">
          <text id="optional-files-terminal">terminal frame</text>
          <Show when={open()}>
            <Show
              when={feature()}
              fallback={<text id="optional-files-loading">Loading Files…</text>}
            >
              {(loaded) => <Dynamic component={loaded().FilesSurface} />}
            </Show>
          </Show>
        </box>
      );
    }

    const setup = await renderForTest(() => <Harness />, { width: 32, height: 4 });
    await setup.renderOnce();
    const shell = setup.renderer.root.findDescendantById("optional-files-shell");
    const terminal = setup.renderer.root.findDescendantById("optional-files-terminal");
    expect(stableFrame(setup.captureCharFrame())).toContain("Loading Files…");
    expect(loader).not.toHaveBeenCalled();

    registry.admit();
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoad({ FilesSurface });
    await physicalLoad;
    await Promise.resolve();
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Files ready");
    expect(setup.renderer.root.findDescendantById("optional-files-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("optional-files-terminal")).toBe(terminal);

    setOpen(false);
    await setup.renderOnce();
    setOpen(true);
    await setup.renderOnce();
    expect(stableFrame(setup.captureCharFrame())).toContain("Files ready");
    await expect(registry.request("files")).resolves.toEqual({ FilesSurface });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(setup.renderer.root.findDescendantById("optional-files-shell")).toBe(shell);
    expect(setup.renderer.root.findDescendantById("optional-files-terminal")).toBe(terminal);
    expect(registry.getMetrics()).toMatchObject({ loadsStarted: 1, cacheHits: 1 });

    destroyTestRenderer(setup);
  });
});
