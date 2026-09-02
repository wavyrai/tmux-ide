import { afterEach, describe, expect, it } from "vitest";

import {
  createCard5DescriptorRecorder,
  createCard5EnvelopeAckRecorder,
  createCard5EnvelopeEvidenceRecorder,
  createCard5InputReceiptRecorder,
  createCard5PaneStreamLifecycleRecorder,
  recordCard5RuntimeReplacement,
  recordCard5SocketLifecycle,
} from "./card5-envelope-evidence.ts";

const globals = globalThis as typeof globalThis & Record<string, unknown>;

afterEach(() => {
  delete globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
  delete globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__;
  delete globals.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  delete globals.__TMUX_IDE_CARD5_INPUT_OPERATION_RECORD__;
});

describe("Card5 envelope evidence", () => {
  it("does zero setup work outside the detailed ProductRig mode", () => {
    expect(createCard5EnvelopeEvidenceRecorder()).toBeNull();
    expect(createCard5EnvelopeAckRecorder()).toBeNull();
    expect(createCard5DescriptorRecorder()).toBeNull();
    expect(createCard5PaneStreamLifecycleRecorder()).toBeNull();
    expect(globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__).toBeUndefined();
  });

  it("retains only the bounded ordered envelope identity needed for seed-first proof", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    const record = createCard5EnvelopeEvidenceRecorder();
    for (let revision = 0; revision < 80; revision += 1) {
      record?.({
        type: revision === 0 ? "terminal.seed" : "terminal.patch",
        generation: "g2",
        revision,
      } as never);
    }
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      events: readonly unknown[];
    };
    const events = read().events;
    expect(events).toHaveLength(64);
    expect(events[0]).toEqual({
      type: "terminal.patch",
      generation: "g2",
      revision: 16,
      acceptedOrdinal: 16,
    });
    expect(events.at(-1)).toEqual({
      type: "terminal.patch",
      generation: "g2",
      revision: 79,
      acceptedOrdinal: 79,
    });
    expect(JSON.stringify(events)).not.toContain("snapshot");
    recordCard5RuntimeReplacement("g1", "g2");
    expect(read()).toMatchObject({
      replacementCount: 1,
      replacementBoundary: {
        predecessorGeneration: "g1",
        replacementGeneration: "g2",
        acceptedOrdinal: 80,
        socketOrdinal: 0,
      },
    });
  });

  it("retains the exact replacement boundary even after the bounded event tail shifts", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    const record = createCard5EnvelopeEvidenceRecorder();
    recordCard5RuntimeReplacement("g1", "g2");
    record?.({ type: "terminal.patch", generation: "g1", revision: 9 } as never);
    for (let revision = 0; revision < 80; revision += 1) {
      record?.({
        type: revision === 0 ? "terminal.seed" : "terminal.patch",
        generation: "g2",
        revision,
      } as never);
    }
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      predecessorAcceptedAfterReplacement: number;
      replacementBoundary: { acceptedOrdinal: number };
      events: readonly { acceptedOrdinal: number }[];
    };
    expect(read().replacementBoundary.acceptedOrdinal).toBe(0);
    expect(read().predecessorAcceptedAfterReplacement).toBe(1);
    expect(read().events[0]?.acceptedOrdinal).toBe(17);
  });

  it("records bounded physical socket outcomes separately from envelope acceptance", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    recordCard5SocketLifecycle("g1", "open");
    recordCard5SocketLifecycle("g1", "closed");
    recordCard5SocketLifecycle("g2", "open");
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      socketEventCount: number;
      socketEvents: readonly unknown[];
    };
    expect(read().socketEventCount).toBe(3);
    expect(read().socketEvents).toEqual([
      { generation: "g1", outcome: "open", ordinal: 0 },
      { generation: "g1", outcome: "closed", ordinal: 1 },
      { generation: "g2", outcome: "open", ordinal: 2 },
    ]);
  });

  it("retains a bounded ordered pane-stream lifecycle without terminal content", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const record = createCard5PaneStreamLifecycleRecorder({
      workspaceName: "workspace-a",
      semanticPaneIds: ["pane-a"],
    });
    for (let ordinal = 0; ordinal < 80; ordinal += 1) {
      record?.({
        generation: "g1",
        requestId: `request-${ordinal}`,
        stage: ordinal % 2 === 0 ? "issued" : "terminal",
        code: ordinal % 2 === 0 ? "none" : "topology-changed",
        origin: ordinal % 2 === 0 ? "client" : "peer",
        closeCode: ordinal % 2 === 0 ? null : 1012,
        closeReason: ordinal % 2 === 0 ? "none" : "topology-changed",
      });
    }
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      lifecycleEventCount: number;
      lifecycleEvents: readonly Record<string, unknown>[];
    };
    expect(read().lifecycleEventCount).toBe(80);
    expect(read().lifecycleEvents).toHaveLength(64);
    expect(read().lifecycleEvents[0]).toMatchObject({ ordinal: 16, stage: "issued" });
    expect(read().lifecycleEvents.at(-1)).toMatchObject({
      ordinal: 79,
      stage: "terminal",
      code: "topology-changed",
      origin: "peer",
      closeCode: 1012,
      closeReason: "topology-changed",
    });
    expect(JSON.stringify(read())).not.toContain("terminal content");
  });

  it("tracks only first-seed activated nonterminal requests and never promotes issuance", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const record = createCard5PaneStreamLifecycleRecorder({
      workspaceName: "workspace-a",
      semanticPaneIds: ["pane-a"],
    });
    const event = (requestId: string, stage: "issued" | "first-seed" | "terminal") =>
      record?.({
        generation: "g1",
        requestId,
        stage,
        code: stage === "terminal" ? "disposed" : "none",
        origin: stage === "terminal" ? "dispose" : "client",
        closeCode: stage === "terminal" ? 1000 : null,
        closeReason: stage === "terminal" ? "renderer-disposed" : "none",
      });
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      activeLifecycleRequests: readonly Record<string, unknown>[];
      activeLifecycleRequestOverflowGenerations: readonly string[];
    };

    event("request-a", "issued");
    expect(read().activeLifecycleRequests).toEqual([]);
    event("request-a", "first-seed");
    event("unused-candidate", "issued");
    expect(read().activeLifecycleRequests).toEqual([
      expect.objectContaining({ generation: "g1", requestId: "request-a" }),
    ]);
    event("request-b", "first-seed");
    expect(read().activeLifecycleRequests.map(({ requestId }) => requestId)).toEqual([
      "request-a",
      "request-b",
    ]);
    event("request-a", "terminal");
    expect(read().activeLifecycleRequests.map(({ requestId }) => requestId)).toEqual(["request-b"]);
    event("request-b", "terminal");
    expect(read().activeLifecycleRequests).toEqual([]);
    expect(read().activeLifecycleRequestOverflowGenerations).toEqual([]);
    for (let ordinal = 0; ordinal < 9; ordinal += 1) event(`overflow-${ordinal}`, "first-seed");
    expect(read().activeLifecycleRequests).toHaveLength(8);
    expect(read().activeLifecycleRequestOverflowGenerations).toEqual(["g1"]);
    record?.({
      generation: "g2",
      requestId: "replacement",
      stage: "first-seed",
      code: "none",
      origin: "client",
      closeCode: null,
      closeReason: "none",
    });
    expect(read().activeLifecycleRequests).toHaveLength(9);
    expect(read().activeLifecycleRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ generation: "g1", requestId: "overflow-0" }),
        expect.objectContaining({ generation: "g2", requestId: "replacement" }),
      ]),
    );
    expect(read().activeLifecycleRequestOverflowGenerations).toEqual(["g1"]);
  });

  it("retains incumbent and candidate generations under global and per-generation caps", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      activeLifecycleRequests: readonly {
        generation: string;
        requestId: string;
        physicalEpoch: number;
      }[];
      activeLifecycleRequestOverflowGenerations: readonly string[];
      activeLifecycleRequestGlobalOverflow: boolean;
    };
    const recorders = Array.from(
      { length: 18 },
      (_, ordinal) =>
        createCard5PaneStreamLifecycleRecorder({
          workspaceName: ordinal === 17 ? "workspace-b" : "workspace-a",
          semanticPaneIds: [ordinal === 17 ? "pane-b" : "pane-a"],
        })!,
    );
    const emit = (ordinal: number, stage: "first-seed" | "terminal") =>
      recorders[ordinal]!({
        generation: ordinal < 8 ? "incumbent" : ordinal < 16 ? "candidate" : "overflow",
        requestId: `request-${ordinal}`,
        stage,
        code: stage === "terminal" ? "disposed" : "none",
        origin: stage === "terminal" ? "dispose" : "client",
        closeCode: stage === "terminal" ? 1000 : null,
        closeReason: stage === "terminal" ? "renderer-disposed" : "none",
      });

    for (let ordinal = 0; ordinal < 16; ordinal += 1) emit(ordinal, "first-seed");
    expect(read().activeLifecycleRequests).toHaveLength(16);
    expect(new Set(read().activeLifecycleRequests.map(({ generation }) => generation))).toEqual(
      new Set(["incumbent", "candidate"]),
    );
    emit(16, "first-seed");
    expect(read().activeLifecycleRequests).toHaveLength(16);
    expect(read().activeLifecycleRequestOverflowGenerations).toContain("overflow");
    emit(0, "terminal");
    expect(read().activeLifecycleRequests).toHaveLength(15);
    expect(read().activeLifecycleRequests.some(({ requestId }) => requestId === "request-8")).toBe(
      true,
    );
    emit(17, "first-seed");
    expect(read().activeLifecycleRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ generation: "candidate", requestId: "request-8" }),
        expect.objectContaining({ generation: "overflow", requestId: "request-17" }),
      ]),
    );
    for (let ordinal = 0; ordinal < 17; ordinal += 1) {
      const overflow = createCard5PaneStreamLifecycleRecorder({
        workspaceName: "workspace-a",
        semanticPaneIds: ["pane-a"],
      })!;
      overflow({
        generation: `overflow-generation-${ordinal}`,
        requestId: `overflow-request-${ordinal}`,
        stage: "first-seed",
        code: "none",
        origin: "client",
        closeCode: null,
        closeReason: "none",
      });
    }
    expect(read().activeLifecycleRequestOverflowGenerations).toHaveLength(16);
    expect(read().activeLifecycleRequestGlobalOverflow).toBe(true);
  });

  it("keeps a replacement physical epoch active when a stale same-request terminal arrives", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const binding = { workspaceName: "workspace-a", semanticPaneIds: ["pane-a"] };
    const first = createCard5PaneStreamLifecycleRecorder(binding)!;
    const replacement = createCard5PaneStreamLifecycleRecorder(binding)!;
    const event = (record: typeof first, stage: "first-seed" | "terminal") =>
      record({
        generation: "g1",
        requestId: "same-request",
        stage,
        code: stage === "terminal" ? "disposed" : "none",
        origin: stage === "terminal" ? "dispose" : "client",
        closeCode: stage === "terminal" ? 1000 : null,
        closeReason: stage === "terminal" ? "renderer-disposed" : "none",
      });
    event(first, "first-seed");
    event(replacement, "first-seed");
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      activeLifecycleRequests: readonly { physicalEpoch: number; requestId: string }[];
    };
    expect(read().activeLifecycleRequests).toHaveLength(2);
    event(first, "terminal");
    expect(read().activeLifecycleRequests).toEqual([
      expect.objectContaining({
        physicalEpoch: replacement.physicalEpoch,
        requestId: "same-request",
      }),
    ]);
    event(replacement, "terminal");
    expect(read().activeLifecycleRequests).toEqual([]);
  });

  it("records the exact semantic ACK only after the socket-send seam reports it", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const recordAck = createCard5EnvelopeAckRecorder();
    recordAck?.({
      generation: "g1",
      canonicalRevision: 7,
      transactionId: "10000000-0000-4000-8000-000000000007",
      deliveryNonce: "20000000-0000-4000-8000-000000000007",
      canonicalStateHash: "0000000000000007",
    });
    recordAck?.({
      generation: "g1",
      canonicalRevision: 8,
      transactionId: "10000000-0000-4000-8000-000000000008",
      deliveryNonce: "20000000-0000-4000-8000-000000000008",
      canonicalStateHash: "0000000000000008",
    });
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      ackSentCount: number;
      ackEvents: readonly unknown[];
    };
    expect(read()).toMatchObject({
      ackSentCount: 2,
      ackEvents: [
        {
          generation: "g1",
          revision: 7,
          transactionId: "10000000-0000-4000-8000-000000000007",
          deliveryNonce: "20000000-0000-4000-8000-000000000007",
          canonicalStateHash: "0000000000000007",
          ordinal: 0,
        },
        {
          generation: "g1",
          revision: 8,
          transactionId: "10000000-0000-4000-8000-000000000008",
          deliveryNonce: "20000000-0000-4000-8000-000000000008",
          canonicalStateHash: "0000000000000008",
          ordinal: 1,
        },
      ],
    });
  });

  it("records the bounded exact descriptor identity issued for the physical stream", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const recordDescriptor = createCard5DescriptorRecorder();
    recordDescriptor?.({
      daemonInstanceId: "g1",
      requestId: "20000000-0000-4000-8000-000000000001",
      webSocketUrl: "ws://127.0.0.1:3000/v1/pane-stream/redeem",
      subprotocol: "tmux-ide-pane-stream-v1",
    });
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      descriptorEventCount: number;
      descriptorEvents: readonly unknown[];
    };
    expect(read()).toMatchObject({
      descriptorEventCount: 1,
      descriptorEvents: [
        {
          generation: "g1",
          requestId: "20000000-0000-4000-8000-000000000001",
          socketUrl: "ws://127.0.0.1:3000/v1/pane-stream/redeem",
          subprotocol: "tmux-ide-pane-stream-v1",
          ordinal: 0,
        },
      ],
    });
  });

  it("records only a digest after the exact input ACK seam", async () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const recordInput = createCard5InputReceiptRecorder();
    await recordInput?.({
      generation: "g1",
      pane: "pane-a",
      seq: 9,
      input: "private marker\n",
      requestId: "10000000-0000-4000-8000-000000000009",
      authorityClientId: "web-client-a",
    });
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      inputReceiptCount: number;
      inputReceipts: readonly Record<string, unknown>[];
      inputOperationCount: number;
      inputOperations: readonly Record<string, unknown>[];
    };
    expect(read().inputReceiptCount).toBe(1);
    expect(read().inputReceipts[0]).toMatchObject({
      generation: "g1",
      pane: "pane-a",
      seq: 9,
      inputSha256: "3e03bff3793368a21c9c2bd2e7bb9c16f1a306d9fa80306051e85e92d7d8e29b",
      requestId: "10000000-0000-4000-8000-000000000009",
      authorityClientId: "web-client-a",
      ordinal: 0,
    });
    expect(JSON.stringify(read())).not.toContain("private marker");
    expect(read().inputOperationCount).toBe(1);
    expect(read().inputOperations).toEqual([
      expect.objectContaining({
        stage: "receipt-published",
        outcome: "ok",
        lifecycleRequestId: "10000000-0000-4000-8000-000000000009",
        clientId: "web-client-a",
        pane: "pane-a",
        seq: 9,
        ordinal: 0,
      }),
    ]);
  });

  it("bounds input operation evidence while preserving the total count", () => {
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    createCard5EnvelopeEvidenceRecorder();
    const record = globals.__TMUX_IDE_CARD5_INPUT_OPERATION_RECORD__ as (event: unknown) => void;
    for (let ordinal = 0; ordinal < 70; ordinal += 1)
      record({ stage: "xterm-enqueue", outcome: "ok", pane: "pane-a" });
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      inputOperationCount: number;
      inputOperations: readonly { ordinal: number }[];
    };
    expect(read().inputOperationCount).toBe(70);
    expect(read().inputOperations).toHaveLength(64);
    expect(read().inputOperations[0]?.ordinal).toBe(6);
    expect(read().inputOperations.at(-1)?.ordinal).toBe(69);
  });
});
