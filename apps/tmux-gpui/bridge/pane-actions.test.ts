import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SessionRuntimeSemanticIntent } from "../../../packages/contracts/src/index.ts";
import {
  createPaneActionExecutor,
  createPaneActionFence,
  paneActionSchema,
  type PaneActionTarget,
  type PaneAction,
} from "./pane-actions.ts";
import type { Layout } from "./topology.ts";
const layout: Layout = {
  type: "layout",
  semanticWindowId: "window-a",
  windowName: "A",
  currentWindow: true,
  cols: 80,
  rows: 24,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [
    { pane: "pane-a", displayName: "A", left: 0, top: 0, width: 80, height: 24, active: true },
  ],
};
function fixture(action: "rename" | "zoom" = "rename") {
  let target: PaneActionTarget | null = {
    token: randomUUID(),
    id: "pane-a",
    generation: randomUUID(),
    workspace: "workspace-a",
    window: "window-a",
    lifetime: "life-a",
  };
  const command: PaneAction =
    action === "rename"
      ? {
          type: "pane-action",
          request: 2,
          id: "pane-a",
          token: target.token,
          action,
          name: "Renamed",
        }
      : {
          type: "pane-action",
          request: 2,
          id: "pane-a",
          token: target.token,
          action,
          desired: "zoomed",
        };
  let input = true,
    geometry = true;
  const calls: SessionRuntimeSemanticIntent[] = [];
  const runtime = {
    ownsConnectionAuthority: (kind: string) => (kind === "input" ? input : geometry),
    requestAuthority: async () => {
      geometry = true;
      return {} as never;
    },
    submitIntent: async (operationId: string, intent: SessionRuntimeSemanticIntent) => {
      calls.push(intent);
      const common = {
        operationId,
        daemonInstanceId: target!.generation,
        workspaceName: target!.workspace,
        outcome: "applied",
      };
      return (
        intent.verb === "workspace.rename"
          ? { ...common, verb: intent.verb, scope: "pane", name: "Renamed" }
          : {
              ...common,
              verb: "workspace.pane.zoom.toggle",
              semanticPaneId: "pane-a",
              zoomed: true,
            }
      ) as never;
    },
  };
  return {
    command,
    runtime,
    calls,
    current: () => target,
    setTarget: (value: PaneActionTarget | null) => {
      target = value;
    },
    setInput: (value: boolean) => {
      input = value;
    },
    setGeometry: (value: boolean) => {
      geometry = value;
    },
  };
}
test("schema rejects controls/blank/oversize names and blind toggle", () => {
  const f = fixture();
  for (const name of ["", " leading", "trailing ", "a\n", "x\x1b[31m", "x".repeat(81)])
    assert.equal(paneActionSchema.safeParse({ ...f.command, name }).success, false);
  assert.equal(
    paneActionSchema.safeParse({ ...fixture("zoom").command, desired: "toggle" }).success,
    false,
  );
  assert.equal(paneActionSchema.safeParse({ ...f.command, name: "合法 name" }).success, true);
});
test("action fence supports zoomed/single panes and retires on title/topology/lifetime changes", () => {
  const fence = createPaneActionFence();
  const first = fence.current(layout, "pane-a", "life-a")!;
  assert.equal(fence.current({ ...layout }, "pane-a", "life-a")!.token, first.token);
  const zoomed = fence.current({ ...layout, zoomed: true }, "pane-a", "life-a")!;
  assert.equal(zoomed.zoomed, true);
  assert.notEqual(zoomed.token, first.token);
  const unzoomed = fence.current(layout, "pane-a", "life-a")!;
  assert.notEqual(unzoomed.token, zoomed.token);
  const newLifetime = fence.current(layout, "pane-a", "life-b")!;
  assert.notEqual(newLifetime.token, unzoomed.token);
  const renamed = { ...layout, panes: [{ ...layout.panes[0]!, displayName: "New" }] };
  const newTitle = fence.current(renamed, "pane-a", "life-b")!;
  assert.notEqual(newTitle.token, newLifetime.token);
  const resized = fence.current(
    { ...renamed, cols: 81, panes: [{ ...renamed.panes[0]!, width: 81 }] },
    "pane-a",
    "life-b",
  )!;
  assert.notEqual(resized.token, newTitle.token);
  assert.equal(fence.current(layout, "missing", "life-a"), null);
  fence.invalidate();
  assert.notEqual(fence.current(layout, "pane-a", "life-a")!.token, first.token);
});
for (const action of ["rename", "zoom"] as const)
  test(`${action} submits exact semantic action once and validates receipt`, async () => {
    const f = fixture(action),
      execute = createPaneActionExecutor();
    assert.equal(await execute(f.runtime, f.current, f.command), true);
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      f.calls[0],
      action === "rename"
        ? {
            verb: "workspace.rename",
            workspaceName: "workspace-a",
            scope: "pane",
            semanticPaneId: "pane-a",
            name: "Renamed",
          }
        : {
            verb: "workspace.pane.zoom.toggle",
            workspaceName: "workspace-a",
            semanticPaneId: "pane-a",
            desired: "zoomed",
          },
    );
  });
