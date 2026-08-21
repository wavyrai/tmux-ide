import { describe, expect, it } from "bun:test";

import { acquireRuntimeResource, runtimeResourceSnapshot } from "./runtime-resource-ledger.ts";

describe("runtime resource ledger", () => {
  it("counts idempotent lifecycle acquisition and release", () => {
    const baseline = runtimeResourceSnapshot()["pane-stream-socket"];
    const release = acquireRuntimeResource("pane-stream-socket");
    expect(runtimeResourceSnapshot()["pane-stream-socket"].active).toBe(baseline.active + 1);
    release();
    release();
    expect(runtimeResourceSnapshot()["pane-stream-socket"]).toEqual({
      created: baseline.created + 1,
      disposed: baseline.disposed + 1,
      active: baseline.active,
    });
  });
});
