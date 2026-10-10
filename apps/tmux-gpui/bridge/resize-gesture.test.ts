import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import {
  createResizeGestureOwner,
  resizeGestureSchema,
  type GestureTarget,
} from "./resize-gesture.ts";
function harness(statusRows = 0) {
  let target: GestureTarget | null = {
    token: randomUUID(),
    generation: randomUUID(),
    workspace: "workspace-a",
    window: "window-a",
    lifetime: "inc1",
    presentationEpoch: 1,
    statusRows,
    cells: 40,
    geometryOwned: true,
    coherent: true,
    layout: {
      type: "layout",
      semanticWindowId: "window-a",
      windowName: "A",
      currentWindow: true,
      cols: 81,
      rows: 24,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [
        { pane: "pane-a", left: 0, top: 0, width: 40, height: 24, active: true },
        { pane: "pane-b", left: 41, top: 0, width: 40, height: 24, active: false },
      ],
    },
  };
  const submissions: { id: string; intent: any; resolve: (v: unknown) => void }[] = [];
  const runtime = {
    ownsConnectionAuthority: () => target?.geometryOwned ?? false,
    requestAuthority: async () => ({}),
    submitIntent: (id: string, intent: any) =>
      new Promise((resolve) => submissions.push({ id, intent, resolve })),
  } as unknown as PaneStreamRuntimeClient;
  const owner = createResizeGestureOwner({
    runtime: () => runtime,
    current: () => target,
    changed: () => {},
  });
  const begin = {
    type: "resize-gesture" as const,
    phase: "begin" as const,
    request: 1,
    gesture: randomUUID(),
    id: "pane-a",
    axis: "cols" as const,
    token: target.token,
    cells: 40,
  };
  const identity = {
    type: begin.type,
    request: 1,
    gesture: begin.gesture,
    id: begin.id,
    axis: begin.axis,
  };
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    owner,
    begin,
    identity,
    submissions,
    tick,
    target: () => target!,
    set: (v: GestureTarget | null) => {
      target = v;
    },
    receipt: (index: number, cells: number) => {
      const s = submissions[index];
      s.resolve({
        ...s.intent,
        operationId: s.id,
        daemonInstanceId: target!.generation,
        outcome: "applied",
        cells,
      });
    },
    layout: (cells: number) => {
      target = {
        ...target!,
        cells,
        token: randomUUID(),
        layout: {
          ...target!.layout,
          panes: [
            { ...target!.layout.panes[0], width: cells },
            { ...target!.layout.panes[1], left: cells + 1, width: 80 - cells },
          ],
        },
      };
      owner.observe();
    },
  };
}
test("one pending and latest; receipt alone never settles, final release exact target waits for layout", async () => {
  const h = harness();
  try {
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, phase: "move", cells: 45 });
    h.owner.command({ ...h.identity, phase: "move", cells: 47 });
    h.owner.command({ ...h.identity, phase: "release", cells: 49 });
    assert.equal(h.submissions.length, 1);
    assert.equal(h.submissions[0].intent.cells, 45);
    h.receipt(0, 44);
    await h.tick();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.owner.publication()?.phase, "pending");
    h.layout(44);
    assert.equal(h.submissions.length, 2);
    assert.equal(h.submissions[1].intent.cells, 49);
    assert.notEqual(h.submissions[0].id, h.submissions[1].id);
    h.layout(48);
    assert.equal(h.owner.publication()?.phase, "pending");
    h.receipt(1, 48);
    await h.tick();
    assert.equal(h.owner.publication()?.phase, "settled");
    assert.equal(h.owner.publication()?.cells, 48);
    assert.equal(h.owner.publication()?.token, h.target().token);
  } finally {
    h.owner.retire();
  }
});
test("cancel discards queued targets, no retry, late receipt cannot resurrect gesture", async () => {
  const h = harness();
  try {
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, phase: "move", cells: 45 });
    h.owner.command({ ...h.identity, phase: "move", cells: 49 });
    h.owner.command({ ...h.identity, phase: "cancel" });
    h.layout(45);
    h.receipt(0, 45);
    await h.tick();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.owner.publication()?.phase, "cancelled");
    assert.equal(h.owner.publication()?.token, null);
    h.owner.command({ ...h.identity, phase: "release", cells: 50 });
    assert.equal(h.submissions.length, 1);
  } finally {
    h.owner.retire();
  }
});
test("lifetime, competing authority and orthogonal topology retire pending motion", async () => {
  for (const change of ["lifetime", "authority", "topology"]) {
    const h = harness();
    try {
      h.owner.command(h.begin);
      h.owner.command({ ...h.identity, phase: "move", cells: 45 });
      h.owner.command({ ...h.identity, phase: "move", cells: 49 });
      const old = h.target();
      h.set(
        change === "lifetime"
          ? { ...old, lifetime: "new" }
          : change === "authority"
            ? { ...old, geometryOwned: false }
            : { ...old, layout: { ...old.layout, rows: 25 } },
      );
      h.owner.observe();
      assert.equal(h.owner.publication()?.phase, "failed");
      h.receipt(0, 45);
      await h.tick();
      assert.equal(h.submissions.length, 1);
      assert.equal(h.owner.publication()?.phase, "failed");
    } finally {
      h.owner.retire();
    }
  }
});
test("unrelated idle geometry fails and gesture identity rejects stale moves", () => {
  const h = harness();
  try {
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, gesture: randomUUID(), phase: "move", cells: 45 });
    assert.equal(h.submissions.length, 0);
    h.layout(42);
    assert.equal(h.owner.publication()?.phase, "failed");
    assert.equal(resizeGestureSchema.safeParse({ ...h.identity, phase: "release" }).success, false);
    assert.equal(
      resizeGestureSchema.safeParse({
        ...h.identity,
        phase: "move",
        cells: 45,
        token: randomUUID(),
      }).success,
      false,
    );
  } finally {
    h.owner.retire();
  }
});

