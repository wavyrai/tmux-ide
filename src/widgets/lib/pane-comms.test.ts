import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
    assert.strictEqual(panes.length, 2);
    assert.strictEqual(panes[0]!.id, "%0");
    assert.strictEqual(panes[0]!.title, "Files");
    assert.strictEqual(panes[0]!.currentCommand, "zsh");
    assert.strictEqual(panes[0]!.active, false);
    assert.strictEqual(panes[1]!.id, "%1");
    assert.strictEqual(panes[1]!.title, "Claude");
    assert.strictEqual(panes[1]!.active, true);
  });

  it("returns empty array when no output", () => {
    setMockPanes("");
    const panes = listSessionPanes("test-session");
    assert.deepStrictEqual(panes, []);
  });
});

describe("findPaneByTitle", () => {
  it("finds pane by exact title match", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findPaneByTitle("s", "Claude"), "%1");
  });

  it("returns null when title not found", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findPaneByTitle("s", "Shell"), null);
  });
});

describe("findPaneByPattern", () => {
  it("finds pane by case-insensitive substring", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findPaneByPattern("s", "claude"), "%1");
  });

  it("returns null when pattern not found", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findPaneByPattern("s", "editor"), null);
  });
});

describe("findAdjacentPane", () => {
  it("returns the next pane", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findAdjacentPane("s", "%0"), "%1");
  });

  it("wraps around to the first pane", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findAdjacentPane("s", "%1"), "%0");
  });

  it("returns null when only one pane", () => {
    setMockPanes("%0\t0\tFiles\tzsh\t80\t24\t1");
    assert.strictEqual(findAdjacentPane("s", "%0"), null);
  });

  it("returns null when pane not found", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(findAdjacentPane("s", "%99"), null);
  });
});

describe("isPaneBusy", () => {
  it("returns false for shell panes", () => {
    setMockPanes("%0\t0\tShell\tzsh\t80\t24\t0");
    assert.strictEqual(isPaneBusy("s", "%0"), false);
  });

  it("returns true for vim", () => {
    setMockPanes("%0\t0\tEditor\tvim\t80\t24\t0");
    assert.strictEqual(isPaneBusy("s", "%0"), true);
  });

  it("returns true for unknown pane", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(isPaneBusy("s", "%99"), true);
  });
});

describe("getPaneBusyStatus", () => {
  it("returns agent for claude panes", () => {
    setMockPanes("%0\t0\tClaude\tclaude\t80\t24\t1");
    assert.strictEqual(getPaneBusyStatus("s", "%0"), "agent");
  });

  it("returns idle for shell panes", () => {
    setMockPanes("%0\t0\tShell\tbash\t80\t24\t0");
    assert.strictEqual(getPaneBusyStatus("s", "%0"), "idle");
  });

  it("returns busy for vim", () => {
    setMockPanes("%0\t0\tEditor\tvim\t80\t24\t0");
    assert.strictEqual(getPaneBusyStatus("s", "%0"), "busy");
  });

  it("returns busy for unknown pane", () => {
    setMockPanes(TWO_PANES);
    assert.strictEqual(getPaneBusyStatus("s", "%99"), "busy");
  });
});

describe("resolveTarget", () => {
  it("returns explicit paneId first", () => {
    setMockPanes(THREE_PANES);
    assert.strictEqual(resolveTarget("s", { paneId: "%2" }), "%2");
  });

  it("finds by title", () => {
    setMockPanes(THREE_PANES);
    assert.strictEqual(resolveTarget("s", { title: "Shell" }), "%2");
  });

  it("finds by title pattern", () => {
    setMockPanes(THREE_PANES);
    assert.strictEqual(resolveTarget("s", { titlePattern: "claude" }), "%1");
  });

  it("falls back to adjacent pane", () => {
    setMockPanes(THREE_PANES);
    assert.strictEqual(resolveTarget("s", { selfPaneId: "%0" }), "%1");
  });

  it("prefers title over adjacency", () => {
    setMockPanes(THREE_PANES);
    assert.strictEqual(resolveTarget("s", { title: "Shell", selfPaneId: "%0" }), "%2");
  });

  it("returns null when nothing matches", () => {
    setMockPanes(THREE_PANES);
    assert.strictEqual(resolveTarget("s", {}), null);
  });
});
