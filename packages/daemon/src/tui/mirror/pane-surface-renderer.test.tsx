/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { useTerminalDimensions } from "@opentui/solid";
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
import { installTuiPerformanceEventSink } from "./performance-events.ts";
import {
  PaneSurfaceRenderable,
  createPaneSurfaceHostFocusTransitionOwner,
  projectPaneFramebufferCells,
  qualifiesPaneSurfaceHostFocusFrame,
  registerPaneSurface,
  type PaneSurfaceOptions,
  type TerminalPaneRenderSource,
} from "./pane-surface.tsx";
import { createSemanticThemeSnapshot, createTerminalPaletteProjection } from "./theme.ts";
import { expectFrameBounds, renderForTest } from "./testing/renderer-harness.test.ts";
import {
  SemanticPaneReplica,
  SemanticTerminalRenderSource,
} from "./semantic-pane-render-source.ts";

function laneUuid(lane: number, offset = 0): string {
  return `00000000-0000-4000-8000-${String(lane * 10 + offset).padStart(12, "0")}`;
}

it("projects actual framebuffer styles, wide continuation, and combining cells", () => {
  const buffers = {
    char: new Uint32Array([0x754c, 0, 0x65]),
    fg: new Uint16Array(12),
    bg: new Uint16Array(12),
    attributes: new Uint32Array([13, 13, 0]),
  };
  for (let index = 0; index < 3; index += 1) {
    const offset = index * 4;
    buffers.fg.set([255, 0, 0, 255], offset);
    buffers.bg.set([1, 2, 3, 255], offset);
  }
  expect(
    projectPaneFramebufferCells(
      buffers,
      3,
      1,
      [{ x: 2, y: 0, chars: "é", fg: 0xff0000, bg: 0x010203, attrs: 0 }],
      0xffffff,
      0x000000,
    ),
  ).toEqual([
    {
      row: 0,
      column: 0,
      chars: "界",
      width: 2,
      foreground: "rgb:ff0000",
      background: "rgb:010203",
      attributes: 13,
    },
    {
      row: 0,
      column: 1,
      chars: "",
      width: 0,
      foreground: "rgb:ff0000",
      background: "rgb:010203",
      attributes: 13,
    },
    {
      row: 0,
      column: 2,
      chars: "é",
      width: 1,
      foreground: "rgb:ff0000",
      background: "rgb:010203",
      attributes: 0,
    },
  ]);
});

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
  it("consumes one exact root-owned focus transition and fences stale replacements", () => {
    let followupRenders = 0;
    const owner = createPaneSurfaceHostFocusTransitionOwner(() => {
      followupRenders += 1;
    });
    const transition = {
      diagnosticEpoch: 1,
      semanticPaneId: "pane-1",
      focused: false,
      rendererEpoch: 3,
      sourceEpoch: 4,
      generation: "generation-1",
      daemonGeneration: "generation-1",
      clientGeneration: 1,
      incarnation: "incarnation-1",
      revision: 1,
      stateHash: "0a63b052b8f1d994",
      cols: 10,
      rows: 6,
    };
    const first = owner.arm(transition);
    const second = owner.arm({ ...transition, diagnosticEpoch: 2, focused: true });
    expect(first).not.toBe(second);
    expect(owner.pending(first!)).toBe(false);
    expect(owner.pending(second!)).toBe(true);
    expect(owner.claim({ ...transition, focused: false })).toBeNull();
    expect(owner.claim({ ...transition, focused: true })?.token).toBe(second);
    expect(owner.pending(second!)).toBe(true);
    const focusEvent = {
      processId: "opentui:123",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      atMicros: 100,
      semanticPaneId: transition.semanticPaneId,
      generation: transition.generation,
      incarnation: transition.incarnation,
      revision: transition.revision,
      stateHash: transition.stateHash,
      cols: transition.cols,
      rows: transition.rows,
      sourceEpoch: transition.sourceEpoch,
      rendererEpoch: transition.rendererEpoch,
      viewportCols: 10,
      viewportRows: 5,
      focused: true,
      diagnosticEpoch: 2,
      full: false,
      writtenRows: [2],
    } as const;
    expect(owner.complete(second!, focusEvent)).toBe(true);
    expect(followupRenders).toBe(1);
    const completed = owner.completed(second!);
    expect(completed).not.toBeNull();
    const currentFrame = {
      semanticPaneId: transition.semanticPaneId,
      focused: true,
      rendererEpoch: transition.rendererEpoch,
      daemonGeneration: transition.daemonGeneration,
      clientGeneration: transition.clientGeneration,
      identity: {
        generation: transition.generation,
        incarnation: transition.incarnation,
        revision: transition.revision,
        stateHash: transition.stateHash,
        cols: transition.cols,
        rows: transition.rows,
        sourceEpoch: transition.sourceEpoch,
      },
    } as const;
    expect(qualifiesPaneSurfaceHostFocusFrame(completed!, currentFrame)).toBe(true);
    expect(
      qualifiesPaneSurfaceHostFocusFrame(completed!, {
        ...currentFrame,
        clientGeneration: 2,
      }),
    ).toBe(false);
    owner.retire(second!);
    expect(owner.completed(second!)).toBeNull();
    expect(owner.claim({ ...transition, focused: true })).toBeNull();
    const claimed = owner.arm(transition);
    expect(owner.claim(transition)?.token).toBe(claimed);
    const superseding = owner.arm({ ...transition, diagnosticEpoch: 3, focused: true });
    expect(owner.complete(claimed!, focusEvent)).toBe(false);
    owner.cancel(superseding ?? undefined);
    const replacement = owner.arm(transition);
    expect(owner.claim({ ...transition, rendererEpoch: 4 })).toBeNull();
    owner.cancel(replacement ?? undefined);
    expect(owner.claim(transition)).toBeNull();
    const paneCancelled = owner.arm(transition);
    owner.cancelPane("other-pane");
    expect(owner.pending(paneCancelled!)).toBe(true);
    owner.cancelPane("pane-1");
    expect(owner.pending(paneCancelled!)).toBe(false);
    expect(owner.arm({ ...transition, stateHash: `sha256:${"a".repeat(64)}` })).toBeNull();
    owner.arm(transition);
    owner.dispose();
    expect(owner.claim(transition)).toBeNull();
    expect(owner.arm(transition)).toBeNull();
  });

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
    let diagnosticIdentityReads = 0;
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => ({
        x: 2,
        y: 2,
        hidden: false,
        style: "block" as const,
        blink: false,
      }),
      paneCanonicalIdentity: () => {
        diagnosticIdentityReads += 1;
        throw new Error("disabled diagnostic identity read");
      },
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
    expect(diagnosticIdentityReads).toBe(0);
  });

  it("applies a cursor-only presentation without a terminal grid walk", async () => {
    registerPaneSurface();
    let cursor = { x: 1, y: 1, hidden: false, style: "block" as const, blink: false };
    let blits = 0;
    let acknowledgements = 0;
    const presentations: Array<{
      gridWalked: boolean;
      gridRowsRead: number;
      fullWalk: boolean;
      cursorX: number;
      style: string;
    }> = [];
    const traceSpans: string[] = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCursorPresentation: (event) =>
        presentations.push({
          gridWalked: event.gridWalked,
          gridRowsRead: event.gridRowsRead,
          fullWalk: event.fullWalk,
          cursorX: event.cursorX,
          style: event.style,
        }),
      terminalTraceSpan: (event) => traceSpans.push(event.traceId),
    });
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => cursor,
      cursorPresentationTrace: () => ({
        traceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        generation: "generation-1",
        incarnation: "incarnation-1",
        semanticPaneId: "pane-1",
        revision: 1,
        stateHash: "0a63b052b8f1d994",
      }),
      paneCanonicalIdentity: () => ({
        generation: "generation-1",
        incarnation: "incarnation-1",
        revision: 1,
        stateHash: "0a63b052b8f1d994",
        cols: 10,
        rows: 5,
        sourceEpoch: 2,
      }),
      acknowledgePresentation: () => {
        acknowledgements += 1;
      },
      blitPane: () => {
        blits += 1;
        return null;
      },
    } satisfies TerminalPaneRenderSource;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    let bumpPresentation!: () => void;
    const setup = await renderForTest(
      () => {
        const [presentationVersion, setPresentationVersion] = createSignal(0);
        bumpPresentation = () => setPresentationVersion((value) => value + 1);
        return (
          <pane_surface
            width={10}
            height={5}
            mirror={mirror}
            paneId="pane-1"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            scrollOffset={0}
            paneFocused={true}
            contentVersion={1}
            presentationVersion={presentationVersion()}
            sourceEpoch={2}
            rendererEpoch={3}
            selRange={null}
            search={null}
          />
        );
      },
      { width: 10, height: 5 },
    );
    try {
      await setup.renderOnce();
      blits = 0;
      acknowledgements = 0;
      presentations.length = 0;
      cursor = { x: 4, y: 1, hidden: false, style: "bar", blink: true };
      bumpPresentation();
      await setup.renderOnce();
      expect(blits).toBe(0);
      expect(acknowledgements).toBe(1);
      expect(presentations).toEqual([
        { gridWalked: false, gridRowsRead: 0, fullWalk: false, cursorX: 4, style: "line" },
      ]);
      expect(traceSpans).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
    } finally {
      uninstall();
    }
  });

  it("distinguishes retained all-row and partial-row walks from a full viewport walk", async () => {
    registerPaneSurface();
    const presentations: Array<{
      gridRowsRead: number;
      fullWalk: boolean;
      gridRowsReadTotal: number;
      fullWalkTotal: number;
      presentationCount: number;
    }> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalCursorPresentation: (event) =>
        presentations.push({
          gridRowsRead: event.gridRowsRead,
          fullWalk: event.fullWalk,
          gridRowsReadTotal: event.gridRowsReadTotal,
          fullWalkTotal: event.fullWalkTotal,
          presentationCount: event.presentationCount,
        }),
    });
    let dirtyRows = [0, 1, 2, 3, 4];
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => ({ x: 1, y: 1, hidden: false, style: "block" as const, blink: false }),
      paneCanonicalIdentity: () => ({
        generation: "generation-1",
        incarnation: "incarnation-1",
        revision: 2,
        stateHash: "0a63b052b8f1d994",
        cols: 10,
        rows: 6,
        sourceEpoch: 2,
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
      ) => options.dirtyRows.push(...dirtyRows),
    } as unknown as TerminalPaneRenderSource;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    let bump!: () => void;
    const setup = await renderForTest(
      () => {
        const [contentVersion, setContentVersion] = createSignal(1);
        bump = () => setContentVersion((value) => value + 1);
        return (
          <pane_surface
            width={10}
            height={5}
            mirror={mirror}
            paneId="pane-1"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            contentVersion={contentVersion()}
            paneFocused={true}
          />
        );
      },
      { width: 10, height: 5 },
    );
    try {
      await setup.renderOnce();
      bump();
      await setup.renderOnce();
      dirtyRows = [0, 2, 4];
      bump();
      await setup.renderOnce();
      expect(presentations).toEqual([
        {
          gridRowsRead: 5,
          fullWalk: true,
          gridRowsReadTotal: 5,
          fullWalkTotal: 1,
          presentationCount: 1,
        },
        {
          gridRowsRead: 5,
          fullWalk: false,
          gridRowsReadTotal: 10,
          fullWalkTotal: 1,
          presentationCount: 2,
        },
        {
          gridRowsRead: 3,
          fullWalk: false,
          gridRowsReadTotal: 13,
          fullWalkTotal: 1,
          presentationCount: 3,
        },
      ]);
    } finally {
      uninstall();
    }
  });

  it("publishes exact focus rows only when explicitly armed and remains fail-open", async () => {
    registerPaneSurface();
    const paints: Array<{
      diagnosticEpoch: number;
      focused: boolean;
      writtenRows: readonly number[];
    }> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: () => undefined,
      terminalPaint: () => undefined,
      terminalDelivery: () => undefined,
      terminalFocusPaint: (event) => paints.push(event),
      terminalFocusFence: () => {
        throw new Error("diagnostic failure");
      },
    });
    let canonicalIdentity = {
      generation: "generation-1",
      incarnation: "incarnation-1",
      revision: 1,
      stateHash: "0a63b052b8f1d994",
      cols: 10,
      rows: 6,
      sourceEpoch: 4,
    };
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => ({ x: 2, y: 2, hidden: false, style: "block" as const, blink: false }),
      paneCanonicalIdentity: () => canonicalIdentity,
      blitPane: (
        _id: string,
        _buffers: unknown,
        _width: number,
        _height: number,
        _scrollOffset: number,
        _defaultFg: number,
        _defaultBg: number,
        options: BlitOptions,
      ) => options.dirtyRows.push(...(options.forceRows ?? [])),
    } as unknown as TerminalPaneRenderSource;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    const focusTransitions = createPaneSurfaceHostFocusTransitionOwner();
    const armFocus = (diagnosticEpoch: number, semanticPaneId: string, focused: boolean) =>
      focusTransitions.arm({
        diagnosticEpoch,
        semanticPaneId,
        focused,
        rendererEpoch: 3,
        sourceEpoch: 4,
        generation: "generation-1",
        daemonGeneration: "generation-1",
        clientGeneration: 1,
        incarnation: "incarnation-1",
        revision: 1,
        stateHash: "0a63b052b8f1d994",
        cols: 10,
        rows: 6,
      });
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
            paneId="pane-1"
            defaultFg={palette.foreground}
            defaultBg={palette.background}
            terminalPalette={palette}
            searchHl={palette.searchHighlight}
            searchCur={palette.searchCurrent}
            paneFocused={focused()}
            sourceEpoch={4}
            rendererEpoch={3}
            hostFocusTransitionOwner={focusTransitions}
          />
        );
      },
      { width: 10, height: 5 },
    );
    await setup.renderOnce();
    expect(paints).toEqual([]);
    const wrongPaneToken = armFocus(99, "other-pane", false);
    setFocused(false);
    await setup.renderOnce();
    focusTransitions.cancel(wrongPaneToken ?? undefined);
    setFocused(true);
    await setup.renderOnce();
    expect(paints).toEqual([]);
    const replacedIdentityToken = armFocus(1, "pane-1", false);
    setFocused(false);
    canonicalIdentity = { ...canonicalIdentity, revision: 2, stateHash: "1a63b052b8f1d994" };
    await setup.renderOnce();
    focusTransitions.cancel(replacedIdentityToken ?? undefined);
    setFocused(true);
    await setup.renderOnce();
    canonicalIdentity = { ...canonicalIdentity, revision: 1, stateHash: "0a63b052b8f1d994" };
    const supersededToken = armFocus(1, "pane-1", false);
    setFocused(false);
    const replacementToken = armFocus(2, "pane-1", true);
    await setup.renderOnce();
    focusTransitions.cancel(supersededToken ?? undefined);
    focusTransitions.cancel(replacementToken ?? undefined);
    setFocused(true);
    await setup.renderOnce();
    expect(paints).toEqual([]);
    const blurToken = armFocus(1, "pane-1", false);
    setFocused(false);
    await expect(setup.renderOnce()).resolves.toBeUndefined();
    focusTransitions.cancel(blurToken ?? undefined);
    const focusToken = armFocus(2, "pane-1", true);
    setFocused(true);
    await expect(setup.renderOnce()).resolves.toBeUndefined();
    focusTransitions.cancel(focusToken ?? undefined);
    expect(
      paints.map(({ diagnosticEpoch, focused, writtenRows, sourceEpoch, rendererEpoch }) => ({
        diagnosticEpoch,
        focused,
        writtenRows,
        sourceEpoch,
        rendererEpoch,
      })),
    ).toEqual([
      {
        diagnosticEpoch: 1,
        focused: false,
        writtenRows: [2],
        sourceEpoch: 4,
        rendererEpoch: 3,
      },
      {
        diagnosticEpoch: 2,
        focused: true,
        writtenRows: [2],
        sourceEpoch: 4,
        rendererEpoch: 3,
      },
    ]);
    uninstall();
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

  it("settles one logical root resize with one full walk per resident pane", async () => {
    registerPaneSurface();
    const blits = new Map<string, number>();
    const mirror = {
      scrollbackDepth: () => 0,
      cursorState: () => null,
      blitPane: (paneId: string) => {
        blits.set(paneId, (blits.get(paneId) ?? 0) + 1);
        return null;
      },
    } as unknown as TerminalPaneRenderSource;
    const palette = createTerminalPaletteProjection(createSemanticThemeSnapshot({ mode: "dark" }));
    const setup = await renderForTest(
      () => {
        const dimensions = useTerminalDimensions();
        const paneWidth = () => Math.max(1, Math.floor(dimensions().width / 2));
        return (
          <box width={dimensions().width} height={dimensions().height} flexDirection="row">
            <pane_surface
              id="resize-pane-a"
              width={paneWidth()}
              height={dimensions().height}
              mirror={mirror}
              paneId="pane.a"
              defaultFg={palette.foreground}
              defaultBg={palette.background}
              terminalPalette={palette}
              searchHl={palette.searchHighlight}
              searchCur={palette.searchCurrent}
              contentVersion={1}
            />
            <pane_surface
              id="resize-pane-b"
              width={paneWidth()}
              height={dimensions().height}
              mirror={mirror}
              paneId="pane.b"
              defaultFg={palette.foreground}
              defaultBg={palette.background}
              terminalPalette={palette}
              searchHl={palette.searchHighlight}
              searchCur={palette.searchCurrent}
              contentVersion={1}
            />
          </box>
        );
      },
      { width: 20, height: 6 },
    );
    await setup.renderOnce();
    blits.clear();
    const framesBefore = Number(setup.getNativeStats().nativeFrameCount);

    setup.resize(30, 8);
    await setup.renderOnce();

    expect(blits).toEqual(
      new Map([
        ["pane.a", 1],
        ["pane.b", 1],
      ]),
    );
    expect(Number(setup.getNativeStats().nativeFrameCount) - framesBefore).toBeLessThanOrEqual(2);
    expect(setup.renderer.root.findDescendantById("resize-pane-a")?.width).toBe(15);
    expect(setup.renderer.root.findDescendantById("resize-pane-b")?.width).toBe(15);
    expectFrameBounds(setup.captureCharFrame(), 30, 8);
  });
});
