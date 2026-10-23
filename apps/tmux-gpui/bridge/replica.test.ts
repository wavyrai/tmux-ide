import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
} from "../../../packages/core/src/terminal-replica.ts";
import {
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  splitTerminalDeliveryChunks,
} from "../../../packages/core/src/terminal-delivery.ts";
import { createReplica } from "./replica.ts";
const generation = randomUUID(),
  deliveryNonce = randomUUID();
function seed(revision = 0, incarnation = `${generation}:0`) {
  const snapshot = blankTerminalReplicaSnapshot(4, 2);
  const bytes = encodeSemanticTerminalUpdate({ frame: "seed", revision, snapshot });
  const envelope = {
    type: "terminal.delivery" as const,
    workspaceName: "test",
    semanticPaneId: "pane-a",
    generation,
    incarnation,
    deliveryNonce,
    transactionId: randomUUID(),
    protocolVersion: 1 as const,
    encoding: "semantic-v1" as const,
    frame: "seed" as const,
    baseRevision: null,
    canonicalRevision: revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.length,
    chunkCount: 1,
    canonicalEquivalent: true as const,
    history: "complete" as const,
    richPlacements: false,
  };
  return { envelope, chunks: splitTerminalDeliveryChunks(envelope.transactionId, bytes) };
}
function setup() {
  const published: unknown[] = [];
  const acks: unknown[] = [];
  const lifetimes: (string | null)[] = [];
  const receiver = createReplica(
    {
      protocolVersion: 1,
      encoding: "semantic-v1",
      generation,
      deliveryNonce,
      richPlacements: false,
    },
    "test",
    "pane-a",
    (s, lifetime) => {
      published.push(s);
      lifetimes.push(lifetime);
    },
    (a) => acks.push(a),
  );
  return { receiver, published, acks, lifetimes };
}
test("publishes and ACKs only a complete authenticated snapshot", () => {
  const { receiver, published, acks } = setup();
  const { envelope, chunks } = seed();
  receiver.accept(envelope);
  assert.equal(published.length, 0);
  for (const chunk of chunks) receiver.accept(chunk);
  assert.equal(published.length, 1);
  assert.equal(acks.length, 1);
});
test("rejects a replaced daemon generation and cannot revive after retirement", () => {
  const { receiver, published, acks } = setup();
  const { envelope, chunks } = seed();
  assert.throws(() => receiver.accept({ ...envelope, generation: randomUUID() }));
  for (const chunk of chunks) receiver.accept(chunk);
  assert.deepEqual(published, [null]);
  assert.equal(acks.length, 0);
});
test("hash corruption clears the view without ACK", () => {
  const { receiver, published, acks } = setup();
  const { envelope, chunks } = seed();
  receiver.accept({ ...envelope, canonicalStateHash: "0000000000000000" });
  assert.throws(() => chunks.forEach((c) => receiver.accept(c)));
  assert.deepEqual(published, [null]);
  assert.equal(acks.length, 0);
});
test("a complete-state receiver retires on projection delivery without acknowledging history", () => {
  const { receiver, published, acks } = setup();
  const { envelope, chunks } = seed();
  receiver.accept(envelope);
  chunks.forEach((chunk) => receiver.accept(chunk));
  assert.equal(acks.length, 1);
  assert.throws(
    () =>
      receiver.accept({
        ...envelope,
        type: "terminal.projection",
        encoding: "alternate-projection-binary-v1",
        canonicalEquivalent: false,
        history: "deferred",
        projectionStateHash: "0000000000000000",
      }),
    /projection was not negotiated/,
  );
  assert.equal(receiver.current(), null);
  assert.equal(published.at(-1), null);
  receiver.accept(envelope);
  chunks.forEach((chunk) => receiver.accept(chunk));
  assert.equal(acks.length, 1);
});
test("disconnect ignores late callbacks and does not replay state", () => {
  const { receiver, published, acks } = setup();
  const { envelope, chunks } = seed();
  receiver.accept(envelope);
  receiver.retire();
  for (const c of chunks) receiver.accept(c);
  assert.deepEqual(published, [null]);
  assert.equal(acks.length, 0);
});

