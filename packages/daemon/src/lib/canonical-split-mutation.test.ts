import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { executeCanonicalSplitMutation } from "./canonical-split-mutation.ts";
import type { SessionRuntimeRegistry } from "../terminal/session-runtime/registry.ts";
const generation = randomUUID();
const target = {
  window: {
    liveSessionId: `live-session.${"a".repeat(20)}`,
    linkId: `window-link.${"b".repeat(32)}`,
    linkRevision: 0,
    expectedSemanticWindowId: "window.test",
  },
  layoutId: randomUUID(),
  splitId: randomUUID(),
  boundary: 0,
};
const intent = { verb: "workspace.window.split.resize" as const, workspaceName: "test", target };
function fixture(status = "applied") {
  let session = "test";
  const native = vi.fn();
  const readWindowSplitLayout = vi.fn(async () => ({
    layoutId: target.layoutId,
    splits: [{ splitId: target.splitId, axis: "cols" }],
  }));
  const resizeWindowSplit = vi.fn(async (_session, _target, _id, authorize) => {
    authorize();
    return status === "applied"
      ? { status, changed: true, boundary: 3 }
      : { status, reason: "test" };
  });
  const options = {
    generation,
    resolveSession: () => session,
    registry: { readWindowSplitLayout, resizeWindowSplit } as unknown as SessionRuntimeRegistry,
    runNative: native,
  };
  return {
    options,
    readWindowSplitLayout,
    resizeWindowSplit,
    rebind: () => {
      session = "other";
    },
  };
}
it("maps verified native clamping into an exact target receipt", async () => {
  const f = fixture();
  const id = randomUUID();
  const fence = vi.fn();
  expect(await executeCanonicalSplitMutation(f.options, id, intent, fence)).toEqual({
    operationId: id,
    daemonInstanceId: generation,
    workspaceName: "test",
    verb: intent.verb,
    outcome: "applied",
    target,
    axis: "cols",
    boundary: 3,
  });
  expect(fence).toHaveBeenCalledTimes(2);
});
it("requires explicit caller authorization and refuses stale handles before dispatch", async () => {
  const f = fixture();
  await expect(
    executeCanonicalSplitMutation(f.options, randomUUID(), intent, undefined),
  ).rejects.toThrow();
  expect(f.readWindowSplitLayout).not.toHaveBeenCalled();
  await expect(
    executeCanonicalSplitMutation(
      f.options,
      randomUUID(),
      { ...intent, target: { ...target, layoutId: randomUUID() } },
      () => {},
    ),
  ).rejects.toThrow();
  expect(f.resizeWindowSplit).not.toHaveBeenCalled();
});
it.each(["refused", "uncertain"])("preserves %s without retry or fallback", async (status) => {
  const f = fixture(status);
  await expect(
    executeCanonicalSplitMutation(f.options, randomUUID(), intent, () => {}),
  ).rejects.toMatchObject({
    code: status === "uncertain" ? "mutation_unverified" : "workspace_unavailable",
  });
  expect(f.resizeWindowSplit).toHaveBeenCalledTimes(1);
});
it("rechecks workspace binding after asynchronous canonical read", async () => {
  const f = fixture();
  f.readWindowSplitLayout.mockImplementationOnce(async () => {
    f.rebind();
    return { layoutId: target.layoutId, splits: [{ splitId: target.splitId, axis: "cols" }] };
  });
  await expect(
    executeCanonicalSplitMutation(f.options, randomUUID(), intent, () => {}),
  ).rejects.toThrow();
});
