import { describe, expect, it, vi } from "vitest";
import type {
  InteractionReceipt,
  TerminalDeliveryEnvelope,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  blankTerminalReplicaSnapshot,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
} from "@tmux-ide/core";
import type {
  OpenPaneStreamClientOptions,
  PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";
import type { WorkspaceClientRuntimeInventory } from "@tmux-ide/daemon-client/workspace-client-types";

import type { OpenTuiVerifiedRoutingContext } from "./open-tui-verified-routing.ts";
import {
  OPEN_TUI_HOST_CLIENT_ID,
  connectOpenTuiWorkspaceRuntimePort,
  type OpenTuiWorkspaceRuntimePort,
} from "./open-tui-workspace-runtime-port.ts";
import { installTuiPerformanceEventSink } from "./performance-events.ts";

const GENERATION = "00000000-0000-4000-8000-000000000001";
const NONCE = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "workspace.alpha";
const SESSION = "alpha";
const PANE_A = "pane.a";
const PANE_B = "pane.b";
const PANE_C = "pane.c";

function inventory(
  semanticPaneIds: readonly string[] = [PANE_A, PANE_B],
): WorkspaceClientRuntimeInventory {
  return Object.freeze({
    workspaceName: WORKSPACE,
    workspaceId: "workspace-id",
    sessionId: SESSION,
    daemonGeneration: GENERATION,
    shellGeneration: 3,
    semanticPaneIds: Object.freeze([...semanticPaneIds]),
  });
}

function negotiated() {
  const result = negotiateTerminalDelivery(
    { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: true },
    GENERATION,
    NONCE,
  );
  if (!result.accepted) throw new Error("negotiation failed");
  return result.negotiated;
}

function seedDelivery(
  pane: string,
  snapshot: TerminalReplicaSnapshot,
  suffix: string,
  performanceTraceId?: string,
) {
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName: WORKSPACE,
    semanticPaneId: pane,
    generation: GENERATION,
    incarnation: `${GENERATION}:1`,
    deliveryNonce: NONCE,
    transactionId,
    ...(performanceTraceId ? { performanceTraceId } : {}),
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "seed",
    baseRevision: null,
    canonicalRevision: 0,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  };
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes) };
}

function patchDelivery(
  pane: string,
  previous: TerminalReplicaSnapshot,
  baseRevision: number,
  revision: number,
  suffix: string,
) {
  const patch = { rows: [], cursor: { ...previous.cursor, x: 1 } };
  const next = applyTerminalReplicaPatch(previous, patch);
  const bytes = encodeSemanticTerminalUpdate({
    frame: "patch",
    baseRevision,
    revision,
    patch,
  });
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName: WORKSPACE,
    semanticPaneId: pane,
    generation: GENERATION,
    incarnation: `${GENERATION}:1`,
    deliveryNonce: NONCE,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-v1",
    frame: "patch",
    baseRevision,
    canonicalRevision: revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(next),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.byteLength,
    chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
    canonicalEquivalent: true,
    history: "complete",
    richPlacements: true,
  };
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes) };
}

