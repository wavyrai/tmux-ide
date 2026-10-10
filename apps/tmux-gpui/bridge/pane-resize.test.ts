import type { SessionRuntimeSemanticIntent } from "../../../packages/contracts/src/index.ts";
import type { WorkspacePaneResizeResult } from "../../../packages/contracts/src/workspace-multiplexer.ts";
import { contentRect } from "./window-canvas.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createPaneResizeFence,
  paneResizeSchema,
  resizePane,
  resizePresentationMatches,
  type ResizeTarget,
} from "./pane-resize.ts";
import type { Layout } from "./topology.ts";
const layout: Layout = {
  type: "layout",
  semanticWindowId: "window-a",
  windowName: "A",
  currentWindow: true,
  cols: 81,
  rows: 24,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [
    { pane: "pane-a", displayName: "A", left: 0, top: 0, width: 40, height: 24, active: true },
    { pane: "pane-b", displayName: "B", left: 41, top: 0, width: 40, height: 24, active: false },
  ],
};
test("fence survives content/name/focus changes, retires on topology and pane lifetime changes", () => {
  const fence = createPaneResizeFence();
  const first = fence(layout, 1);
  assert.equal(
    fence(
      {
        ...layout,
        windowName: "renamed",
        panes: layout.panes.map((p) => ({ ...p, active: !p.active, displayName: "renamed" })),
      },
      1,
    ),
    first,
  );
  assert.notEqual(fence(layout, 2), first);
  const second = fence(layout, 2);
  assert.notEqual(fence({ ...layout, cols: 82 }, 2), second);
  assert.equal(fence(undefined, 2), null);
  assert.notEqual(fence(layout, 2), first);
});
test("cached old resize canvas cannot grant token for current geometry", () => {
  const regions = layout.panes.map((p) => ({
    id: p.pane!,
    left: p.left,
    top: p.top,
    width: p.width,
    height: p.height,
  }));
  assert.equal(resizePresentationMatches(layout, regions), true);
  assert.equal(
    resizePresentationMatches(
      { ...layout, panes: [{ ...layout.panes[0], width: 41 }, layout.panes[1]] },
      regions,
    ),
    false,
  );
  assert.equal(resizePresentationMatches(layout, regions.slice(1)), false);
  assert.equal(resizePresentationMatches({ ...layout, paneBorderStatus: "top" }, regions), true);
});
test("zoom and single-pane layouts revoke gestures; restored splits get a fresh token", () => {
  const fence = createPaneResizeFence();
  const first = fence(layout, 1);
  const regions = layout.panes.map((p) => ({
    id: p.pane!,
    left: p.left,
    top: p.top,
    width: p.width,
    height: p.height,
  }));
  const zoomed = { ...layout, zoomed: true };
  assert.equal(resizePresentationMatches(zoomed, regions), false);
  assert.equal(fence(zoomed, 1), null);
  const restored = fence(layout, 1);
  assert.ok(restored);
  assert.notEqual(restored, first);
  const single = { ...layout, panes: [layout.panes[0]] };
  assert.equal(resizePresentationMatches(single, regions.slice(0, 1)), false);
  assert.equal(fence(single, 1), null);
  assert.notEqual(fence(layout, 1), restored);
});
function fixture() {
  let target: ResizeTarget | null = {
    token: randomUUID(),
    generation: randomUUID(),
    workspace: "workspace-a",
    window: "window-a",
    lifetime: "inc-1",
    statusRows: 0,
  };
  const command = {
    type: "resize-pane" as const,
    request: 7,
    id: "pane-a",
    token: target.token,
    axis: "cols" as "cols" | "rows",
    cells: 30,
  };
  let owned = true;
  const calls: unknown[] = [];
  const runtime = {
    ownsConnectionAuthority: () => owned,
    requestAuthority: async () => {
      owned = true;
      return {} as never;
    },
    submitIntent: async (operationId: string, intent: SessionRuntimeSemanticIntent) => {
      calls.push(intent);
      assert.equal(intent.verb, "workspace.pane.resize");
      return {
        operationId,
        daemonInstanceId: target!.generation,
        outcome: "applied",
        ...intent,
      } as WorkspacePaneResizeResult;
    },
  };
  return {
    command,
    runtime,
    calls,
    current: () => target,
    set: (next: ResizeTarget | null) => {
      target = next;
    },
    unowned: () => {
      owned = false;
    },
  };
}
test("exact semantic target and clamped receipt; outer status row converted once", async () => {
  for (const status of ["off", "top", "bottom"] as const) {
    const paneLayout = { ...layout, paneBorderStatus: status };
    const statusRows = layout.panes[0].height - contentRect(paneLayout, layout.panes[0]).rows;
    const f = fixture();
    f.command.axis = "rows";
    f.set({ ...f.current()!, statusRows });
    const receipt = await resizePane(f.runtime, f.current, f.command);
    assert.ok(receipt);
    assert.equal(receipt.cells, 30 - statusRows);
    assert.equal(receipt.axis, "rows");
    assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(f.calls, [
      {
        verb: "workspace.pane.resize",
        workspaceName: "workspace-a",
        semanticPaneId: "pane-a",
        axis: "rows",
        cells: 30 - statusRows,
      },
    ]);
  }
});
test("stale and missing targets cannot even acquire geometry authority", async () => {
  const f = fixture();
  f.unowned();
  f.runtime.requestAuthority = async () => {
    throw Error("must not acquire");
  };
  f.command.token = randomUUID();
  assert.equal(await resizePane(f.runtime, f.current, f.command), null);
  f.set(null);
  assert.equal(await resizePane(f.runtime, f.current, f.command), null);
  assert.equal(f.calls.length, 0);
});
test("authority wait revalidates token, lifetime and exact window", async () => {
  for (const field of ["token", "lifetime", "window", "generation"] as const) {
    const f = fixture();
    f.unowned();
    f.runtime.requestAuthority = async () => {
      f.set({ ...f.current()!, [field]: randomUUID() });
      return {} as never;
    };
    assert.equal(await resizePane(f.runtime, f.current, f.command), null);
    assert.equal(f.calls.length, 0);
  }
});
test("post-dispatch replacement and foreign receipts never claim success", async () => {
  for (const field of ["operationId", "daemonInstanceId", "semanticPaneId", "axis", "outcome"]) {
    const f = fixture();
    const submit = f.runtime.submitIntent;
    f.runtime.submitIntent = async (...args) =>
      ({ ...(await submit(...args)), [field]: "foreign" }) as WorkspacePaneResizeResult;
    assert.equal(await resizePane(f.runtime, f.current, f.command), null);
  }
  const f = fixture();
  const submit = f.runtime.submitIntent;
  f.runtime.submitIntent = async (...args) => {
    const result = await submit(...args);
    f.set(null);
    return result;
  };
  assert.equal(await resizePane(f.runtime, f.current, f.command), null);
});
test("malformed and oversized resize rejected", () => {
  const f = fixture();
  for (const change of [
    { cells: 1 },
    { cells: 1001 },
    { axis: "rows", cells: 501 },
    { token: "bad" },
    { request: 0 },
    { extra: 1 },
  ])
    assert.equal(paneResizeSchema.safeParse({ ...f.command, ...change }).success, false);
});

