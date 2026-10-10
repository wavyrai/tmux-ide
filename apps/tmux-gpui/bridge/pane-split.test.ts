import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createPaneActionExecutor,
  paneActionSchema,
  type PaneActionTarget,
} from "./pane-actions.ts";
function fixture(direction: "right" | "down" = "right") {
  let target: PaneActionTarget | null = {
    token: randomUUID(),
    id: "pane-source",
    generation: randomUUID(),
    workspace: "workspace",
    window: "window",
    lifetime: "birth",
  };
  const command = {
    type: "pane-action" as const,
    request: 1,
    id: target.id,
    token: target.token,
    action: "split" as const,
    direction,
  };
  let input = true,
    geometry = true,
    calls = 0;
  let patch: Record<string, unknown> = {};
  const runtime = {
    ownsConnectionAuthority: (kind: string) => (kind === "input" ? input : geometry),
    requestAuthority: async () => {
      geometry = true;
      return {} as never;
    },
    submitIntent: async (operationId: string, intent: unknown) => {
      calls++;
      assert.deepEqual(intent, {
        verb: "workspace.window.split",
        workspaceName: "workspace",
        semanticPaneId: "pane-source",
        direction,
      });
      return {
        verb: "workspace.window.split",
        operationId,
        daemonInstanceId: target!.generation,
        workspaceName: "workspace",
        outcome: "applied",
        direction,
        semanticPaneId: "pane-created",
        displayTitle: "New pane",
        ...patch,
      } as never;
    },
  };
  return {
    command,
    runtime,
    current: () => target,
    calls: () => calls,
    patch: (value: Record<string, unknown>) => {
      patch = value;
    },
    retire: () => {
      target = null;
    },
    change: (value: Partial<PaneActionTarget>) => {
      target = { ...target!, ...value };
    },
    input: (value: boolean) => {
      input = value;
    },
    geometry: (value: boolean) => {
      geometry = value;
    },
  };
}
for (const direction of ["right", "down"] as const)
  test(`split ${direction} returns exact new-pane receipt once`, async () => {
    const f = fixture(direction),
      execute = createPaneActionExecutor();
    const result = await execute(f.runtime, f.current, f.command);
    assert.ok(result && typeof result === "object");
    assert.equal(result.semanticPaneId, "pane-created");
    assert.equal(result.direction, direction);
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    assert.equal(f.calls(), 1);
  });
test("split rejects malformed directions and uncertain/mismatched receipts without retry", async () => {
  for (const patch of [
    { operationId: randomUUID() },
    { daemonInstanceId: randomUUID() },
    { workspaceName: "other" },
    { direction: "down" },
    { semanticPaneId: "pane-source" },
    { semanticPaneId: "" },
    { outcome: "replayed" },
    { outcome: "unchanged" },
  ]) {
    const f = fixture(),
      execute = createPaneActionExecutor();
    f.patch(patch);
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    assert.equal(f.calls(), 1);
  }
  const f = fixture();
  assert.equal(paneActionSchema.safeParse({ ...f.command, direction: "left" }).success, false);
  assert.equal(
    paneActionSchema.safeParse({ ...f.command, semanticPaneId: "other" }).success,
    false,
  );
});
test("split consumes pending token and rechecks lifetime/input/geometry after acquisition", async () => {
  for (const changed of ["lifetime", "token", "input", "geometry"] as const) {
    const f = fixture(),
      execute = createPaneActionExecutor();
    f.geometry(false);
    let release!: () => void;
    f.runtime.requestAuthority = () =>
      new Promise((resolve) => {
        release = () => {
          f.geometry(true);
          if (changed === "input") f.input(false);
          else if (changed === "geometry") f.geometry(false);
          else f.change({ [changed]: randomUUID() });
          resolve({} as never);
        };
      });
    const pending = execute(f.runtime, f.current, f.command);
    assert.equal(await execute(f.runtime, f.current, f.command), false);
    release();
    assert.equal(await pending, false);
    assert.equal(f.calls(), 0);
  }
});
test("split refusal and retirement cannot be retried or report success", async () => {
  const f = fixture(),
    execute = createPaneActionExecutor();
  let calls = 0;
  f.runtime.submitIntent = async () => {
    calls++;
    throw new Error("refused");
  };
  await assert.rejects(execute(f.runtime, f.current, f.command));
  assert.equal(await execute(f.runtime, f.current, f.command), false);
  assert.equal(calls, 1);
  const other = fixture(),
    submit = other.runtime.submitIntent;
  other.runtime.submitIntent = async (...args) => {
    const receipt = await submit(...args);
    other.retire();
    return receipt;
  };
  assert.equal(
    await createPaneActionExecutor()(other.runtime, other.current, other.command),
    false,
  );
});

test("a delayed split receipt cannot reattach after lifetime replacement or authority loss", async () => {
  for (const mode of ["lifetime", "input", "geometry"] as const) {
    const f = fixture();
    const submit = f.runtime.submitIntent;
    let release!: () => void;
    f.runtime.submitIntent = async (...args) => {
      const receipt = await submit(...args);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return receipt;
    };
    const pending = createPaneActionExecutor()(f.runtime, f.current, f.command);
    await Promise.resolve();
    if (mode === "lifetime") f.change({ lifetime: "replacement" });
    else if (mode === "input") f.input(false);
    else f.geometry(false);
    release();
    assert.equal(await pending, false);
    assert.equal(f.calls(), 1);
  }
});
