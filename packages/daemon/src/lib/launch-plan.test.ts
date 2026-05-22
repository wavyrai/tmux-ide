import { describe, it, expect } from "bun:test";
import { buildPaneCommand, collectPaneStartupPlan } from "./launch-plan.ts";
import type { Row } from "../types.ts";

describe("buildPaneCommand", () => {
  it("passes through normal pane commands", () => {
    expect(buildPaneCommand({ command: "pnpm dev" })).toBe("pnpm dev");
  });

  it("returns the command unchanged for Claude panes", () => {
    expect(buildPaneCommand({ command: "claude", role: "lead" })).toBe("claude");
    expect(buildPaneCommand({ command: "claude", role: "teammate", task: 'Fix "lint"' })).toBe(
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

    expect(result.focusPane).toBe("%1");
    expect(result.paneActions).toEqual([
      {
        targetPane: "%1",
        title: "Lead",
        chdir: null,
        exports: [`export 'PORT'='3000'`],
        command: `claude --name 'Lead'`,
        widgetType: null,
        widgetTarget: null,
        paneRole: "lead",
        paneType: "agent",
      },
      {
        targetPane: "%2",
        title: "Worker",
        chdir: null,
        exports: [],
        command: `claude --name 'Worker'`,
        widgetType: null,
        widgetTarget: null,
        paneRole: "teammate",
        paneType: "agent",
      },
      {
        targetPane: "%3",
        title: "Shell",
        chdir: "/workspace/apps/web",
        exports: [],
        command: null,
        widgetType: null,
        widgetTarget: null,
        paneRole: "shell",
        paneType: "shell",
      },
    ]);
  });

  it("widgets:false config produces fewer pane actions when widget panes are stripped", () => {
    const fullRows: Row[] = [
      {
        panes: [
          { title: "Claude", command: "claude", role: "lead" },
          { title: "Tasks", type: "tasks" },
          { title: "Explorer", type: "explorer" },
        ],
      },
      {
        panes: [{ title: "Shell" }, { title: "War Room", type: "warroom" }],
      },
    ];

    // Simulate headless mode: strip widget panes (panes with type set)
    const headlessRows = fullRows
      .map((row) => ({ ...row, panes: row.panes.filter((p) => !p.type) }))
      .filter((row) => row.panes.length > 0);

    const fullResult = collectPaneStartupPlan(
      fullRows,
      [
        ["%1", "%2", "%3"],
        ["%4", "%5"],
      ],
      new Set(["%1", "%4"]),
      "/workspace",
    );

    const headlessResult = collectPaneStartupPlan(
      headlessRows,
      [["%1"], ["%4"]],
      new Set(["%1", "%4"]),
      "/workspace",
    );

    // Full has 5 pane actions (3 widgets + agent + shell)
    expect(fullResult.paneActions.length).toBe(5);
    // Headless has only 2 (agent + shell), 3 widget panes stripped
    expect(headlessResult.paneActions.length).toBe(2);
    expect(headlessResult.paneActions.every((a) => a.widgetType === null)).toBeTruthy();
  });
});
