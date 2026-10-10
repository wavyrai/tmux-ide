import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSplitLayoutReader, splitLayoutMatches } from "./split-layout.ts";
import type { WindowSplitLayoutResource } from "../../../packages/contracts/src/window-split-layout.ts";
import type { Layout } from "./topology.ts";
const target = {
  liveSessionId: `live-session.${"a".repeat(20)}`,
  linkId: `window-link.${"b".repeat(32)}`,
  linkRevision: 1,
  expectedSemanticWindowId: "window.test",
};
const layout: Layout = {
  type: "layout",
  semanticWindowId: "window.test",
  windowName: "Test",
  currentWindow: true,
  cols: 81,
  rows: 24,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [
    { pane: "pane.a", left: 0, top: 0, width: 40, height: 24, active: true },
    { pane: "pane.b", left: 41, top: 0, width: 40, height: 24, active: false },
  ],
};
const resource = (): WindowSplitLayoutResource => ({
  version: 1,
  window: target,
  layoutId: randomUUID(),
  cols: 81,
  rows: 24,
  panes: layout.panes.map((p) => ({
    semanticPaneId: p.pane!,
    left: p.left,
    top: p.top,
    width: p.width,
    height: p.height,
  })),
  splits: [{ splitId: randomUUID(), axis: "cols", boundary: 40, start: 0, length: 24 }],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("publishes only matching canonical geometry and ignores output/label-only changes", async () => {
  let calls = 0;
  const r = createSplitLayoutReader({
    read: async () => {
      calls++;
      return resource();
    },
    changed: () => {},
  });
  r.update(target, layout, 1);
  await tick();
  assert.ok(r.current());
  r.update(target, { ...layout, windowName: "renamed" }, 1);
  await tick();
  assert.equal(calls, 1);
  const exported = r.current()!;
  exported.splits[0].boundary = 1;
  assert.equal(r.current()!.splits[0].boundary, 40);
  assert.equal(splitLayoutMatches(resource(), { ...layout, zoomed: true }), false);
  r.dispose();
  assert.equal(r.current(), null);
});
test("retires old reads on lifetime change even if cancellation is ignored", async () => {
  const pending: Array<(r: WindowSplitLayoutResource) => void> = [];
  const signals: AbortSignal[] = [];
  const r = createSplitLayoutReader({
    read: (_t, s) => {
      signals.push(s);
      return new Promise((resolve) => pending.push(resolve));
    },
    changed: () => {},
  });
  r.update(target, layout, 1);
  await tick();
  r.update(target, layout, 2);
  await tick();
  assert.equal(signals[0].aborted, true);
  pending[0](resource());
  await tick();
  assert.equal(r.current(), null);
  pending[1](resource());
  await tick();
  assert.ok(r.current());
  r.update(null, undefined, 2);
  assert.equal(r.current(), null);
  r.dispose();
});
test("wrong link or geometry never grants handles; unsupported reads do not retry on output", async () => {
  for (const bad of [
    { ...resource(), window: { ...target, linkRevision: 2 } },
    { ...resource(), cols: 82 },
  ]) {
    const r = createSplitLayoutReader({ read: async () => bad, changed: () => {} });
    r.update(target, layout, 1);
    await tick();
    assert.equal(r.current(), null);
    r.dispose();
  }
  let calls = 0;
  const r = createSplitLayoutReader({
    read: async () => {
      calls++;
      throw Error("unsupported");
    },
    changed: () => {},
  });
  r.update(target, layout, 1);
  await tick();
  r.update(target, layout, 1);
  await tick();
  assert.equal(calls, 1);
  r.dispose();
});