test("stale token, foreign pane and lost input never dispatch", async () => {
  for (const mode of ["token", "pane", "input"]) {
    const f = fixture();
    if (mode === "token") f.setTarget({ ...f.current()!, token: randomUUID() });
    if (mode === "pane") f.setTarget({ ...f.current()!, id: "other" });
    if (mode === "input") f.setInput(false);
    assert.equal(await createPaneActionExecutor()(f.runtime, f.current, f.command), false);
    assert.equal(f.calls.length, 0);
  }
});
test("geometry grant cannot cross pane lifetime or token changes", async () => {
  for (const field of ["lifetime", "token"]) {
    const f = fixture("zoom");
    f.setGeometry(false);
    f.runtime.requestAuthority = async () => {
      f.setGeometry(true);
      f.setTarget({ ...f.current()!, [field]: randomUUID() });
      return {} as never;
    };
    assert.equal(await createPaneActionExecutor()(f.runtime, f.current, f.command), false);
    assert.equal(f.calls.length, 0);
  }
});
test("mismatched and replayed receipts fail without retry; rejected mutation stays consumed", async () => {
  for (const patch of [
    { operationId: randomUUID() },
    { daemonInstanceId: randomUUID() },
    { workspaceName: "other" },
    { scope: "window" },
    { name: "other" },
    { outcome: "replayed" },
  ]) {
    const f = fixture(),
      execute = createPaneActionExecutor(),
      submit = f.runtime.submitIntent;
    f.runtime.submitIntent = async (...args) =>
      ({ ...((await submit(...args)) as Record<string, unknown>), ...patch }) as never;
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    assert.equal(f.calls.length, 1);
  }
  const f = fixture(),
    execute = createPaneActionExecutor();
  let calls = 0;
  f.runtime.submitIntent = async () => {
    calls++;
    throw new Error("mutation_unverified");
  };
  await assert.rejects(execute(f.runtime, f.current, f.command));
  assert.equal(await execute(f.runtime, f.current, f.command), false);
  assert.equal(calls, 1);
});
test("zoom result must match explicit desired pane/state and retirement cannot report success", async () => {
  for (const mode of ["pane", "state", "retired"]) {
    const f = fixture("zoom"),
      submit = f.runtime.submitIntent;
    f.runtime.submitIntent = async (...args) => {
      const result = await submit(...args);
      if (mode === "retired") f.setTarget(null);
      return {
        ...(result as Record<string, unknown>),
        ...(mode === "pane"
          ? { semanticPaneId: "other" }
          : mode === "state"
            ? { zoomed: false }
            : {}),
      } as never;
    };
    assert.equal(await createPaneActionExecutor()(f.runtime, f.current, f.command), false);
  }
});
