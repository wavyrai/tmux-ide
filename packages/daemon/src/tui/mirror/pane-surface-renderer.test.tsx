/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSignal } from "solid-js";
import { TerminalDeliveryEnvelopeSchemaZ, TerminalDeliveryFaultSchemaZ } from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
} from "@tmux-ide/core";
import type { BlitOptions } from "./pane-mirror.ts";
import {
  PaneSurfaceRenderable,
  registerPaneSurface,
  type PaneSurfaceOptions,
  type TerminalPaneRenderSource,
} from "./pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "./theme.ts";
import { renderForTest } from "./testing/renderer-harness.test.ts";
import {
  SemanticPaneReplica,
  SemanticTerminalRenderSource,
} from "./semantic-pane-render-source.ts";

function laneUuid(lane: number, offset = 0): string {
  return `00000000-0000-4000-8000-${String(lane * 10 + offset).padStart(12, "0")}`;
}

function semanticLane(
  grapheme: string,
  lane: number,
): { source: SemanticTerminalRenderSource; replica: SemanticPaneReplica; nonce: string } {
  const generation = laneUuid(lane, 1);
  const nonce = laneUuid(lane, 2);
  const negotiation = negotiateTerminalDelivery(
    { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
    generation,
    nonce,
  );
  if (!negotiation.accepted) throw new Error("negotiation failed");
  const replica = new SemanticPaneReplica({
    negotiated: negotiation.negotiated,
    workspaceName: "workspace.alpha",
    semanticPaneId: "pane.editor",
    ack: () => {},
    nack: () => {},
  });
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(4, 2));
  snapshot.grid[0]!.cells[0]!.grapheme = grapheme;
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  const transactionId = `00000000-0000-4000-8000-${grapheme.charCodeAt(0).toString().padStart(12, "0")}`;
  const envelope = TerminalDeliveryEnvelopeSchemaZ.parse({
    type: "terminal.delivery",
    workspaceName: "workspace.alpha",
    semanticPaneId: "pane.editor",
    generation,
    incarnation: `${generation}:1`,
    deliveryNonce: nonce,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: 1,
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: false,
  });
  replica.accept(envelope);
  for (const chunk of splitTerminalDeliveryChunks(transactionId, bytes)) replica.accept(chunk);
  const source = new SemanticTerminalRenderSource();
  source.set(replica);
  return { source, replica, nonce };
}

describe("PaneSurface OpenTUI renderer", () => {
  it("renders semantic cells and survives an atomic fault/reconnect source replacement", async () => {
    registerPaneSurface();
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    const firstLane = semanticLane("A", 1);
    let setSource!: (source: SemanticTerminalRenderSource) => void;
    let bumpContent!: () => void;
    const surfaces = new Set<PaneSurfaceRenderable>();
    const setup = await renderForTest(
      () => {
        const [source, setSourceSignal] = createSignal(firstLane.source);
        const [contentVersion, setContentVersion] = createSignal(1);
        setSource = setSourceSignal;
        bumpContent = () => setContentVersion((version) => version + 1);
        return (
          <pane_surface
            ref={(surface: PaneSurfaceRenderable) => surfaces.add(surface)}
            width={4}
            height={2}
            mirror={source()}
            paneId="pane.editor"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            contentVersion={contentVersion()}
          />
        );
      },
      { width: 4, height: 2 },
    );

    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("A");
    expect(surfaces.size).toBe(1);

    firstLane.replica.accept(
      TerminalDeliveryFaultSchemaZ.parse({
        type: "terminal.delivery.fault",
        reason: "source-closed",
        message: "test lane disconnected",
        deliveryNonce: firstLane.nonce,
      }),
    );
    bumpContent();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).not.toContain("A");

    const replacementLane = semanticLane("B", 2);
    setSource(replacementLane.source);
    bumpContent();
    await setup.renderOnce();
    const reconnectedFrame = setup.captureCharFrame();
    expect(reconnectedFrame).toContain("B");
    expect(reconnectedFrame).not.toContain("A");
    expect(surfaces.size).toBe(1);
  });

  it("repaints only the cursor-marker row when focus changes", async () => {
    registerPaneSurface();
    const blits: Array<Pick<BlitOptions, "full" | "forceRows">> = [];
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => ({
        x: 2,
        y: 2,
        hidden: false,
        style: "block" as const,
        blink: false,
      }),
      blitPane: (
        _id: string,
        _buffers: unknown,
        _width: number,
        _height: number,
        _scrollOffset: number,
        _defaultFg: number,
        _defaultBg: number,
        options: BlitOptions,
      ) => {
        blits.push({ full: options.full, forceRows: options.forceRows });
      },
    } as unknown as TerminalPaneRenderSource;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    let setFocused!: (focused: boolean) => void;
    const setup = await renderForTest(
      () => {
        const [focused, setFocusedSignal] = createSignal(true);
        setFocused = setFocusedSignal;
        return (
          <pane_surface
            width={10}
            height={5}
            mirror={mirror}
            paneId="%1"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            scrollOffset={0}
            paneFocused={focused()}
            contentVersion={1}
            selRange={null}
            search={null}
          />
        );
      },
      { width: 10, height: 5 },
    );

    await setup.renderOnce();
    expect(blits.at(-1)?.full).toBe(true);

    blits.length = 0;
    setFocused(false);
    await setup.renderOnce();
    expect(blits).toEqual([{ full: false, forceRows: [2] }]);

    blits.length = 0;
    setFocused(true);
    await setup.renderOnce();
    expect(blits).toEqual([{ full: false, forceRows: [2] }]);
  });

  it("forces a full blit when a retained source epoch changes at the same content version", async () => {
    registerPaneSurface();
    const fullBlits: boolean[] = [];
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
        options: BlitOptions,
      ) => fullBlits.push(options.full),
    } as unknown as TerminalPaneRenderSource;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    let replaceSource!: () => void;
    const setup = await renderForTest(
      () => {
        const [sourceEpoch, setSourceEpoch] = createSignal(1);
        replaceSource = () => setSourceEpoch((epoch) => epoch + 1);
        return (
          <pane_surface
            width={4}
            height={2}
            mirror={mirror}
            paneId="pane.editor"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            contentVersion={1}
            sourceEpoch={sourceEpoch()}
          />
        );
      },
      { width: 4, height: 2 },
    );

    await setup.renderOnce();
    fullBlits.length = 0;
    replaceSource();
    await setup.renderOnce();
    expect(fullBlits).toEqual([true]);
  });
});
