import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import { createSplitGestureOwner, splitGestureSchema } from "./split-gesture.ts";
import type { SplitResizeSnapshot } from "./split-resize.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const generation = randomUUID(),
    layoutId = randomUUID(),
    splitId = randomUUID(),
    gesture = randomUUID();
  const window = {
    liveSessionId: `live-session.${"a".repeat(20)}`,
    linkId: `window-link.${"a".repeat(32)}`,
    expectedSemanticWindowId: "window.one",
    linkRevision: 1,
  };
  let state: SplitResizeSnapshot & { coherent: boolean; geometryOwned: boolean } = {
    generation,
    workspace: "project",
    lifetime: "one",
    window,
    coherent: true,
    geometryOwned: true,
    resource: {
      version: 1,
      window,
      layoutId,
      cols: 80,
      rows: 24,
      panes: [{ semanticPaneId: "pane.one", left: 0, top: 0, width: 80, height: 24 }],
      splits: [{ splitId, axis: "cols", boundary: 39, start: 0, length: 24 }],
    },
  };
  const pending: {
    id: string;
    target: { window: typeof window; layoutId: string; splitId: string; boundary: number };
    resolve: (v: unknown) => void;
  }[] = [];
  const runtime = {
    ownsConnectionAuthority: () => true,
    requestAuthority: async () => null,
    submitIntent: (id: string, intent: { target: (typeof pending)[number]["target"] }) =>
      new Promise((resolve) =>
        pending.push({ id, target: structuredClone(intent.target), resolve }),
      ),
  } as unknown as PaneStreamRuntimeClient;
  let changes = 0;
  const owner = createSplitGestureOwner({
    runtime: () => runtime,
    current: () => state,
    changed: () => {
      changes++;
    },
  });
  const begin = {
    type: "split-gesture",
    phase: "begin",
    request: 1,
    gesture,
    target: { window, layoutId, splitId, boundary: 39 },
    axis: "cols",
  };
  const command = (phase: string, boundary?: number) =>
    owner.command({
      type: "split-gesture",
      phase,
      request: 1,
      gesture,
      ...(boundary === undefined ? {} : { boundary }),
    });
  function finish(index: number, actual: number, coherent = true, successor = true) {
    const p = pending[index]!;
    const resource = {
      ...state.resource!,
      layoutId: randomUUID(),
      splits: [{ ...state.resource!.splits[0]!, splitId: randomUUID(), boundary: actual }],
    };
    state = { ...state, coherent, resource };
    p.resolve({
      operationId: p.id,
      daemonInstanceId: generation,
      workspaceName: "project",
      verb: "workspace.window.split.resize",
      outcome: "applied",
      target: p.target,
      axis: "cols",
      boundary: actual,
      successor: successor ? { resource, splitId: resource.splits[0]!.splitId } : null,
    });
    return resource;
  }
  return {
    owner,
    begin,
    command,
    pending,
    finish,
    get: () => state,
    set: (next: typeof state) => {
      state = next;
    },
    changes: () => changes,
  };
}
test("one pending request coalesces final release and rebases only after coherent successor", async () => {
  const f = fixture();
  assert.equal(f.owner.command(f.begin), true);
  f.command("move", 45);
  f.command("move", 47);
  f.command("release", 50);
  assert.equal(f.pending.length, 1);
  const resource = f.finish(0, 45, false);
  await tick();
  assert.equal(f.pending.length, 1);
  assert.equal(f.owner.publication()?.phase, "pending");
  f.set({ ...f.get(), coherent: true });
  f.owner.observe();
  assert.equal(f.pending.length, 2);
  assert.equal(f.pending[1]!.target.layoutId, resource.layoutId);
  assert.equal(f.pending[1]!.target.boundary, 50);
  f.finish(1, 50);
  await tick();
  assert.equal(f.owner.publication()?.phase, "settled");
});
test("clamped pointer is not resent; a new desired pointer may continue", async () => {
  const f = fixture();
  f.owner.command(f.begin);
  f.command("move", 79);
  f.finish(0, 70);
  await tick();
  f.owner.observe();
  f.command("move", 79);
  assert.equal(f.pending.length, 1);
  f.command("release", 78);
  assert.equal(f.pending.length, 2);
  f.finish(1, 70);
  await tick();
  assert.equal(f.pending.length, 2);
  assert.equal(f.owner.publication()?.boundary, 70);
  assert.equal(f.owner.publication()?.phase, "settled");
});
test("cancel preserves pending ownership and late completion cannot revive or overwrite", async () => {
  const f = fixture();
  f.owner.command(f.begin);
  f.command("move", 45);
  f.command("cancel");
  const refused = randomUUID();
  assert.equal(f.owner.command({ ...f.begin, gesture: refused }), false);
  assert.equal(f.owner.publication()?.gesture, refused);
  assert.equal(f.owner.publication()?.phase, "failed");
  f.finish(0, 45);
  await tick();
  assert.equal(f.owner.publication()?.gesture, refused);
  assert.equal(f.owner.publication()?.phase, "failed");
  assert.equal(f.pending.length, 1);
  const r = f.get().resource!;
  assert.equal(
    f.owner.command({
      ...f.begin,
      gesture: randomUUID(),
      target: {
        window: r.window,
        layoutId: r.layoutId,
        splitId: r.splits[0]!.splitId,
        boundary: 45,
      },
    }),
    true,
  );
  f.owner.retire();
});
test("missing successor, scope replacement and geometry lease loss fail closed", async () => {
  for (const failure of ["successor", "scope", "lease"] as const) {
    const f = fixture();
    f.owner.command(f.begin);
    f.command("move", 45);
    if (failure === "scope") f.set({ ...f.get(), lifetime: "replacement" });
    if (failure === "lease") f.set({ ...f.get(), geometryOwned: false });
    f.finish(0, 45, true, failure !== "successor");
    await tick();
    assert.equal(f.owner.publication()?.phase, "failed");
    assert.equal(f.pending.length, 1);
  }
});
test("output-only refresh survives but foreign idle geometry and stale commands do not", () => {
  const f = fixture();
  f.owner.command(f.begin);
  const beforeChanges = f.changes();
  f.set(structuredClone(f.get()));
  f.owner.observe();
  assert.equal(f.changes(), beforeChanges);
  assert.equal(f.owner.publication()?.phase, "dragging");
  assert.equal(
    f.owner.command({
      type: "split-gesture",
      phase: "move",
      request: 2,
      gesture: f.begin.gesture,
      boundary: 45,
    }),
    false,
  );
  f.set({ ...f.get(), resource: { ...f.get().resource!, layoutId: randomUUID() } });
  f.owner.observe();
  assert.equal(f.owner.publication()?.phase, "failed");
  assert.equal(f.pending.length, 0);
});
test("pending canonical wait is bounded and late completion remains inert", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.owner.command(f.begin);
  f.command("move", 45);
  t.mock.timers.tick(5001);
  assert.equal(f.owner.publication()?.phase, "failed");
  f.finish(0, 45);
  await tick();
  assert.equal(f.owner.publication()?.phase, "failed");
});
test("wire is strict and begin requires exact observed boundary and coherent ownership", () => {
  const f = fixture();
  assert.equal(splitGestureSchema.safeParse({ ...f.begin, nativePath: [0] }).success, false);
  assert.equal(f.owner.command({ ...f.begin, target: { ...f.begin.target, boundary: 40 } }), false);
  f.set({ ...f.get(), coherent: false });
  assert.equal(f.owner.command(f.begin), false);
  f.set({ ...f.get(), coherent: true, geometryOwned: false });
  assert.equal(f.owner.command(f.begin), false);
  assert.equal(f.pending.length, 0);
});

