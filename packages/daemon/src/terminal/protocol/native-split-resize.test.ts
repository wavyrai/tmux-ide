import { describe, expect, it } from "vitest";
import {
  resizeNativeSplit,
  type NativeSplitResizeRequest,
  type NativeSplitRunner,
} from "./native-split-resize.ts";
const cap = JSON.stringify({
  schemaVersion: 1,
  capability: "split-resize-v1",
  sessionMembership: "exact-session-link-v1",
  maxDepth: 64,
  maxLeaves: 512,
  maxGrid: 4096,
});
const before = "abcd,9x3,0,0{4x3,0,0,1,4x3,5,0,2}";
const after = "abcd,9x3,0,0{5x3,0,0,1,3x3,6,0,2}";
const request: NativeSplitResizeRequest = {
  sessionId: "$7",
  windowId: "@3",
  expectedLayout: before,
  path: [0],
  axis: "cols",
  boundary: 5,
};
function executor(response: unknown, capability = cap) {
  const calls: string[][] = [];
  const run: NativeSplitRunner = (args) => {
    calls.push([...args]);
    return calls.length === 1 ? capability : JSON.stringify(response);
  };
  return { run, calls };
}
describe("internal native split adapter", () => {
  it("positively probes selected runner then submits exact captured split command", async () => {
    const e = executor({ schemaVersion: 1, boundary: 5, layout: after });
    expect(await resizeNativeSplit(request, e.run)).toMatchObject({
      status: "applied",
      boundary: 5,
      layout: after,
      changed: true,
    });
    expect(e.calls).toEqual([
      ["tmux-ide-resize-split", "-V"],
      [
        "tmux-ide-resize-split",
        "-t",
        "@3",
        "-s",
        "$7",
        "-E",
        before,
        "-p",
        "0",
        "-a",
        "cols",
        "-c",
        "5",
      ],
    ]);
  });
  it("accepts actual clamp and unchanged native geometry without fabricated requested size", async () => {
    for (const [layout, boundary] of [
      [before, 4],
      [after, 5],
    ] as const) {
      const e = executor({ schemaVersion: 1, boundary, layout });
      expect(await resizeNativeSplit({ ...request, boundary: 8 }, e.run)).toMatchObject({
        status: "applied",
        boundary,
        changed: layout !== before,
      });
    }
  });
  it("checks capability each call; unsupported, malformed, extra fields and unknown versions never mutate", async () => {
    for (const c of [
      "unknown command",
      "x".repeat(1025),
      JSON.stringify({ ...JSON.parse(cap), extra: true }),
      JSON.stringify({ ...JSON.parse(cap), schemaVersion: 2 }),
      JSON.stringify({ ...JSON.parse(cap), maxGrid: 8192 }),
    ]) {
      const e = executor({}, c);
      expect(await resizeNativeSplit(request, e.run)).toEqual({
        status: "refused",
        reason: "unsupported",
      });
      expect(e.calls).toHaveLength(1);
    }
    let calls = 0;
    expect(
      await resizeNativeSplit(request, () => {
        calls++;
        throw new Error("private socket details");
      }),
    ).toEqual({ status: "refused", reason: "unsupported" });
    expect(calls).toBe(1);
  });
  it("refuses the older prototype without positive session-link capability", async () => {
    const old = JSON.parse(cap);
    delete old.sessionMembership;
    const e = executor({}, JSON.stringify(old));
    expect(await resizeNativeSplit(request, e.run)).toEqual({
      status: "refused",
      reason: "unsupported",
    });
    expect(e.calls).toHaveLength(1);
  });
  it("rejects invalid captured target data before probing or mutation", async () => {
    const invalid = [
      { sessionId: "$4294967296" },
      { sessionId: "$01" },
      { sessionId: "name" },
      { sessionId: "@7" },
      { windowId: "session:window" },
      { windowId: "@4294967296" },
      { path: [] },
      { path: [1] },
      { path: [-1] },
      { path: Array(64).fill(0) },
      { axis: "rows" },
      { boundary: Infinity },
      { boundary: 4097 },
      { expectedLayout: "abcd,4097x1,0,0{2x1,0,0,1,4094x1,3,0,2}" },
      { expectedLayout: "abcd,3x1,0,0{1x1,0,0,1,1x1,2,0,4294967296}" },
    ];
    for (const value of invalid) {
      const e = executor({});
      expect(
        await resizeNativeSplit({ ...request, ...value } as NativeSplitResizeRequest, e.run),
      ).toEqual({ status: "refused", reason: "invalid-request" });
      expect(e.calls).toHaveLength(0);
    }
  });
  it("snapshots request/path before asynchronous probe", async () => {
    const path = [0],
      mutable = { ...request, path };
    const e = executor({ schemaVersion: 1, boundary: 5, layout: after });
    const run: NativeSplitRunner = async (args) => {
      const result = e.run(args);
      if (args.includes("-V")) {
        path[0] = 1;
        mutable.windowId = "@99";
        mutable.sessionId = "$99";
        mutable.boundary = 100;
      }
      return result;
    };
    expect(await resizeNativeSplit(mutable, run)).toMatchObject({ status: "applied", boundary: 5 });
    expect(e.calls[1]).toContain("@3");
    expect(e.calls[1]).toContain("$7");
    expect(e.calls[1]?.at(-1)).toBe("5");
  });
  it("treats dispatch rejection and malformed post-effect results as uncertain, never retries", async () => {
    let calls = 0;
    expect(
      await resizeNativeSplit(request, () => {
        if (++calls === 1) return cap;
        throw new Error("split layout mismatch");
      }),
    ).toEqual({ status: "uncertain", reason: "command-failed" });
    expect(calls).toBe(2);
    const invalid = [
      {},
      { schemaVersion: 1, boundary: 5, layout: after, extra: 1 },
      { schemaVersion: 1, boundary: 4, layout: after },
      { schemaVersion: 1, boundary: 6, layout: "abcd,9x3,0,0{6x3,0,0,1,2x3,7,0,2}" },
      { schemaVersion: 1, boundary: 5, layout: after.replace(",0,2}", ",0,3}") },
      { schemaVersion: 1, boundary: 5, layout: after.replace("9x3", "10x3") },
      { schemaVersion: 1, boundary: 5, layout: "x".repeat(17000) },
    ];
    for (const receipt of invalid) {
      const e = executor(receipt);
      expect(await resizeNativeSplit(request, e.run)).toEqual({
        status: "uncertain",
        reason: "invalid-receipt",
      });
      expect(e.calls).toHaveLength(2);
    }
  });
  it("keeps exact ancestry and geometry outside affected parent, including orthogonal dimensions", async () => {
    const layout = "abcd,9x7,0,0[9x3,0,0{4x3,0,0,1,4x3,5,0,2},9x3,0,4,3]";
    const changed = "abcd,9x7,0,0[9x3,0,0{5x3,0,0,1,3x3,6,0,2},9x3,0,4,3]";
    const r = { ...request, expectedLayout: layout, path: [0, 0] };
    expect(
      await resizeNativeSplit(r, executor({ schemaVersion: 1, boundary: 5, layout: changed }).run),
    ).toMatchObject({ status: "applied" });
    for (const invalid of [
      "abcd,9x7,0,0[9x4,0,0{5x4,0,0,1,3x4,6,0,2},9x2,0,5,3]",
      "abcd,9x7,0,0{5x7,0,0[5x3,0,0,1,5x3,0,4,3],3x7,6,0,2}",
    ])
      expect(
        await resizeNativeSplit(
          r,
          executor({ schemaVersion: 1, boundary: 5, layout: invalid }).run,
        ),
      ).toEqual({ status: "uncertain", reason: "invalid-receipt" });
  });
  it("matches native conservative serializer budget before dispatch", async () => {
    const layout =
      "abcd,799x1,0,0{" +
      Array.from({ length: 400 }, (_, i) => `1x1,${i * 2},0,${i}`).join(",") +
      "}";
    const e = executor({});
    expect(await resizeNativeSplit({ ...request, expectedLayout: layout }, e.run)).toEqual({
      status: "refused",
      reason: "invalid-request",
    });
    expect(e.calls).toHaveLength(0);
  });
});