test("verified newer incarnation changes lifetime only at complete commit", () => {
  const { receiver, published, acks, lifetimes } = setup();
  const first = seed(3);
  receiver.accept(first.envelope);
  for (const chunk of first.chunks) receiver.accept(chunk);
  assert.deepEqual(lifetimes, [JSON.stringify([generation, `${generation}:0`])]);
  const replacement = seed(4, `${generation}:1`);
  receiver.accept(replacement.envelope);
  assert.equal(lifetimes.length, 1, "envelope admission alone is not a committed lifetime");
  for (const chunk of replacement.chunks) receiver.accept(chunk);
  assert.equal(published.length, 2);
  assert.equal(acks.length, 2);
  assert.deepEqual(lifetimes, [
    JSON.stringify([generation, `${generation}:0`]),
    JSON.stringify([generation, `${generation}:1`]),
  ]);
  receiver.retire();
  assert.equal(published.at(-1), null);
  assert.equal(lifetimes.at(-1), null);
  for (const chunk of replacement.chunks) receiver.accept(chunk);
  assert.equal(lifetimes.length, 3);
});
test("failed replacement clears the committed lifetime without advertising its incarnation", () => {
  const { receiver, lifetimes } = setup();
  const first = seed();
  receiver.accept(first.envelope);
  first.chunks.forEach((chunk) => receiver.accept(chunk));
  const replacement = seed(4, `${generation}:1`);
  receiver.accept({ ...replacement.envelope, canonicalStateHash: "0000000000000000" });
  assert.throws(() => replacement.chunks.forEach((chunk) => receiver.accept(chunk)));
  assert.deepEqual(lifetimes, [JSON.stringify([generation, `${generation}:0`]), null]);
});

import type {
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalReplicaSnapshot,
  TerminalSemanticDeliveryPayload,
} from "../../../packages/contracts/src/index.ts";
import { encodeCompactSemanticTerminalUpdate } from "../../../packages/core/src/terminal-delivery.ts";

function compactFixture(fallback = true) {
  const published: (TerminalReplicaSnapshot | null)[] = [];
  const acks: TerminalDeliveryAck[] = [];
  const receiver = createReplica(
    {
      protocolVersion: 1,
      encoding: "semantic-compact-v1",
      generation,
      deliveryNonce,
      richPlacements: false,
      ...(fallback ? { fallbackEncoding: "semantic-v1" as const } : {}),
    },
    "test",
    "pane-a",
    (snapshot) => published.push(snapshot),
    (ack) => acks.push(ack),
  );
  return { receiver, published, acks };
}
function encodedDelivery(
  payload: TerminalSemanticDeliveryPayload,
  snapshot: TerminalReplicaSnapshot,
  encoding: "semantic-compact-v1" | "semantic-v1" = "semantic-compact-v1",
  overrideBytes?: Uint8Array,
) {
  const bytes =
    overrideBytes ??
    (encoding === "semantic-compact-v1"
      ? encodeCompactSemanticTerminalUpdate(payload)
      : encodeSemanticTerminalUpdate(payload));
  const transactionId = randomUUID();
  const chunks = splitTerminalDeliveryChunks(transactionId, bytes);
  const envelope: TerminalDeliveryEnvelope = {
    ...seed().envelope,
    transactionId,
    encoding,
    frame: payload.frame,
    baseRevision: payload.frame === "seed" ? null : payload.baseRevision,
    canonicalRevision: payload.revision,
    canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
    representationHash: hashTerminalDeliveryRepresentation(bytes),
    representationBytes: bytes.length,
    chunkCount: chunks.length,
  };
  const expectedAck: TerminalDeliveryAck = {
    type: "terminal.delivery.ack",
    workspaceName: envelope.workspaceName,
    semanticPaneId: envelope.semanticPaneId,
    generation,
    incarnation: envelope.incarnation,
    deliveryNonce,
    transactionId,
    canonicalRevision: payload.revision,
    canonicalStateHash: envelope.canonicalStateHash,
    representationHash: envelope.representationHash,
  };
  return { envelope, chunks, expectedAck };
}
function unicodeSnapshot() {
  const base = blankTerminalReplicaSnapshot(80, 24);
  const row = (index: number) => ({
    wrapped: index % 2 === 0,
    cells: base.grid[0].cells.map((cell, column) => ({
      ...cell,
      grapheme:
        column === 0
          ? "界"
          : column === 1
            ? ""
            : column === 2
              ? "e\u0301"
              : String.fromCodePoint(0x2800 + ((index + column) % 256)),
      width: (column === 0 ? 2 : column === 1 ? 0 : 1) as 0 | 1 | 2,
    })),
  });
  return {
    ...base,
    grid: Array.from({ length: 24 }, (_, i) => row(i)),
    history: Array.from({ length: 300 }, (_, i) => row(i + 24)),
  };
}

