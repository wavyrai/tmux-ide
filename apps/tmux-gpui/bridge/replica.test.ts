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