test("receipt and new layout wait for coherent surfaces instead of cancelling on resize skew", async () => {
  const h = harness();
  try {
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, phase: "move", cells: 45 });
    h.set({ ...h.target(), coherent: false });
    h.layout(45);
    h.receipt(0, 45);
    await h.tick();
    assert.equal(h.owner.publication()?.phase, "pending");
    assert.equal(h.owner.publication()?.token, null);
    h.set({ ...h.target(), coherent: true });
    h.owner.observe();
    assert.equal(h.owner.publication()?.phase, "dragging");
    assert.equal(h.owner.publication()?.token, h.target().token);
  } finally {
    h.owner.retire();
  }
});
test("unrelated same-axis redistribution cannot receive a matching-token attestation", async () => {
  const h = harness();
  try {
    // Extra split inside trailing group is outside the captured boundary cohort.
    const base = h.target();
    base.layout.panes = [
      base.layout.panes[0],
      { ...base.layout.panes[1], width: 19 },
      { pane: "pane-c", left: 61, top: 0, width: 20, height: 24, active: false },
    ];
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, phase: "move", cells: 45 });
    const changed = {
      ...h.target(),
      cells: 45,
      token: randomUUID(),
      layout: {
        ...base.layout,
        panes: [
          { ...base.layout.panes[0], width: 45 },
          { ...base.layout.panes[1], left: 46, width: 18 },
          { ...base.layout.panes[2], left: 65, width: 16 },
        ],
      },
    };
    h.set(changed);
    h.owner.observe();
    assert.equal(h.owner.publication()?.phase, "failed");
    h.receipt(0, 45);
    await h.tick();
    assert.equal(h.owner.publication()?.token, null);
  } finally {
    h.owner.retire();
  }
});

test("new gesture during cancelled in-flight operation gets an explicit refusal, old completion cannot replace it", async () => {
  const h = harness();
  try {
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, phase: "move", cells: 45 });
    h.owner.command({ ...h.identity, phase: "cancel" });
    const next = { ...h.begin, gesture: randomUUID() };
    h.owner.command(next);
    assert.equal(h.owner.publication()?.gesture, next.gesture);
    assert.equal(h.owner.publication()?.phase, "failed");
    const refusal = h.owner.publication();
    h.layout(45);
    h.receipt(0, 45);
    await h.tick();
    assert.deepEqual(h.owner.publication(), refusal);
    assert.equal(h.submissions.length, 1);
    const fresh = { ...h.begin, gesture: randomUUID(), token: h.target().token, cells: 45 };
    h.owner.command(fresh);
    assert.equal(h.owner.publication()?.gesture, fresh.gesture);
    assert.equal(h.owner.publication()?.phase, "dragging");
  } finally {
    h.owner.retire();
  }
});

test("neighbor-only lifetime epoch replacement rejects pending receipt despite identical pane IDs and geometry", async () => {
  const h = harness();
  try {
    h.owner.command(h.begin);
    h.owner.command({ ...h.identity, phase: "move", cells: 45 });
    h.owner.command({ ...h.identity, phase: "move", cells: 49 });
    const before = h.target();
    h.set({ ...before, presentationEpoch: before.presentationEpoch + 1, token: randomUUID() });
    assert.equal(h.target().lifetime, before.lifetime);
    assert.deepEqual(h.target().layout, before.layout);
    h.owner.observe();
    assert.equal(h.owner.publication()?.phase, "failed");
    h.layout(45);
    h.receipt(0, 45);
    await h.tick();
    assert.equal(h.submissions.length, 1);
    assert.equal(h.owner.publication()?.phase, "failed");
    assert.equal(h.owner.publication()?.token, null);
  } finally {
    h.owner.retire();
  }
});
