import { describe, expect, it } from "bun:test";
import type {
  CanonicalTerminalReplicaPatch,
  CanonicalTerminalReplicaSeed,
  CanonicalTerminalReplicaUpdate,
  SessionRuntimeAuthorityKind,
  SessionRuntimeTerminalInput,
  TerminalReplicaDeliveryMetadata,
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "@tmux-ide/core";

import {
  createTerminalFastLane,
  createWorkspaceClientTerminalSource,
  type TerminalFastLaneControlPort,
  type TerminalFastLaneGenerationAddress,
  type TerminalFastLanePaneAddress,
  type TerminalFastLaneSourcePort,
  type TerminalFastLaneViewport,
} from "./terminal-fast-lane.ts";

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "workspace";

function address(generation = GENERATION_A): TerminalFastLaneGenerationAddress {
  return { workspaceName: WORKSPACE, generation };
}

function seed(
  snapshot: TerminalReplicaSnapshot,
  revision = 0,
  generation = GENERATION_A,
  semanticPaneId = "pane-a",
  incarnation = `${generation}:0`,
): CanonicalTerminalReplicaSeed {
  return {
    type: "terminal.seed",
    workspaceName: WORKSPACE,
    semanticPaneId,
    generation,
    incarnation,
    revision,
    cols: snapshot.cols,
    rows: snapshot.rows,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
    snapshot,
  };
}

function patch(
  current: TerminalReplicaSnapshot,
  payload: TerminalReplicaPatchPayload,
  revision: number,
  generation = GENERATION_A,
  semanticPaneId = "pane-a",
  incarnation = `${generation}:0`,
): CanonicalTerminalReplicaPatch {
  const next = applyTerminalReplicaPatch(current, payload);
  return {
    type: "terminal.patch",
    workspaceName: WORKSPACE,
    semanticPaneId,
    generation,
    incarnation,
    baseRevision: revision - 1,
    revision,
    cols: next.cols,
    rows: next.rows,
    stateHash: hashTerminalReplicaSnapshot(next),
    hashAlgorithm: "fnv1a64-v1",
    patch: payload,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class FakeSource implements TerminalFastLaneSourcePort {
  readonly listeners = new Map<
    string,
    Set<
      (update: CanonicalTerminalReplicaUpdate, metadata?: TerminalReplicaDeliveryMetadata) => void
    >
  >();
  subscribe(
    pane: TerminalFastLanePaneAddress,
    listener: (update: CanonicalTerminalReplicaUpdate) => void,
  ): () => void {
    const key = `${pane.generation}:${pane.semanticPaneId}`;
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => listeners.delete(listener);
  }
  emit(
    update: CanonicalTerminalReplicaUpdate,
    generation = update.generation,
    pane = update.semanticPaneId,
    metadata?: TerminalReplicaDeliveryMetadata,
  ): void {
    for (const listener of [...(this.listeners.get(`${generation}:${pane}`) ?? [])])
      listener(update, metadata);
  }
  capture(generation: string, pane: string): (update: CanonicalTerminalReplicaUpdate) => void {
    return [...(this.listeners.get(`${generation}:${pane}`) ?? [])][0]!;
  }
}

class FakeControl implements TerminalFastLaneControlPort {
  readonly owned = new Set<SessionRuntimeAuthorityKind>();
  readonly writes: Array<{
    address: TerminalFastLanePaneAddress;
    input: SessionRuntimeTerminalInput;
    performanceTraceId?: string;
  }> = [];
  readonly resizes: Array<{
    address: TerminalFastLaneGenerationAddress;
    viewport: TerminalFastLaneViewport;
  }> = [];
  readonly requests: SessionRuntimeAuthorityKind[] = [];
  requestResult = true;
  writeResult: "ok" | "authority-lost" = "ok";
  writeResults: Array<"ok" | "authority-lost"> = [];
  resizeResult: "ok" | "authority-lost" = "ok";
  writeGate: Promise<void> | null = null;
  writeGates: Promise<void>[] = [];
  resizeGates: Promise<void>[] = [];

  owns(authority: SessionRuntimeAuthorityKind): boolean {
    return this.owned.has(authority);
  }
  async request(authority: SessionRuntimeAuthorityKind): Promise<boolean> {
    this.requests.push(authority);
    if (this.requestResult) this.owned.add(authority);
    return this.requestResult;
  }
  async write(
    address: TerminalFastLanePaneAddress,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
  ) {
    const result = this.writeResults.shift() ?? this.writeResult;
    this.writes.push({
      address,
      input: { ...input },
      ...(performanceTraceId ? { performanceTraceId } : {}),
    });
    const gate = this.writeGates.shift() ?? this.writeGate;
    if (gate) await gate;
    return result;
  }
  async resize(address: TerminalFastLaneGenerationAddress, viewport: TerminalFastLaneViewport) {
    const gate = this.resizeGates.shift();
    this.resizes.push({ address, viewport });
    if (gate) await gate;
    return this.resizeResult;
  }
}

function rig(
  overrides: {
    maxPendingInputs?: number;
    maxPendingInputBytes?: number;
    maxInFlightInputs?: number;
  } = {},
) {
  const source = new FakeSource();
  const control = new FakeControl();
  const repairs: unknown[] = [];
  const lane = createTerminalFastLane({
    address: address(),
    source,
    control,
    repair: { request: (request) => repairs.push(request) },
    ...overrides,
  });
  return { lane, source, control, repairs };
}

describe("terminal fast lane", () => {
  it("separates slow or throwing observers from exact canonical apply timing", () => {
    const source = new FakeSource();
    const control = new FakeControl();
    let nowMicros = 1_000;
    const stages: Array<{
      operation: string;
      atMicros: number;
      semanticPaneId?: string;
      generation?: string;
      incarnation?: string;
      revision?: number;
      stateHash?: string;
    }> = [];
    const lane = createTerminalFastLane({
      address: address(),
      source,
      control,
      repair: { request: () => undefined },
      diagnosticNowMicros: () => nowMicros,
      onTraceStage: (stage) => {
        stages.push(stage);
        if (stage.operation === "delivery-received") nowMicros += 40_000;
        if (stage.operation === "canonical-apply-begin") throw new Error("observer failed");
      },
    });
    const snapshot = blankTerminalReplicaSnapshot(132, 41);
    let publications = 0;
    lane.subscribePane("pane-a", () => (publications += 1));
    source.emit(seed(snapshot, 0));
    const changedRow = {
      ...snapshot.grid[0]!,
      cells: [
        { ...snapshot.grid[0]!.cells[0]!, grapheme: "x" },
        ...snapshot.grid[0]!.cells.slice(1),
      ],
    };
    const update = patch(snapshot, { rows: [{ index: 0, row: changedRow }] }, 1);

    expect(() =>
      source.emit(update, update.generation, update.semanticPaneId, {
        performanceTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).not.toThrow();
    expect(publications).toBe(2);
    expect(stages.map(({ operation }) => operation)).toEqual([
      "delivery-received",
      "delivery-observer-returned",
      "canonical-apply-begin",
      "canonical-apply-end",
      "lane-published",
    ]);
    expect(stages.find(({ operation }) => operation === "delivery-received")?.atMicros).toBe(1_000);
    expect(
      stages.find(({ operation }) => operation === "delivery-observer-returned")?.atMicros,
    ).toBe(41_000);
    expect(stages.find(({ operation }) => operation === "canonical-apply-begin")?.atMicros).toBe(
      41_000,
    );
    expect(stages.find(({ operation }) => operation === "canonical-apply-end")?.atMicros).toBe(
      41_000,
    );
    for (const stage of stages) {
      expect(stage).toMatchObject({
        semanticPaneId: "pane-a",
        generation: GENERATION_A,
        incarnation: `${GENERATION_A}:0`,
        revision: 1,
        stateHash: update.stateHash,
      });
    }
  });

  it("does no diagnostic clock work when canonical tracing is disabled", () => {
    const source = new FakeSource();
    const lane = createTerminalFastLane({
      address: address(),
      source,
      control: new FakeControl(),
      repair: { request: () => undefined },
      diagnosticNowMicros: () => {
        throw new Error("disabled clock must not run");
      },
    });
    lane.subscribePane("pane-a", () => undefined);
    const update = seed(blankTerminalReplicaSnapshot(2, 1));
    expect(() =>
      source.emit(update, update.generation, update.semanticPaneId, {
        performanceTraceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).not.toThrow();
    expect(lane.paneState("pane-a")?.revision).toBe(0);
  });

  it("keeps canonical apply live when the enabled diagnostic clock throws", () => {
    const source = new FakeSource();
    const lane = createTerminalFastLane({
      address: address(),
      source,
      control: new FakeControl(),
      repair: { request: () => undefined },
      onTraceStage: () => undefined,
      diagnosticNowMicros: () => {
        throw new Error("diagnostic clock failed");
      },
    });
    lane.subscribePane("pane-a", () => undefined);
    const update = seed(blankTerminalReplicaSnapshot(2, 1));
    expect(() =>
      source.emit(update, update.generation, update.semanticPaneId, {
        performanceTraceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    ).not.toThrow();
    expect(lane.paneState("pane-a")?.revision).toBe(0);
  });

  it("publishes ordered pane-local state once and coalesces repair until a valid seed", () => {
    const { lane, source, repairs } = rig();
    const snapshot = blankTerminalReplicaSnapshot(4, 2);
    const publications: number[] = [];
    let isolatedListenerCalls = 0;
    lane.subscribePane("pane-a", (publication) => publications.push(publication.state.revision));
    lane.subscribePane("pane-a", () => {
      isolatedListenerCalls += 1;
      throw new Error("observer failure");
    });
    let siblingCalls = 0;
    lane.subscribePane("pane-b", () => (siblingCalls += 1));

    const initial = seed(snapshot);
    source.emit(initial);
    source.emit(initial);
    source.emit(patch(snapshot, { rows: [] }, 2));
    source.emit(patch(snapshot, { rows: [] }, 3));
    source.emit(
      { ...patch(snapshot, { rows: [] }, 1), semanticPaneId: "pane-b" },
      GENERATION_A,
      "pane-a",
    );
    expect(publications).toEqual([0]);
    expect(isolatedListenerCalls).toBe(1);
    expect(siblingCalls).toBe(0);
    expect(repairs).toHaveLength(1);

    source.emit(seed(snapshot, 2, GENERATION_A, "pane-a", `${GENERATION_A}:1`));
    source.emit(patch(snapshot, { rows: [] }, 4, GENERATION_A, "pane-a", `${GENERATION_A}:1`));
    expect(publications).toEqual([0, 2]);
    expect(repairs).toHaveLength(2);
    expect(lane.counters()).toMatchObject({
      published: 2,
      duplicateOrStale: 1,
      repairs: 2,
    });
  });

  it("routes 10k updates to exactly one pane and never asks for semantic publication", () => {
    const listeners = new Map<string, (update: CanonicalTerminalReplicaUpdate) => void>();
    let semanticCallbacks = 0;
    const client = {
      subscribe: () => {
        semanticCallbacks += 1;
        return () => undefined;
      },
      subscribeTerminal: (
        target: { workspaceName: string; semanticPaneId: string },
        listener: (update: CanonicalTerminalReplicaUpdate) => void,
      ) => {
        listeners.set(target.semanticPaneId, listener);
        return () => listeners.delete(target.semanticPaneId);
      },
    };
    const control = new FakeControl();
    const lane = createTerminalFastLane({
      address: address(),
      source: createWorkspaceClientTerminalSource(client),
      control,
      repair: { request: () => undefined },
    });
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    let addressed = 0;
    let sibling = 0;
    lane.subscribePane("pane-a", () => (addressed += 1));
    lane.subscribePane("pane-b", () => (sibling += 1));
    listeners.get("pane-a")!(seed(snapshot));
    for (let revision = 1; revision < 10_000; revision += 1) {
      listeners.get("pane-a")!(patch(snapshot, { rows: [] }, revision));
    }
    expect(addressed).toBe(10_000);
    expect(sibling).toBe(0);
    expect(semanticCallbacks).toBe(0);
    expect(lane.counters()).toMatchObject({ accepted: 10_000, published: 10_000 });
  });

  it("preserves text/key order with one authority request and UTF-8-bounded overflow", async () => {
    const { lane, control } = rig({ maxPendingInputs: 3, maxPendingInputBytes: 10 });
    const authority = deferred<boolean>();
    control.request = async (kind) => {
      control.requests.push(kind);
      const granted = await authority.promise;
      if (granted) control.owned.add(kind);
      return granted;
    };
    const first = lane.sendInput("pane-a", { kind: "text", data: "é" });
    const second = lane.sendInput("pane-a", { kind: "key", data: "Enter" });
    const third = lane.sendInput("pane-b", { kind: "text", data: "界" });
    const overflow = await lane.sendInput("pane-b", { kind: "key", data: "Up" });
    expect(overflow).toEqual({ status: "rejected", reason: "queue-full" });
    expect(control.requests).toEqual(["input"]);

    authority.resolve(true);
    await settle();
    expect(await Promise.all([first, second, third])).toEqual([
      { status: "sent" },
      { status: "sent" },
      { status: "sent" },
    ]);
    expect(control.writes.map((write) => write.input)).toEqual([
      { kind: "text", data: "é" },
      { kind: "key", data: "Enter" },
      { kind: "text", data: "界" },
    ]);
    expect(lane.counters()).toMatchObject({
      inputAccepted: 3,
      inputRejected: 1,
      inputWrites: 3,
      authorityRequests: 1,
    });
  });

  it("forwards trace identity only for accepted ordered input and fences retired work", async () => {
    const { lane, control } = rig({ maxPendingInputs: 2 });
    const authority = deferred<boolean>();
    control.request = async (kind) => {
      control.requests.push(kind);
      const granted = await authority.promise;
      if (granted) control.owned.add(kind);
      return granted;
    };
    const traceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const traceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const traceRejected = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const first = lane.sendInput("pane-a", { kind: "text", data: "a" }, traceA);
    const second = lane.sendInput("pane-a", { kind: "text", data: "b" }, traceB);
    expect(await lane.sendInput("pane-a", { kind: "text", data: "c" }, traceRejected)).toEqual({
      status: "rejected",
      reason: "queue-full",
    });
    authority.resolve(true);
    expect(await Promise.all([first, second])).toEqual([{ status: "sent" }, { status: "sent" }]);
    expect(control.writes.map(({ performanceTraceId }) => performanceTraceId)).toEqual([
      traceA,
      traceB,
    ]);

    const gate = deferred<boolean>();
    control.owned.delete("input");
    control.request = async () => await gate.promise;
    const retired = lane.sendInput(
      "pane-a",
      { kind: "text", data: "old" },
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    );
    lane.replaceGeneration(address(GENERATION_B));
    expect(await retired).toEqual({ status: "rejected", reason: "retired" });
    gate.resolve(true);
    await settle();
    expect(control.writes).toHaveLength(2);
  });

  it("reports settled queue bytes on the final transport acknowledgement", async () => {
    const source = new FakeSource();
    const control = new FakeControl();
    control.owned.add("input");
    const stages: Array<{
      operation: string;
      inputPending: number;
      inputInFlight: number;
      inputPendingBytes: number;
    }> = [];
    const lane = createTerminalFastLane({
      address: address(),
      source,
      control,
      repair: { request: () => undefined },
      onTraceStage: (stage) => stages.push(stage),
    });

    await expect(
      lane.sendInput(
        "pane-a",
        { kind: "key", data: "Enter" },
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ),
    ).resolves.toEqual({ status: "sent" });
    expect(stages.at(-1)).toMatchObject({
      operation: "transport-ack",
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
    });
    expect(lane.counters()).toMatchObject({
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
    });
  });

  it("dispatches a bounded FIFO window without waiting for each acknowledgement", async () => {
    const { lane, control } = rig({ maxInFlightInputs: 2 });
    control.owned.add("input");
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    control.writeGates.push(firstGate.promise, secondGate.promise, Promise.resolve());
    const first = lane.sendInput("pane-a", { kind: "text", data: "a" });
    const second = lane.sendInput("pane-a", { kind: "text", data: "b" });
    const third = lane.sendInput("pane-a", { kind: "text", data: "c" });
    await settle();
    expect(control.writes.map(({ input }) => input.data)).toEqual(["a", "b"]);

    secondGate.resolve();
    await settle();
    expect(await second).toEqual({ status: "sent" });
    expect(control.writes.map(({ input }) => input.data)).toEqual(["a", "b", "c"]);
    expect(await third).toEqual({ status: "sent" });
    firstGate.resolve();
    expect(await first).toEqual({ status: "sent" });
    expect(lane.counters()).toMatchObject({ inputAccepted: 3, inputWrites: 3 });
  });

  it("retires an out-of-order authority loss exactly once and releases every queue byte", async () => {
    const { lane, control } = rig({
      maxPendingInputs: 3,
      maxPendingInputBytes: 3,
      maxInFlightInputs: 3,
    });
    control.owned.add("input");
    const firstGate = deferred<void>();
    const lostGate = deferred<void>();
    const thirdGate = deferred<void>();
    control.writeGates.push(firstGate.promise, lostGate.promise, thirdGate.promise);
    control.writeResults.push("ok", "authority-lost", "ok");
    const first = lane.sendInput("pane-a", { kind: "text", data: "a" });
    const lost = lane.sendInput("pane-a", { kind: "text", data: "b" });
    const third = lane.sendInput("pane-a", { kind: "text", data: "c" });
    await settle();
    expect(control.writes.map(({ input }) => input.data)).toEqual(["a", "b", "c"]);

    lostGate.resolve();
    await expect(lost).resolves.toEqual({ status: "rejected", reason: "authority-lost" });
    await expect(first).resolves.toEqual({ status: "rejected", reason: "authority-lost" });
    await expect(third).resolves.toEqual({ status: "rejected", reason: "authority-lost" });
    expect(lane.counters()).toMatchObject({
      inputRejected: 3,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
    });

    firstGate.resolve();
    thirdGate.resolve();
    await settle();
    expect(lane.counters()).toMatchObject({ inputRejected: 3, inputWrites: 0 });
    control.owned.delete("input");
    control.writeGates.length = 0;
    control.writeResults.length = 0;
    expect(await lane.sendInput("pane-a", { kind: "text", data: "z" })).toEqual({
      status: "sent",
    });
    expect(lane.counters().inputPendingBytes).toBe(0);
  });

  it("fences late authority grants and write acknowledgements on generation replacement", async () => {
    const { lane, control } = rig();
    const authority = deferred<boolean>();
    control.request = async (kind) => {
      control.requests.push(kind);
      return await authority.promise;
    };
    const pendingGrant = lane.sendInput("pane-a", { kind: "key", data: "a" });
    lane.replaceGeneration(address(GENERATION_B));
    expect(await pendingGrant).toEqual({ status: "rejected", reason: "retired" });
    control.request = async (kind) => {
      control.requests.push(kind);
      control.owned.add(kind);
      return true;
    };
    const replacement = lane.sendInput("pane-a", { kind: "key", data: "b" });
    await settle();
    expect(await replacement).toEqual({ status: "sent" });
    expect(control.writes.map(({ input }) => input)).toEqual([{ kind: "key", data: "b" }]);
    authority.resolve(true);
    await settle();
    expect(control.writes).toHaveLength(1);

    control.owned.add("input");
    const write = deferred<void>();
    control.writeGate = write.promise;
    const pendingAck = lane.sendInput("pane-a", { kind: "key", data: "c" });
    await settle();
    lane.dispose();
    expect(await pendingAck).toEqual({ status: "rejected", reason: "disposed" });
    write.resolve();
    await settle();
    expect(lane.counters().inputWrites).toBe(1);
  });

  it("coalesces a resize burst to first+latest and never drops final size", async () => {
    const { lane, control } = rig();
    control.owned.add("geometry");
    const firstGate = deferred<void>();
    control.resizeGates.push(firstGate.promise, Promise.resolve());
    const first = lane.resize({ cols: 80, rows: 24 });
    const middle = lane.resize({ cols: 90, rows: 30 });
    const latest = lane.resize({ cols: 120, rows: 40 });
    expect(await middle).toEqual({ status: "superseded" });
    expect(control.resizes.map(({ viewport }) => viewport)).toEqual([{ cols: 80, rows: 24 }]);
    firstGate.resolve();
    await settle();
    expect(await first).toEqual({ status: "applied" });
    expect(await latest).toEqual({ status: "applied" });
    expect(control.resizes.map(({ viewport }) => viewport)).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 40 },
    ]);
    expect(lane.counters()).toMatchObject({
      resizeAccepted: 3,
      resizeTransports: 2,
      resizeSuperseded: 1,
    });
  });

  it("fences an old pane subscription and accepts a fresh generation seed", () => {
    const { lane, source } = rig();
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const revisions: string[] = [];
    lane.subscribePane("pane-a", (publication) =>
      revisions.push(`${publication.state.generation}:${publication.state.revision}`),
    );
    const oldListener = source.capture(GENERATION_A, "pane-a");
    source.emit(seed(snapshot));
    lane.replaceGeneration(address(GENERATION_B));
    oldListener(seed(snapshot, 1));
    source.emit(seed(snapshot, 0, GENERATION_B));
    expect(revisions).toEqual([`${GENERATION_A}:0`, `${GENERATION_B}:0`]);
  });

  it("retains canonical seed and patches while a pane has no renderer observer", () => {
    const { lane, source } = rig();
    const initial = blankTerminalReplicaSnapshot(2, 1);
    const stop = lane.subscribePane("pane-a", () => undefined);
    source.emit(seed(initial));
    stop();

    const changedRow = {
      ...initial.grid[0]!,
      cells: initial.grid[0]!.cells.map((cell, index) =>
        index === 0 ? { ...cell, grapheme: "R" } : cell,
      ),
    };
    source.emit(patch(initial, { rows: [{ index: 0, row: changedRow }] }, 1));

    const retained = lane.paneState("pane-a");
    expect(retained?.generation).toBe(GENERATION_A);
    expect(retained?.revision).toBe(1);
    expect(retained?.snapshot?.grid[0]?.cells[0]?.grapheme).toBe("R");
    expect(source.listeners.get(`${GENERATION_A}:pane-a`)?.size).toBe(1);

    const revisions: number[] = [];
    lane.subscribePane("pane-a", ({ state }) => revisions.push(state.revision));
    expect(revisions).toEqual([]);
    lane.dispose();
    expect(source.listeners.get(`${GENERATION_A}:pane-a`)?.size).toBe(0);
  });

  it("retains exactly the generation inventory without renderer observers", () => {
    const { lane, source } = rig();
    lane.retainPanes(["pane-a", "pane-b"]);
    expect(source.listeners.get(`${GENERATION_A}:pane-a`)?.size).toBe(1);
    expect(source.listeners.get(`${GENERATION_A}:pane-b`)?.size).toBe(1);

    const outside: number[] = [];
    lane.subscribePane("pane-outside", ({ state }) => outside.push(state.revision));
    expect(source.listeners.has(`${GENERATION_A}:pane-outside`)).toBe(false);

    const removed: number[] = [];
    lane.subscribePane("pane-a", ({ state }) => removed.push(state.revision));

    lane.retainPanes(["pane-b"]);
    expect(source.listeners.get(`${GENERATION_A}:pane-a`)?.size ?? 0).toBe(0);
    expect(source.listeners.get(`${GENERATION_A}:pane-b`)?.size).toBe(1);
    source.emit(seed(blankTerminalReplicaSnapshot(2, 1), 0, GENERATION_A, "pane-a"));
    expect(removed).toEqual([]);
    expect(outside).toEqual([]);
    lane.dispose();
    expect(source.listeners.get(`${GENERATION_A}:pane-b`)?.size ?? 0).toBe(0);
  });

  it("stages candidate panes additively and trims only after commit", () => {
    const { lane, source } = rig();
    lane.retainPanes(["pane-incumbent"]);
    const initial = blankTerminalReplicaSnapshot(2, 1);
    source.emit(seed(initial, 0, GENERATION_A, "pane-incumbent"));
    expect(lane.paneState("pane-incumbent")?.hash).toBe(hashTerminalReplicaSnapshot(initial));

    const releaseCandidate = lane.stagePanes(["pane-candidate"]);
    expect(source.listeners.get(`${GENERATION_A}:pane-incumbent`)?.size).toBe(1);
    expect(source.listeners.get(`${GENERATION_A}:pane-candidate`)?.size).toBe(1);
    expect(lane.paneState("pane-incumbent")?.hash).toBe(hashTerminalReplicaSnapshot(initial));

    lane.retainPanes(["pane-candidate"]);
    // The candidate stage overlaps the committed inventory, so releasing it
    // cannot close the newly active source. The incumbent trims at commit.
    releaseCandidate();
    expect(source.listeners.get(`${GENERATION_A}:pane-incumbent`)?.size ?? 0).toBe(0);
    expect(source.listeners.get(`${GENERATION_A}:pane-candidate`)?.size).toBe(1);
    lane.dispose();
  });

  it("releases an abandoned candidate stage without disturbing the incumbent", () => {
    const { lane, source } = rig();
    lane.retainPanes(["pane-incumbent"]);
    const releaseCandidate = lane.stagePanes(["pane-candidate"]);
    releaseCandidate();
    releaseCandidate();
    expect(source.listeners.get(`${GENERATION_A}:pane-candidate`)?.size ?? 0).toBe(0);
    expect(source.listeners.get(`${GENERATION_A}:pane-incumbent`)?.size).toBe(1);
    lane.dispose();
  });
});

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

describe("terminal fast-lane shared conformance", () => {
  it("produces identical transitions and counters for core/OpenTUI/Web/SDK-labelled clients", async () => {
    const surfaces = ["core", "opentui", "web", "sdk"] as const;
    const traces: Array<{ surface: (typeof surfaces)[number]; hash: string; counters: unknown }> =
      [];
    for (const surface of surfaces) {
      const { lane, source, control, repairs } = rig();
      const snapshot = blankTerminalReplicaSnapshot(2, 1);
      const transitions: string[] = [];
      lane.subscribePane("pane-a", ({ state }) =>
        transitions.push(
          `${state.generation}:${state.incarnation}:${state.revision}:${state.hash}`,
        ),
      );
      source.emit(seed(snapshot));
      source.emit(seed(snapshot));
      source.emit(patch(snapshot, { rows: [] }, 2));
      source.emit(seed(snapshot, 2, GENERATION_A, "pane-a", `${GENERATION_A}:1`));
      control.owned.add("input");
      await Promise.all([
        lane.sendInput("pane-a", { kind: "text", data: "paste" }),
        lane.sendInput("pane-a", { kind: "key", data: "Enter" }),
      ]);
      control.owned.delete("input");
      control.requestResult = false;
      await lane.sendInput("pane-a", { kind: "key", data: "C-c" });
      control.owned.add("geometry");
      const gate = deferred<void>();
      control.resizeGates.push(gate.promise, Promise.resolve());
      const first = lane.resize({ cols: 80, rows: 24 });
      const middle = lane.resize({ cols: 90, rows: 30 });
      const latest = lane.resize({ cols: 100, rows: 40 });
      await middle;
      gate.resolve();
      await Promise.all([first, latest]);
      lane.replaceGeneration(address(GENERATION_B));
      source.emit(seed(snapshot, 0, GENERATION_B));
      transitions.push(`repairs:${repairs.length}`);
      const counters = lane.counters();
      traces.push({ surface, hash: fnv1a64(JSON.stringify(transitions)), counters });
      lane.dispose();
    }
    expect(new Set(traces.map(({ hash }) => hash)).size).toBe(1);
    expect(new Set(traces.map(({ counters }) => JSON.stringify(counters))).size).toBe(1);
    expect(new Set(traces.map(({ surface }) => surface)).size).toBe(4);
  });
});