test("clamped readback preserves exact validated operation identity and actual cells", async () => {
  for (const outcome of ["applied", "unchanged"] as const) {
    const f = fixture();
    let operation = "";
    const submit = f.runtime.submitIntent;
    f.runtime.submitIntent = async (...args) => {
      operation = args[0];
      const result = await submit(...args);
      // A legitimate resize changes geometry, not the pane lifetime.
      f.set({ ...f.current()!, token: randomUUID() });
      return { ...result, cells: 19, outcome };
    };
    const receipt = await resizePane(f.runtime, f.current, f.command);
    assert.deepEqual(receipt, {
      operationId: operation,
      daemonInstanceId: f.current()!.generation,
      outcome,
      verb: "workspace.pane.resize",
      workspaceName: "workspace-a",
      semanticPaneId: "pane-a",
      axis: "cols",
      cells: 19,
    });
    assert.notEqual(receipt!.cells, f.command.cells);
    assert.ok(Object.isFrozen(receipt));
  }
});
test("schema-valid foreign operation/generation/axis receipts and replaced lifetime are rejected", async () => {
  for (const change of [
    { operationId: randomUUID() },
    { daemonInstanceId: randomUUID() },
    { axis: "rows" as const },
    { workspaceName: "another-workspace" },
  ]) {
    const f = fixture();
    const submit = f.runtime.submitIntent;
    f.runtime.submitIntent = async (...args) => ({ ...(await submit(...args)), ...change });
    assert.equal(await resizePane(f.runtime, f.current, f.command), null);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture();
  const submit = f.runtime.submitIntent;
  f.runtime.submitIntent = async (...args) => {
    const result = await submit(...args);
    f.set({ ...f.current()!, lifetime: "inc-2" });
    return result;
  };
  assert.equal(await resizePane(f.runtime, f.current, f.command), null);
  assert.equal(f.calls.length, 1);
});

test("controller-supplied operation UUID is preserved and malformed ID fails before authority", async () => {
  const f = fixture();
  const operation = randomUUID();
  assert.equal(
    (await resizePane(f.runtime, f.current, f.command, operation))?.operationId,
    operation,
  );
  f.unowned();
  f.runtime.requestAuthority = async () => {
    throw Error("must not acquire");
  };
  await assert.rejects(resizePane(f.runtime, f.current, f.command, "not-an-operation"));
  assert.equal(f.calls.length, 1);
});
