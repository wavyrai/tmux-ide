import { describe, it, expect } from "bun:test";
import { WORKSPACE_SEMANTIC_PANE_OPTION } from "@tmux-ide/contracts";
import {
  buildPaneCommand,
  collectPaneStartupPlan,
  paneIdentityOptions,
  semanticPaneIdForPane,
} from "./launch-plan.ts";
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
          {
            id: "agent-lead",
            title: "Lead",
            command: "claude",
            role: "lead",
            focus: true,
            env: { PORT: 3000 },
          },
          {
            id: "agent-worker",
            title: "Worker",
            command: "claude",
            role: "teammate",
            task: "Review",
          },
        ],
      },
      {
        panes: [{ id: "shell-main", title: "Shell", dir: "apps/web" }],
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
        semanticPaneId: "agent-lead",
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
        semanticPaneId: "agent-worker",
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
        semanticPaneId: "shell-main",
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

  it("uses explicit ids and deterministic metadata ids instead of row/column positions", () => {
    expect(semanticPaneIdForPane({ id: "agent-lead", title: "Renamed" })).toBe("agent-lead");
    const derived = semanticPaneIdForPane({ title: "Lead", command: "claude" });
    expect(derived).toMatch(/^pane-lead-[a-f0-9]{16}$/u);
    expect(
      semanticPaneIdForPane({
        title: "Lead",
        command: "claude",
        env: { B: "2", A: "1" },
      }),
    ).toBe(
      semanticPaneIdForPane({
        title: "Lead",
        command: "claude",
        env: { A: "1", B: "2" },
      }),
    );

    expect(
      paneIdentityOptions({
        semanticPaneId: "agent-lead",
        paneRole: "lead",
        paneType: "agent",
        title: "Lead",
      }),
    ).toEqual([
      [WORKSPACE_SEMANTIC_PANE_OPTION, "agent-lead"],
      ["@ide_role", "lead"],
      ["@ide_name", "Lead"],
      ["@ide_type", "agent"],
    ]);
  });

  it("keeps derived identities stable across insert, reorder, and delete", () => {
    const original: Row[] = [
      {
        panes: [
          { title: "Planner", command: "claude" },
          { title: "Implementer", command: "codex" },
        ],
      },
    ];
    const changed: Row[] = [
      {
        panes: [
          { title: "Reviewer", command: "claude" },
          { title: "Implementer", command: "codex" },
          { title: "Planner", command: "claude" },
        ],
      },
    ];
    const deleted: Row[] = [{ panes: [{ title: "Planner", command: "claude" }] }];
    const first = collectPaneStartupPlan(original, [["%1", "%2"]], new Set(["%1"]), "/repo");
    const second = collectPaneStartupPlan(changed, [["%3", "%4", "%5"]], new Set(["%3"]), "/repo");
    const third = collectPaneStartupPlan(deleted, [["%6"]], new Set(["%6"]), "/repo");
    const byTitle = (plan: typeof first) =>
      new Map(plan.paneActions.map((action) => [action.title, action.semanticPaneId]));

    expect(byTitle(second).get("Planner")).toBe(byTitle(first).get("Planner"));
    expect(byTitle(second).get("Implementer")).toBe(byTitle(first).get("Implementer"));
    expect(byTitle(third).get("Planner")).toBe(byTitle(first).get("Planner"));
  });

  it("keeps identical implicit legacy panes launchable but diagnoses durable ambiguity", () => {
    const result = collectPaneStartupPlan(
      [{ panes: [{ command: "zsh" }, { command: "zsh" }] }],
      [["%1", "%2"]],
      new Set(["%1"]),
      "/repo",
    );

    expect(new Set(result.paneActions.map((action) => action.semanticPaneId)).size).toBe(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "AMBIGUOUS_IMPLICIT_PANE_ID" }),
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
