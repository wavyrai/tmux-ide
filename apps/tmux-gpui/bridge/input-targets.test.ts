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
import {
  publishInputTargets,
  bindInputTargets,
  visibleInputTargets,
  inputTargetsSchema,
} from "./input-targets.ts";
import { createWindowPresentation } from "./window-presentation.ts";
import type { Layout } from "./topology.ts";

function setup() {
  const generation = randomUUID(),
    deliveryNonce = randomUUID();
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
    () => {},
    () => {},
  );
  function seed(revision = 0, incarnation = `${generation}:0`, corrupt = false) {
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
      canonicalStateHash: corrupt ? "0".repeat(64) : hashTerminalReplicaSnapshot(snapshot),
      representationHash: hashTerminalDeliveryRepresentation(bytes),
      representationBytes: bytes.length,
      chunkCount: 1,
      canonicalEquivalent: true as const,
      history: "complete" as const,
      richPlacements: false,
    };
    receiver.accept(envelope);
    for (const chunk of splitTerminalDeliveryChunks(envelope.transactionId, bytes))
      receiver.accept(chunk);
  }
  const targets = (overrides = {}) =>
    publishInputTargets({
      enabled: true,
      connection: "child-connection",
      liveSessionId: "session",
      workspaceName: "test",
      surfaces: receiver.current()
        ? [{ paneId: "pane-a", snapshot: receiver.current()!.snapshot }]
        : [],
      current: () => receiver.current(),
      ...overrides,
    });
  return { receiver, seed, targets, generation };
}
test("only committed canonical source exposes lifetime; retirement and corrupt delivery clear it", () => {
  const a = setup();
  assert.deepEqual(a.targets(), []);
  a.seed();
  assert.equal(a.targets().length, 1);
  a.receiver.retire();
  assert.deepEqual(a.targets(), []);
  const b = setup();
  assert.throws(() => b.seed(0, `${b.generation}:0`, true));
  assert.deepEqual(b.targets(), []);
});
test("same-window navigation request and content revision do not change target token", () => {
  const a = setup();
  a.seed();
  const initial = bindInputTargets(a.targets(), "browser", ["pane-a"]);
  // The navigation request belongs to the surrounding publication, never token scope.
  const before = { request: 1, inputTargets: initial };
  a.seed(1);
  const after = { request: 2, inputTargets: bindInputTargets(a.targets(), "browser", ["pane-a"]) };
  assert.deepEqual(before.inputTargets, after.inputTargets);
});
test("incarnation, child connection, browser connection and session changes replace fence", () => {
  const a = setup();
  a.seed();
  const first = a.targets();
  assert.notDeepEqual(a.targets({ connection: "new" }), first);
  assert.notDeepEqual(a.targets({ liveSessionId: "new" }), first);
  assert.notDeepEqual(
    bindInputTargets(first, "browser", ["pane-a"]),
    bindInputTargets(first, "new-browser", ["pane-a"]),
  );
  a.seed(1, `${a.generation}:1`);
  assert.notDeepEqual(a.targets(), first);
});
test("disabled authority, missing canonical proof and unrepresented row identity produce no targets", () => {
  const a = setup();
  a.seed();
  assert.deepEqual(a.targets({ enabled: false }), []);
  assert.deepEqual(a.targets({ current: () => null }), []);
  assert.deepEqual(
    a.targets({ surfaces: [{ paneId: "pane-a", snapshot: blankTerminalReplicaSnapshot(4, 2) }] }),
    [],
  );
});
test("old helpers stay unsupported; malformed, duplicate and out-of-region metadata rejected", () => {
  assert.deepEqual(bindInputTargets(undefined, "browser", []), []);
  const a = setup();
  a.seed();
  const target = a.targets()[0];
  for (const value of [
    [target, target],
    Array(25).fill(target),
    [{ ...target, token: "invalid" }],
    [{ ...target, id: "x".repeat(513) }],
  ])
    assert.throws(() => inputTargetsSchema.parse(value));
  assert.throws(() => bindInputTargets([target], "browser", ["other"]));
});
test("visible target must match actual composed cells, including retained resize-skew rejection", () => {
  const a = setup();
  a.seed();
  const surfaces = [{ paneId: "pane-a", snapshot: a.receiver.current()!.snapshot }];
  const layout: Layout = {
    type: "layout",
    windowName: "test",
    currentWindow: true,
    zoomed: false,
    paneBorderStatus: "off",
    semanticWindowId: "window",
    cols: 4,
    rows: 2,
    panes: [{ pane: "pane-a", left: 0, top: 0, width: 4, height: 2, active: true }],
  };
  const canvas = createWindowPresentation("pane-a").update(layout, surfaces, true)!;
  assert.equal(visibleInputTargets(a.targets(), "browser", surfaces, canvas).length, 1);
  assert.deepEqual(
    visibleInputTargets(
      a.targets(),
      "browser",
      [{ paneId: "pane-a", snapshot: blankTerminalReplicaSnapshot(4, 2) }],
      canvas,
    ),
    [],
  );
  assert.deepEqual(visibleInputTargets(a.targets(), "browser", surfaces, null), []);
});

test("same-sized replacement sharing identical rows cannot borrow retained presentation provenance", () => {
  const a = setup();
  a.seed();
  const original = a.receiver.current()!.snapshot;
  const layout: Layout = {
    type: "layout",
    semanticWindowId: "w",
    windowName: "w",
    currentWindow: true,
    zoomed: false,
    paneBorderStatus: "off",
    cols: 4,
    rows: 2,
    panes: [{ pane: "pane-a", left: 0, top: 0, width: 4, height: 2, active: true }],
  };
  const presentation = createWindowPresentation("pane-a").update(
    layout,
    [{ paneId: "pane-a", snapshot: original }],
    true,
  )!;
  const replacement = { ...original };
  assert.equal(replacement.grid, original.grid);
  assert.deepEqual(
    visibleInputTargets(
      a.targets(),
      "browser",
      [{ paneId: "pane-a", snapshot: replacement }],
      presentation,
    ),
    [],
  );
});