function rig(coherent = true, corruptBeforeCoherent = false) {
  let streamOptions: OpenPaneStreamClientOptions | null = null;
  const receiptListeners = new Set<(receipt: InteractionReceipt) => void>();
  const client = {
    daemonInstanceId: GENERATION,
    requestId: "00000000-0000-4000-8000-000000000010",
    effectiveViewerMode: "interactive",
    authoritySnapshot: null,
    setPresence: vi.fn(),
    noteActivity: vi.fn(),
    requestAuthority: vi.fn(async () => null),
    releaseAuthority: vi.fn(async () => undefined),
    sendTerminalInput: vi.fn(async () => "ok" as const),
    sendText: vi.fn(),
    sendKey: vi.fn(),
    fitViewport: vi.fn(async () => undefined),
    ack: vi.fn(),
    nack: vi.fn(),
    setVisibility: vi.fn(),
    submitIntent: vi.fn(async () => null),
    close: vi.fn(),
    onReceipt: (listener: (receipt: InteractionReceipt) => void) => {
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
  } satisfies PaneStreamRuntimeClient & {
    onReceipt(listener: (receipt: InteractionReceipt) => void): () => void;
  };
  const openPaneStream = vi.fn(async (_expected, options) => {
    streamOptions = options as OpenPaneStreamClientOptions;
    for (const pane of options.stream.panes) {
      options.onNegotiated(pane, { accepted: true, negotiated: negotiated() });
    }
    if (corruptBeforeCoherent) {
      options.onTerminalDelivery(PANE_A, {
        type: "terminal.delivery.chunk",
        transactionId: "00000000-0000-4000-8000-000000000009",
        index: 0,
        bytes: new Uint8Array([0]),
      });
    }
    if (coherent) {
      options.onLayout?.({
        type: "layout",
        semanticWindowId: "window.main",
        windowName: "main",
        currentWindow: true,
        cols: 120,
        rows: 40,
        zoomed: false,
        paneBorderStatus: "off",
        panes: options.stream.panes.map((pane, index) => ({
          pane,
          left: index * 60,
          top: 0,
          width: 60,
          height: 40,
          active: index === 0,
        })),
      });
      for (const [index, pane] of options.stream.panes.entries()) {
        const seed = seedDelivery(pane, blankTerminalReplicaSnapshot(4, 2), String(10 + index));
        options.onTerminalDelivery(pane, seed.envelope);
        for (const chunk of seed.chunks) options.onTerminalDelivery(pane, chunk);
      }
    }
    return client;
  });
  const routing: OpenTuiVerifiedRoutingContext = {
    daemonInstanceId: GENERATION,
    workspaceName: WORKSPACE,
    sessionName: SESSION,
    assertCurrent: vi.fn(),
    openPaneStream,
    retire: vi.fn(),
  };
  return {
    client,
    routing,
    openPaneStream,
    options: () => {
      if (!streamOptions) throw new Error("stream not opened");
      return streamOptions;
    },
  };
}

describe("OpenTUI WorkspaceClient runtime port", () => {
  it("does not publish a live port until current layout and every pane seed are coherent", async () => {
    const test = rig(false);
    let settled = false;
    const opening = connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    }).then((port) => {
      settled = true;
      return port;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    test.options().onLayout?.({
      type: "layout",
      semanticWindowId: "window.main",
      windowName: "main",
      currentWindow: true,
      cols: 120,
      rows: 40,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [],
    });
    const first = seedDelivery(PANE_A, blankTerminalReplicaSnapshot(4, 2), "201");
    test.options().onTerminalDelivery(PANE_A, first.envelope);
    for (const chunk of first.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    await Promise.resolve();
    expect(settled).toBe(false);

    const second = seedDelivery(PANE_B, blankTerminalReplicaSnapshot(4, 2), "202");
    test.options().onTerminalDelivery(PANE_B, second.envelope);
    for (const chunk of second.chunks) test.options().onTerminalDelivery(PANE_B, chunk);
    const port = await opening;
    expect(settled).toBe(true);
    expect(port.getLayout()).toMatchObject({ semanticWindowId: "window.main" });
    await port.close();
  });

  it("primes every pane across the inventory before coherent publication", async () => {
    const test = rig();
    const paneIds = [PANE_A, PANE_B, PANE_C];
    const subscriptions: Awaited<ReturnType<OpenTuiWorkspaceRuntimePort["subscribeTerminal"]>>[] =
      [];
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(paneIds),
      routing: test.routing,
      prepareRuntime: async (candidate) => {
        for (const subscription of await Promise.all(
          paneIds.map((semanticPaneId) =>
            candidate.subscribeTerminal({ workspaceName: WORKSPACE, semanticPaneId }),
          ),
        )) {
          subscription.onUpdate(() => undefined);
          subscriptions.push(subscription);
        }
      },
    });

    expect(subscriptions).toHaveLength(3);
    expect(test.client.ack).toHaveBeenCalledTimes(3);
    expect(test.client.ack.mock.calls.map(([ack]) => ack.semanticPaneId).sort()).toEqual(paneIds);
    await port.close();
  });

  it("flushes startup NACKs emitted before the physical client promise resolves", async () => {
    const test = rig(true, true);
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });

    expect(test.client.nack).toHaveBeenCalledWith(
      expect.objectContaining({
        semanticPaneId: PANE_A,
        reason: "protocol-violation",
        transactionId: "00000000-0000-4000-8000-000000000009",
      }),
    );
    await port.close();
  });

  it("aborts a negotiated but incoherent physical connection", async () => {
    const test = rig(false);
    const controller = new AbortController();
    const opening = connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new Error("retired target"));
    await expect(opening).rejects.toThrow("retired target");
    expect(test.client.close).toHaveBeenCalledOnce();
  });

  it("rejects coherent readiness when the physical stream faults", async () => {
    const test = rig(false);
    const opening = connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    await Promise.resolve();
    await Promise.resolve();
    test.options().onFault?.(new Error("socket retired"));
    await expect(opening).rejects.toThrow("socket retired");
    expect(test.client.close).toHaveBeenCalledOnce();
  });

  it("preserves the daemon fault detail at the OpenTUI causal boundary", async () => {
    const test = rig(false);
    const opening = connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    await Promise.resolve();
    await Promise.resolve();
    test.options().onTerminalDelivery(PANE_B, {
      type: "terminal.delivery.fault",
      reason: "protocol-violation",
      message: "ACK has no in-flight transaction",
      deliveryNonce: NONCE,
    });
    await expect(opening).rejects.toThrow(
      "Terminal delivery failed for pane.b: protocol-violation (ACK has no in-flight transaction)",
    );
    expect(test.client.close).toHaveBeenCalledOnce();
  });

  it("opens one exact inventory stream and projects layout from that same connection", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });

    expect(test.openPaneStream).toHaveBeenCalledOnce();
    expect(test.options().stream).toMatchObject({
      workspaceName: WORKSPACE,
      panes: [PANE_A, PANE_B],
      viewerMode: "interactive",
      terminalDelivery: { encodings: ["semantic-v1"] },
    });
    expect(test.options().hostClientId).toBe(OPEN_TUI_HOST_CLIENT_ID);
    expect(test.options()).not.toHaveProperty("onTerminalFrameArrival");
    expect(test.options()).not.toHaveProperty("onInputTransportStage");

    const layouts: unknown[] = [];
    port.onLayout((layout) => layouts.push(layout));
    test.options().onLayout?.({
      type: "layout",
      semanticWindowId: "window.main",
      windowName: "main",
      currentWindow: true,
      cols: 120,
      rows: 40,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [{ pane: PANE_A, left: 0, top: 0, width: 60, height: 40, active: true }],
    });
    expect(layouts).toHaveLength(2);
    expect(port.getLayout()).toMatchObject({ cols: 120, panes: [{ pane: PANE_A }] });
    expect(Object.isFrozen(port.getLayout())).toBe(true);
    test.options().onLayout?.({
      type: "layout",
      semanticWindowId: "window.logs",
      windowName: "logs",
      currentWindow: false,
      cols: 80,
      rows: 24,
      zoomed: false,
      paneBorderStatus: "top",
      panes: [{ pane: PANE_B, left: 0, top: 0, width: 80, height: 24, active: true }],
    });
    expect(port.getLayoutSnapshot()).toMatchObject({
      current: { semanticWindowId: "window.main" },
      windows: [{ semanticWindowId: "window.main" }, { semanticWindowId: "window.logs" }],
    });
  });

  it("delivers only the addressed pane, preserves trace metadata, then ACKs", async () => {
    const traceId = "00000000-0000-4000-8000-000000000099";
    const test = rig();
    const ordering: string[] = [];
    test.client.ack.mockImplementation(() => ordering.push("ack"));
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const addressed = vi.fn(() => ordering.push("listener"));
    subscription.onUpdate(addressed);
    const sibling = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_B,
    });
    const siblingListener = vi.fn();
    sibling.onUpdate(siblingListener);
    addressed.mockClear();
    siblingListener.mockClear();
    test.client.ack.mockClear();
    ordering.length = 0;

    const delivery = seedDelivery(PANE_A, blankTerminalReplicaSnapshot(4, 2), "101", traceId);
    test.options().onTerminalDelivery(PANE_A, delivery.envelope);
    for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);

    expect(addressed).toHaveBeenCalledOnce();
    expect(addressed.mock.calls[0]).toEqual([
      expect.objectContaining({
        type: "terminal.seed",
        workspaceName: WORKSPACE,
        semanticPaneId: PANE_A,
        generation: GENERATION,
      }),
      {
        performanceTraceId: traceId,
        representationHash: delivery.envelope.representationHash,
      },
    ]);
    expect(siblingListener).not.toHaveBeenCalled();
    expect(ordering).toEqual(["listener", "ack"]);
    expect(test.client.ack).toHaveBeenCalledWith(
      expect.objectContaining({
        semanticPaneId: PANE_A,
        transactionId: delivery.envelope.transactionId,
      }),
    );
    expect(test.client.nack).not.toHaveBeenCalled();
  });

  it("reports the bounded wire-delivery queue only while a performance sink is installed", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    subscription.onUpdate(() => undefined);
    const terminalDelivery = vi.fn();
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery,
    });
    try {
      const delivery = seedDelivery(PANE_A, blankTerminalReplicaSnapshot(4, 2), "109");
      test.options().onTerminalDelivery(PANE_A, delivery.envelope);
      for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);

      expect(terminalDelivery).toHaveBeenCalledOnce();
      expect(terminalDelivery).toHaveBeenCalledWith({
        parseMs: expect.any(Number),
        queuePeak: 1,
        queueCapacity: 1,
        settledQueueDepth: 0,
        revisionLagPeak: 0,
        reseed: true,
      });
    } finally {
      uninstall();
      await subscription.close();
      await port.close();
    }
  });

  it("withholds ACK until a synchronous listener exists", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    test.client.ack.mockClear();
    expect(test.client.ack).not.toHaveBeenCalled();

    const listener = vi.fn();
    subscription.onUpdate(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(test.client.ack).toHaveBeenCalledOnce();
  });

  it("NACKs baseline gaps and invalid semantic representations", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    subscription.onUpdate(() => undefined);
    const snapshot = blankTerminalReplicaSnapshot(4, 2);
    test.client.nack.mockClear();

    const gap = patchDelivery(PANE_A, snapshot, 5, 6, "104");
    test.options().onTerminalDelivery(PANE_A, gap.envelope);
    expect(test.client.nack).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "gap", appliedRevision: 0 }),
    );
    const nacksAfterGap = test.client.nack.mock.calls.length;
    for (const chunk of gap.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(test.client.nack).toHaveBeenCalledTimes(nacksAfterGap);

    const bytes = new TextEncoder().encode("not-json");
    const transactionId = "00000000-0000-4000-8000-000000000105";
    const seed = seedDelivery(PANE_A, snapshot, "105");
    const invalid: TerminalDeliveryEnvelope = {
      ...seed.envelope,
      transactionId,
      incarnation: `${GENERATION}:2`,
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
      chunkCount: 1,
    };
    test.options().onTerminalDelivery(PANE_A, invalid);
    for (const chunk of splitTerminalDeliveryChunks(transactionId, bytes))
      test.options().onTerminalDelivery(PANE_A, chunk);
    expect(test.client.nack).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: "decode-failed", transactionId }),
    );
  });

  it("reconnects for canonical patch rejection without ACKing the rejected delivery", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    subscription.onUpdate((update) => {
      if (update.type === "terminal.patch") {
        port.requestTerminalRepair?.(
          { workspaceName: WORKSPACE, semanticPaneId: PANE_A },
          "conflict",
        );
      }
    });
    test.client.ack.mockClear();
    test.client.close.mockClear();

    const previous = blankTerminalReplicaSnapshot(4, 2);
    const corrupt = patchDelivery(PANE_A, previous, 0, 1, "190");
    const corruptEnvelope = { ...corrupt.envelope, canonicalStateHash: "ffffffffffffffff" };
    test.options().onTerminalDelivery(PANE_A, corruptEnvelope);
    for (const chunk of corrupt.chunks) test.options().onTerminalDelivery(PANE_A, chunk);

    expect(test.client.ack).not.toHaveBeenCalled();
    expect(test.client.close).toHaveBeenCalledOnce();
    port.requestTerminalRepair?.({ workspaceName: WORKSPACE, semanticPaneId: PANE_A }, "conflict");
    expect(test.client.close).toHaveBeenCalledOnce();
    await port.closed;
  });

  it("closes subscriptions, receipt forwarding and physical transport exactly once", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const settled = vi.fn();
    void port.closed.then(settled);

    await port.close();
    await port.close();
    await port.closed;

    expect(subscription).toMatchObject({ closed: true });
    expect(test.client.close).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();
  });

  it("keeps semantic session identity distinct from the verified raw tmux route", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: { ...inventory(), sessionId: "session:semantic-alpha" },
      routing: test.routing,
    });

    expect(test.routing.assertCurrent).toHaveBeenCalledWith({
      daemonInstanceId: GENERATION,
      workspaceName: WORKSPACE,
      sessionName: SESSION,
    });
    expect(test.openPaneStream).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: SESSION }),
      expect.any(Object),
    );
    await port.close();
  });

  it("installs transport diagnostic callbacks only when the sink exists at connect", async () => {
    const terminalTraceStage = vi.fn();
    const terminalClockCalibration = vi.fn();
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      terminalTraceStage,
      terminalClockCalibration,
    });
    const test = rig();
    try {
      const port = await connectOpenTuiWorkspaceRuntimePort({
        inventory: inventory(),
        routing: test.routing,
      });
      const memoryUsage = vi.spyOn(process, "memoryUsage");
      expect(test.options().onInputTransportStage).toEqual(expect.any(Function));
      expect(test.options().onTerminalFrameArrival).toEqual(expect.any(Function));
      expect(test.options().onClockCalibration).toEqual(expect.any(Function));
      expect(test.options().onClockCalibrationOutcome).toEqual(expect.any(Function));
      test.options().onClockCalibration?.({
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000077",
        daemonInstanceId: GENERATION,
        probe: 1,
        calibratedAtMicros: 10,
        offsetLowerMicros: 90,
        offsetUpperMicros: 110,
        uncertaintyMicros: 20,
        roundTripMicros: 21,
        daemonWorkMicros: 1,
      });
      test.options().onClockCalibrationOutcome?.({
        version: 1,
        requestId: "00000000-0000-4000-8000-000000000077",
        daemonInstanceId: GENERATION,
        reason: "calibrated",
        attemptedProbes: 5,
        receivedProbes: 5,
        validProbes: 5,
        selectedProbes: 1,
        selectedProbe: 1,
      });
      test.options().onInputTransportStage?.({
        traceId: "trace.one",
        operation: "pane-stream-socket-send-return",
        atMicros: 41,
        pane: PANE_A,
        sequence: 1,
        sharedMicros: 20,
      });
      test.options().onInputAck?.({
        traceId: "trace.one",
        pane: PANE_A,
        sequence: 1,
        sharedMicros: 30,
      });
      test.options().onTerminalFrameArrival?.({
        traceId: "trace.one",
        pane: PANE_A,
        atMicros: 42,
        sharedMicros: 40,
      });
      expect(terminalTraceStage).toHaveBeenCalledTimes(3);
      expect(terminalTraceStage.mock.calls[0]?.[0]).toMatchObject({
        traceId: "trace.one",
        operation: "pane-stream-socket-send-return",
        atMicros: 41,
        sharedMicros: 20,
        generation: GENERATION,
        clockUncertaintyMicros: 20,
      });
      expect(terminalTraceStage.mock.calls.map(([event]) => event.generation)).toEqual([
        GENERATION,
        GENERATION,
        GENERATION,
      ]);
      expect(
        terminalTraceStage.mock.calls.map(([event]) => event.clockCalibrationRequestId),
      ).toEqual(Array.from({ length: 3 }, () => "00000000-0000-4000-8000-000000000077"));
      expect(terminalClockCalibration).toHaveBeenCalledWith(
        expect.objectContaining({
          daemonInstanceId: GENERATION,
          reason: "calibrated",
          attemptedProbes: 5,
          receivedProbes: 5,
          validProbes: 5,
          selectedProbes: 1,
        }),
      );
      terminalClockCalibration.mockImplementation(() => {
        throw new Error("calibration diagnostic failed");
      });
      expect(() =>
        test.options().onClockCalibrationOutcome?.({
          version: 1,
          requestId: "00000000-0000-4000-8000-000000000077",
          daemonInstanceId: GENERATION,
          reason: "timeout-no-sample",
          attemptedProbes: 1,
          receivedProbes: 0,
          validProbes: 0,
          selectedProbes: 0,
          selectedProbe: null,
        }),
      ).not.toThrow();
      expect(terminalTraceStage.mock.calls[0]?.[0]).not.toHaveProperty("rssBytes");
      expect(terminalTraceStage.mock.calls[0]?.[0]).not.toHaveProperty("heapUsedBytes");
      terminalTraceStage.mockImplementation(() => {
        throw new Error("diagnostic sink failed");
      });
      expect(() =>
        test.options().onInputTransportStage?.({
          traceId: "trace.two",
          operation: "pane-stream-next-event-loop-turn",
          atMicros: 43,
          pane: PANE_A,
          sequence: 2,
        }),
      ).not.toThrow();
      expect(() =>
        test.options().onTerminalFrameArrival?.({
          traceId: "trace.two",
          pane: PANE_A,
          atMicros: 44,
        }),
      ).not.toThrow();
      expect(memoryUsage).not.toHaveBeenCalled();
      memoryUsage.mockRestore();
      await port.close();
    } finally {
      uninstall();
    }
  });

  it("rejects unsorted or cross-route runtime inventories before opening", async () => {
    const test = rig();
    await expect(
      connectOpenTuiWorkspaceRuntimePort({
        inventory: { ...inventory(), semanticPaneIds: [PANE_B, PANE_A] },
        routing: test.routing,
      }),
    ).rejects.toThrow("sorted and unique");
    await expect(
      connectOpenTuiWorkspaceRuntimePort({
        inventory: { ...inventory(), workspaceName: "workspace.beta" },
        routing: test.routing,
      }),
    ).rejects.toThrow("does not match");
    expect(test.openPaneStream).not.toHaveBeenCalled();
  });
});
