import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalReplicaSnapshot,
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  decodeCompactSemanticTerminalUpdate,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
  TerminalDeliveryAssembler,
  TerminalDeliveryStateTooLargeError,
  type TerminalDeliveryClientState,
} from "@tmux-ide/core";
import {
  SessionRuntimeTerminalDeliveryHub,
  selectExactSemanticRepresentation,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";
import {
  createSessionRuntimeObservability,
  type SessionRuntimeStageSpan,
  type SessionRuntimeTraceContext,
} from "./runtime-observability.ts";
import { terminalDeliveryObservationOrdinal } from "./terminal-delivery-observation-identity.ts";

const generation = "00000000-0000-4000-8000-000000000001";

class FakeOwner implements TerminalDeliverySourceOwner {
  listener:
    | ((update: CanonicalTerminalReplicaUpdate, trace: SessionRuntimeTraceContext | null) => void)
    | null = null;
  raw:
    | ((record: {
        baseRevision: number;
        revision: number;
        bytes: Uint8Array;
        contiguous: boolean;
      }) => void)
    | null = null;
  closes = 0;
  subscriptions = 0;
  async subscribeSource(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
    onRaw: (record: {
      baseRevision: number;
      revision: number;
      bytes: Uint8Array;
      contiguous: boolean;
    }) => void,
  ) {
    this.subscriptions += 1;
    this.listener = listener;
    this.raw = onRaw;
    return {
      generation,
      semanticPaneId: "pane-a",
      close: async () => {
        this.closes += 1;
      },
    };
  }
  emit(
    update: CanonicalTerminalReplicaUpdate,
    trace: SessionRuntimeTraceContext | null = null,
  ): void {
    this.listener?.(update, trace);
  }
}

function trace(id: string): SessionRuntimeTraceContext {
  return {
    traceId: id,
    scenario: "terminal-input-to-paint",
    authority: { generation, incarnation: `${generation}:0` },
  };
}

function seed(revision = 0, incarnation = `${generation}:0`): CanonicalTerminalReplicaUpdate {
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  return {
    type: "terminal.seed",
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    generation,
    incarnation,
    revision,
    cols: 2,
    rows: 1,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
    snapshot,
  };
}

function tombstone(revision: number): CanonicalTerminalReplicaUpdate {
  return {
    type: "terminal.tombstone",
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    generation,
    incarnation: `${generation}:0`,
    baseRevision: revision - 1,
    revision,
    cols: 2,
    rows: 1,
    stateHash: hashTerminalReplicaTombstone("pane-closed"),
    hashAlgorithm: "fnv1a64-v1",
    tombstone: { reason: "pane-closed" },
  };
}

function patch(revision: number, x: number): CanonicalTerminalReplicaUpdate {
  const snapshot = blankTerminalReplicaSnapshot(2, 1);
  const next = { ...snapshot, cursor: { ...snapshot.cursor, x } };
  return {
    type: "terminal.patch",
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    generation,
    incarnation: `${generation}:0`,
    baseRevision: revision - 1,
    revision,
    cols: 2,
    rows: 1,
    stateHash: hashTerminalReplicaSnapshot(next),
    hashAlgorithm: "fnv1a64-v1",
    patch: { rows: [], cursor: next.cursor },
  };
}

function ack(envelope: TerminalDeliveryEnvelope): TerminalDeliveryAck {
  return {
    type: "terminal.delivery.ack",
    workspaceName: envelope.workspaceName,
    semanticPaneId: envelope.semanticPaneId,
    generation: envelope.generation,
    incarnation: envelope.incarnation,
    deliveryNonce: envelope.deliveryNonce,
    transactionId: envelope.transactionId,
    canonicalRevision: envelope.canonicalRevision,
    canonicalStateHash: envelope.canonicalStateHash,
    representationHash: envelope.representationHash,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function assembledBytes(
  envelope: TerminalDeliveryEnvelope,
  messages: readonly TerminalDeliveryServerMessage[],
): Uint8Array {
  const assembler = new TerminalDeliveryAssembler(envelope);
  for (const message of messages)
    if (
      message.type === "terminal.delivery.chunk" &&
      message.transactionId === envelope.transactionId
    )
      assembler.write(message);
  return assembler.complete();
}

function commitMessages(
  state: TerminalDeliveryClientState,
  envelope: TerminalDeliveryEnvelope,
  messages: readonly TerminalDeliveryServerMessage[],
) {
  let admitted = admitTerminalDeliveryEnvelope(state, envelope);
  const assembler = new TerminalDeliveryAssembler(envelope);
  for (const message of messages)
    if (
      message.type === "terminal.delivery.chunk" &&
      message.transactionId === envelope.transactionId
    ) {
      admitted = admitTerminalDeliveryChunk(admitted, message);
      assembler.write(message);
    }
  return commitTerminalDelivery(admitted, completeTerminalDelivery(admitted, assembler));
}

describe("SessionRuntimeTerminalDeliveryHub", () => {
  it("prunes ACK-superseded representations only after divergent clients advance", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const firstMessages: TerminalDeliveryServerMessage[] = [];
    const secondMessages: TerminalDeliveryServerMessage[] = [];
    const offer = {
      protocolVersions: [1],
      encodings: ["semantic-compact-v1"],
      richPlacements: false,
    } as const;
    const first = await hub.open("first", "pane-a", offer, (message) =>
      firstMessages.push(message),
    );
    const second = await hub.open("second", "pane-a", offer, (message) =>
      secondMessages.push(message),
    );
    owner.emit(seed());
    await settle();
    const firstEnvelope = firstMessages.find(
      (message): message is TerminalDeliveryEnvelope => message.type === "terminal.delivery",
    );
    const secondEnvelope = secondMessages.find(
      (message): message is TerminalDeliveryEnvelope => message.type === "terminal.delivery",
    );
    expect(firstEnvelope).toBeDefined();
    expect(secondEnvelope).toBeDefined();
    expect(hub.metrics().representationCacheBytes).toBeGreaterThan(0);
    first.ack(ack(firstEnvelope!));
    expect(hub.metrics().representationCacheBytes).toBeGreaterThan(0);
    second.ack(ack(secondEnvelope!));
    expect(hub.metrics().representationCacheBytes).toBe(0);

    await first.close();
    await second.close();
    const reconnectMessages: TerminalDeliveryServerMessage[] = [];
    const reconnect = await hub.open("reconnect", "pane-a", offer, (message) =>
      reconnectMessages.push(message),
    );
    owner.emit(seed());
    await settle();
    const reconnectEnvelope = reconnectMessages.find(
      (message): message is TerminalDeliveryEnvelope => message.type === "terminal.delivery",
    );
    expect(reconnectEnvelope).toBeDefined();
    reconnect.ack(ack(reconnectEnvelope!));
    expect(hub.metrics().representationCacheBytes).toBe(0);
    await reconnect.close();
    await hub.close();
  });

  it("selects the exact representable semantic representation without discarding a valid patch", () => {
    const candidate = (frame: "patch" | "seed" | "tombstone", bytes: number) => ({
      payload: { frame },
      bytes: new Uint8Array(bytes),
    });
    const tooLarge = () => {
      throw new TerminalDeliveryStateTooLargeError(16 * 1024 * 1024 + 1);
    };
    const seed = vi.fn(() => candidate("seed", 1024));

    expect(
      selectExactSemanticRepresentation(() => candidate("patch", 512 * 1024), seed).payload.frame,
    ).toBe("patch");
    expect(seed).not.toHaveBeenCalled();

    const observedSmallerPatch = selectExactSemanticRepresentation(
      () => candidate("patch", 740_307),
      () => candidate("seed", 2_194_552),
    );
    expect(observedSmallerPatch.payload.frame).toBe("patch");
    expect(observedSmallerPatch.bytes).toHaveLength(740_307);
    expect(observedSmallerPatch.observation).toEqual({
      attemptedPatchBytes: 740_307,
      attemptedSeedBytes: 2_194_552,
      selectionStatus: "patch-preferred",
    });

    const observedSmallerSeed = selectExactSemanticRepresentation(
      () => candidate("patch", 740_307),
      () => candidate("seed", 600_000),
    );
    expect(observedSmallerSeed.payload.frame).toBe("seed");
    expect(observedSmallerSeed.bytes).toHaveLength(600_000);
    expect(observedSmallerSeed.observation?.selectionStatus).toBe("seed-preferred");

    const observedTie = selectExactSemanticRepresentation(
      () => candidate("patch", 740_307),
      () => candidate("seed", 740_307),
    );
    expect(observedTie.payload.frame).toBe("patch");
    expect(observedTie.observation?.selectionStatus).toBe("patch-preferred");
    const unobservedSmallerPatch = candidate("patch", 740_307);
    expect(
      selectExactSemanticRepresentation(
        () => unobservedSmallerPatch,
        () => candidate("seed", 2_194_552),
        false,
      ),
    ).toBe(unobservedSmallerPatch);

    const validLargePatch = selectExactSemanticRepresentation(
      () => candidate("patch", 512 * 1024 + 1),
      tooLarge,
    );
    expect(validLargePatch.payload.frame).toBe("patch");
    expect(validLargePatch.bytes).toHaveLength(512 * 1024 + 1);
    expect(validLargePatch.observation).toEqual({
      attemptedPatchBytes: 512 * 1024 + 1,
      attemptedSeedBytes: 16 * 1024 * 1024 + 1,
      selectionStatus: "patch-fallback",
    });

    const validSeed = selectExactSemanticRepresentation(tooLarge, () =>
      candidate("seed", 16 * 1024 * 1024),
    );
    expect(validSeed.payload.frame).toBe("seed");
    expect(validSeed.bytes).toHaveLength(16 * 1024 * 1024);
    expect(validSeed.observation).toEqual({
      attemptedPatchBytes: 16 * 1024 * 1024 + 1,
      attemptedSeedBytes: 16 * 1024 * 1024,
      selectionStatus: "seed-preferred",
    });
    const unobservedPatch = candidate("patch", 512 * 1024 + 1);
    expect(selectExactSemanticRepresentation(() => unobservedPatch, tooLarge, false)).toBe(
      unobservedPatch,
    );
    const directSeed = candidate("seed", 321);
    expect(selectExactSemanticRepresentation(() => directSeed, seed).observation).toEqual({
      attemptedPatchBytes: null,
      attemptedSeedBytes: 321,
      selectionStatus: "direct-seed",
    });
    const directTombstone = candidate("tombstone", 123);
    expect(selectExactSemanticRepresentation(() => directTombstone, seed).observation).toEqual({
      attemptedPatchBytes: null,
      attemptedSeedBytes: null,
      selectionStatus: "direct-tombstone",
    });

    expect(() => selectExactSemanticRepresentation(tooLarge, tooLarge)).toThrow(
      TerminalDeliveryStateTooLargeError,
    );
    expect(() =>
      selectExactSemanticRepresentation(
        () => {
          throw new Error("patch encoding failed");
        },
        () => candidate("seed", 1),
      ),
    ).toThrow("patch encoding failed");
    expect(() =>
      selectExactSemanticRepresentation(
        () => candidate("patch", 512 * 1024 + 1),
        () => {
          throw new Error("seed encoding failed");
        },
      ),
    ).toThrow("seed encoding failed");
  });

  it("selects the smaller exact over-threshold representation through the real hub", async () => {
    const runCase = async (
      baseRevision: number,
      patchShape: "patch-smaller" | "seed-smaller" | "tie",
      expectedFrame: "patch" | "seed",
    ) => {
      const owner = new FakeOwner();
      const spans: SessionRuntimeStageSpan[] = [];
      const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
        observability: createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) }),
      });
      const messages: TerminalDeliveryServerMessage[] = [];
      const connection = await hub.open(
        `size-${patchShape}`,
        "pane-a",
        { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
        (message) => messages.push(message),
      );
      const blank = blankTerminalReplicaSnapshot(2, 1);
      const initialSnapshot = {
        ...blank,
        history: Array.from({ length: 3_000 }, () => blank.grid[0]!),
      };
      owner.emit({
        type: "terminal.seed",
        workspaceName: "workspace",
        semanticPaneId: "pane-a",
        generation,
        incarnation: `${generation}:0`,
        revision: baseRevision,
        cols: 2,
        rows: 1,
        stateHash: hashTerminalReplicaSnapshot(initialSnapshot),
        hashAlgorithm: "fnv1a64-v1",
        snapshot: initialSnapshot,
      });
      await settle();
      const initialEnvelope = messages.findLast(
        (message) => message.type === "terminal.delivery",
      ) as TerminalDeliveryEnvelope;
      connection.ack(ack(initialEnvelope));
      const targetSnapshot = {
        ...initialSnapshot,
        cursor: { ...initialSnapshot.cursor, x: 1 },
      };
      const commonPatch = {
        rows: [] as { index: number; row: TerminalReplicaSnapshot["grid"][number] }[],
        history: targetSnapshot.history,
        cursor: targetSnapshot.cursor,
      };
      const richPatch = {
        ...commonPatch,
        dimensions: { cols: 2, rows: 1 },
        rows: targetSnapshot.grid.map((row, index) => ({ index, row })),
        modes: targetSnapshot.modes,
        placements: targetSnapshot.placements,
        bootstrap: targetSnapshot.bootstrap,
      };
      const tiePatch = {
        ...commonPatch,
        rows: targetSnapshot.grid.map((row, index) => ({ index, row })),
        modes: targetSnapshot.modes,
        bootstrap: targetSnapshot.bootstrap,
      };
      owner.emit({
        type: "terminal.patch",
        workspaceName: "workspace",
        semanticPaneId: "pane-a",
        generation,
        incarnation: `${generation}:0`,
        baseRevision,
        revision: baseRevision + 1,
        cols: 2,
        rows: 1,
        stateHash: hashTerminalReplicaSnapshot(targetSnapshot),
        hashAlgorithm: "fnv1a64-v1",
        patch:
          patchShape === "seed-smaller" ? richPatch : patchShape === "tie" ? tiePatch : commonPatch,
      });
      await settle();
      const envelope = messages.findLast(
        (message) => message.type === "terminal.delivery",
      ) as TerminalDeliveryEnvelope;
      expect(envelope.frame).toBe(expectedFrame);
      expect(envelope.representationBytes).toBeGreaterThan(512 * 1024);
      const observation = spans.findLast(
        (span) =>
          span.operation === "terminal-delivery-encode-enqueue" &&
          span.terminalDelivery?.canonicalRevision === baseRevision + 1,
      )?.terminalDelivery;
      expect(observation?.attemptedPatchBytes).toBeGreaterThan(512 * 1024);
      expect(observation?.attemptedSeedBytes).toBeGreaterThan(512 * 1024);
      if (patchShape === "tie")
        expect(observation?.attemptedPatchBytes).toBe(observation?.attemptedSeedBytes);
      else if (expectedFrame === "patch")
        expect(observation?.attemptedPatchBytes).toBeLessThan(observation?.attemptedSeedBytes ?? 0);
      else
        expect(observation?.attemptedSeedBytes).toBeLessThan(observation?.attemptedPatchBytes ?? 0);
      connection.ack(ack(envelope));
      expect(hub.metrics()).toMatchObject({
        inFlight: 0,
        queueDepth: 0,
        reseeds: expectedFrame === "seed" ? 2 : 1,
      });
      await connection.close();
      await hub.close();
    };
    await runCase(0, "patch-smaller", "patch");
    await runCase(0, "seed-smaller", "seed");
    await runCase(10, "tie", "patch");
  });

  it("closes a source that resolves after reset and allows a clean retry", async () => {
    let resolveLate!: (source: {
      generation: string;
      semanticPaneId: string;
      close: () => Promise<void>;
    }) => void;
    const lateClose = vi.fn(async () => undefined);
    const lateOwner: TerminalDeliverySourceOwner = {
      subscribeSource: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveLate = resolve;
          }),
      ),
    };
    const retryOwner = new FakeOwner();
    const owners: TerminalDeliverySourceOwner[] = [lateOwner, retryOwner];
    const hub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      "workspace",
      () => owners.shift()!,
    );
    const offer = {
      protocolVersions: [1],
      encodings: ["semantic-v1"],
      richPlacements: false,
    } as const;
    const opening = hub.open("client", "pane-a", offer, () => undefined);
    await Promise.resolve();
    await hub.resetForSessionRestart();
    resolveLate({ generation, semanticPaneId: "pane-a", close: lateClose });

    await expect(opening).rejects.toThrow("retired during startup");
    expect(lateClose).toHaveBeenCalledOnce();
    const retry = await hub.open("client", "pane-a", offer, () => undefined);
    expect(retryOwner.subscriptions).toBe(1);
    await retry.close();
    await hub.close();
  });

  it("closes a source that resolves after hub shutdown", async () => {
    let resolveLate!: (source: {
      generation: string;
      semanticPaneId: string;
      close: () => Promise<void>;
    }) => void;
    const lateClose = vi.fn(async () => undefined);
    const owner: TerminalDeliverySourceOwner = {
      subscribeSource: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveLate = resolve;
          }),
      ),
    };
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const opening = hub.open(
      "client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      () => undefined,
    );
    await Promise.resolve();
    await hub.close();
    resolveLate({ generation, semanticPaneId: "pane-a", close: lateClose });

    await expect(opening).rejects.toThrow("retired during startup");
    expect(lateClose).toHaveBeenCalledOnce();
  });

  it("reserves concurrent opens before awaiting pane startup so capacity cannot oversubscribe", async () => {
    let release!: () => void;
    const startGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = new FakeOwner();
    owner.subscribeSource = async (...args) => {
      await startGate;
      return FakeOwner.prototype.subscribeSource.apply(owner, args);
    };
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const offer = {
      protocolVersions: [1],
      encodings: ["semantic-v1"],
      richPlacements: false,
    } as const;
    const admitted = Array.from({ length: 64 }, (_, index) =>
      hub.open(`client-${index}`, "pane-a", offer, () => undefined),
    );

    await expect(hub.open("client-64", "pane-a", offer, () => undefined)).rejects.toThrow(
      "Terminal delivery client limit reached",
    );
    release();
    const connections = await Promise.all(admitted);
    expect(hub.metrics()).toMatchObject({ clients: 64, connections: 64 });
    await Promise.all(connections.map((connection) => connection.close()));
    await hub.close();
  });

  it("rejects incompatible protocol offers before allocating pane state", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "old-client",
      "pane-a",
      { protocolVersions: [2], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
    );
    expect(connection.negotiation).toEqual({
      accepted: false,
      reason: "protocol-version-mismatch",
    });
    expect(owner.subscriptions).toBe(0);
    expect(messages).toHaveLength(0);
    await hub.close();
  });

  it("fans one canonical seed to eight isolated clients with one in-flight each", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[][] = Array.from({ length: 8 }, () => []);
    const connections = await Promise.all(
      messages.map((sink, index) =>
        hub.open(
          `client-${index}`,
          "pane-a",
          { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
          (message) => sink.push(message),
        ),
      ),
    );
    owner.emit(seed());
    await settle();
    expect(messages.every((sink) => sink[0]?.type === "terminal.delivery")).toBe(true);
    expect(hub.metrics().inFlight).toBe(8);
    expect(hub.convergenceSnapshot().clients).toHaveLength(8);
    for (let index = 0; index < connections.length; index += 1)
      connections[index]!.ack(ack(messages[index]![0] as TerminalDeliveryEnvelope));
    expect(hub.metrics().inFlight).toBe(0);
    await hub.close();
  });

  it.each([2, 4, 8])(
    "converges %i mixed semantic, ANSI diff and raw consumers on one canonical tuple",
    async (count) => {
      const owner = new FakeOwner();
      const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
      const encodings = ["semantic-v1", "ansi-diff-v1", "ansi-raw-v1"] as const;
      const sinks = Array.from({ length: count }, () => [] as TerminalDeliveryServerMessage[]);
      const connections = await Promise.all(
        sinks.map((sink, index) =>
          hub.open(
            `mixed-${index}`,
            "pane-a",
            {
              protocolVersions: [1],
              encodings: [encodings[index % encodings.length]!],
              richPlacements: false,
            },
            (message) => sink.push(message),
          ),
        ),
      );
      for (let index = 0; index < count; index += 1) {
        const result = connections[index]!.negotiation;
        expect(result.accepted && result.negotiated.encoding).toBe(
          encodings[index % encodings.length],
        );
      }
      owner.emit(seed());
      await settle();
      for (let index = 0; index < count; index += 1)
        connections[index]!.ack(ack(sinks[index]![0] as TerminalDeliveryEnvelope));
      owner.raw?.({
        baseRevision: 0,
        revision: 1,
        bytes: new TextEncoder().encode("\u001b[2G"),
        contiguous: true,
      });
      owner.emit(patch(1, 1));
      await settle();
      const envelopes = sinks.map(
        (sink) =>
          sink.findLast(
            (message) => message.type === "terminal.delivery",
          ) as TerminalDeliveryEnvelope,
      );
      expect(
        new Set(
          envelopes.map(
            (envelope) => `${envelope.canonicalRevision}:${envelope.canonicalStateHash}`,
          ),
        ).size,
      ).toBe(1);
      expect(envelopes[0]!.canonicalRevision).toBe(1);
      for (let index = 0; index < count; index += 1) {
        const encoding = encodings[index % encodings.length];
        expect(envelopes[index]!.canonicalEquivalent).toBe(encoding === "semantic-v1");
        if (encoding === "ansi-raw-v1") expect(envelopes[index]!.frame).toBe("patch");
      }
      for (let index = 0; index < count; index += 1)
        connections[index]!.ack(ack(envelopes[index]!));
      expect(hub.metrics().inFlight).toBe(0);
      const convergence = hub.convergenceSnapshot();
      expect(convergence.panes).toEqual([
        expect.objectContaining({
          semanticPaneId: "pane-a",
          incarnation: `${generation}:0`,
          revision: 1,
          stateHash: envelopes[0]!.canonicalStateHash,
        }),
      ]);
      expect(
        new Set(
          convergence.clients.map((client) => `${client.baselineRevision}:${client.baselineHash}`),
        ).size,
      ).toBe(1);
      expect(convergence.clients.every((client) => client.queueDepth === 0)).toBe(true);
      await hub.close();
    },
  );

  it("lets fast clients advance while a stalled sink retains only one flight and latest pointer", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const slowMessages: TerminalDeliveryServerMessage[] = [];
    const fastMessages: TerminalDeliveryServerMessage[] = [];
    let releaseSlow!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = await hub.open(
      "slow",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => {
        slowMessages.push(message);
        return blocked;
      },
    );
    const fast = await hub.open(
      "fast",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => fastMessages.push(message),
    );
    owner.emit(seed());
    await settle();
    fast.ack(ack(fastMessages[0] as TerminalDeliveryEnvelope));
    for (let revision = 1; revision <= 20; revision += 1) owner.emit(patch(revision, revision % 2));
    await settle();
    const latest = fastMessages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(latest.canonicalRevision).toBe(20);
    fast.ack(ack(latest));
    expect(hub.metrics()).toMatchObject({ clients: 2, inFlight: 1, latestPointers: 1 });
    expect(hub.metrics().maxQueueDepth).toBeLessThanOrEqual(2);
    expect(hub.convergenceSnapshot().clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: "slow", inFlightRevision: 0, latestRevision: 20 }),
        expect.objectContaining({ clientId: "fast", baselineRevision: 20 }),
      ]),
    );
    expect(slowMessages.filter((message) => message.type === "terminal.delivery")).toHaveLength(1);
    releaseSlow();
    await settle();
    slow.ack(ack(slowMessages[0] as TerminalDeliveryEnvelope));
    await settle();
    const resumed = slowMessages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(resumed.canonicalRevision).toBe(20);
    expect(resumed.frame).toBe("seed");
    slow.ack(ack(resumed));
    await Promise.all([slow.close(), fast.close()]);
    await hub.close();
  });

  it("preempts a blocked representation with source close and tolerates its racing ACK", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[] = [];
    let releaseRepresentation!: () => void;
    const blockedRepresentation = new Promise<void>((resolve) => {
      releaseRepresentation = resolve;
    });
    const connection = await hub.open(
      "slow",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => {
        messages.push(message);
        return message.type === "terminal.delivery" ? blockedRepresentation : undefined;
      },
    );
    owner.emit(seed());
    await settle();
    const displaced = messages[0] as TerminalDeliveryEnvelope;

    owner.emit(tombstone(1));
    await settle();
    expect(messages.at(-1)).toMatchObject({
      type: "terminal.delivery.fault",
      reason: "source-closed",
    });

    // The renderer may have applied the representation immediately before it
    // observed close. That authenticated ACK belongs to the displaced flight,
    // and must not transform honest lifecycle racing into protocol failure.
    connection.ack(ack(displaced));
    expect(
      messages.filter(
        (message) =>
          message.type === "terminal.delivery.fault" && message.reason === "protocol-violation",
      ),
    ).toHaveLength(0);
    releaseRepresentation();
    await settle();
    await connection.close();
    await hub.close();
  });

  it("accepts only an exact duplicate ACK and faults mutated replays", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
    );
    owner.emit(seed());
    await settle();
    const accepted = ack(messages[0] as TerminalDeliveryEnvelope);
    connection.ack(accepted);
    connection.ack(accepted);
    expect(messages.some((message) => message.type === "terminal.delivery.fault")).toBe(false);
    connection.ack({ ...accepted, canonicalStateHash: "0000000000000000" });
    await settle();
    expect(messages.at(-1)?.type).toBe("terminal.delivery.fault");
    await connection.close();
    await hub.close();
  });

  it("rejects an ACK sent before any representation chunk reaches the sink", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[] = [];
    let connection!: Awaited<ReturnType<typeof hub.open>>;
    connection = await hub.open(
      "eager-client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => {
        messages.push(message);
        if (message.type === "terminal.delivery") connection.ack(ack(message));
      },
    );
    owner.emit(seed());
    await settle();
    expect(messages.map((message) => message.type)).toEqual([
      "terminal.delivery",
      "terminal.delivery.fault",
    ]);
    await connection.close();
    await hub.close();
  });

  it("drops queued canonical work on restart and delivers the terminal fault first", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[] = [];
    await hub.open(
      "client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
    );
    owner.emit(seed());
    await hub.resetForSessionRestart();
    await settle();
    expect(messages.map((message) => message.type)).toEqual(["terminal.delivery.fault"]);
    expect(owner.closes).toBe(1);
    await hub.close();
  });

  it("rebinds a reopened semantic pane without a frozen client retaining the dead owner", async () => {
    const owners = [new FakeOwner(), new FakeOwner()];
    let ownerIndex = 0;
    const hub = new SessionRuntimeTerminalDeliveryHub(
      generation,
      "workspace",
      () => owners[ownerIndex++]!,
    );
    const live: TerminalDeliveryServerMessage[] = [];
    const frozen: TerminalDeliveryServerMessage[] = [];
    const liveConnection = await hub.open(
      "live",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => live.push(message),
    );
    const frozenConnection = await hub.open(
      "frozen",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => frozen.push(message),
    );
    owners[0]!.emit(seed());
    await settle();
    liveConnection.ack(ack(live[0] as TerminalDeliveryEnvelope));
    frozenConnection.ack(ack(frozen[0] as TerminalDeliveryEnvelope));
    frozenConnection.setVisibility("frozen");
    owners[0]!.emit(tombstone(1));
    await settle();
    expect(live.findLast((message) => message.type === "terminal.delivery")).toMatchObject({
      frame: "tombstone",
    });
    expect(frozen.at(-1)?.type).toBe("terminal.delivery.fault");
    const reopened: TerminalDeliveryServerMessage[] = [];
    const reopenedConnection = await hub.open(
      "reopened",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => reopened.push(message),
    );
    owners[1]!.emit(seed(2, `${generation}:1`));
    await settle();
    expect(reopened[0]).toMatchObject({ type: "terminal.delivery", canonicalRevision: 2 });
    expect(owners[0]!.closes).toBeGreaterThan(0);
    await Promise.all([
      liveConnection.close(),
      frozenConnection.close(),
      reopenedConnection.close(),
    ]);
    await hub.close();
  });

  it("keeps hidden/frozen clients quiet and background clients cadence-bound", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const hidden: TerminalDeliveryServerMessage[] = [];
    const background: TerminalDeliveryServerMessage[] = [];
    const hiddenConnection = await hub.open(
      "hidden",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => hidden.push(message),
    );
    const backgroundConnection = await hub.open(
      "background",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => background.push(message),
    );
    hiddenConnection.setVisibility("hidden");
    backgroundConnection.setVisibility("background");
    owner.emit(seed());
    await Promise.resolve();
    expect(hidden).toHaveLength(0);
    expect(background).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    await settle();
    expect(background[0]?.type).toBe("terminal.delivery");
    hiddenConnection.setVisibility("visible");
    await settle();
    expect(hidden[0]?.type).toBe("terminal.delivery");
    await Promise.all([hiddenConnection.close(), backgroundConnection.close()]);
    await hub.close();
  });

  it("coalesces a frozen revision flood into one latest seed on thaw", async () => {
    const owner = new FakeOwner();
    const spans: SessionRuntimeStageSpan[] = [];
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
      observability: createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) }),
    });
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "frozen-client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
    );
    owner.emit(seed());
    await settle();
    connection.ack(ack(messages[0] as TerminalDeliveryEnvelope));
    connection.setVisibility("frozen");
    const before = messages.filter((message) => message.type === "terminal.delivery").length;
    for (let revision = 1; revision <= 20; revision += 1) owner.emit(patch(revision, revision % 2));
    await settle();
    expect(messages.filter((message) => message.type === "terminal.delivery")).toHaveLength(before);
    connection.setVisibility("visible");
    await settle();
    const resumed = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(resumed).toMatchObject({ frame: "seed", canonicalRevision: 20 });
    expect(
      spans.findLast(
        (span) =>
          span.operation === "terminal-delivery-encode-enqueue" &&
          span.terminalDelivery?.canonicalRevision === 20,
      )?.terminalDelivery,
    ).toMatchObject({
      representation: "seed",
      representationBytes: resumed.representationBytes,
      attemptedPatchBytes: null,
      attemptedSeedBytes: resumed.representationBytes,
      selectionStatus: "direct-seed",
    });
    expect(hub.metrics().latestPointers).toBe(1);
    await connection.close();
    await hub.close();
  });

  it("preserves the latest controlled probe through coalesced untraced state", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "trace-client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
    );
    owner.emit(seed());
    await settle();
    connection.ack(ack(messages[0] as TerminalDeliveryEnvelope));

    const first = trace("00000000-0000-4000-8000-000000000091");
    owner.emit(patch(1, 1), first);
    owner.emit(patch(2, 0));
    await settle();
    let delivered = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(delivered).toMatchObject({ canonicalRevision: 2, performanceTraceId: first.traceId });
    connection.ack(ack(delivered));

    const traceA = trace("00000000-0000-4000-8000-000000000092");
    const traceB = trace("00000000-0000-4000-8000-000000000093");
    owner.emit(patch(3, 1), traceA);
    owner.emit(patch(4, 0), traceB);
    await settle();
    delivered = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(delivered).toMatchObject({ canonicalRevision: 4, performanceTraceId: traceB.traceId });
    await connection.close();
    await hub.close();
  });

  it("joins trace-null enqueue and settlement by exact delivery identity", async () => {
    const owner = new FakeOwner();
    const spans: SessionRuntimeStageSpan[] = [];
    const observability = createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) });
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
      observability,
    });
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "identity-client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
      {
        clientId: "opentui:42",
        surface: "opentui",
        laneId: "lane-a",
        requestId: "00000000-0000-4000-8000-000000000010",
      },
    );
    owner.emit(seed());
    await settle();
    connection.ack(ack(messages[0] as TerminalDeliveryEnvelope));
    owner.emit(patch(1, 1));
    await settle();
    const envelope = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(terminalDeliveryObservationOrdinal(envelope)).toBeGreaterThan(0);
    connection.ack(ack(envelope));
    const encode = spans.findLast(
      (span) =>
        span.operation === "terminal-delivery-encode-enqueue" &&
        span.terminalDelivery?.canonicalRevision === 1,
    );
    const settled = spans.findLast(
      (span) =>
        span.operation === "terminal-delivery-settled" &&
        span.terminalDelivery?.canonicalRevision === 1,
    );
    expect(encode).toMatchObject({ traceId: null, clockKind: "performance-now" });
    expect(settled).toMatchObject({ traceId: null, clockKind: "performance-now" });
    expect(encode?.terminalDelivery).toMatchObject({
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      canonicalGeneration: generation,
      canonicalIncarnation: `${generation}:0`,
      canonicalRevision: 1,
      canonicalStateHash: envelope.canonicalStateHash,
      transactionId: envelope.transactionId,
      representation: "patch",
      selectionStatus: "patch-preferred",
      deliveryClientId: "opentui:42",
      deliverySurface: "opentui",
      deliveryLaneId: "lane-a",
      deliveryRequestId: "00000000-0000-4000-8000-000000000010",
      deliveryNonce: envelope.deliveryNonce,
    });
    expect(settled?.terminalDelivery).toMatchObject({
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      canonicalGeneration: generation,
      canonicalIncarnation: `${generation}:0`,
      canonicalRevision: 1,
      canonicalStateHash: envelope.canonicalStateHash,
      deliveryOrdinal: encode?.terminalDelivery?.deliveryOrdinal,
      transactionId: envelope.transactionId,
      queueDepth: 0,
      inFlight: 0,
      inFlightBytes: 0,
      deliveryClientId: "opentui:42",
      deliverySurface: "opentui",
      deliveryLaneId: "lane-a",
      deliveryRequestId: "00000000-0000-4000-8000-000000000010",
      deliveryNonce: envelope.deliveryNonce,
    });
    const readyStatus = spans.findLast(
      (span) =>
        span.operation === "terminal-delivery-subscriber-status" &&
        span.terminalDelivery?.canonicalRevision === 1,
    );
    expect(readyStatus?.terminalDelivery).toMatchObject({
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      canonicalGeneration: generation,
      canonicalIncarnation: `${generation}:0`,
      canonicalRevision: 1,
      canonicalStateHash: envelope.canonicalStateHash,
      deliveryClientId: "opentui:42",
      deliverySurface: "opentui",
      deliveryLaneId: "lane-a",
      deliveryRequestId: "00000000-0000-4000-8000-000000000010",
      deliveryPurpose: "terminal-surface",
      deliveryVisibility: "visible",
      deliveryBaselineRevision: 1,
      deliveryBaselineHash: envelope.canonicalStateHash,
      deliveryInFlightRevision: null,
      deliveryInFlightHash: null,
      deliveryLatestRevision: null,
      deliveryClientQueueDepth: 0,
    });
    expect(readyStatus?.terminalDelivery?.deliveryStatusOrdinal).toBeGreaterThan(0);
    expect(
      spans.filter((span) => span.operation === "terminal-delivery-subscriber-lifecycle"),
    ).toEqual([
      expect.objectContaining({
        terminalDelivery: expect.objectContaining({
          deliveryLifecycleEvent: "open",
          deliveryPurpose: "terminal-surface",
          deliveryLifecycleOrdinal: 1,
          deliveryClientId: "opentui:42",
          deliverySurface: "opentui",
          deliveryLaneId: "lane-a",
          deliveryRequestId: "00000000-0000-4000-8000-000000000010",
        }),
      }),
    ]);
    await connection.close();
    expect(
      spans.filter((span) => span.operation === "terminal-delivery-subscriber-lifecycle"),
    ).toEqual([
      expect.objectContaining({
        terminalDelivery: expect.objectContaining({ deliveryLifecycleEvent: "open" }),
      }),
      expect.objectContaining({
        terminalDelivery: expect.objectContaining({
          deliveryLifecycleEvent: "close",
          deliveryLifecycleOrdinal: 2,
        }),
      }),
    ]);
    await hub.close();
  });

  it("delivers and ACKs the smaller exact large representation through adjacent updates", async () => {
    const owner = new FakeOwner();
    const spans: SessionRuntimeStageSpan[] = [];
    const observability = createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) });
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
      observability,
    });
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "large-client",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-v1"], richPlacements: false },
      (message) => messages.push(message),
    );
    const initial = seed();
    if (initial.type !== "terminal.seed") throw new Error("test seed unavailable");
    owner.emit(initial);
    await settle();
    connection.ack(ack(messages[0] as TerminalDeliveryEnvelope));
    const append = (base: TerminalReplicaSnapshot, revision: number, graphemeBytes: number) => {
      const row = {
        wrapped: false,
        cells: [
          { ...base.grid[0]!.cells[0]!, grapheme: "x".repeat(graphemeBytes) },
          base.grid[0]!.cells[1]!,
        ],
      };
      const snapshot = { ...base, history: [...base.history, row] };
      return {
        snapshot,
        update: {
          type: "terminal.patch" as const,
          workspaceName: "workspace",
          semanticPaneId: "pane-a",
          generation,
          incarnation: `${generation}:0`,
          baseRevision: revision - 1,
          revision,
          cols: snapshot.cols,
          rows: snapshot.rows,
          stateHash: hashTerminalReplicaSnapshot(snapshot),
          hashAlgorithm: "fnv1a64-v1" as const,
          patch: { rows: [], historyDelta: { trim: 0, append: [row] } },
        },
      };
    };
    const first = append(initial.snapshot, 1, 14 * 1024 * 1024);
    owner.emit(first.update);
    await settle();
    const firstEnvelope = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(firstEnvelope).toMatchObject({ frame: "patch", canonicalRevision: 1 });
    const second = append(first.snapshot, 2, 3 * 1024 * 1024);
    owner.emit(second.update);
    await settle();
    expect(messages.filter((message) => message.type === "terminal.delivery").at(-1)).toBe(
      firstEnvelope,
    );
    connection.ack(ack(firstEnvelope));
    await settle();
    const secondEnvelope = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(secondEnvelope).toMatchObject({ frame: "patch", canonicalRevision: 2 });
    expect(secondEnvelope.representationBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(messages.some((message) => message.type === "terminal.delivery.fault")).toBe(false);
    connection.ack(ack(secondEnvelope));
    expect(hub.metrics()).toMatchObject({ reseeds: 1, inFlight: 0, queueDepth: 0 });
    expect(
      spans.findLast(
        (span) =>
          span.operation === "terminal-delivery-encode-enqueue" &&
          span.terminalDelivery?.canonicalRevision === 2,
      )?.terminalDelivery,
    ).toMatchObject({
      representation: "patch",
      selectionStatus: "patch-fallback",
      canonicalStateHash: second.update.stateHash,
    });
    const impossible = append(second.snapshot, 3, 17 * 1024 * 1024);
    owner.emit(impossible.update);
    await settle();
    expect(
      messages.findLast((message) => message.type === "terminal.delivery.fault"),
    ).toMatchObject({ reason: "state-too-large" });
    expect(spans.findLast((span) => span.operation === "terminal-delivery-fault")).toMatchObject({
      terminalDelivery: {
        workspaceName: "workspace",
        semanticPaneId: "pane-a",
        faultReason: "state-too-large",
      },
    });
    await connection.close();
    await hub.close();
  }, 60_000);

  it("delivers a compact 5000-row state through the real hub, coalesces exactly, and reseeds reconnects", async () => {
    const owner = new FakeOwner();
    const spans: SessionRuntimeStageSpan[] = [];
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
      observability: createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) }),
    });
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "compact-client",
      "pane-a",
      {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1", "semantic-v1"],
        richPlacements: false,
      },
      (message) => messages.push(message),
    );
    expect(connection.negotiation).toMatchObject({
      accepted: true,
      negotiated: { encoding: "semantic-compact-v1" },
    });
    if (!connection.negotiation.accepted) throw new Error("compact negotiation rejected");
    let clientState = createTerminalDeliveryClientState(
      connection.negotiation.negotiated,
      "workspace",
      "pane-a",
    );
    const blank = blankTerminalReplicaSnapshot(132, 40);
    const historyRow = blank.grid[0]!;
    const snapshots = [{ ...blank, history: Array.from({ length: 5_000 }, () => historyRow) }];
    const canonicalUpdate = (
      revision: number,
      snapshot: TerminalReplicaSnapshot,
    ): CanonicalTerminalReplicaUpdate =>
      revision === 0
        ? {
            type: "terminal.seed",
            workspaceName: "workspace",
            semanticPaneId: "pane-a",
            generation,
            incarnation: `${generation}:0`,
            revision,
            cols: snapshot.cols,
            rows: snapshot.rows,
            stateHash: hashTerminalReplicaSnapshot(snapshot),
            hashAlgorithm: "fnv1a64-v1",
            snapshot,
          }
        : {
            type: "terminal.patch",
            workspaceName: "workspace",
            semanticPaneId: "pane-a",
            generation,
            incarnation: `${generation}:0`,
            baseRevision: revision - 1,
            revision,
            cols: snapshot.cols,
            rows: snapshot.rows,
            stateHash: hashTerminalReplicaSnapshot(snapshot),
            hashAlgorithm: "fnv1a64-v1",
            patch: { rows: [], cursor: snapshot.cursor },
          };

    owner.emit(canonicalUpdate(0, snapshots[0]!));
    await settle();
    const first = messages.find(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(first).toMatchObject({
      encoding: "semantic-compact-v1",
      frame: "seed",
      canonicalRevision: 0,
    });
    expect(first.representationBytes).toBeLessThan(16 * 1024 * 1024);
    expect(
      spans.findLast(
        (span) =>
          span.operation === "terminal-delivery-encode-enqueue" &&
          span.terminalDelivery?.canonicalRevision === 0,
      )?.terminalDelivery,
    ).toMatchObject({
      selectedEncoding: "semantic-compact-v1",
      selectionStatus: "direct-seed",
      attemptedPatchBytes: null,
      attemptedCompactPatchBytes: null,
      attemptedCompactSeedBytes: first.representationBytes,
    });
    expect(
      spans.findLast(
        (span) =>
          span.operation === "terminal-delivery-encode-enqueue" &&
          span.terminalDelivery?.canonicalRevision === 0,
      )?.terminalDelivery?.attemptedLegacySeedBytes,
    ).toBeNull();
    expect(decodeCompactSemanticTerminalUpdate(assembledBytes(first, messages))).toEqual({
      frame: "seed",
      revision: 0,
      snapshot: snapshots[0],
    });
    const firstCommit = commitMessages(clientState, first, messages);
    clientState = firstCommit.state;

    for (let revision = 1; revision <= 2; revision += 1) {
      const prior = snapshots.at(-1)!;
      const next = { ...prior, cursor: { ...prior.cursor, x: revision } };
      snapshots.push(next);
      owner.emit(canonicalUpdate(revision, next));
    }
    await settle();
    connection.ack(firstCommit.ack);
    await settle();
    const coalesced = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(coalesced).toMatchObject({ frame: "seed", canonicalRevision: 2 });
    expect(decodeCompactSemanticTerminalUpdate(assembledBytes(coalesced, messages))).toMatchObject({
      frame: "seed",
      revision: 2,
      snapshot: snapshots[2],
    });
    const coalescedCommit = commitMessages(clientState, coalesced, messages);
    clientState = coalescedCommit.state;
    connection.ack(coalescedCommit.ack);

    const next = { ...snapshots[2]!, cursor: { ...snapshots[2]!.cursor, x: 3 } };
    snapshots.push(next);
    owner.emit(canonicalUpdate(3, next));
    await settle();
    const adjacent = messages.findLast(
      (message) => message.type === "terminal.delivery",
    ) as TerminalDeliveryEnvelope;
    expect(adjacent).toMatchObject({ frame: "patch", canonicalRevision: 3 });
    const adjacentCommit = commitMessages(clientState, adjacent, messages);
    clientState = adjacentCommit.state;
    expect(clientState.canonicalSnapshot).toEqual(snapshots[3]);
    connection.ack(adjacentCommit.ack);
    expect(hub.metrics()).toMatchObject({ inFlight: 0, queueDepth: 0 });
    expect(messages.some((message) => message.type === "terminal.delivery.fault")).toBe(false);

    const reconnectMessages: TerminalDeliveryServerMessage[] = [];
    const reconnect = await hub.open(
      "compact-reconnect",
      "pane-a",
      {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1", "semantic-v1"],
        richPlacements: false,
      },
      (message) => reconnectMessages.push(message),
    );
    await settle();
    const reseed = reconnectMessages[0] as TerminalDeliveryEnvelope;
    expect(reseed).toMatchObject({ frame: "seed", canonicalRevision: 3 });
    expect(decodeCompactSemanticTerminalUpdate(assembledBytes(reseed, reconnectMessages))).toEqual({
      frame: "seed",
      revision: 3,
      snapshot: snapshots[3],
    });
    if (!reconnect.negotiation.accepted) throw new Error("compact reconnect negotiation rejected");
    const reconnectCommit = commitMessages(
      createTerminalDeliveryClientState(reconnect.negotiation.negotiated, "workspace", "pane-a"),
      reseed,
      reconnectMessages,
    );
    expect(reconnectCommit.state.canonicalSnapshot).toEqual(snapshots[3]);
    reconnect.ack(reconnectCommit.ack);
    await Promise.all([connection.close(), reconnect.close()]);
    await hub.close();
  }, 60_000);

  it("faults only when the compact and legacy exact seeds are both unrepresentable", async () => {
    const owner = new FakeOwner();
    const spans: SessionRuntimeStageSpan[] = [];
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
      observability: createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) }),
    });
    const messages: TerminalDeliveryServerMessage[] = [];
    await hub.open(
      "compact-impossible",
      "pane-a",
      {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1", "semantic-v1"],
        richPlacements: false,
      },
      (message) => messages.push(message),
    );
    const blank = blankTerminalReplicaSnapshot(132, 40);
    const longA = "a".repeat(1_500);
    const longB = "b".repeat(1_500);
    const row = {
      wrapped: false,
      cells: Array.from({ length: 132 }, (_, index) => ({
        ...blank.grid[0]!.cells[0]!,
        grapheme: index % 2 === 0 ? longA : longB,
      })),
    };
    const snapshot = {
      ...blank,
      grid: Array.from({ length: 40 }, () => row),
      history: Array.from({ length: 60 }, () => row),
    };
    owner.emit({
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      revision: 0,
      cols: snapshot.cols,
      rows: snapshot.rows,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
      snapshot,
    });
    await settle();
    expect(
      messages.findLast((message) => message.type === "terminal.delivery.fault"),
    ).toMatchObject({ reason: "state-too-large" });
    const failure = spans.findLast((span) => span.operation === "terminal-delivery-fault");
    expect(failure?.terminalDelivery).toMatchObject({
      faultReason: "state-too-large",
      selectedEncoding: "semantic-compact-v1",
      selectionStatus: "direct-seed",
      attemptedLegacyPatchBytes: null,
      attemptedCompactPatchBytes: null,
    });
    expect(failure?.terminalDelivery).toMatchObject({
      attemptedLegacySeedBytes: null,
      attemptedLegacySeedAtLeastBytes: 16 * 1024 * 1024 + 1,
      attemptedLegacySeedSizeCapped: true,
    });
    expect(failure?.terminalDelivery?.attemptedCompactSeedBytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(
      spans.findLast((span) => span.operation === "terminal-delivery-encode-enqueue")
        ?.terminalDelivery,
    ).toMatchObject({
      selectedEncoding: "semantic-compact-v1",
      selectionStatus: "direct-seed",
    });
    await hub.close();
  }, 60_000);

  it("falls back per envelope when compact structure rejects an exact legacy-representable seed", async () => {
    const owner = new FakeOwner();
    const spans: SessionRuntimeStageSpan[] = [];
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner, {
      observability: createSessionRuntimeObservability({ onSpan: (span) => spans.push(span) }),
    });
    const messages: TerminalDeliveryServerMessage[] = [];
    const connection = await hub.open(
      "compact-legacy-fallback",
      "pane-a",
      {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1", "semantic-v1"],
        richPlacements: false,
      },
      (message) => messages.push(message),
    );
    if (!connection.negotiation.accepted) throw new Error("fallback negotiation rejected");
    expect(connection.negotiation.negotiated).toMatchObject({
      encoding: "semantic-compact-v1",
      fallbackEncoding: "semantic-v1",
    });
    const compactOnlyMessages: TerminalDeliveryServerMessage[] = [];
    const compactOnly = await hub.open(
      "compact-only",
      "pane-a",
      {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1"],
        richPlacements: false,
      },
      (message) => compactOnlyMessages.push(message),
    );
    const blank = blankTerminalReplicaSnapshot(1, 1);
    const placement = {
      id: "i",
      kind: "k",
      row: 0,
      column: 0,
      columns: 1,
      rows: 1,
      contentDigest: "d",
    };
    const snapshot = {
      ...blank,
      placements: Array.from({ length: 170_000 }, () => placement),
    };
    owner.emit({
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      revision: 0,
      cols: 1,
      rows: 1,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
      snapshot,
    });
    await settle();
    const envelope = messages[0] as TerminalDeliveryEnvelope;
    expect(envelope).toMatchObject({ encoding: "semantic-v1", frame: "seed" });
    const committed = commitMessages(
      createTerminalDeliveryClientState(connection.negotiation.negotiated, "workspace", "pane-a"),
      envelope,
      messages,
    );
    expect(committed.state.canonicalSnapshot).toEqual(snapshot);
    connection.ack(committed.ack);
    expect(messages.some((message) => message.type === "terminal.delivery.fault")).toBe(false);
    expect(compactOnlyMessages).toContainEqual(
      expect.objectContaining({ type: "terminal.delivery.fault", reason: "state-too-large" }),
    );
    expect(
      compactOnlyMessages.some(
        (message) => message.type === "terminal.delivery" && message.encoding === "semantic-v1",
      ),
    ).toBe(false);
    await compactOnly.close();
    expect(
      spans.findLast(
        (span) =>
          span.operation === "terminal-delivery-encode-enqueue" &&
          span.terminalDelivery?.selectedEncoding === "semantic-v1",
      )?.terminalDelivery,
    ).toMatchObject({
      selectedEncoding: "semantic-v1",
      selectionStatus: "legacy-seed-fallback",
      attemptedCompactPatchBytes: null,
      attemptedLegacyPatchBytes: null,
    });
    await connection.close();
    await hub.close();
  }, 60_000);

  it("does not let a compact-only cache entry suppress a later client's negotiated fallback", async () => {
    const owner = new FakeOwner();
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
    const compactMessages: TerminalDeliveryServerMessage[] = [];
    const fallbackMessages: TerminalDeliveryServerMessage[] = [];
    const compact = await hub.open(
      "compact-first",
      "pane-a",
      { protocolVersions: [1], encodings: ["semantic-compact-v1"], richPlacements: false },
      (message) => compactMessages.push(message),
    );
    const fallback = await hub.open(
      "fallback-second",
      "pane-a",
      {
        protocolVersions: [1],
        encodings: ["semantic-compact-v1", "semantic-v1"],
        richPlacements: false,
      },
      (message) => fallbackMessages.push(message),
    );
    const blank = blankTerminalReplicaSnapshot(2, 1);
    const snapshot = {
      ...blank,
      grid: [
        {
          ...blank.grid[0]!,
          cells: [
            { ...blank.grid[0]!.cells[0]!, grapheme: "x".repeat(4_097) },
            blank.grid[0]!.cells[1]!,
          ],
        },
      ],
    };
    owner.emit({
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      revision: 0,
      cols: 2,
      rows: 1,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
      snapshot,
    });
    await settle();
    expect(compactMessages).toContainEqual(
      expect.objectContaining({ type: "terminal.delivery.fault", reason: "state-too-large" }),
    );
    expect(fallbackMessages[0]).toMatchObject({
      type: "terminal.delivery",
      encoding: "semantic-v1",
    });
    await compact.close();
    await fallback.close();
    await hub.close();
  });
});
