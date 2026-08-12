import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalDeliveryServerMessage,
} from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
} from "@tmux-ide/core";
import {
  SessionRuntimeTerminalDeliveryHub,
  type TerminalDeliverySourceOwner,
} from "./terminal-delivery-hub.ts";

const generation = "00000000-0000-4000-8000-000000000001";

class FakeOwner implements TerminalDeliverySourceOwner {
  listener: ((update: CanonicalTerminalReplicaUpdate) => void) | null = null;
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
    listener: (update: CanonicalTerminalReplicaUpdate) => void,
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
  emit(update: CanonicalTerminalReplicaUpdate): void {
    this.listener?.(update);
  }
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

describe("SessionRuntimeTerminalDeliveryHub", () => {
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
    const hub = new SessionRuntimeTerminalDeliveryHub(generation, "workspace", () => owner);
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
    expect(hub.metrics().latestPointers).toBe(1);
    await connection.close();
    await hub.close();
  });
});
