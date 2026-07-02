import { describe, expect, it } from "vitest";
import { isListableSession, rollupStatus, rollupWindows } from "./sessions.ts";
import type { AgentStatus } from "../detect/classify.ts";

describe("rollupStatus", () => {
  it("blocked wins over everything else", () => {
    expect(rollupStatus(["idle", "working", "done", "blocked", "unknown"])).toBe("blocked");
  });

  it("working wins over done, idle and unknown", () => {
    expect(rollupStatus(["idle", "done", "working", "unknown"])).toBe("working");
  });

  it("done wins over idle and unknown", () => {
    expect(rollupStatus(["idle", "unknown", "done"])).toBe("done");
  });

  it("empty array rolls up to idle", () => {
    expect(rollupStatus([])).toBe("idle");
  });

  it("all-unknown stays unknown", () => {
    expect(rollupStatus(["unknown", "unknown"])).toBe("unknown");
  });

  it("unknown only wins when nothing else is present — idle beats unknown", () => {
    expect(rollupStatus(["unknown", "idle"])).toBe("idle");
  });
});

describe("rollupWindows", () => {
  const pane = (windowIndex: number, windowName: string, windowActive = false) => ({
    windowIndex,
    windowName,
    windowActive,
  });

  it("groups each window's panes and rolls their statuses up", () => {
    const panes = [pane(0, "editor", true), pane(0, "editor", true), pane(1, "server")];
    const statuses: AgentStatus[] = ["idle", "working", "done"];
    expect(rollupWindows(panes, statuses)).toEqual([
      { index: 0, name: "editor", active: true, panes: 2, status: "working" },
      { index: 1, name: "server", active: false, panes: 1, status: "done" },
    ]);
  });

  it("returns windows in ascending index order regardless of pane order", () => {
    const panes = [pane(3, "c"), pane(1, "a"), pane(2, "b")];
    const statuses: AgentStatus[] = ["idle", "idle", "idle"];
    expect(rollupWindows(panes, statuses).map((w) => w.index)).toEqual([1, 2, 3]);
  });

  it("marks a window active when ANY of its panes reports window_active", () => {
    const panes = [pane(0, "w", false), pane(0, "w", true)];
    const statuses: AgentStatus[] = ["idle", "idle"];
    expect(rollupWindows(panes, statuses)[0]!.active).toBe(true);
  });

  it("an empty pane list yields an empty window list", () => {
    expect(rollupWindows([], [])).toEqual([]);
  });

  it("a lone blocked pane makes its window blocked", () => {
    expect(rollupWindows([pane(0, "w")], ["blocked"])).toEqual([
      { index: 0, name: "w", active: false, panes: 1, status: "blocked" },
    ]);
  });
});

describe("isListableSession", () => {
  it("hides `_`-prefixed internal sessions from the switcher", () => {
    expect(isListableSession("_tmux-ide-chrome")).toBe(false);
    expect(isListableSession("_scratch")).toBe(false);
    expect(isListableSession("_")).toBe(false);
  });

  it("keeps every non-internal session", () => {
    expect(isListableSession("my-project")).toBe(true);
    expect(isListableSession("tmux-ide")).toBe(true);
  });
});
