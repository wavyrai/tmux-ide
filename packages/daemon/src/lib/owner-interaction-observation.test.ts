import { expect, it, vi } from "vitest";
import type { NativeJournalCapability } from "@tmux-ide/contracts";
import { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
import { InteractionObservationStatusStore } from "./interaction-observation-status.ts";
import { InteractionReceiptJournal } from "./interaction-receipt-journal.ts";
import type {
  NativeJournalObserverEvent,
  NativeTmuxInteractionObserverOptions,
} from "./native-tmux-interaction-observer.ts";
const id = "00000000-0000-4000-8000-000000000001",
  epoch = "00000000-0000-4000-8000-000000000002";
const scope = { serverId: `tmux-server.${"a".repeat(32)}`, generation: id };
const cap: NativeJournalCapability = {
  schemaVersion: 2,
  type: "capability",
  serverEpoch: id,
  journalEpoch: epoch,
  enabled: true,
  coverage: [
    "command-outcome-v1",
    "pty-enqueue-v1",
    "capture-produced-v1",
    "cooperative-operation-v1",
    "pane-identity-v1",
  ],
  capacity: 4096,
  maxBatch: 256,
  maxWaiters: 4,
  waitingReaders: 0,
  degraded: 0,
};
function rig(enabled = true, other = false) {
  const serverScope = other ? { ...scope, serverId: `tmux-server.${"b".repeat(32)}` } : scope;
  const status = new InteractionObservationStatusStore(id, serverScope),
    journal = new InteractionReceiptJournal();
  let event!: (event: NativeJournalObserverEvent) => void;
  let finish!: (status: "ready" | "unavailable") => void;
  const dispose = vi.fn(async () => {});
  const factory = vi.fn((options: NativeTmuxInteractionObserverOptions) => {
    event = options.onEvent;
    return {
      start: () =>
        new Promise<"ready" | "unavailable">((resolve) => {
          finish = resolve;
        }),
      dispose,
    };
  });
  const selector = new OwnerInteractionObservation({
    environmentId: id,
    serverScope,
    tmuxAuthority: {
      executablePath: "/test/tmux",
      socketSelector: { kind: "path", path: "/test/tmux.sock" },
    },
    nativeServerIdentity: { pid: "1", startTime: "1" },
    enabled,
    status,
    publishEvidence: (evidence) => journal.publishEvidence(evidence),
    readerFactory: factory,
  });
  return {
    selector,
    status,
    journal,
    factory,
    dispose,
    event: (value: NativeJournalObserverEvent) => event(value),
    finish: (value: "ready" | "unavailable") => finish(value),
  };
}
it("never probes without explicit opt-in and preserves stock availability", async () => {
  const r = rig(false);
  r.selector.stockAvailable(true);
  await r.selector.start();
  expect(r.factory).not.toHaveBeenCalled();
  expect(r.selector.allowStockPublication()).toBe(true);
  expect(r.status.getSnapshot().method).toBe("stock-hooks");
  await r.selector.dispose();
});
it("selects stock once on capability failure and reports withheld startup coverage", async () => {
  const r = rig();
  r.selector.stockAvailable(true);
  const start = r.selector.start();
  expect(r.selector.allowStockPublication()).toBe(false);
  expect(r.status.getSnapshot().lastGap?.reason).toBe("uncertain-consume");
  r.event({ type: "state", status: "unavailable", capability: null });
  r.finish("unavailable");
  await start;
  expect(r.selector.selection).toBe("stock");
  expect(r.selector.allowStockPublication()).toBe(true);
  expect(r.dispose).toHaveBeenCalledTimes(1);
  await r.selector.dispose();
});
it("keeps native ownership through retry/degradation and ignores late callbacks", async () => {
  const r = rig();
  const start = r.selector.start();
  r.event({ type: "state", status: "ready", capability: cap });
  r.finish("ready");
  await start;
  expect(r.selector.allowStockPublication()).toBe(false);
  r.selector.stockAvailable(true);
  expect(r.status.getSnapshot().method).toBe("native-journal");
  r.event({ type: "state", status: "retrying", capability: cap });
  expect(r.status.getSnapshot().method).toBe("unavailable");
  expect(r.selector.allowStockPublication()).toBe(false);
  r.event({ type: "state", status: "ready", capability: cap });
  expect(r.status.getSnapshot().method).toBe("native-journal");
  r.event({ type: "state", status: "degraded", capability: { ...cap, degraded: 1 } });
  r.event({ type: "state", status: "ready", capability: cap });
  expect(r.status.getSnapshot().method).toBe("unavailable");
  await r.selector.dispose();
  r.event({ type: "state", status: "ready", capability: cap });
  expect(r.status.getSnapshot().method).toBe("unavailable");
});
it("publishes unresolved native evidence in the same scoped journal without guessing an alias", async () => {
  for (const other of [false, true]) {
    const r = rig(true, other);
    const start = r.selector.start();
    r.event({ type: "state", status: "ready", capability: cap });
    r.finish("ready");
    await start;
    r.event({
      type: "batch",
      batch: {
        schemaVersion: 2,
        type: "batch",
        serverEpoch: id,
        journalEpoch: epoch,
        oldest: "1",
        newest: "1",
        next: "1",
        gap: null,
        degraded: 0,
        records: [
          {
            sequence: "1",
            commandId: "1",
            issuerId: "1",
            requestId: "1",
            parentCommandId: "0",
            monotonicUs: "1",
            count: "0",
            targetId: 0,
            targetBirthId: "1",
            kind: 1,
            outcome: 1,
            flags: 1,
            transport: 1,
            derivation: 0,
            correlation: null,
          },
        ],
      },
    });
    const entry = r.journal.read(0).receipts[0]!;
    expect(entry.type).toBe("interaction.evidence");
    expect(entry.evidence?.endpoints.destination).toMatchObject({
      kind: "native-pane",
      serverScope: { serverId: other ? `tmux-server.${"b".repeat(32)}` : scope.serverId },
    });
    expect(entry).not.toHaveProperty("workspaceName");
    expect(r.status.getSnapshot().cursor).toEqual({ epoch, sequence: "1" });
    await r.selector.dispose();
  }
});
it("records native retention gaps and aborts selection before late readiness", async () => {
  const r = rig();
  const start = r.selector.start();
  r.event({ type: "state", status: "ready", capability: cap });
  r.finish("ready");
  await start;
  r.event({
    type: "gap",
    cursor: { serverEpoch: id, journalEpoch: epoch, sequence: "0" },
    missing: { from: "1", through: "3" },
  });
  expect(r.status.getSnapshot()).toMatchObject({
    droppedCount: "3",
    lastGap: { reason: "native-range-dropped", range: { epoch, from: "1", to: "3" } },
  });
  await r.selector.dispose();
  expect(r.selector.allowStockPublication()).toBe(false);
});
it("keeps authored hook completion independent from passive native selection", async () => {
  const { createTmuxInteractionObservationHandler } =
    await import("./tmux-interaction-observation-handler.ts");
  const r = rig();
  const start = r.selector.start();
  r.event({ type: "state", status: "ready", capability: cap });
  r.finish("ready");
  await start;
  const publish = vi.fn(),
    consume = vi.fn(() => true),
    invalidate = vi.fn();
  const observe = createTmuxInteractionObservationHandler({
    consumeAuthored: consume,
    publishExternal: () => {
      if (r.selector.allowStockPublication()) publish();
    },
    invalidateInventory: invalidate,
    reportPublicationFailure: vi.fn(),
  });
  expect(
    observe({
      operationId: id,
      operationKind: "workspace.pane.send",
      workspaceName: "alpha",
      semanticPaneId: "pane.alpha",
      capturedTarget: null,
    }),
  ).toBe(true);
  expect(consume).toHaveBeenCalledTimes(1);
  expect(publish).not.toHaveBeenCalled();
  observe({
    operationId: null,
    operationKind: "workspace.pane.send",
    workspaceName: "alpha",
    semanticPaneId: "pane.alpha",
    capturedTarget: null,
  });
  expect(publish).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledTimes(2);
  await r.selector.dispose();
});

it("updates the reset cursor and gap together even when the new journal stays idle", async () => {
  const r = rig();
  const start = r.selector.start();
  r.event({ type: "state", status: "ready", capability: cap });
  r.finish("ready");
  await start;
  const nextEpoch = "00000000-0000-4000-8000-000000000003";
  expect(r.selector.nativeServerEpoch).toBe(id);
  r.event({
    type: "reset",
    previous: { serverEpoch: id, journalEpoch: epoch, sequence: "7" },
    cursor: { serverEpoch: id, journalEpoch: nextEpoch, sequence: "0" },
  });
  expect(r.status.getSnapshot()).toMatchObject({
    method: "native-journal",
    cursor: { epoch: nextEpoch, sequence: "0" },
    lastGap: { reason: "epoch-reset" },
    droppedCount: null,
  });
  expect(r.selector.nativeServerEpoch).toBe(id);
  await r.selector.dispose();
  expect(r.selector.nativeServerEpoch).toBeNull();
});
it("retires permanently even if reader disposal rejects", async () => {
  const r = rig();
  const start = r.selector.start();
  r.event({ type: "state", status: "ready", capability: cap });
  r.finish("ready");
  await start;
  r.dispose.mockRejectedValueOnce(new Error("reader cleanup failed"));
  const first = r.selector.dispose();
  await expect(first).rejects.toThrow("reader cleanup failed");
  expect(r.selector.dispose()).toBe(first);
  expect(r.selector.allowStockPublication()).toBe(false);
  r.event({ type: "state", status: "ready", capability: cap });
  expect(r.journal.read(0).receipts).toHaveLength(0);
});

it("requires explicit snapshot capability plus all owned pane guards and retires the getter", async () => {
  const r = rig();
  const start = r.selector.start();
  expect(r.selector.atomicPaneSnapshot).toBe(false);
  r.event({
    type: "state",
    status: "ready",
    capability: {
      ...cap,
      ownedOperationTransport: "direct-wrapper-v1",
      ownedOperationEpochGuard: "server-epoch-v1",
      ownedOperationPaneGuard: "direct-pane-v1",
      atomicPaneSnapshot: "capture-resume-v1",
    },
  });
  r.finish("ready");
  await start;
  expect(r.selector.atomicPaneSnapshot).toBe(true);
  await r.selector.dispose();
  expect(r.selector.atomicPaneSnapshot).toBe(false);
});

it("activates the default stock owner once for an explicit supported split read and awaits readiness", async () => {
  const r = rig(false);
  await r.selector.start();
  const first = r.selector.activateForSplit(id);
  const second = r.selector.activateForSplit(id);
  expect(r.factory).toHaveBeenCalledTimes(1);
  expect(r.factory.mock.calls[0]![0].expectedServerEpoch).toBe(id);
  let complete = false;
  void first.then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  r.event({
    type: "state",
    status: "ready",
    capability: {
      ...cap,
      ownedOperationTransport: "direct-wrapper-v1",
      ownedOperationEpochGuard: "server-epoch-v1",
      ownedOperationPaneGuard: "direct-pane-v1",
      ownedOperationSessionGuard: "direct-session-v1",
    },
  });
  r.finish("ready");
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(await r.selector.activateForSplit(id)).toBe(true);
  expect(r.factory).toHaveBeenCalledTimes(1);
  await r.selector.dispose();
});

it.each(["disposed", "failed", "wrong-epoch"])(
  "lazy activation cannot expose retired or failed readiness: %s",
  async (scenario) => {
    const r = rig(false);
    await r.selector.start();
    const result = r.selector.activateForSplit(id);
    if (scenario === "disposed") await r.selector.dispose();
    r.event({
      type: "state",
      status: scenario === "failed" ? "unavailable" : "ready",
      capability:
        scenario === "failed"
          ? null
          : {
              ...cap,
              serverEpoch: scenario === "wrong-epoch" ? epoch : id,
              ownedOperationTransport: "direct-wrapper-v1",
              ownedOperationEpochGuard: "server-epoch-v1",
              ownedOperationPaneGuard: "direct-pane-v1",
              ownedOperationSessionGuard: "direct-session-v1",
            },
    });
    r.finish(scenario === "failed" ? "unavailable" : "ready");
    expect(await result).toBe(false);
    expect(await r.selector.activateForSplit(id)).toBe(false);
    expect(r.factory).toHaveBeenCalledTimes(1);
    await r.selector.dispose();
  },
);

it("bounds a stuck lazy initialization and refuses late ready callbacks", async () => {
  vi.useFakeTimers();
  const r = rig(false);
  try {
    const result = r.selector.activateForSplit(id);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await result).toBe(false);
    expect(r.dispose).toHaveBeenCalled();
    r.event({ type: "state", status: "ready", capability: cap });
    r.finish("ready");
    await Promise.resolve();
    await Promise.resolve();
    expect(r.selector.allowStockPublication()).toBe(false);
    expect(r.status.getSnapshot().method).toBe("unavailable");
    expect(r.selector.nativeServerEpoch).toBeNull();
    expect(await r.selector.activateForSplit(id)).toBe(false);
  } finally {
    await r.selector.dispose();
    vi.useRealTimers();
  }
});
