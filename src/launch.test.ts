import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPaneMap, waitForPaneCommand } from "./launch.ts";

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

    assert.deepStrictEqual(splitCalls, [
      { targetPane: "%1", direction: "vertical", cwd: "/workspace", percent: 40 },
      { targetPane: "%1", direction: "horizontal", cwd: "/workspace", percent: 50 },
      { targetPane: "%42", direction: "horizontal", cwd: "/workspace/apps/api", percent: 50 },
    ]);

    assert.deepStrictEqual(paneMap, [
      ["%1", "%99"],
      ["%42", "%7"],
    ]);
    assert.deepStrictEqual([...firstPanesOfRows], ["%1", "%42"]);
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

    assert.deepStrictEqual(splitCalls, [
      { targetPane: "%5", direction: "vertical", cwd: "/workspace", percent: 50 },
      { targetPane: "%21", direction: "vertical", cwd: "/workspace", percent: 40 },
    ]);
    assert.deepStrictEqual(paneMap, [["%5"], ["%21"], ["%34"]]);
    assert.deepStrictEqual([...firstPanesOfRows], ["%5", "%21", "%34"]);
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

    assert.strictEqual(result, true);
    assert.deepStrictEqual(seenSleeps, [25, 25]);
  });

  it("returns false after exhausting retries", () => {
    const seenSleeps = [];

    const result = waitForPaneCommand("%1", ["claude"], {
      attempts: 3,
      delayMs: 10,
      getCurrentCommand: () => "zsh",
      sleep: (ms) => seenSleeps.push(ms),
    });

    assert.strictEqual(result, false);
    assert.deepStrictEqual(seenSleeps, [10, 10]);
  });
});
