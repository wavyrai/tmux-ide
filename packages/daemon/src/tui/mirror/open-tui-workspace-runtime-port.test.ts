import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  InteractionReceipt,
  TerminalDeliveryEnvelope,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  applyTerminalReplicaUpdate,
  blankTerminalReplicaSnapshot,
  encodeCompactSemanticTerminalUpdate,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  hashTerminalReplicaSnapshot,
  negotiateTerminalDelivery,
  splitTerminalDeliveryChunks,
  type TerminalReplicaState,
} from "@tmux-ide/core";
import {
  PaneStreamOperationError,
  type OpenPaneStreamClientOptions,
  type PaneStreamRuntimeClient,
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

function negotiated(compact = false) {
  const result = negotiateTerminalDelivery(
    {
      protocolVersions: [1],
      encodings: compact ? ["semantic-compact-v1", "semantic-v1"] : ["semantic-v1"],
      richPlacements: true,
    },
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
  encoding: "semantic-v1" | "semantic-compact-v1" = "semantic-v1",
) {
  const bytes =
    encoding === "semantic-compact-v1"
      ? encodeCompactSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot })
      : encodeSemanticTerminalUpdate({ frame: "seed", revision: 0, snapshot });
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
    encoding,
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
  encoding: "semantic-v1" | "semantic-compact-v1" = "semantic-v1",
) {
  const patch = { rows: [], cursor: { ...previous.cursor, x: 1 } };
  const next = applyTerminalReplicaPatch(previous, patch);
  const payload = { frame: "patch" as const, baseRevision, revision, patch };
  const bytes =
    encoding === "semantic-compact-v1"
      ? encodeCompactSemanticTerminalUpdate(payload)
      : encodeSemanticTerminalUpdate(payload);
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
    encoding,
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

function uniqueHistoryRows(start: number, count: number, cols = 132) {
  const blank = blankTerminalReplicaSnapshot(cols, 41);
  const defaultCell = blank.grid[0]!.cells[0]!;
  return Object.freeze(
    Array.from({ length: count }, (_, offset) => {
      const prefix = `workload-${String(start + offset).padStart(4, "0")}`;
      return Object.freeze({
        wrapped: false,
        cells: Object.freeze([
          ...[...prefix].map((grapheme) => Object.freeze({ ...defaultCell, grapheme })),
          ...Array.from({ length: cols - prefix.length }, () => defaultCell),
        ]),
      });
    }),
  );
}

function repeatedBlankHistoryRows(count: number, cols = 132) {
  const row = blankTerminalReplicaSnapshot(cols, 41).grid[0]!;
  return Object.freeze(Array.from({ length: count }, () => row));
}

function compactHistoryPatchDelivery(
  previous: TerminalReplicaSnapshot,
  baseRevision: number,
  revision: number,
  append: ReturnType<typeof uniqueHistoryRows>,
  suffix: string,
  trim = 0,
) {
  const patch = Object.freeze({
    dimensions: Object.freeze({ cols: previous.cols, rows: previous.rows }),
    rows: Object.freeze([]),
    historyDelta: Object.freeze({ trim, append }),
  });
  const next = applyTerminalReplicaPatch(previous, patch);
  const bytes = encodeCompactSemanticTerminalUpdate({
    frame: "patch",
    baseRevision,
    revision,
    patch,
  });
  const transactionId = `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const envelope: TerminalDeliveryEnvelope = {
    type: "terminal.delivery",
    workspaceName: WORKSPACE,
    semanticPaneId: PANE_A,
    generation: GENERATION,
    incarnation: `${GENERATION}:1`,
    deliveryNonce: NONCE,
    transactionId,
    protocolVersion: 1,
    encoding: "semantic-compact-v1",
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
  return { envelope, chunks: splitTerminalDeliveryChunks(transactionId, bytes), next };
}

function rig(
  coherent = true,
  corruptBeforeCoherent = false,
  encoding: "semantic-v1" | "semantic-compact-v1" = "semantic-v1",
) {
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
    fitViewport: vi.fn(async (): Promise<"ok" | "geometry-authority-conflict"> => "ok"),
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
      options.onNegotiated(pane, {
        accepted: true,
        negotiated: negotiated(encoding === "semantic-compact-v1"),
      });
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
        const seed = seedDelivery(
          pane,
          blankTerminalReplicaSnapshot(4, 2),
          String(10 + index),
          undefined,
          encoding,
        );
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
  it("retains one current window across tmux false-then-true switch frames", async () => {
    const test = rig(true);
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const seen: Array<{ current: string | null; currentCount: number }> = [];
    const stop = port.onLayout((snapshot) =>
      seen.push({
        current: snapshot.current?.semanticWindowId ?? null,
        currentCount: snapshot.windows.filter((window) => window.currentWindow).length,
      }),
    );
    const main = port.getLayout()!;
    test.options().onLayout?.({ ...main, currentWindow: false, panes: [main.panes[0]!] });
    expect(seen.at(-1)).toEqual({ current: "window.main", currentCount: 1 });
    test.options().onLayout?.({
      ...main,
      semanticWindowId: "window.next",
      windowName: "next",
      currentWindow: true,
      panes: [main.panes[1]!],
    });
    expect(seen.at(-1)).toEqual({ current: "window.next", currentCount: 1 });
    expect(seen.every(({ current, currentCount }) => current !== null && currentCount === 1)).toBe(
      true,
    );
    stop();
    await port.close();
  });

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
      panes: [
        { pane: PANE_A, left: 0, top: 0, width: 60, height: 40, active: true },
        { pane: PANE_B, left: 60, top: 0, width: 60, height: 40, active: false },
      ],
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

  it("commits a large compact bootstrap seed before cooperative patch scheduling", async () => {
    const immediate = vi.spyOn(globalThis, "setImmediate");
    const test = rig(false, false, "semantic-compact-v1");
    const opening = connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory([PANE_A]),
      routing: test.routing,
    });
    await Promise.resolve();
    test.options().onLayout?.({
      type: "layout",
      semanticWindowId: "window.main",
      windowName: "main",
      currentWindow: true,
      cols: 132,
      rows: 41,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [{ pane: PANE_A, left: 0, top: 0, width: 132, height: 41, active: true }],
    });
    const blank = blankTerminalReplicaSnapshot(132, 41);
    const snapshot = Object.freeze({
      ...blank,
      history: repeatedBlankHistoryRows(1_000),
    }) as TerminalReplicaSnapshot;
    const seed = seedDelivery(PANE_A, snapshot, "203", undefined, "semantic-compact-v1");
    test.options().onTerminalDelivery(PANE_A, seed.envelope);
    for (const chunk of seed.chunks) test.options().onTerminalDelivery(PANE_A, chunk);

    const port = await opening;
    expect(immediate).not.toHaveBeenCalled();
    immediate.mockRestore();
    await port.close();
  });

  for (const [name, mutate] of [
    ["missing", (panes: Array<Record<string, unknown>>) => panes.slice(0, 1)],
    ["extra", (panes: Array<Record<string, unknown>>) => [...panes, { ...panes[0], pane: PANE_C }]],
    ["duplicate", (panes: Array<Record<string, unknown>>) => [...panes, { ...panes[0] }]],
  ] as const) {
    it(`refuses coherent activation for ${name} pane coverage`, async () => {
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
      const valid = {
        type: "layout" as const,
        semanticWindowId: "window.main",
        windowName: "main",
        currentWindow: true,
        cols: 120,
        rows: 40,
        zoomed: false,
        paneBorderStatus: "off" as const,
        panes: [
          { pane: PANE_A, left: 0, top: 0, width: 60, height: 40, active: true },
          { pane: PANE_B, left: 60, top: 0, width: 60, height: 40, active: false },
        ],
      };
      test.options().onLayout?.({ ...valid, panes: mutate(valid.panes) });
      for (const [index, pane] of [PANE_A, PANE_B].entries()) {
        const seed = seedDelivery(pane, blankTerminalReplicaSnapshot(4, 2), `30${index}`);
        test.options().onTerminalDelivery(pane, seed.envelope);
        for (const chunk of seed.chunks) test.options().onTerminalDelivery(pane, chunk);
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      test.options().onLayout?.(valid);
      const port = await opening;
      expect(settled).toBe(true);
      await port.close();
    });
  }

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
      terminalDelivery: { encodings: ["semantic-compact-v1", "semantic-v1"] },
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
    expect(layouts).toHaveLength(1);
    expect(port.getLayout()).toMatchObject({
      cols: 120,
      panes: [{ pane: PANE_A }, { pane: PANE_B }],
    });
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

  it("maps only an exact pane-stream geometry rejection to the shared conflict result", async () => {
    const test = rig();
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });

    await expect(port.fitViewport(120, 40)).resolves.toBe("ok");
    test.client.fitViewport.mockResolvedValueOnce("geometry-authority-conflict");
    await expect(port.fitViewport(139, 45)).resolves.toBe("geometry-authority-conflict");
    test.client.fitViewport.mockRejectedValueOnce(
      new PaneStreamOperationError("authority-rejected", "geometry belongs to another client"),
    );
    await expect(port.fitViewport(140, 46)).resolves.toBe("geometry-authority-conflict");
    test.client.fitViewport.mockRejectedValueOnce(
      new PaneStreamOperationError("operation-timeout", "viewport fit timed out"),
    );
    await expect(port.fitViewport(141, 46)).rejects.toMatchObject({ code: "operation-timeout" });
    await port.close();
  });

  it("retains the last coherent live layout across incomplete extra and duplicate updates", async () => {
    const test = rig();
    const rejected: unknown[] = [];
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
      onDiagnostic: (phase, details) => {
        if (phase === "layout" && "rejected" in details) rejected.push(details);
      },
    });
    const coherent = port.getLayoutSnapshot();
    const published: unknown[] = [];
    port.onLayout((snapshot) => published.push(snapshot));
    const frame = coherent.current!;
    const invalidPanes = [
      [frame.panes[0]!],
      [...frame.panes, { ...frame.panes[0]! }],
      [...frame.panes, { ...frame.panes[0]!, pane: PANE_C }],
    ];
    for (const panes of invalidPanes) {
      test.options().onLayout?.({ ...frame, panes });
      expect(port.getLayoutSnapshot()).toBe(coherent);
    }
    for (let index = 0; index < 150; index += 1)
      test.options().onLayout?.({ ...frame, panes: invalidPanes[0]! });
    expect(published).toEqual([coherent]);
    expect(rejected).toHaveLength(4);
    await port.close();
  });

  it("deduplicates identical semantic layouts while publishing switch rename and geometry once", async () => {
    const test = rig();
    const layoutDiagnostics: unknown[] = [];
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
      onDiagnostic: (phase, details) => {
        if (phase === "layout" && !("rejected" in details)) layoutDiagnostics.push(details);
      },
    });
    const published: Array<ReturnType<OpenTuiWorkspaceRuntimePort["getLayoutSnapshot"]>> = [];
    port.onLayout((snapshot) => published.push(snapshot));
    const initial = port.getLayoutSnapshot().current!;

    for (let index = 0; index < 150; index += 1) {
      test.options().onLayout?.({
        ...initial,
        panes: initial.panes.map((pane) => ({ ...pane })),
      });
    }
    expect(published).toHaveLength(1);
    expect(layoutDiagnostics).toHaveLength(1);

    test.options().onLayout?.({ ...initial, windowName: "renamed" });
    expect(published).toHaveLength(2);
    expect(layoutDiagnostics).toHaveLength(2);
    test.options().onLayout?.({ ...initial, windowName: "renamed" });
    expect(published).toHaveLength(2);
    expect(layoutDiagnostics).toHaveLength(2);

    const renamed = port.getLayoutSnapshot().current!;
    test.options().onLayout?.({
      ...renamed,
      cols: renamed.cols + 1,
      panes: renamed.panes.map((pane, index) =>
        index === renamed.panes.length - 1 ? { ...pane, width: pane.width + 1 } : { ...pane },
      ),
    });
    expect(published).toHaveLength(3);
    expect(layoutDiagnostics).toHaveLength(3);

    const resized = port.getLayoutSnapshot().current!;
    test.options().onLayout?.({ ...resized, currentWindow: false, panes: [resized.panes[0]!] });
    expect(published).toHaveLength(3);
    test.options().onLayout?.({
      ...resized,
      semanticWindowId: "window.next",
      windowName: "next",
      currentWindow: true,
      panes: [resized.panes[1]!],
    });
    expect(published).toHaveLength(4);
    expect(published.at(-1)?.current?.semanticWindowId).toBe("window.next");
    test.options().onLayout?.({ ...resized, currentWindow: true, panes: [resized.panes[0]!] });
    expect(published).toHaveLength(5);
    expect(layoutDiagnostics).toHaveLength(5);
    expect(published.at(-1)?.current?.semanticWindowId).toBe("window.main");
    await port.close();
  });

  it("retains one unstamped window across rename by stable pane identity", async () => {
    const test = rig(false);
    const opening = connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const frame = (windowName: string) => ({
      type: "layout" as const,
      semanticWindowId: null,
      windowName,
      currentWindow: true,
      cols: 120,
      rows: 40,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [
        { pane: PANE_A, left: 0, top: 0, width: 60, height: 40, active: true },
        { pane: PANE_B, left: 60, top: 0, width: 60, height: 40, active: false },
      ],
    });
    test.options().onLayout?.(frame("before"));
    for (const [index, pane] of [PANE_A, PANE_B].entries()) {
      const seed = seedDelivery(pane, blankTerminalReplicaSnapshot(4, 2), `40${index}`);
      test.options().onTerminalDelivery(pane, seed.envelope);
      for (const chunk of seed.chunks) test.options().onTerminalDelivery(pane, chunk);
    }
    const port = await opening;
    test.options().onLayout?.(frame("after"));
    expect(port.getLayoutSnapshot().current).toMatchObject({ windowName: "after" });
    expect(
      port.getLayoutSnapshot().windows.filter(({ semanticWindowId }) => semanticWindowId === null),
    ).toMatchObject([{ windowName: "after" }]);
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

  it("dispatches compact seed and patch envelopes through the production endpoint", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    let replicaState: TerminalReplicaState | null = null;
    let acceptedSeed: CanonicalTerminalReplicaUpdate | null = null;
    const applyProfiles: unknown[] = [];
    const listener = vi.fn((update: CanonicalTerminalReplicaUpdate) => {
      const result = applyTerminalReplicaUpdate(replicaState, update, {
        authenticatedFrameHash: "0000000000000000",
        instrumentation: {
          nowMicros: () => 1,
          onComplete: (profile) => applyProfiles.push(profile),
        },
      });
      if (result.status !== "applied") throw new Error(`compact reducer ${result.status}`);
      replicaState = result.state;
      if (update.type === "terminal.seed") {
        acceptedSeed = update;
        expect(result.state.snapshot).toBe(update.snapshot);
      }
      if (update.type === "terminal.patch")
        expect(result.state.snapshot?.cursor).toBe(update.patch.cursor);
    });
    subscription.onUpdate(listener);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal.seed", revision: 0 }),
      expect.any(Object),
    );
    listener.mockClear();
    test.client.ack.mockClear();
    const previous = blankTerminalReplicaSnapshot(4, 2);
    const delivery = patchDelivery(PANE_A, previous, 0, 1, "211", "semantic-compact-v1");
    test.options().onTerminalDelivery(PANE_A, delivery.envelope);
    for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "terminal.patch", revision: 1 }),
        expect.any(Object),
      );
      expect(test.client.ack).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: delivery.envelope.transactionId }),
      );
    });
    expect(test.client.nack).not.toHaveBeenCalled();
    expect(applyProfiles).toEqual([
      expect.objectContaining({
        trustedCompactAdoption: true,
        counts: expect.objectContaining({ validatedCells: 0, frozenCells: 0, rowHashMisses: 0 }),
      }),
      expect.objectContaining({
        trustedCompactAdoption: true,
        counts: expect.objectContaining({ validatedCells: 0, frozenCells: 0, rowHashMisses: 0 }),
      }),
    ]);
    let replayProfile: unknown = null;
    const replay = applyTerminalReplicaUpdate(null, acceptedSeed!, {
      authenticatedFrameHash: "0000000000000000",
      instrumentation: {
        nowMicros: () => 1,
        onComplete: (profile) => (replayProfile = profile),
      },
    });
    expect(replay.status).toBe("applied");
    expect(replayProfile).toMatchObject({ trustedCompactAdoption: false });
    await subscription.close();
    await port.close();
  });

  it("cooperatively commits unique 4096+904 history patches with no partial ACK", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    let state = blankTerminalReplicaSnapshot(132, 41);
    const listener = vi.fn((update: CanonicalTerminalReplicaUpdate) => {
      if (update.type === "terminal.patch") state = applyTerminalReplicaPatch(state, update.patch);
    });
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();

    const first = compactHistoryPatchDelivery(state, 0, 1, uniqueHistoryRows(0, 4_096), "301");
    test.options().onTerminalDelivery(PANE_A, first.envelope);
    for (const chunk of first.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        expect(test.client.ack).toHaveBeenCalledWith(
          expect.objectContaining({ transactionId: first.envelope.transactionId }),
        );
      },
      { timeout: 5_000 },
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(hashTerminalReplicaSnapshot(state)).toBe(hashTerminalReplicaSnapshot(first.next));

    listener.mockClear();
    test.client.ack.mockClear();
    const second = compactHistoryPatchDelivery(state, 1, 2, uniqueHistoryRows(4_096, 904), "302");
    test.options().onTerminalDelivery(PANE_A, second.envelope);
    for (const chunk of second.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    await vi.waitFor(
      () => {
        expect(test.client.ack).toHaveBeenCalledWith(
          expect.objectContaining({ transactionId: second.envelope.transactionId }),
        );
      },
      { timeout: 5_000 },
    );
    expect(listener).toHaveBeenCalledOnce();
    expect(hashTerminalReplicaSnapshot(state)).toBe(hashTerminalReplicaSnapshot(second.next));
    expect(state.history).toHaveLength(5_000);
    expect(test.client.nack).not.toHaveBeenCalled();
    await subscription.close();
    await port.close();
  }, 20_000);

  it("cooperatively adopts an expansion-heavy compact patch below 64KiB without blocking", () => {
    const fixture = fileURLToPath(
      new URL("../../../test-support/open-tui-compact-sub64-process.ts", import.meta.url),
    );
    const tsx = fileURLToPath(new URL("../../../../../node_modules/.bin/tsx", import.meta.url));
    const result = spawnSync(tsx, [fixture], {
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const measurement = JSON.parse(result.stdout.trim()) as {
      representationBytes: number;
      placementSeedBytes: number;
      placementPatchBytes: number;
      maxHeartbeatDelayMs: number;
      deliveryCount: number;
      ackCount: number;
      finalHashExact: boolean;
      decodeProfiles: readonly unknown[];
      applyProfiles: readonly {
        readonly trustedCompactAdoption: boolean;
        readonly phaseMicros: Readonly<Record<string, number>>;
        readonly counts: Readonly<Record<string, number>>;
      }[];
    };
    expect(measurement.representationBytes).toBeGreaterThan(32 * 1_024);
    expect(measurement.representationBytes).toBeLessThan(64 * 1_024);
    expect(measurement.placementSeedBytes).toBeGreaterThan(2 * 1_024 * 1_024);
    expect(measurement.placementPatchBytes).toBeGreaterThan(2 * 1_024 * 1_024);
    expect(measurement.placementSeedBytes).toBeLessThan(16 * 1_024 * 1_024);
    expect(measurement.placementPatchBytes).toBeLessThan(16 * 1_024 * 1_024);
    // This max includes time the child is descheduled by the host. Shared
    // Node 22 runners can miss one 33 ms frame even though compact delivery
    // adoption performs no measured synchronous work (asserted below).
    expect(measurement.maxHeartbeatDelayMs).toBeLessThanOrEqual(60);
    expect(measurement.deliveryCount).toBe(5);
    expect(measurement.ackCount).toBe(5);
    expect(measurement.finalHashExact).toBe(true);
    expect(measurement.applyProfiles).toHaveLength(5);
    expect(measurement.decodeProfiles).toHaveLength(5);
    for (const profile of measurement.applyProfiles) {
      expect(profile.trustedCompactAdoption).toBe(true);
      expect(Object.values(profile.phaseMicros).every((value) => value === 0)).toBe(true);
      expect(Object.values(profile.counts).every((value) => value === 0)).toBe(true);
    }
  }, 35_000);

  it("reuses authenticated history rows across 24 compact endpoint workload cycles", () => {
    const fixture = fileURLToPath(
      new URL("../../../test-support/open-tui-compact-sub64-process.ts", import.meta.url),
    );
    const tsx = fileURLToPath(new URL("../../../../../node_modules/.bin/tsx", import.meta.url));
    const result = spawnSync(tsx, [fixture, "workload"], {
      encoding: "utf8",
      timeout: 90_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const measurement = JSON.parse(result.stdout.trim()) as {
      workloadMinBytes: number;
      workloadMaxBytes: number;
      workloadCycles: number;
      explicitGcAvailable: boolean;
      maxHeartbeatDelayMs: number;
      peakRssBytes: number;
      peakHeapBytes: number;
      rssSlopeBytesPerSample: number;
      heapSlopeBytesPerSample: number;
      rssGrowthBytes: number;
      heapGrowthBytes: number;
      measuredExternalBytes: readonly number[];
      measuredArrayBufferBytes: readonly number[];
      deliveryCount: number;
      ackCount: number;
      finalHashExact: boolean;
      applyProfiles: readonly {
        readonly trustedCompactAdoption: boolean;
        readonly phaseMicros: Readonly<Record<string, number>>;
        readonly counts: Readonly<Record<string, number>>;
      }[];
      decodeProfiles: readonly {
        readonly reusedCompactPayload: boolean;
        readonly expandedRuns: number;
        readonly expandedCells: number;
        readonly reusedRows: number;
        readonly allocatedCells: number;
        readonly canonicalUtf8Allocations: number;
        readonly canonicalUtf8Bytes: number;
        readonly validatedCellAllocations: number;
      }[];
    };
    expect(measurement.workloadCycles).toBe(24);
    expect(measurement.explicitGcAvailable).toBe(false);
    expect(measurement.workloadMinBytes).toBeGreaterThan(512 * 1_024);
    expect(measurement.workloadMaxBytes).toBeLessThan(1_024 * 1_024);
    // Keep the same narrow host-scheduling allowance as the compact delivery
    // case above. The zero-work adoption profiles below remain deterministic.
    expect(measurement.maxHeartbeatDelayMs).toBeLessThanOrEqual(60);
    expect(measurement.peakRssBytes).toBeLessThan(1_073_741_824);
    expect(measurement.peakHeapBytes).toBeLessThan(536_870_912);
    expect(measurement.rssSlopeBytesPerSample).toBeLessThanOrEqual(262_144);
    expect(measurement.heapSlopeBytesPerSample).toBeLessThanOrEqual(131_072);
    expect(measurement.rssGrowthBytes).toBeLessThanOrEqual(67_108_864);
    expect(measurement.heapGrowthBytes).toBeLessThanOrEqual(33_554_432);
    expect(
      Math.max(...measurement.measuredExternalBytes) -
        Math.min(...measurement.measuredExternalBytes),
    ).toBeLessThanOrEqual(262_144);
    expect(
      Math.max(...measurement.measuredArrayBufferBytes) -
        Math.min(...measurement.measuredArrayBufferBytes),
    ).toBeLessThanOrEqual(262_144);
    expect(measurement.deliveryCount).toBe(28);
    expect(measurement.ackCount).toBe(28);
    expect(measurement.finalHashExact).toBe(true);
    expect(measurement.applyProfiles).toHaveLength(28);
    expect(measurement.decodeProfiles).toHaveLength(28);
    for (const profile of measurement.applyProfiles) {
      expect(profile.trustedCompactAdoption).toBe(true);
      expect(Object.values(profile.phaseMicros).every((value) => value === 0)).toBe(true);
      expect(Object.values(profile.counts).every((value) => value === 0)).toBe(true);
    }
    for (const profile of measurement.decodeProfiles.slice(-24)) {
      expect(profile.reusedCompactPayload).toBe(false);
      expect(profile.reusedRows).toBe(4_096);
      expect(profile.allocatedCells).toBe(0);
      expect(profile.canonicalUtf8Allocations).toBeLessThan(64);
      expect(profile.expandedCells).toBeGreaterThan(0);
      expect(profile.canonicalUtf8Allocations).toBe(0);
      expect(profile.canonicalUtf8Bytes).toBe(0);
      expect(profile.validatedCellAllocations).toBeLessThan(64);
    }
  }, 95_000);

  it("retires a cooperative hash mismatch without publication or ACK", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    test.client.nack.mockClear();
    const delivery = compactHistoryPatchDelivery(
      blankTerminalReplicaSnapshot(132, 41),
      0,
      1,
      uniqueHistoryRows(0, 4_096),
      "303",
    );
    const envelope = { ...delivery.envelope, canonicalStateHash: "ffffffffffffffff" };
    test.options().onTerminalDelivery(PANE_A, envelope);
    for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    await vi.waitFor(
      () => {
        expect(test.client.nack).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "decode-failed",
            transactionId: envelope.transactionId,
          }),
        );
      },
      { timeout: 5_000 },
    );
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    await subscription.close();
    await port.close();
  }, 15_000);

  it("never detaches ungranted exact aliases or shared transport views", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    subscription.onUpdate(() => undefined);
    await vi.waitFor(() => expect(test.client.ack).toHaveBeenCalled());
    test.client.ack.mockClear();
    const first = patchDelivery(
      PANE_A,
      blankTerminalReplicaSnapshot(4, 2),
      0,
      1,
      "611",
      "semantic-compact-v1",
    );
    expect(first.chunks).toHaveLength(1);
    const owned = first.chunks[0]!.bytes;
    test.options().onTerminalDelivery(PANE_A, first.envelope);
    test.options().onTerminalDelivery(PANE_A, first.chunks[0]!);
    expect(owned.byteLength).toBeGreaterThan(0);
    await vi.waitFor(() => expect(test.client.ack).toHaveBeenCalledOnce());

    const firstSnapshot = applyTerminalReplicaPatch(blankTerminalReplicaSnapshot(4, 2), {
      rows: [],
      cursor: { ...blankTerminalReplicaSnapshot(4, 2).cursor, x: 1 },
    });
    const second = patchDelivery(PANE_A, firstSnapshot, 1, 2, "612", "semantic-compact-v1");
    expect(second.chunks).toHaveLength(1);
    const source = second.chunks[0]!.bytes;
    const shared = new Uint8Array(source.byteLength + 2);
    shared.set(source, 1);
    test.options().onTerminalDelivery(PANE_A, second.envelope);
    test.options().onTerminalDelivery(PANE_A, {
      ...second.chunks[0]!,
      bytes: shared.subarray(1, shared.byteLength - 1),
    });
    expect(shared.byteLength).toBe(source.byteLength + 2);
    await vi.waitFor(() => expect(test.client.ack).toHaveBeenCalledTimes(2));
    expect(test.client.nack).not.toHaveBeenCalled();
    await subscription.close();
    await port.close();
  });

  it("invalidates an in-flight cooperative decode when its generation host closes", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    test.client.nack.mockClear();
    const delivery = compactHistoryPatchDelivery(
      blankTerminalReplicaSnapshot(132, 41),
      0,
      1,
      uniqueHistoryRows(0, 1_000),
      "304",
    );
    test.options().onTerminalDelivery(PANE_A, delivery.envelope);
    for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(test.client.ack).not.toHaveBeenCalled();
    await port.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    expect(test.client.nack).not.toHaveBeenCalled();
  }, 10_000);

  it("retires an incumbent cooperative flight before closing on an overlapping envelope", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    test.client.nack.mockClear();
    test.client.close.mockClear();
    const incumbent = compactHistoryPatchDelivery(
      blankTerminalReplicaSnapshot(132, 41),
      0,
      1,
      repeatedBlankHistoryRows(1_000),
      "305",
    );
    expect(incumbent.envelope.representationBytes).toBeLessThan(64 * 1_024);
    test.options().onTerminalDelivery(PANE_A, incumbent.envelope);
    for (const chunk of incumbent.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(test.client.ack).not.toHaveBeenCalled();

    const overlap = seedDelivery(
      PANE_A,
      blankTerminalReplicaSnapshot(4, 2),
      "306",
      undefined,
      "semantic-compact-v1",
    );
    test.options().onTerminalDelivery(PANE_A, overlap.envelope);
    await port.closed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(test.client.close).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    expect(test.client.nack).not.toHaveBeenCalled();
  }, 10_000);

  it("NACKs a duplicate cooperative chunk, retires its token, and accepts the next seed", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    test.client.nack.mockClear();
    const incumbent = compactHistoryPatchDelivery(
      blankTerminalReplicaSnapshot(132, 41),
      0,
      1,
      repeatedBlankHistoryRows(1_000),
      "307",
    );
    expect(incumbent.envelope.representationBytes).toBeLessThan(64 * 1_024);
    test.options().onTerminalDelivery(PANE_A, incumbent.envelope);
    for (const chunk of incumbent.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    test.options().onTerminalDelivery(PANE_A, incumbent.chunks.at(-1)!);
    expect(test.client.nack).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "decode-failed",
        transactionId: incumbent.envelope.transactionId,
      }),
    );

    const next = seedDelivery(
      PANE_A,
      blankTerminalReplicaSnapshot(4, 2),
      "308",
      undefined,
      "semantic-compact-v1",
    );
    test.options().onTerminalDelivery(PANE_A, next.envelope);
    for (const chunk of next.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    await vi.waitFor(() => {
      expect(test.client.ack).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: next.envelope.transactionId }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listener).toHaveBeenCalledOnce();
    expect(test.client.ack).toHaveBeenCalledTimes(1);
    await subscription.close();
    await port.close();
  }, 10_000);

  it("dispatches an offered semantic-v1 fallback envelope after compact negotiation", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    const delivery = patchDelivery(
      PANE_A,
      blankTerminalReplicaSnapshot(4, 2),
      0,
      1,
      "213",
      "semantic-v1",
    );
    test.options().onTerminalDelivery(PANE_A, delivery.envelope);
    for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal.patch", revision: 1 }),
      expect.any(Object),
    );
    expect(test.client.ack).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: delivery.envelope.transactionId }),
    );
    expect(test.client.nack).not.toHaveBeenCalled();
    await subscription.close();
    await port.close();
  });

  it("freezes the legacy fallback baseline before a later compact patch grant", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    let fallbackSeed: CanonicalTerminalReplicaUpdate | null = null;
    subscription.onUpdate((update) => {
      if (update.type === "terminal.seed") fallbackSeed = update;
    });
    const baseline = blankTerminalReplicaSnapshot(4, 2);
    const seed = seedDelivery(PANE_A, baseline, "215", undefined, "semantic-v1");
    test.options().onTerminalDelivery(PANE_A, seed.envelope);
    for (const chunk of seed.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    if (fallbackSeed?.type !== "terminal.seed") throw new Error("fallback seed missing");
    expect(() => {
      fallbackSeed.snapshot.grid[0]!.cells[0]!.grapheme = "mutated-after-ack";
    }).toThrow();

    test.client.ack.mockClear();
    test.client.nack.mockClear();
    const patch = patchDelivery(PANE_A, baseline, 0, 1, "216", "semantic-compact-v1");
    test.options().onTerminalDelivery(PANE_A, patch.envelope);
    for (const chunk of patch.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    await vi.waitFor(() => {
      expect(test.client.ack).toHaveBeenCalledWith(
        expect.objectContaining({ transactionId: patch.envelope.transactionId }),
      );
    });
    expect(test.client.nack).not.toHaveBeenCalled();
    await subscription.close();
    await port.close();
  });

  it("NACKs an unoffered compact envelope without canonical mutation", async () => {
    const test = rig(true, false, "semantic-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    test.client.nack.mockClear();
    const delivery = patchDelivery(
      PANE_A,
      blankTerminalReplicaSnapshot(4, 2),
      0,
      1,
      "214",
      "semantic-compact-v1",
    );
    test.options().onTerminalDelivery(PANE_A, delivery.envelope);
    for (const chunk of delivery.chunks) test.options().onTerminalDelivery(PANE_A, chunk);
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    expect(test.client.nack).toHaveBeenCalled();
    await subscription.close();
    await port.close();
  });

  it.each([
    ["semantic-compact-v1", '{"v":999}'],
    ["semantic-v1", "{"],
  ] as const)(
    "NACKs malformed %s bytes after compact negotiation without ACK or canonical mutation",
    async (encoding, malformed) => {
      const test = rig(true, false, "semantic-compact-v1");
      const port = await connectOpenTuiWorkspaceRuntimePort({
        inventory: inventory(),
        routing: test.routing,
      });
      const subscription = await port.subscribeTerminal({
        workspaceName: WORKSPACE,
        semanticPaneId: PANE_A,
      });
      const listener = vi.fn();
      subscription.onUpdate(listener);
      listener.mockClear();
      test.client.ack.mockClear();
      test.client.nack.mockClear();
      const bytes = new TextEncoder().encode(malformed);
      const seed = seedDelivery(
        PANE_A,
        blankTerminalReplicaSnapshot(4, 2),
        "212",
        undefined,
        encoding,
      );
      const envelope = {
        ...seed.envelope,
        incarnation: `${GENERATION}:2`,
        transactionId: "00000000-0000-4000-8000-000000000212",
        representationHash: hashTerminalDeliveryRepresentation(bytes),
        representationBytes: bytes.byteLength,
        chunkCount: 1,
      };
      test.options().onTerminalDelivery(PANE_A, envelope);
      for (const chunk of splitTerminalDeliveryChunks(envelope.transactionId, bytes))
        test.options().onTerminalDelivery(PANE_A, chunk);
      await vi.waitFor(() => {
        expect(test.client.nack).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "decode-failed",
            transactionId: envelope.transactionId,
          }),
        );
      });
      expect(test.client.ack).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      await subscription.close();
      await port.close();
    },
  );

  it("NACKs a large malformed cooperative compact frame without publication", async () => {
    const test = rig(true, false, "semantic-compact-v1");
    const port = await connectOpenTuiWorkspaceRuntimePort({
      inventory: inventory(),
      routing: test.routing,
    });
    const subscription = await port.subscribeTerminal({
      workspaceName: WORKSPACE,
      semanticPaneId: PANE_A,
    });
    const listener = vi.fn();
    subscription.onUpdate(listener);
    listener.mockClear();
    test.client.ack.mockClear();
    test.client.nack.mockClear();
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        f: "s",
        k: "terminal-semantic-compact",
        r: 1,
        s: "malformed".repeat(10_000),
        v: 1,
      }),
    );
    const seed = seedDelivery(
      PANE_A,
      blankTerminalReplicaSnapshot(4, 2),
      "305",
      undefined,
      "semantic-compact-v1",
    );
    const envelope: TerminalDeliveryEnvelope = {
      ...seed.envelope,
      incarnation: `${GENERATION}:2`,
      transactionId: "00000000-0000-4000-8000-000000000305",
      canonicalRevision: 1,
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024))),
    };
    test.options().onTerminalDelivery(PANE_A, envelope);
    for (const chunk of splitTerminalDeliveryChunks(envelope.transactionId, bytes))
      test.options().onTerminalDelivery(PANE_A, chunk);
    await vi.waitFor(() => {
      expect(test.client.nack).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "decode-failed",
          transactionId: envelope.transactionId,
        }),
      );
    });
    expect(listener).not.toHaveBeenCalled();
    expect(test.client.ack).not.toHaveBeenCalled();
    await subscription.close();
    await port.close();
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

  it("NACKs a compact hash mismatch before publication or ACK", async () => {
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
    test.client.nack.mockClear();
    test.client.close.mockClear();

    const previous = blankTerminalReplicaSnapshot(4, 2);
    const corrupt = patchDelivery(PANE_A, previous, 0, 1, "190");
    const corruptEnvelope = { ...corrupt.envelope, canonicalStateHash: "ffffffffffffffff" };
    test.options().onTerminalDelivery(PANE_A, corruptEnvelope);
    for (const chunk of corrupt.chunks) test.options().onTerminalDelivery(PANE_A, chunk);

    expect(test.client.ack).not.toHaveBeenCalled();
    expect(test.client.nack).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "decode-failed",
        transactionId: corruptEnvelope.transactionId,
      }),
    );
    expect(test.client.close).not.toHaveBeenCalled();
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
