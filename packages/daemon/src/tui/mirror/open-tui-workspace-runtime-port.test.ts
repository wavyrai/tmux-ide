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
} from "./open-tui-workspace-runtime-port.ts";

const GENERATION = "00000000-0000-4000-8000-000000000001";
const NONCE = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "workspace.alpha";
const SESSION = "alpha";
const PANE_A = "pane.a";
const PANE_B = "pane.b";

function inventory(): WorkspaceClientRuntimeInventory {
  return Object.freeze({
    workspaceName: WORKSPACE,
    workspaceId: "workspace-id",
    sessionId: SESSION,
    daemonGeneration: GENERATION,
    shellGeneration: 3,
    semanticPaneIds: Object.freeze([PANE_A, PANE_B]),
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
      { performanceTraceId: traceId },
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