test("compact multichunk seed and Unicode/history patch publish exact canonical snapshots and ACKs", () => {
  const fixture = compactFixture();
  const snapshot = unicodeSnapshot();
  const initial = encodedDelivery({ frame: "seed", revision: 0, snapshot }, snapshot);
  assert.ok(initial.chunks.length > 1, "fixture must exercise real chunk assembly");
  fixture.receiver.accept(initial.envelope);
  for (const chunk of initial.chunks.slice(0, -1)) fixture.receiver.accept(chunk);
  assert.deepEqual(fixture.published, []);
  assert.deepEqual(fixture.acks, []);
  fixture.receiver.accept(initial.chunks.at(-1)!);
  assert.deepEqual(fixture.published, [snapshot]);
  assert.deepEqual(fixture.acks, [initial.expectedAck]);
  const row = { ...snapshot.grid[0], wrapped: !snapshot.grid[0].wrapped };
  const next = {
    ...snapshot,
    grid: [row, ...snapshot.grid.slice(1)],
    history: [...snapshot.history.slice(2), row],
  };
  const patch = encodedDelivery(
    {
      frame: "patch",
      revision: 1,
      baseRevision: 0,
      patch: { rows: [{ index: 0, row }], historyDelta: { trim: 2, append: [row] } },
    },
    next,
  );
  fixture.receiver.accept(patch.envelope);
  patch.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
  assert.deepEqual(fixture.published.at(-1), next);
  assert.deepEqual(fixture.acks, [initial.expectedAck, patch.expectedAck]);
});

test("compact negotiation admits semantic fallback only when explicitly negotiated", () => {
  const snapshot = blankTerminalReplicaSnapshot(4, 2);
  const next = { ...snapshot, cursor: { ...snapshot.cursor, x: 1 } };
  const initial = encodedDelivery({ frame: "seed", revision: 0, snapshot }, snapshot);
  const patch = encodedDelivery(
    { frame: "patch", revision: 1, baseRevision: 0, patch: { rows: [], cursor: next.cursor } },
    next,
    "semantic-v1",
  );
  for (const fallback of [true, false]) {
    const fixture = compactFixture(fallback);
    fixture.receiver.accept(initial.envelope);
    initial.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
    if (fallback) {
      fixture.receiver.accept(patch.envelope);
      patch.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
      assert.deepEqual(fixture.published.at(-1), next);
      assert.deepEqual(fixture.acks, [initial.expectedAck, patch.expectedAck]);
    } else {
      assert.throws(() => fixture.receiver.accept(patch.envelope));
      patch.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
      assert.equal(fixture.published.at(-1), null);
      assert.deepEqual(fixture.acks, [initial.expectedAck]);
    }
  }
});

test("malformed compact payload, canonical hash corruption and baseline gaps retire without ACK", () => {
  const snapshot = blankTerminalReplicaSnapshot(4, 2);
  const payload = { frame: "seed" as const, revision: 0, snapshot };
  const malformed = JSON.parse(
    new TextDecoder().decode(encodeCompactSemanticTerminalUpdate(payload)),
  );
  malformed.v = 99;
  for (const failure of ["malformed", "hash", "baseline"] as const) {
    const fixture = compactFixture();
    const initial = encodedDelivery(payload, snapshot);
    fixture.receiver.accept(initial.envelope);
    initial.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
    const bad =
      failure === "baseline"
        ? encodedDelivery(
            { frame: "patch", revision: 2, baseRevision: 1, patch: { rows: [] } },
            snapshot,
          )
        : encodedDelivery(
            { ...payload, revision: 1 },
            snapshot,
            "semantic-compact-v1",
            failure === "malformed"
              ? new TextEncoder().encode(JSON.stringify(malformed))
              : undefined,
          );
    if (failure === "hash")
      bad.envelope = { ...bad.envelope, canonicalStateHash: "0000000000000000" };
    assert.throws(
      () => {
        fixture.receiver.accept(bad.envelope);
        bad.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
      },
      failure === "malformed"
        ? /Unsupported compact semantic version/
        : failure === "hash"
          ? /Canonical state hash mismatch/
          : /identity or ordering mismatch/,
    );
    assert.equal(fixture.published.at(-1), null);
    assert.deepEqual(fixture.acks, [initial.expectedAck]);
    const count = fixture.published.length;
    fixture.receiver.accept(initial.envelope);
    initial.chunks.forEach((chunk) => fixture.receiver.accept(chunk));
    assert.equal(fixture.published.length, count);
    assert.deepEqual(fixture.acks, [initial.expectedAck]);
  }
});
