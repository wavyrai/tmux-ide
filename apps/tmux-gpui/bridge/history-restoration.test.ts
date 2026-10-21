import { test } from "node:test";
import assert from "node:assert/strict";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
import { createHistoryViewport } from "./history.ts";
import {
  createHistoryRestoration,
  type AnchorResult,
  type HistoryFrame,
} from "./history-restoration.ts";
const row = () => blankTerminalReplicaSnapshot(2, 2).grid[0]!;
function fixture() {
  const a = row(),
    b = row(),
    c = row();
  let frame: HistoryFrame = {
    proof: {
      workspaceName: "w",
      semanticPaneId: "p",
      generation: "g",
      incarnation: "i",
      revision: 1,
      stateHash: "hash1",
    },
    snapshot: { ...blankTerminalReplicaSnapshot(2, 2), history: [a, b] },
  };
  const viewport = createHistoryViewport();
  viewport.update(frame.snapshot);
  const requests: {
    proof: HistoryFrame["proof"];
    operation: unknown;
    signal: AbortSignal;
    resolve: (value: AnchorResult | null) => void;
  }[] = [];
  let changes = 0;
  const owner = createHistoryRestoration({
    current: () => frame,
    restore: (r) => !!viewport.restoreRow(r),
    changed: () => changes++,
    read: (proof, operation, signal) =>
      new Promise((resolve) => requests.push({ proof, operation, signal, resolve })),
  });
  owner.observe(frame);
  return {
    owner,
    viewport,
    requests,
    a,
    b,
    c,
    changes: () => changes,
    frame: () => frame,
    update: (history: typeof frame.snapshot.history, revision: number) => {
      frame = {
        proof: { ...frame.proof, revision, stateHash: `hash${revision}` },
        snapshot: { ...frame.snapshot, history },
      };
      viewport.update(frame.snapshot);
      owner.observe(frame);
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
test("capture uses exact canonical index and proof, never bounded viewport offset", async () => {
  const f = fixture();
  f.viewport.scroll(1);
  f.owner.capture(f.viewport.captureIndex());
  assert.deepEqual(f.requests[0]!.operation, { kind: "capture", historyIndex: 1 });
  assert.equal(f.requests[0]!.proof.stateHash, "hash1");
  f.requests[0]!.resolve({ status: "captured", token: "opaque" });
  await settle();
  assert.equal(f.owner.publication().token, "opaque");
  f.owner.dispose();
});
test("busy output restore matches later delivered proof and carries exact row forward", async () => {
  const f = fixture();
  f.owner.restore("opaque");
  assert.equal(f.owner.publication().state, "restoring");
  const proof = { ...f.frame().proof, revision: 2, stateHash: "hash2" };
  f.requests[0]!.resolve({ status: "resolved", proof, historyIndex: 1 });
  await settle();
  assert.equal(f.owner.publication().state, "restoring");
  f.update([f.a, f.b, f.c], 2);
  assert.equal(f.owner.publication().state, "historical");
  assert.equal(f.viewport.scroll(0)!.history.length, 0);
  f.owner.restore("opaque");
  f.update([f.a, f.b, f.c, row()], 3);
  f.requests[1]!.resolve({ status: "resolved", proof, historyIndex: 1 });
  await settle();
  assert.equal(f.owner.publication().state, "historical");
  assert.equal(f.viewport.offset, 3);
  f.owner.dispose();
});
test("replacement identical text cannot resurrect missing row", async () => {
  const f = fixture();
  f.owner.restore("opaque");
  const proof = f.frame().proof;
  f.update([row(), row()], 2);
  f.requests[0]!.resolve({ status: "resolved", proof, historyIndex: 1 });
  await settle();
  assert.equal(f.owner.publication().state, "lost");
  assert.equal(f.viewport.offset, 0);
  f.owner.dispose();
});
test("return live cancels pending restore and late reply cannot change viewport", async () => {
  const f = fixture();
  f.owner.restore("opaque");
  f.owner.live();
  assert.equal(f.requests[0]!.signal.aborted, true);
  f.requests[0]!.resolve({ status: "resolved", proof: f.frame().proof, historyIndex: 1 });
  await settle();
  assert.equal(f.owner.publication().state, "live");
  assert.equal(f.viewport.offset, 0);
  f.owner.dispose();
});
test("unsupported old daemon is distinct from lost anchor", async () => {
  for (const result of [null, { status: "lost" } as const, { status: "stale" } as const]) {
    const f = fixture();
    f.owner.restore("opaque");
    f.requests[0]!.resolve(result);
    await settle();
    assert.equal(
      f.owner.publication().state,
      result === null ? "unsupported" : result.status === "lost" ? "lost" : "unavailable",
    );
    f.owner.dispose();
  }
});

test("capture pending is explicitly unresolved and return live cancels late token", async () => {
  const f = fixture();
  f.viewport.scroll(1);
  f.owner.capture(f.viewport.captureIndex());
  assert.deepEqual(f.owner.publication(), { state: "historical", token: null });
  f.owner.live();
  f.requests[0]!.resolve({ status: "captured", token: "late" });
  await settle();
  assert.deepEqual(f.owner.publication(), { state: "live", token: null });
  f.owner.dispose();
});
test("bounded history slice keeps canonical indices and refuses omitted rows", async () => {
  for (const index of [4, 5, 1003]) {
    const f = fixture();
    const history = Array.from({ length: 1005 }, row);
    f.update(history, 2);
    f.owner.restore("opaque");
    f.requests[0]!.resolve({ status: "resolved", proof: f.frame().proof, historyIndex: index });
    await settle();
    assert.equal(f.owner.publication().state, index < 5 ? "lost" : "historical");
    if (index >= 5) assert.equal(f.viewport.offset, history.length - index);
    f.owner.dispose();
  }
});

test("handoff waits for the newest capture rather than superseded completion", async () => {
  const f = fixture();
  f.owner.capture(0);
  f.owner.capture(1);
  let finished = false;
  const handoff = f.owner.settleCapture().then((value) => {
    finished = true;
    return value;
  });
  f.requests[0]!.resolve({ status: "captured", token: "old" });
  await settle();
  assert.equal(finished, false);
  f.requests[1]!.resolve({ status: "captured", token: "new" });
  assert.deepEqual(await handoff, { state: "historical", token: "new" });
  f.owner.dispose();
});

test("return-live handoff does not wait for an obsolete capture", async () => {
  const f = fixture();
  f.owner.capture(0);
  f.owner.live();
  assert.deepEqual(await f.owner.settleCapture(), { state: "live", token: null });
  f.requests[0]!.resolve({ status: "captured", token: "obsolete" });
  await settle();
  assert.deepEqual(f.owner.publication(), { state: "live", token: null });
  f.owner.dispose();
});

test("new proofs sharing owned history rows avoid repeated serialization", async (t) => {
  const { freezeOwnedTerminalReplicaRow } =
    await import("../../../packages/core/src/terminal-replica-owned-row.ts");
  const f = fixture();
  const owned = freezeOwnedTerminalReplicaRow(row());
  const stringify = t.mock.method(JSON, "stringify");
  for (let revision = 2; revision < 12; revision++) f.update([owned], revision);
  // One admission each for viewport and restoration, independent weak caches.
  assert.equal(stringify.mock.calls.filter((call) => call.arguments[0] === owned).length, 2);
  f.owner.dispose();
});
