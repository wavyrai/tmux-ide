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
    expect(read().activeLifecycleRequests).toEqual([
      expect.objectContaining({ generation: "g2", requestId: "replacement" }),
    ]);
    expect(read().activeLifecycleRequestOverflowGenerations).toEqual([]);
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
  });
});
