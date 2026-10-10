import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeWindow, windowForLayout } from "./geometry.ts";
const resize = { kind: "resize", data: { cols: 91, rows: 27 } };
test("resize targets verified window only while holding geometry authority", async () => {
  const calls: unknown[] = [];
  const ok = await resizeWindow(
    {
      ownsConnectionAuthority: () => true,
      requestAuthority: async () => {
        throw new Error("Unexpected request");
      },
      fitViewport: async (...args) => {
        calls.push(args);
        return "ok";
      },
    },
    () => "window-a",
    resize,
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [[91, 27, "window-a"]]);
});
test("missing topology or authority denial never resizes", async () => {
  let requested = 0;
  const runtime = {
    ownsConnectionAuthority: () => false,
    requestAuthority: async () => {
      requested++;
      return null;
    },
    fitViewport: async () => {
      throw new Error("Must not resize");
    },
  };
  assert.equal(await resizeWindow(runtime, () => null, resize), false);
  assert.equal(requested, 0);
  assert.equal(await resizeWindow(runtime, () => "window-a", resize), false);
  assert.equal(requested, 1);
});
test("topology changes and lost leases cannot redirect a resize", async () => {
  let observations = 0;
  const runtime = {
    ownsConnectionAuthority: () => true,
    requestAuthority: async () => null,
    fitViewport: async () => {
      throw new Error("Must not resize changed target");
    },
  };
  assert.equal(
    await resizeWindow(runtime, () => (++observations === 1 ? "window-a" : "window-b"), resize),
    false,
  );
  await assert.rejects(
    resizeWindow(runtime, () => "window-a", { kind: "resize", data: { cols: 1, rows: 20 } }),
  );
});

test("pane removal invalidates the former resize target until its new layout arrives", () => {
  let current: string | null = "window-a";
  current = windowForLayout(current, "pane", { semanticWindowId: "unrelated", panes: [] });
  assert.equal(current, "window-a");
  current = windowForLayout(current, "pane", { semanticWindowId: "window-a", panes: [] });
  assert.equal(current, null);
  current = windowForLayout(current, "pane", {
    semanticWindowId: "window-b",
    panes: [{ pane: "pane" }],
  });
  assert.equal(current, "window-b");
  current = windowForLayout(current, "pane", { semanticWindowId: "window-a", panes: [] });
  assert.equal(current, "window-b");
});

test("unidentified containing layout clears a previously verified target", () => {
  assert.equal(
    windowForLayout("window-a", "pane", { semanticWindowId: null, panes: [{ pane: "pane" }] }),
    null,
  );
});
