import { describe, expect, it } from "vitest";
import {
  encodeWidgetMarkerLine,
  type TerminalReplicaPlacement,
  type TerminalReplicaRow,
  type WidgetAssetId,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalWidgetContent,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/core";

import type { RichPreviewAssetLoadResult, RichPreviewRequest } from "./contract.ts";
import { createRichPreviewSession, richPreviewRequestsFromCanonical } from "./session.ts";

const ASSET = "a".repeat(64) as WidgetAssetId;

function row(text: string): TerminalReplicaRow {
  return {
    cells: [...text].map((grapheme) => ({
      grapheme,
      width: 1 as const,
      foreground: { kind: "default" as const },
      background: { kind: "default" as const },
      attributes: 0,
    })),
    wrapped: false,
  };
}

function request(
  args: unknown,
  options: {
    id?: string;
    renderableId?: string;
    paneGeneration?: string;
    geometry?: Partial<Pick<TerminalReplicaPlacement, "row" | "column" | "rows" | "columns">>;
    visible?: boolean;
  } = {},
): RichPreviewRequest {
  const id = options.id ?? "markdown";
  const digest = hashTerminalWidgetContent(id, args);
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(120, 20));
  snapshot.history = [row(encodeWidgetMarkerLine(id, args))];
  const placement: TerminalReplicaPlacement = {
    id,
    kind: "widget",
    row: options.geometry?.row ?? 0,
    column: options.geometry?.column ?? 0,
    rows: options.geometry?.rows ?? 10,
    columns: options.geometry?.columns ?? 80,
    contentDigest: digest,
  };
  snapshot.placements = [placement];
  return {
    authority: {
      workspaceId: "workspace",
      workspaceGeneration: "11111111-1111-4111-8111-111111111111",
      paneId: "terminal.pane.abcdefghijklmnop",
      paneGeneration: options.paneGeneration ?? "pane:incarnation-1",
      renderableId: options.renderableId ?? "rich:one",
      contentDigest: digest,
    },
    snapshot: snapshot as TerminalReplicaSnapshot,
    placement,
    visible: options.visible ?? true,
  };
}

