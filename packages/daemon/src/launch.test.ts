import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPaneMap, waitForPaneCommand, ensureTaskDocs } from "./launch.ts";

describe("buildPaneMap", () => {
  it("uses returned pane ids instead of assuming sequential numbering", () => {
    const rows = [
      {
        size: "60%",
        panes: [{ title: "A" }, { title: "B" }],
      },
      {
        panes: [{ title: "C" }, { title: "D", dir: "apps/api" }],
      },
    ];
    const splitCalls = [];
    const returnedPaneIds = ["%42", "%99", "%7"];

    const { paneMap, firstPanesOfRows } = buildPaneMap(
      rows,
      "/workspace",
      "%1",
      ({ targetPane, direction, cwd, percent }) => {
        splitCalls.push({ targetPane, direction, cwd, percent });
        return returnedPaneIds.shift();
      },
    );

    expect(splitCalls).toEqual([
      { targetPane: "%1", direction: "vertical", cwd: "/workspace", percent: 40 },
      { targetPane: "%1", direction: "horizontal", cwd: "/workspace", percent: 50 },
      { targetPane: "%42", direction: "horizontal", cwd: "/workspace/apps/api", percent: 50 },
    ]);

    expect(paneMap).toEqual([
      ["%1", "%99"],
      ["%42", "%7"],
    ]);
    expect([...firstPanesOfRows]).toEqual(["%1", "%42"]);
  });

  it("chains additional row splits from the returned row pane ids", () => {
    const rows = [
      { size: "50%", panes: [{ title: "Lead" }] },
      { size: "30%", panes: [{ title: "Worker" }] },
      { panes: [{ title: "Shell" }] },
    ];
    const splitCalls = [];
    const returnedPaneIds = ["%21", "%34"];

    const { paneMap, firstPanesOfRows } = buildPaneMap(
      rows,
      "/workspace",
      "%5",
      ({ targetPane, direction, cwd, percent }) => {
        splitCalls.push({ targetPane, direction, cwd, percent });
        return returnedPaneIds.shift();
      },
    );

    expect(splitCalls).toEqual([
      { targetPane: "%5", direction: "vertical", cwd: "/workspace", percent: 50 },
      { targetPane: "%21", direction: "vertical", cwd: "/workspace", percent: 40 },
    ]);
    expect(paneMap).toEqual([["%5"], ["%21"], ["%34"]]);
    expect([...firstPanesOfRows]).toEqual(["%5", "%21", "%34"]);
  });
});

describe("waitForPaneCommand", () => {
  it("returns true once the pane reports an expected command", () => {
    const seenSleeps = [];
    const commands = ["zsh", "zsh", "claude"];

    const result = waitForPaneCommand("%1", ["claude"], {
      attempts: 5,
      delayMs: 25,
      getCurrentCommand: () => commands.shift(),
      sleep: (ms) => seenSleeps.push(ms),
    });

    expect(result).toBe(true);
    expect(seenSleeps).toEqual([25, 25]);
  });

  it("returns false after exhausting retries", () => {
    const seenSleeps = [];

    const result = waitForPaneCommand("%1", ["claude"], {
      attempts: 3,
      delayMs: 10,
      getCurrentCommand: () => "zsh",
      sleep: (ms) => seenSleeps.push(ms),
    });

    expect(result).toBe(false);
    expect(seenSleeps).toEqual([10, 10]);
  });
});

describe("ensureTaskDocs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-launch-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates CLAUDE.md with task docs when file does not exist", () => {
    ensureTaskDocs(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content.includes("## Task Management")).toBeTruthy();
    expect(content.includes("tmux-ide mission set")).toBeTruthy();
    expect(content.includes("tmux-ide task create")).toBeTruthy();
    expect(content.includes("--proof")).toBeTruthy();
    expect(content.includes("--depends")).toBeTruthy();
  });

  it("appends task docs to existing CLAUDE.md", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# My Project\n\nExisting content.\n");
    ensureTaskDocs(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(content.startsWith("# My Project\n\nExisting content.\n")).toBeTruthy();
    expect(content.includes("## Task Management")).toBeTruthy();
  });

  it("does not duplicate if section already exists", () => {
    writeFileSync(join(tmpDir, "CLAUDE.md"), "# Project\n\n## Task Management\n\nAlready here.\n");
    ensureTaskDocs(tmpDir);
    const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    const count = content.split("## Task Management").length - 1;
    expect(count).toBe(1);
    expect(content.includes("Already here.")).toBeTruthy();
    expect(!content.includes("tmux-ide mission set")).toBeTruthy();
  });

  it("is idempotent when called twice", () => {
    ensureTaskDocs(tmpDir);
    const first = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    ensureTaskDocs(tmpDir);
    const second = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
    expect(first).toBe(second);
  });
});
