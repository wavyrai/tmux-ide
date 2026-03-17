import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPaneCommand, collectPaneStartupPlan } from "./launch-plan.js";

describe("buildPaneCommand", () => {
  it("passes through normal pane commands", () => {
    assert.strictEqual(buildPaneCommand({ command: "pnpm dev" }), "pnpm dev");
  });

  it("returns the command unchanged for Claude panes", () => {
    assert.strictEqual(buildPaneCommand({ command: "claude", role: "lead" }), "claude");
    assert.strictEqual(
      buildPaneCommand({ command: "claude", role: "teammate", task: 'Fix "lint"' }),
      "claude",
    );
  });
});

describe("collectPaneStartupPlan", () => {
  it("launches team panes as normal pane commands", () => {
    const rows = [
      {
        panes: [
          { title: "Lead", command: "claude", role: "lead", focus: true, env: { PORT: 3000 } },
          { title: "Worker", command: "claude", role: "teammate", task: "Review" },
        ],
      },
      {
        panes: [{ title: "Shell", dir: "apps/web" }],
      },
    ];

    const result = collectPaneStartupPlan(
      rows,
      [["%1", "%2"], ["%3"]],
      new Set(["%1", "%3"]),
      "/workspace",
    );

    assert.strictEqual(result.focusPane, "%1");
    assert.deepStrictEqual(result.paneActions, [
      {
        targetPane: "%1",
        title: "Lead",
        chdir: null,
        exports: ["export PORT=3000"],
        command: "claude",
      },
      {
        targetPane: "%2",
        title: "Worker",
        chdir: null,
        exports: [],
        command: "claude",
      },
      {
        targetPane: "%3",
        title: "Shell",
        chdir: "/workspace/apps/web",
        exports: [],
        command: null,
      },
    ]);
  });
});