function deferredLoad() {
  let resolve!: (result: RichPreviewAssetLoadResult) => void;
  const promise = new Promise<RichPreviewAssetLoadResult>((accept) => (resolve = accept));
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("rich preview session", () => {
  it("derives exact authority from canonical identity without copying snapshot or geometry into identity", () => {
    const value = request({ text: "# One" });
    const moved = { ...value.placement, row: 9, columns: 12 };
    const [first] = richPreviewRequestsFromCanonical(
      {
        ...value.authority,
        snapshot: value.snapshot,
      },
      [
        {
          renderableId: value.authority.renderableId,
          paneId: value.authority.paneId,
          placementId: moved.id,
          placement: moved,
          clipped: null,
          hostRect: null,
          clipping: { top: false, right: false, bottom: false, left: false },
          visible: false,
          marker: { id: moved.id, args: null, lineIndex: moved.row },
          fallback: {
            kind: "authenticated-content-unavailable",
            widgetId: moved.id,
            placementKind: moved.kind,
            contentDigest: moved.contentDigest,
          },
        },
      ],
    );
    expect(first?.snapshot).toBe(value.snapshot);
    expect(first?.authority).toEqual(value.authority);
    expect(JSON.stringify(first?.authority)).not.toContain('"row"');
  });

  it("recovers and verifies a marker from retained canonical rows without making geometry identity", () => {
    let changes = 0;
    const session = createRichPreviewSession({
      loadAsset: async () => ({ status: "error", reason: "unavailable" }),
      onChange: () => changes++,
      afterNativeFrame: (callback) => callback(),
    });
    const first = request({ text: "# Canonical" });
    session.sync([first]);
    expect(session.publications()[0]).toMatchObject({
      authority: { contentDigest: first.authority.contentDigest },
      resolution: { phase: "ready", surface: { kind: "markdown", text: "# Canonical" } },
    });
    const moved = request(
      { text: "# Canonical" },
      { geometry: { row: 8, column: 4, rows: 5, columns: 30 } },
    );
    session.sync([moved]);
    expect(session.publications()[0]?.authority).toBe(first.authority);
    expect(changes).toBe(1);
    session.sync([moved]);
    expect(changes).toBe(1);
  });

  it("releases decoded inline marker content with its final preview reference", () => {
    const session = createRichPreviewSession({
      loadAsset: async () => ({ status: "error", reason: "unavailable" }),
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    for (let index = 0; index < 100; index += 1) {
      session.sync([request({ text: `# unique-${index}-${"x".repeat(1_000)}` })]);
    }
    expect(session.getMetrics()).toMatchObject({ activePreviews: 1, retainedBytes: 0 });
    session.sync([]);
    expect(session.publications()).toEqual([]);
    expect(session.getMetrics()).toMatchObject({ activePreviews: 0, retainedBytes: 0 });
  });

  it("fails closed when canonical content does not match the authenticated digest", () => {
    const session = createRichPreviewSession({
      loadAsset: async () => ({ status: "error", reason: "unavailable" }),
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    const value = request({ text: "trusted" });
    value.snapshot.history = [row(encodeWidgetMarkerLine("markdown", { text: "different" }))];
    session.sync([value]);
    expect(session.publications()).toEqual([]);
  });

  it("performs no asset IO for unsupported raster and GIF previews", () => {
    let loads = 0;
    const session = createRichPreviewSession({
      loadAsset: async () => {
        loads++;
        return { status: "error", reason: "unavailable" };
      },
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    session.sync([
      request({ assetId: ASSET, name: "demo.gif" }, { id: "image" }),
      request({ assetId: ASSET, name: "demo.png" }, { id: "image", renderableId: "rich:two" }),
    ]);
    expect(loads).toBe(0);
    expect(session.publications().map(({ resolution }) => resolution.phase)).toEqual([
      "fallback",
      "fallback",
    ]);
  });

  it("single-flights shared assets and evicts immediately after the final reference disappears", async () => {
    const pending = deferredLoad();
    let loads = 0;
    const session = createRichPreviewSession({
      loadAsset: () => {
        loads++;
        return pending.promise;
      },
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    const a = request({ assetId: ASSET, title: "A" });
    const b = request({ assetId: ASSET, title: "A" }, { renderableId: "rich:two" });
    session.sync([a, b]);
    expect(loads).toBe(1);
    expect(session.getMetrics()).toMatchObject({ inFlightAssets: 1, joinedLoads: 1 });
    const bytes = new TextEncoder().encode("# Loaded");
    pending.resolve({
      status: "ok",
      asset: {
        assetId: ASSET,
        media: "text/markdown",
        name: "A.md",
        byteLength: bytes.length,
        bytes,
      },
    });
    await tick();
    expect(session.getMetrics()).toMatchObject({ cachedAssets: 1, retainedBytes: bytes.length });
    session.sync([a]);
    expect(session.getMetrics().retainedBytes).toBe(bytes.length);
    session.sync([]);
    expect(session.getMetrics()).toMatchObject({ cachedAssets: 0, retainedBytes: 0 });
  });

  it("aborts disappeared work and fences late results across pane generations", async () => {
    const first = deferredLoad();
    const second = deferredLoad();
    let calls = 0;
    const session = createRichPreviewSession({
      loadAsset: () => (++calls === 1 ? first.promise : second.promise),
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    const old = request({ assetId: ASSET, title: "Old" });
    const nextAsset = "b".repeat(64) as WidgetAssetId;
    const current = request(
      { assetId: nextAsset, title: "Current" },
      { paneGeneration: "pane:incarnation-2" },
    );
    session.sync([old]);
    session.sync([current]);
    expect(session.getMetrics()).toMatchObject({ loadsStarted: 2, loadsAborted: 1 });
    const staleBytes = new TextEncoder().encode("stale");
    first.resolve({
      status: "ok",
      asset: {
        assetId: ASSET,
        media: "text/markdown",
        name: "old.md",
        byteLength: 5,
        bytes: staleBytes,
      },
    });
    const currentBytes = new TextEncoder().encode("# Current");
    second.resolve({
      status: "ok",
      asset: {
        assetId: nextAsset,
        media: "text/markdown",
        name: "current.md",
        byteLength: currentBytes.length,
        bytes: currentBytes,
      },
    });
    await tick();
    expect(session.publications()[0]).toMatchObject({
      authority: { paneGeneration: "pane:incarnation-2" },
      resolution: { surface: { text: "# Current" } },
    });
    expect(session.getMetrics().lateResultsDiscarded).toBeGreaterThanOrEqual(1);
  });

  it("publishes a deterministic cap fallback without a reload loop", async () => {
    let loads = 0;
    const bytes = new TextEncoder().encode("12345");
    const session = createRichPreviewSession(
      {
        loadAsset: async () => {
          loads++;
          return {
            status: "ok",
            asset: {
              assetId: ASSET,
              media: "text/markdown",
              name: "large.md",
              byteLength: bytes.length,
              bytes,
            },
          };
        },
        onChange: () => undefined,
        afterNativeFrame: (callback) => callback(),
      },
      { retainedByteCap: 4 },
    );
    const value = request({ assetId: ASSET });
    session.sync([value]);
    await tick();
    expect(session.publications()[0]).toMatchObject({ resolution: { phase: "fallback" } });
    session.sync([value]);
    session.sync([value]);
    expect(loads).toBe(1);
    expect(session.getMetrics()).toMatchObject({ cacheLimitRefusals: 1, retainedBytes: 0 });
  });

  it("rejects dishonest host asset identity and byte accounting", async () => {
    const actual = new TextEncoder().encode("much larger than declared");
    const wrongId = "c".repeat(64) as WidgetAssetId;
    const session = createRichPreviewSession({
      loadAsset: async () => ({
        status: "ok",
        asset: {
          assetId: wrongId,
          media: "text/markdown",
          name: "wrong.md",
          byteLength: 1,
          bytes: actual,
        },
      }),
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    session.sync([request({ assetId: ASSET })]);
    await tick();
    expect(session.publications()[0]).toMatchObject({ resolution: { phase: "fallback" } });
    expect(session.getMetrics()).toMatchObject({ cachedAssets: 0, retainedBytes: 0 });
  });

  it("preserves the original refusal for later consumers", async () => {
    let loads = 0;
    const session = createRichPreviewSession({
      loadAsset: async () => {
        loads++;
        return { status: "error", reason: "hash-mismatch" };
      },
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    const first = request({ assetId: ASSET });
    session.sync([first]);
    await tick();
    const second = request({ assetId: ASSET }, { renderableId: "rich:two" });
    session.sync([first, second]);
    expect(loads).toBe(1);
    expect(session.publications()[1]?.resolution.surface.text).toContain("unavailable");
    expect(session.publications()[1]?.resolution.surface.text).not.toContain("cache limit");
  });

  it("keeps a shared asset live across a same-asset generation replacement", async () => {
    const pending = deferredLoad();
    let loads = 0;
    const session = createRichPreviewSession({
      loadAsset: () => {
        loads++;
        return pending.promise;
      },
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    const first = request({ assetId: ASSET });
    const peer = request({ assetId: ASSET }, { renderableId: "rich:peer" });
    session.sync([first, peer]);
    session.sync([request({ assetId: ASSET }, { paneGeneration: "pane:incarnation-2" }), peer]);
    expect(loads).toBe(1);
    expect(session.getMetrics()).toMatchObject({ inFlightAssets: 1, loadsAborted: 0 });
  });

  it("transfers a sole same-asset authority without aborting or reloading", async () => {
    const pending = deferredLoad();
    let loads = 0;
    const session = createRichPreviewSession({
      loadAsset: () => {
        loads++;
        return pending.promise;
      },
      onChange: () => undefined,
      afterNativeFrame: (callback) => callback(),
    });
    session.sync([request({ assetId: ASSET })]);
    session.sync([request({ assetId: ASSET }, { paneGeneration: "pane:incarnation-2" })]);
    expect(loads).toBe(1);
    expect(session.getMetrics()).toMatchObject({ inFlightAssets: 1, loadsAborted: 0 });
    const bytes = new TextEncoder().encode("# Current");
    pending.resolve({
      status: "ok",
      asset: {
        assetId: ASSET,
        media: "text/markdown",
        name: "current.md",
        byteLength: bytes.length,
        bytes,
      },
    });
    await tick();
    expect(session.publications()[0]).toMatchObject({
      authority: { paneGeneration: "pane:incarnation-2" },
      resolution: { phase: "ready", surface: { text: "# Current" } },
    });
  });
});
