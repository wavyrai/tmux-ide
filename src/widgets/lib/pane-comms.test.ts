import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  _setExecutor,
  listSessionPanes,
  findPaneByTitle,
  findPaneByPattern,
  findAdjacentPane,
  isPaneBusy,
  getPaneBusyStatus,
  resolveTarget,
} from "./pane-comms.ts";

let restoreExec: () => void;
let mockOutput: string;
let tmuxCalls: string[][];

beforeEach(() => {
  mockOutput = "";
  tmuxCalls = [];
  restoreExec = _setExecutor((_cmd: string, args: string[]) => {
    tmuxCalls.push(args);
    return mockOutput;
  });
});

afterEach(() => {
  restoreExec();
});

function setMockPanes(output: string) {
  mockOutput = output;
}

const TWO_PANES = ["%0\t0\tFiles\tzsh\t80\t24\t0", "%1\t1\tClaude\tclaude\t80\t24\t1"].join("\n");

const THREE_PANES = [
  "%0\t0\tFiles\tzsh\t80\t24\t0",
  "%1\t1\tClaude\tclaude\t80\t24\t1",
  "%2\t2\tShell\tzsh\t80\t24\t0",
].join("\n");

describe("listSessionPanes", () => {
  it("parses tmux list-panes output correctly", () => {
    setMockPanes(TWO_PANES);
    const panes = listSessionPanes("test-session");
    expect(panes.length).toBe(2);
    expect(panes[0]!.id).toBe("%0");
    expect(panes[0]!.title).toBe("Files");
    expect(panes[0]!.currentCommand).toBe("zsh");
    expect(panes[0]!.active).toBe(false);
    expect(panes[1]!.id).toBe("%1");
    expect(panes[1]!.title).toBe("Claude");
    expect(panes[1]!.active).toBe(true);
  });

  it("returns empty array when no output", () => {
    setMockPanes("");
    const panes = listSessionPanes("test-session");
    expect(panes).toEqual([]);
  });
});

describe("findPaneByTitle", () => {
  it("finds pane by exact title match", () => {
    setMockPanes(TWO_PANES);
    expect(findPaneByTitle("s", "Claude")).toBe("%1");
  });

  it("returns null when title not found", () => {
    setMockPanes(TWO_PANES);
    expect(findPaneByTitle("s", "Shell")).toBe(null);
  });
});

describe("findPaneByPattern", () => {
  it("finds pane by case-insensitive substring", () => {
    setMockPanes(TWO_PANES);
    expect(findPaneByPattern("s", "claude")).toBe("%1");
  });

  it("returns null when pattern not found", () => {
    setMockPanes(TWO_PANES);
    expect(findPaneByPattern("s", "editor")).toBe(null);
  });
});

describe("findAdjacentPane", () => {
  it("returns the next pane", () => {
    setMockPanes(TWO_PANES);
    expect(findAdjacentPane("s", "%0")).toBe("%1");
  });

  it("wraps around to the first pane", () => {
    setMockPanes(TWO_PANES);
    expect(findAdjacentPane("s", "%1")).toBe("%0");
  });

  it("returns null when only one pane", () => {
    setMockPanes("%0\t0\tFiles\tzsh\t80\t24\t1");
    expect(findAdjacentPane("s", "%0")).toBe(null);
  });

  it("returns null when pane not found", () => {
    setMockPanes(TWO_PANES);
    expect(findAdjacentPane("s", "%99")).toBe(null);
  });
});

describe("isPaneBusy", () => {
  it("returns false for shell panes", () => {
    setMockPanes("%0\t0\tShell\tzsh\t80\t24\t0");
    expect(isPaneBusy("s", "%0")).toBe(false);
  });

  it("returns true for vim", () => {
    setMockPanes("%0\t0\tEditor\tvim\t80\t24\t0");
    expect(isPaneBusy("s", "%0")).toBe(true);
  });

  it("returns true for unknown pane", () => {
    setMockPanes(TWO_PANES);
    expect(isPaneBusy("s", "%99")).toBe(true);
  });
});

describe("getPaneBusyStatus", () => {
  it("returns agent for claude panes", () => {
    setMockPanes("%0\t0\tClaude\tclaude\t80\t24\t1");
    expect(getPaneBusyStatus("s", "%0")).toBe("agent");
  });

  it("returns idle for shell panes", () => {
    setMockPanes("%0\t0\tShell\tbash\t80\t24\t0");
    expect(getPaneBusyStatus("s", "%0")).toBe("idle");
  });

  it("returns busy for vim", () => {
    setMockPanes("%0\t0\tEditor\tvim\t80\t24\t0");
    expect(getPaneBusyStatus("s", "%0")).toBe("busy");
  });

  it("returns busy for unknown pane", () => {
    setMockPanes(TWO_PANES);
    expect(getPaneBusyStatus("s", "%99")).toBe("busy");
  });
});

describe("resolveTarget", () => {
  it("returns explicit paneId first", () => {
    setMockPanes(THREE_PANES);
    expect(resolveTarget("s", { paneId: "%2" })).toBe("%2");
  });

  it("finds by title", () => {
    setMockPanes(THREE_PANES);
    expect(resolveTarget("s", { title: "Shell" })).toBe("%2");
  });

  it("finds by title pattern", () => {
    setMockPanes(THREE_PANES);
    expect(resolveTarget("s", { titlePattern: "claude" })).toBe("%1");
  });

  it("falls back to adjacent pane", () => {
    setMockPanes(THREE_PANES);
    expect(resolveTarget("s", { selfPaneId: "%0" })).toBe("%1");
  });

  it("prefers title over adjacency", () => {
    setMockPanes(THREE_PANES);
    expect(resolveTarget("s", { title: "Shell", selfPaneId: "%0" })).toBe("%2");
  });

  it("returns null when nothing matches", () => {
    setMockPanes(THREE_PANES);
    expect(resolveTarget("s", {})).toBe(null);
  });
});
