import assert from "node:assert/strict";
import test from "node:test";

import { conditionAnsiTmuxFixture } from "./product-ansi-tmux-precondition.mjs";

// This is the exact private-tmux shape: a top pane-status row consumes screen
// row zero, so the pane begins at native row one while retaining 40 body rows.
const exact = "%1\t@1\ttop\t132\t41\t0\t1\t132\t40\t42\tnode";

test("preconditions default geometry and admits two exact stable samples", async () => {
  const calls = [];
  const rows = [exact, exact];
  const result = await conditionAnsiTmuxFixture({
    paneId: "%1",
    marker: "ANSI_MARKER",
    executable: "/usr/bin/node",
    run: async (args) => {
      calls.push(args);
      if (args[0] === "list-panes") return rows.shift();
      if (args[0] === "capture-pane") return "ANSI_MARKER";
      return "";
    },
    now: () => 0,
    wait: async () => undefined,
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["set-option", "-w", "-t", "%1", "pane-border-status", "top"],
    ["resize-window", "-t", "%1", "-x", "132", "-y", "41"],
  ]);
  assert.deepEqual(result, {
    windowId: "@1",
    paneId: "%1",
    pid: 42,
    command: "node",
    windowCols: 132,
    windowRows: 41,
    paneLeft: 0,
    paneTop: 1,
    paneCols: 132,
    paneRows: 40,
    stableSamples: 2,
    markerCount: 1,
  });
});

for (const [name, rows] of [
  ["wrong pane mapping", [exact.replace("%1", "%2"), exact.replace("%1", "%2")]],
  ["unstable identity", [exact, exact.replace("\t42\t", "\t43\t")]],
  ["wrong geometry", [exact.replace("\t132\t40\t", "\t131\t40\t"), exact]],
  ["legacy top-zero geometry", [exact.replace("\t0\t1\t132\t", "\t0\t0\t132\t"), exact]],
])
  test(`fails closed before daemon for ${name}`, async () => {
    let clock = 0;
    await assert.rejects(
      conditionAnsiTmuxFixture({
        paneId: "%1",
        marker: "ANSI_MARKER",
        executable: "/usr/bin/node",
        run: async (args) => {
          if (args[0] === "list-panes") return rows.shift() ?? "";
          if (args[0] === "capture-pane") return "ANSI_MARKER";
          return "";
        },
        now: () => clock,
        wait: async () => {
          clock += 25;
        },
        timeoutMs: 75,
      }),
      /did not reach exact stable geometry/u,
    );
  });

test("never starts an expired child and reports bounded predicate facts", async () => {
  let clock = 0;
  const calls = [];
  await assert.rejects(
    conditionAnsiTmuxFixture({
      paneId: "%1",
      marker: "ANSI_MARKER",
      executable: "/usr/bin/node",
      run: async (args) => {
        calls.push(args[0]);
        clock += args[0] === "list-panes" ? 60 : 1;
        return args[0] === "list-panes" ? exact : "";
      },
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
      timeoutMs: 50,
    }),
    (error) => {
      assert.deepEqual(error.observation, {
        stage: "ansi-tmux-precondition",
        outcome: "list-deadline",
        exactSamples: 0,
        listAttempts: 1,
        captureAttempts: 0,
        markerCount: 0,
        remainingMs: 0,
        singleRow: false,
        paneIdentityExact: false,
        windowIdentityValid: false,
        borderExact: false,
        commandExact: false,
        numericExact: false,
        windowGeometryExact: false,
        paneGeometryExact: false,
        markerExact: false,
        stable: false,
      });
      return true;
    },
  );
  assert.deepEqual(calls, ["set-option", "resize-window", "list-panes"]);
});

test("normalizes list and capture child failures without leaking their message", async () => {
  for (const [stage, failure, expectedOutcome] of [
    ["list-panes", Object.assign(new Error("/tmp/private.sock %99"), { code: "EIO" }), "list-exit"],
    [
      "capture-pane",
      Object.assign(new Error("secret marker"), { code: "ETIMEDOUT" }),
      "capture-timeout",
    ],
  ]) {
    await assert.rejects(
      conditionAnsiTmuxFixture({
        paneId: "%1",
        marker: "ANSI_MARKER",
        executable: "/usr/bin/node",
        run: async (args) => {
          if (args[0] === stage) throw failure;
          if (args[0] === "list-panes") return exact;
          return "";
        },
        now: () => 0,
      }),
      (error) => {
        assert.equal(error.observation.outcome, expectedOutcome);
        assert.doesNotMatch(JSON.stringify(error.observation), /tmp|private|secret|%99/u);
        return true;
      },
    );
  }
});
