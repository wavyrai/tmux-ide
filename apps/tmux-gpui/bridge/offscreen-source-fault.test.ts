import assert from "node:assert/strict";
import { test } from "node:test";
import type { Layout } from "./topology.ts";
import { isOffscreenSourceFault } from "./offscreen-source-fault.ts";
const layout = (id: string, panes: string[], currentWindow = false): Layout => ({
  type: "layout",
  semanticWindowId: id,
  windowName: "duplicate label",
  currentWindow,
  cols: 80,
  rows: 24,
  zoomed: false,
  paneBorderStatus: "off",
  panes: panes.map((pane, i) => ({
    pane,
    left: i * 40,
    top: 0,
    width: 40,
    height: 24,
    active: i === 0,
  })),
});

test("only another exact window is isolated, independent of active tab or labels", () => {
  const layouts = [layout("one", ["selected", "sibling"]), layout("two", ["offscreen"], true)];
  assert.equal(isOffscreenSourceFault(layouts, "selected", "offscreen"), true);
  assert.equal(isOffscreenSourceFault(layouts, "selected", "selected"), false);
  assert.equal(isOffscreenSourceFault(layouts, "selected", "sibling"), false);
  // A fresh helper selecting the failed tab must surface its failure.
  assert.equal(isOffscreenSourceFault(layouts, "offscreen", "offscreen"), false);
  assert.equal(isOffscreenSourceFault(layouts, "selected", "unknown"), false);
});

test("unknown, incomplete and ambiguous topology never suppresses source faults", () => {
  const valid = [layout("one", ["selected"]), layout("two", ["offscreen"])];
  for (const layouts of [
    [],
    [valid[1]],
    [valid[0]],
    [...valid, layout("third", ["selected"])],
    [...valid, layout("third", ["offscreen"])],
    [...valid, layout("one", ["other"])],
    [layout("", ["selected"]), valid[1]],
    [valid[0], layout("two", ["offscreen", ""])],
  ])
    assert.equal(isOffscreenSourceFault(layouts, "selected", "offscreen"), false);
  const hidden = { ...layout("one", ["sibling"]), zoomed: true };
  assert.equal(isOffscreenSourceFault([hidden, valid[1]], "selected", "offscreen"), false);
});

import { createSourceFaultFence } from "./offscreen-source-fault.ts";

test("retained source fault becomes fatal if topology brings it into view", () => {
  let layouts = [layout("one", ["selected", "sibling"]), layout("two", ["offscreen"])];
  const fence = createSourceFaultFence(
    () => "selected",
    () => layouts,
  );
  assert.equal(fence.isolate("offscreen", "protocol-violation"), false);
  assert.equal(fence.currentFailure(), null);
  assert.equal(fence.isolate("sibling", "source-closed"), false);
  assert.equal(fence.isolate("offscreen", "state-too-large"), true);
  assert.equal(fence.currentFailure(), null);
  layouts = [layout("one", ["selected", "sibling", "offscreen"])];
  assert.equal(fence.currentFailure(), "state-too-large");
});

test("retained fault cannot silently survive uncertain membership or resurrect on fresh selection", () => {
  let layouts = [layout("one", ["selected"]), layout("two", ["offscreen"])];
  const fence = createSourceFaultFence(
    () => "selected",
    () => layouts,
  );
  assert.equal(fence.isolate("offscreen", "source-closed"), true);
  const newlySelected = createSourceFaultFence(
    () => "offscreen",
    () => layouts,
  );
  assert.equal(newlySelected.isolate("offscreen", "source-closed"), false);
  layouts = [layout("one", ["selected"])];
  assert.equal(fence.currentFailure(), "source-closed");
});

import { randomUUID } from "node:crypto";
import type {
  TerminalDeliveryServerMessage,
  TerminalReplicaSnapshot,
} from "../../../packages/contracts/src/index.ts";
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

