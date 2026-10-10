import { expect, it } from "vitest";
import { parseLayoutTree } from "../protocol/layout-parse.ts";
import {
  SplitLayoutPublicationPending,
  type NativeSplitLayoutSnapshot,
} from "./session-channel.ts";
import { WindowSplitAuthority } from "./window-split-authority.ts";
const epoch = "11111111-1111-4111-8111-111111111111";
const window = {
  liveSessionId: `live-session.${"a".repeat(20)}`,
  linkId: `window-link.${"a".repeat(32)}`,
  expectedSemanticWindowId: "window.one",
  linkRevision: 1,
};
const rawLayout =
  "abcd,19x7,0,0{9x7,0,0[9x3,0,0{4x3,0,0,1,4x3,5,0,2},9x3,0,4{4x3,0,4,3,4x3,5,4,4}],9x7,10,0[9x3,10,0{4x3,10,0,5,4x3,15,0,6},9x3,10,4{4x3,10,4,7,4x3,15,4,8}]}";
function rig() {
  let snapshot: NativeSplitLayoutSnapshot = {
    runtimeSessionId: "$1",
    runtimeWindowId: "@2",
    sessionName: "proof",
    sessionCreated: "42",
    semanticWindowId: "window.one",
    rawLayout,
    panes: Array.from({ length: 8 }, (_, i) => ({
      runtimePaneId: `%${i + 1}`,
      semanticPaneId: `pane.${i + 1}`,
      nativePaneBirthId: `${i + 1}`,
    })),
  };
  let nativeEpoch: string | null = epoch;
  let failed = false;
  let pending = false;
  const authority = new WindowSplitAuthority({
    describe: () => {
      if (failed) throw Error("canonical unavailable");
      if (pending) throw new SplitLayoutPublicationPending();
      return snapshot;
    },
    serverEpoch: () => nativeEpoch,
  });
  const resource = authority.read(window);
  const target = {
    window,
    layoutId: resource.layoutId,
    splitId: resource.splits[0]!.splitId,
    boundary: 12,
  };
  return {
    authority,
    pending: (value: boolean) => {
      pending = value;
    },
    resource,
    target,
    change: (update: Partial<NativeSplitLayoutSnapshot>) => {
      snapshot = { ...snapshot, ...update };
    },
    snapshot: () => snapshot,
    retireEpoch: () => {
      nativeEpoch = null;
    },
    fail: () => {
      failed = true;
    },
  };
}
it("projects all nested native edges and resolves the ancestor using a private path", () => {
  const r = rig();
  expect(r.resource.panes).toHaveLength(8);
  expect(r.resource.splits).toHaveLength(7);
  expect(r.resource.splits[0]).toMatchObject({ axis: "cols", boundary: 9, start: 0, length: 7 });
  const serialized = JSON.stringify(r.resource);
  for (const secret of [
    "rawLayout",
    "runtimePaneId",
    "nativePaneBirthId",
    "runtimeWindowId",
    "path",
    rawLayout,
  ])
    expect(serialized).not.toContain(secret);
  expect(r.authority.resolve(r.target)).toEqual({
    request: {
      sessionId: "$1",
      windowId: "@2",
      expectedLayout: rawLayout,
      path: [0],
      axis: "cols",
      boundary: 12,
    },
    serverEpoch: epoch,
    session: { id: "$1", name: "proof", created: "42" },
    anchor: { paneId: "%1", paneBirthId: "1" },
  });
  const inner = r.resource.splits.find(
    (split) => split.axis === "cols" && split.start === 4 && split.boundary === 4,
  )!;
  expect(r.authority.resolve({ ...r.target, splitId: inner.splitId }).request.path).toEqual([
    0, 1, 0,
  ]);
});
it("keeps handles stable for unchanged state but returns detached public objects", () => {
  const r = rig();
  const original = structuredClone(r.resource);
  r.resource.panes[0]!.width = 4096;
  r.resource.splits.length = 0;
  expect(r.authority.read(window)).toEqual(original);
  r.change({ panes: [...r.snapshot().panes].reverse() });
  expect(r.authority.read(window)).toEqual(original);
  const resolved = r.authority.resolve(r.target);
  (resolved.request.path as number[])[0] = 7;
  expect(r.authority.resolve(r.target).request.path).toEqual([0]);
});
it.each([
  "layout",
  "birth",
  "semantic",
  "session",
  "window",
  "epoch",
  "unavailable",
  "dispose",
] as const)("retires stale %s observation without trusting old handles", (change) => {
  const r = rig();
  if (change === "layout") r.change({ rawLayout: rawLayout.replace("abcd", "dcba") });
  if (change === "birth")
    r.change({
      panes: r.snapshot().panes.map((p, i) => (i === 0 ? { ...p, nativePaneBirthId: "99" } : p)),
    });
  if (change === "semantic")
    r.change({
      panes: r.snapshot().panes.map((p, i) => (i === 0 ? { ...p, semanticPaneId: "pane.new" } : p)),
    });
  if (change === "session") r.change({ runtimeSessionId: "$9" });
  if (change === "window") r.change({ runtimeWindowId: "@9" });
  if (change === "epoch") r.retireEpoch();
  if (change === "unavailable") r.fail();
  if (change === "dispose") r.authority.dispose();
  expect(() => r.authority.resolve(r.target)).toThrow("unavailable or stale");
});
it("refuses forged tokens without evicting another viewer's valid handle", () => {
  const r = rig();
  expect(() => r.authority.resolve({ ...r.target, splitId: epoch })).toThrow();
  expect(() => r.authority.resolve({ ...r.target, layoutId: epoch })).toThrow();
  expect(() =>
    r.authority.resolve({ ...r.target, window: { ...window, linkRevision: 2 } }),
  ).toThrow();
  expect(r.authority.resolve(r.target).request.path).toEqual([0]);
});
it.each([
  "missing",
  "extra",
  "duplicate",
  "zero-birth",
  "duplicate-semantic",
  "invalid-tree",
] as const)("rejects incomplete identity projection: %s", (kind) => {
  const r = rig();
  const panes = [...r.snapshot().panes];
  if (kind === "missing") panes.pop();
  if (kind === "extra")
    panes.push({ runtimePaneId: "%99", semanticPaneId: "pane.99", nativePaneBirthId: "99" });
  if (kind === "duplicate") panes[1] = panes[0]!;
  if (kind === "zero-birth") panes[0] = { ...panes[0]!, nativePaneBirthId: "0" };
  if (kind === "duplicate-semantic") panes[1] = { ...panes[1]!, semanticPaneId: "pane.1" };
  r.change({ panes, ...(kind === "invalid-tree" ? { rawLayout: "bad" } : {}) });
  expect(() => r.authority.read(window)).toThrow();
  expect(() => r.authority.resolve(r.target)).toThrow();
});
it("bounds retained window handles and invalidates evicted observations", () => {
  const r = rig();
  for (let i = 1; i <= 32; i++)
    r.authority.read({ ...window, linkId: `window-link.${i.toString(16).padStart(32, "0")}` });
  expect(() => r.authority.resolve(r.target)).toThrow();
  const latest = r.authority.read(window);
  expect(latest.layoutId).not.toBe(r.target.layoutId);
});

