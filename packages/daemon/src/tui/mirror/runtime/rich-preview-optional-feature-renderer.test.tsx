/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import {
  encodeWidgetMarkerLine,
  type TerminalReplicaRow,
  type WidgetAssetId,
} from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalWidgetContent } from "@tmux-ide/core";

import type { BlitOptions } from "../pane-mirror.ts";
import {
  PaneSurfaceRenderable,
  registerPaneSurface,
  type TerminalPaneRenderSource,
} from "../pane-surface.tsx";
import type { RichPlacementProjection } from "../rich-placement-projection.ts";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "../theme.ts";
import { renderForTest } from "../testing/renderer-harness.test.ts";
import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";
import { RichPreviewOverlay } from "./rich-preview-overlay.tsx";

const ASSET = "a".repeat(64) as WidgetAssetId;

function richInput(title: string, width: number) {
  const args = { assetId: ASSET, title };
  const contentDigest = hashTerminalWidgetContent("markdown", args);
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(40, 8));
  const marker = encodeWidgetMarkerLine("markdown", args);
  const row: TerminalReplicaRow = {
    wrapped: false,
    cells: [...marker].map((grapheme) => ({
      grapheme,
      width: 1,
      foreground: { kind: "default" },
      background: { kind: "default" },
      attributes: 0,
    })),
  };
  snapshot.grid[0] = row;
  const placement = {
    id: "markdown",
    kind: "widget",
    row: 0,
    column: 0,
    rows: 6,
    columns: width,
    contentDigest,
  } as const;
  snapshot.placements = [placement];
  const projection: RichPlacementProjection = {
    renderableId: "rich:pane.editor:markdown",
    paneId: "pane.editor",
    marker: { id: "markdown", args, lineIndex: 0 },
    placement,
    visible: true,
    hostRect: { left: 0, top: 0, width, height: 6 },
  };
  return { snapshot, projection, contentDigest };
}

describe("deferred Rich Preview production OpenTUI boundary", () => {
  it("retains pane and wrapper identities through load, content, geometry, and theme updates", async () => {
    registerPaneSurface();
    const registry = createApplicationOptionalFeatureRegistry();
    const pendingFeature = registry.request("richPreview");
    expect(registry.getMetrics().loadsStarted).toBe(0);
    registry.admit();
    const feature = await pendingFeature;
    if (!feature) throw new Error("Rich Preview feature did not load");

    let resolveAsset!: (
      value: Awaited<
        ReturnType<Parameters<typeof feature.createRichPreviewFeatureSession>[0]["loadAsset"]>
      >,
    ) => void;
    const loadAsset = () =>
      new Promise<
        Awaited<
          ReturnType<Parameters<typeof feature.createRichPreviewFeatureSession>[0]["loadAsset"]>
        >
      >((resolve) => {
        resolveAsset = resolve;
      });
    let theme = createSemanticThemeSnapshot({ mode: "dark" });
    const frames: Array<() => void> = [];
    let bumpRevision!: () => void;
    const session = feature.createRichPreviewFeatureSession({
      theme: () => theme,
      loadAsset,
      onChange: () => bumpRevision?.(),
      afterNativeFrame: (callback) => frames.push(callback),
    });
    const initial = richInput("First", 32);
    const request = (value: ReturnType<typeof richInput>, generation: string) =>
      feature.richPreviewRequestsFromCanonical(
        {
          workspaceId: "workspace",
          workspaceGeneration: "11111111-1111-4111-8111-111111111111",
          paneId: "pane.editor",
          paneGeneration: generation,
          snapshot: value.snapshot,
        },
        [value.projection],
      );
    session.sync(request(initial, "pane:g1"));

    const palette = createTerminalPaletteProjection(theme);
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (
        _id: string,
        _buffers: unknown,
        _width: number,
        _height: number,
        _scrollOffset: number,
        _defaultFg: number,
        _defaultBg: number,
        _options: BlitOptions,
      ) => undefined,
    } as unknown as TerminalPaneRenderSource;
    const paneRefs = new Set<PaneSurfaceRenderable>();
    const wrapperRefs = new Set<object>();
    let setPlacement!: (value: RichPlacementProjection | null) => void;
    let setTheme!: (value: typeof theme) => void;
    const setup = await renderForTest(
      () => {
        const [revision, setRevision] = createSignal(0);
        const [placement, setPlacementSignal] = createSignal<RichPlacementProjection | null>(
          initial.projection,
        );
        const [themeSignal, setThemeSignal] = createSignal(theme);
        bumpRevision = () => setRevision((value) => value + 1);
        setPlacement = setPlacementSignal;
        setTheme = setThemeSignal;
        const publicationFor = (id: string) => {
          revision();
          return session.publications().find((item) => item.authority.renderableId === id);
        };
        return (
          <box position="relative" width={40} height={8}>
            <pane_surface
              ref={(pane: PaneSurfaceRenderable) => paneRefs.add(pane)}
              width={40}
              height={8}
              mirror={mirror}
              paneId="pane.editor"
              defaultFg={palette.foreground}
              defaultBg={palette.background}
              terminalPalette={palette}
              searchHl={palette.searchHighlight}
              searchCur={palette.searchCurrent}
              contentVersion={1}
            />
            <RichPreviewOverlay
              placementIds={placement() ? [initial.projection.renderableId] : []}
              placementFor={() => placement()}
              publicationFor={publicationFor}
              surfaceComponent={feature.TuiRichWidgetSurface}
              theme={themeSignal()}
              syntaxStyle={session.syntaxStyle()}
              wrapperRef={(_id, wrapper) => wrapperRefs.add(wrapper)}
            />
          </box>
        );
      },
      { width: 40, height: 8 },
    );
    await setup.waitForFrame((frame) => frame.includes("Loading Markdown"));
    expect(paneRefs.size).toBe(1);
    expect(wrapperRefs.size).toBe(1);

    const bytes = new TextEncoder().encode("# Loaded");
    resolveAsset({
      status: "ok",
      asset: {
        assetId: ASSET,
        media: "text/markdown",
        name: "first.md",
        byteLength: bytes.length,
        bytes,
      },
    });
    await setup.waitForFrame((frame) => frame.includes("Loaded"));
    expect(paneRefs.size).toBe(1);
    expect(wrapperRefs.size).toBe(1);

    const changed = richInput("Changed", 36);
    session.sync(request(changed, "pane:g2"));
    setPlacement(changed.projection);
    await setup.renderOnce();
    theme = createSemanticThemeSnapshot({ mode: "light" });
    setTheme(theme);
    session.syncTheme();
    await setup.renderOnce();
    expect(paneRefs.size).toBe(1);
    expect(wrapperRefs.size).toBe(1);

    session.sync([]);
    setPlacement(null);
    await setup.renderOnce();
    expect(paneRefs.size).toBe(1);
    session.sync(request(changed, "pane:g3"));
    setPlacement(changed.projection);
    await setup.renderOnce();
    expect(paneRefs.size).toBe(1);
    expect(wrapperRefs.size).toBe(2);

    setup.renderer.destroy();
    session.dispose();
    frames.splice(0).forEach((frame) => frame());
    registry.dispose();
  });
});
