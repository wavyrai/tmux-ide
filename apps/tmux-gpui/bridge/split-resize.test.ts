import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeSplit, type SplitResizeSnapshot } from "./split-resize.ts";
const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const grant = {
  generation: uuid,
  session: "project",
  clientId: "test",
  authority: "geometry" as const,
  token: uuid,
  revision: 1,
};
function fixture() {
  let current: SplitResizeSnapshot = {
    generation: uuid,
    workspace: "project",
    lifetime: "one",
    window: {
      liveSessionId: `live-session.${"a".repeat(20)}`,
      linkId: `window-link.${"a".repeat(32)}`,
      expectedSemanticWindowId: "window.one",
      linkRevision: 1,
    },
    resource: {
      version: 1,
      window: {
        liveSessionId: `live-session.${"a".repeat(20)}`,
        linkId: `window-link.${"a".repeat(32)}`,
        expectedSemanticWindowId: "window.one",
        linkRevision: 1,
      },
      layoutId: uuid,
      cols: 80,
      rows: 24,
      panes: [{ semanticPaneId: "pane.one", left: 0, top: 0, width: 80, height: 24 }],
      splits: [{ splitId: uuid, axis: "cols", boundary: 39, start: 0, length: 24 }],
    },
  };
  const command = {
    target: {
      window: structuredClone(current.window),
      layoutId: uuid,
      splitId: uuid,
      boundary: 79,
    },
    axis: "cols" as const,
  };
  const result = {
    operationId: uuid,
    daemonInstanceId: uuid,
    workspaceName: "project",
    verb: "workspace.window.split.resize" as const,
    outcome: "applied" as const,
    target: structuredClone(command.target),
    axis: "cols" as const,
    boundary: 70,
  };
  let count = 0,
    owned = true;
  const runtime = {
    ownsConnectionAuthority: () => owned,
    requestAuthority: async (): ReturnType<PaneStreamRuntimeClient["requestAuthority"]> => {
      owned = true;
      return grant;
    },
    submitIntent: async () => {
      count++;
      return result;
    },
  };
  return {
    command,
    result,
    runtime,
    get: () => current,
    set: (v: SplitResizeSnapshot) => {
      current = v;
    },
    count: () => count,
    unown: () => {
      owned = false;
    },
  };
}
test("clamped receipt permits changed layout after submission without retry", async () => {
  const f = fixture();
  const submit = f.runtime.submitIntent;
  f.runtime.submitIntent = async () => {
    const r = await submit();
    f.set({ ...f.get(), resource: { ...f.get().resource!, layoutId: other } });
    return r;
  };
  assert.equal((await resizeSplit(f.runtime, f.get, f.command, uuid))?.boundary, 70);
  assert.equal(f.count(), 1);
});
test("stale layout during authority acquisition cannot dispatch", async () => {
  const f = fixture();
  f.unown();
  const acquire = f.runtime.requestAuthority;
  f.runtime.requestAuthority = async () => {
    await acquire();
    f.set({ ...f.get(), resource: { ...f.get().resource!, layoutId: other } });
    return grant;
  };
  assert.equal(await resizeSplit(f.runtime, f.get, f.command, uuid), null);
  assert.equal(f.count(), 0);
});
test("wrong echoed target is refused even when actual boundary is plausible", async () => {
  const f = fixture();
  f.result.target.splitId = other;
  assert.equal(await resizeSplit(f.runtime, f.get, f.command, uuid), null);
  assert.equal(f.count(), 1);
});
test("late scope and lifetime changes refuse result", async () => {
  for (const patch of [{ generation: other }, { workspace: "other" }, { lifetime: "two" }]) {
    const f = fixture(),
      submit = f.runtime.submitIntent;
    f.runtime.submitIntent = async () => {
      const r = await submit();
      f.set({ ...f.get(), ...patch });
      return r;
    };
    assert.equal(await resizeSplit(f.runtime, f.get, f.command, uuid), null);
    assert.equal(f.count(), 1);
  }
});
test("detached command survives caller mutation while waiting for authority", async () => {
  const f = fixture();
  f.unown();
  const acquire = f.runtime.requestAuthority;
  f.runtime.requestAuthority = async () => {
    f.command.target.boundary = 1;
    f.command.target.window.linkRevision = 9;
    return acquire();
  };
  assert.equal((await resizeSplit(f.runtime, f.get, f.command, uuid))?.target.boundary, 79);
});
test("malformed inputs and unknown split axis do not acquire or submit", async () => {
  const f = fixture();
  let requests = 0;
  f.unown();
  f.runtime.requestAuthority = async () => {
    requests++;
    return null;
  };
  assert.equal(await resizeSplit(f.runtime, f.get, { ...f.command, axis: "rows" }, uuid), null);
  assert.equal(
    await resizeSplit(
      f.runtime,
      f.get,
      { ...f.command, target: { ...f.command.target, boundary: 4097 } },
      uuid,
    ),
    null,
  );
  assert.equal(requests, 0);
  assert.equal(f.count(), 0);
});

test("resource refresh after submission accepts receipt but absent pre-submit resource refuses", async () => {
  const f = fixture();
  const submit = f.runtime.submitIntent;
  f.runtime.submitIntent = async () => {
    const result = await submit();
    f.set({ ...f.get(), resource: null });
    return result;
  };
  assert.equal((await resizeSplit(f.runtime, f.get, f.command, uuid))?.boundary, 70);
  const absent = fixture();
  absent.set({ ...absent.get(), resource: null });
  assert.equal(await resizeSplit(absent.runtime, absent.get, absent.command, uuid), null);
  assert.equal(absent.count(), 0);
});
test("retained window replacement after submission refuses even with no resource", async () => {
  const f = fixture();
  const submit = f.runtime.submitIntent;
  f.runtime.submitIntent = async () => {
    const result = await submit();
    f.set({ ...f.get(), window: { ...f.get().window, linkRevision: 2 }, resource: null });
    return result;
  };
  assert.equal(await resizeSplit(f.runtime, f.get, f.command, uuid), null);
});