function realReceiver(pane: string) {
  const generation = randomUUID(),
    deliveryNonce = randomUUID();
  const published: (TerminalReplicaSnapshot | null)[] = [];
  const acknowledged: number[] = [];
  const receiver = createReplica(
    {
      protocolVersion: 1,
      encoding: "semantic-v1",
      generation,
      deliveryNonce,
      richPlacements: false,
    },
    "fixture",
    pane,
    (snapshot) => published.push(snapshot),
    (ack) => acknowledged.push(ack.canonicalRevision),
  );
  const initial = blankTerminalReplicaSnapshot(40, 24);
  const changed = { ...initial, cursor: { ...initial.cursor, x: 1 } };
  function deliver(patch = false) {
    const revision = patch ? 1 : 0;
    const snapshot = patch ? changed : initial;
    const bytes = encodeSemanticTerminalUpdate(
      patch
        ? { frame: "patch", revision, baseRevision: 0, patch: { rows: [], cursor: changed.cursor } }
        : { frame: "seed", revision, snapshot },
    );
    const transactionId = randomUUID();
    const chunks = splitTerminalDeliveryChunks(transactionId, bytes);
    const envelope: TerminalDeliveryServerMessage = {
      type: "terminal.delivery",
      workspaceName: "fixture",
      semanticPaneId: pane,
      generation,
      incarnation: `${generation}:0`,
      deliveryNonce,
      transactionId,
      protocolVersion: 1,
      encoding: "semantic-v1",
      frame: patch ? "patch" : "seed",
      baseRevision: patch ? 0 : null,
      canonicalRevision: revision,
      canonicalStateHash: hashTerminalReplicaSnapshot(snapshot),
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.length,
      chunkCount: chunks.length,
      canonicalEquivalent: true,
      history: "complete",
      richPlacements: false,
    };
    receiver.accept(envelope);
    for (const chunk of chunks) receiver.accept(chunk);
  }
  return { receiver, published, acknowledged, deliver, deliveryNonce };
}

test("real retained replicas keep selected patches flowing while offscreen retirement stops publication and ACK", () => {
  for (const seededOffscreen of [false, true]) {
    const layouts = [layout("one", ["selected", "sibling"]), layout("two", ["offscreen"])];
    const fence = createSourceFaultFence(
      () => "selected",
      () => layouts,
    );
    const selected = realReceiver("selected"),
      sibling = realReceiver("sibling"),
      offscreen = realReceiver("offscreen");
    selected.deliver();
    sibling.deliver();
    if (seededOffscreen) offscreen.deliver();
    assert.equal(fence.isolate("offscreen", "state-too-large"), true);
    offscreen.receiver.retire();
    assert.equal(offscreen.published.at(-1), null);
    const publicationCount = offscreen.published.length;
    const ackCount = offscreen.acknowledged.length;
    offscreen.deliver(seededOffscreen);
    assert.equal(offscreen.published.length, publicationCount, "retired source cannot republish");
    assert.equal(
      offscreen.acknowledged.length,
      ackCount,
      "retired source cannot ACK late delivery",
    );
    selected.deliver(true);
    sibling.deliver(true);
    assert.deepEqual(selected.acknowledged, [0, 1]);
    assert.deepEqual(sibling.acknowledged, [0, 1]);
    assert.equal(selected.published.length, 2);
    assert.equal(selected.published.at(-1)?.cursor.x, 1);
    assert.equal(sibling.published.at(-1)?.cursor.x, 1);
    assert.equal(fence.currentFailure(), null);
  }
});

test("selected and visible sibling source faults remain fatal to real replicas without ACK", () => {
  const layouts = [layout("one", ["selected", "sibling"]), layout("two", ["offscreen"])];
  for (const pane of ["selected", "sibling"]) {
    const fence = createSourceFaultFence(
      () => "selected",
      () => layouts,
    );
    const target = realReceiver(pane);
    target.deliver();
    assert.equal(fence.isolate(pane, "state-too-large"), false);
    assert.throws(
      () =>
        target.receiver.accept({
          type: "terminal.delivery.fault",
          reason: "state-too-large",
          message: "Private source diagnostic",
          deliveryNonce: target.deliveryNonce,
        }),
      /Terminal source unavailable/,
    );
    assert.equal(target.published.at(-1), null);
    assert.deepEqual(target.acknowledged, [0]);
    const publicationCount = target.published.length;
    target.deliver(true);
    assert.equal(target.published.length, publicationCount);
    assert.deepEqual(target.acknowledged, [0]);
  }
});