it("refuses a deep 256-pane layout that exceeds native serialization admission", () => {
  const r = rig();
  const native = (first: number, count: number, left: number): string => {
    if (count === 1) return `1x1,${left},0,${first}`;
    const half = count / 2;
    return `${count * 2 - 1}x1,${left},0{${native(first, half, left)},${native(first + half, half, left + count)}}`;
  };
  r.change({
    rawLayout: `abcd,${native(1, 256, 0)}`,
    panes: Array.from({ length: 256 }, (_, index) => ({
      runtimePaneId: `%${index + 1}`,
      semanticPaneId: `pane.${index + 1}`,
      nativePaneBirthId: String(index + 1),
    })),
  });
  expect(parseLayoutTree(r.snapshot().rawLayout)).not.toBeNull();
  expect(Buffer.byteLength(r.snapshot().rawLayout)).toBeLessThan(8192);
  expect(() => r.authority.read(window)).toThrow();
});

it("issues the captured split successor only after full canonical post-layout publication", () => {
  const r = rig();
  const before = "abcd,81x24,0,0{40x24,0,0,1,40x24,41,0,2}";
  const after = "abcd,81x24,0,0{50x24,0,0,1,30x24,51,0,2}";
  r.change({ rawLayout: before, panes: r.snapshot().panes.slice(0, 2) });
  const start = r.authority.read(window);
  const target = {
    window,
    layoutId: start.layoutId,
    splitId: start.splits[0]!.splitId,
    boundary: 50,
  };
  const observe = r.authority.prepareSuccessor(target);
  expect(observe(after)).toBeUndefined();
  r.pending(true);
  expect(observe(after)).toBeUndefined();
  r.pending(false);
  r.change({ rawLayout: after });
  const next = observe(after)!;
  expect(next.resource).toEqual(r.authority.read(window));
  expect(next.resource.layoutId).not.toBe(start.layoutId);
  expect(next.resource.splits.find((s) => s.splitId === next.splitId)?.boundary).toBe(50);
  expect(() => r.authority.resolve(target)).toThrow();
  expect(
    r.authority.resolve({
      window,
      layoutId: next.resource.layoutId,
      splitId: next.splitId,
      boundary: 55,
    }).request.path,
  ).toEqual([0]);
});

it("returns an immediate successor for an unchanged clamp and refuses lifetime/external changes", () => {
  for (const change of ["noop", "birth", "layout", "dispose"] as const) {
    const r = rig();
    const observe = r.authority.prepareSuccessor(r.target);
    if (change === "birth")
      r.change({
        panes: r.snapshot().panes.map((p, i) => (i ? p : { ...p, nativePaneBirthId: "999" })),
      });
    if (change === "layout")
      r.change({ rawLayout: r.snapshot().rawLayout.replace("abcd,", "ffff,") });
    if (change === "dispose") r.authority.dispose();
    const result = observe(rawLayout);
    if (change === "noop") expect(result?.resource).toEqual(r.resource);
    else expect(result).toBeNull();
  }
});