test("pending missing canvas remains inert and cancellation after release stays terminal", async () => {
  const f = fixture();
  f.owner.command(f.begin);
  f.command("release", 45);
  const previous = f.get();
  f.set({ ...previous, coherent: false, resource: null });
  f.owner.observe();
  assert.equal(f.owner.publication()?.phase, "pending");
  assert.equal(f.command("cancel"), true);
  f.set(previous);
  f.finish(0, 45);
  await tick();
  assert.equal(f.owner.publication()?.phase, "cancelled");
});
test("receipt does not settle against a different complete canonical resource", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.owner.command(f.begin);
  f.command("release", 45);
  f.finish(0, 45, false);
  await tick();
  f.set({ ...f.get(), coherent: true, resource: { ...f.get().resource!, layoutId: randomUUID() } });
  f.owner.observe();
  assert.equal(f.owner.publication()?.phase, "pending");
  t.mock.timers.tick(5001);
  assert.equal(f.owner.publication()?.phase, "failed");
  assert.equal(f.pending.length, 1);
});

test("window identity ignores object key ordering at begin and during observation", () => {
  const f = fixture();
  const w = f.get().window;
  f.set({
    ...f.get(),
    window: {
      liveSessionId: w.liveSessionId,
      linkId: w.linkId,
      linkRevision: w.linkRevision,
      expectedSemanticWindowId: w.expectedSemanticWindowId,
    },
  });
  assert.equal(f.owner.command(f.begin), true);
  f.set({ ...f.get(), window: structuredClone(w) });
  f.owner.observe();
  assert.equal(f.owner.publication()?.phase, "dragging");
  f.owner.retire();
});

test("well-formed stale target or lost lease begins receive a failure ACK and fresh gestures recover", () => {
  for (const failure of ["target", "lease"] as const) {
    const f = fixture();
    const initial = f.get();
    if (failure === "lease") f.set({ ...initial, geometryOwned: false });
    const rejected =
      failure === "target"
        ? { ...f.begin, target: { ...f.begin.target, layoutId: randomUUID() } }
        : f.begin;
    assert.equal(f.owner.command(rejected), false);
    assert.equal(f.owner.publication()?.gesture, rejected.gesture);
    assert.equal(f.owner.publication()?.phase, "failed");
    assert.equal(f.owner.publication()?.target, null);
    assert.equal(f.pending.length, 0);
    f.set(initial);
    const corrected = { ...f.begin, gesture: randomUUID() };
    assert.equal(f.owner.command(corrected), true);
    assert.equal(f.owner.publication()?.gesture, corrected.gesture);
    assert.equal(f.owner.publication()?.phase, "dragging");
    f.owner.retire();
  }
});
