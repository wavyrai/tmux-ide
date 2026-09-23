import { describe, expect, it } from "vitest";
import {
  buildNativeWindowLinkGuard,
  buildNativeWindowLinkPaneSelectGuard,
  classifyNativeWindowLinkGuardResult,
} from "./tmux-window-link-guard.ts";

const valid = { sessionId: "$12", windowIndex: 3, expectedWindowId: "@45" };
describe("native window link guard boundary", () => {
  it.each([
    "$0:3",
    "$1' ; kill-server",
    "$01",
    "session",
    "$1\n",
    "$9007199254740992",
    "#{session_id}",
  ])("rejects noncanonical session ID %j", (sessionId) => {
    expect(() => buildNativeWindowLinkGuard({ ...valid, sessionId }, "select")).toThrow();
  });
  it.each(["@1;kill-server", "@01", "%1", "@1\n", "@9007199254740992", "#{window_id}"])(
    "rejects noncanonical backing ID %j",
    (expectedWindowId) => {
      expect(() => buildNativeWindowLinkGuard({ ...valid, expectedWindowId }, "unlink")).toThrow();
    },
  );
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe index %j",
    (windowIndex) => {
      expect(() => buildNativeWindowLinkGuard({ ...valid, windowIndex }, "select")).toThrow();
    },
  );
  it.each(["%1;kill-server", "%01", "@1", "%1\n", "%9007199254740992", "#{pane_id}"])(
    "rejects noncanonical pane ID %j",
    (paneId) => {
      expect(() => buildNativeWindowLinkPaneSelectGuard(valid, paneId)).toThrow();
    },
  );
  it("requires both pane identity and expected backing before compound selection", () => {
    const args = buildNativeWindowLinkPaneSelectGuard(valid, "%7");
    expect(args.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "%7"]);
    expect(args[4]).toBe("#{&&:#{==:#{pane_id},%7},#{==:#{window_id},@45}}");
    expect(args[5]).toContain("link-guard.interrupted");
  });
  it("does not permit runtime injection of arbitrary verbs", () => {
    expect(() => buildNativeWindowLinkGuard(valid, "kill" as "unlink")).toThrow();
  });
  it("uses exact session:index, complete tuple comparison, and ordinary unlink", () => {
    const args = buildNativeWindowLinkGuard(valid, "unlink");
    expect(args.slice(0, 4)).toEqual(["if-shell", "-F", "-t", "$12:3"]);
    expect(args[4]).toBe(
      "#{&&:#{==:#{session_id},$12},#{&&:#{==:#{window_index},3},#{==:#{window_id},@45}}}",
    );
    expect(args[5]).toBe("unlink-window -t '$12:3' ; display-message -p 'link-guard.ok'");
  });
  it.each(["1;kill-server", "01", "-1", "#{pid}", "1\n", "99999999999999999"])(
    "rejects malformed native generation %j",
    (value) => {
      expect(() =>
        buildNativeWindowLinkGuard({ ...valid, expectedServerPid: value }, "select"),
      ).toThrow();
      expect(() =>
        buildNativeWindowLinkGuard({ ...valid, expectedSessionCreated: value }, "select"),
      ).toThrow();
    },
  );
  it("rechecks server/session generation after native selection hooks", () => {
    const args = buildNativeWindowLinkPaneSelectGuard(
      { ...valid, expectedServerPid: "123", expectedSessionCreated: "456" },
      "%7",
    );
    expect(args[5]!.split("#{==:#{pid},123}")).toHaveLength(3);
    expect(args[5]!.split("#{==:#{session_created},456}")).toHaveLength(3);
  });
  it.each([
    [0, "link-guard.ok\n", "applied"],
    [0, "link-guard.stale\n", "stale"],
    [1, "", "native-refused"],
    [1, "link-guard.ok", "native-refused"],
    [null, "link-guard.ok", "indeterminate"],
    [0, "", "indeterminate"],
    [0, "link-guard.interrupted", "indeterminate"],
    [0, "link-guard.ok\nlink-guard.stale", "indeterminate"],
    [0, "unrelated\nlink-guard.ok", "indeterminate"],
  ] as const)("classifies completion %j / %j as %s", (status, stdout, expected) => {
    expect(classifyNativeWindowLinkGuardResult(status, stdout)).toBe(expected);
  });
});
