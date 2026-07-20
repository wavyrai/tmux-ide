import { describe, expect, it } from "vitest";
import { WorkspaceConfigV1SchemaZ } from "../workspace-config.ts";
import type { WorkspaceAppLayoutNode } from "../workspace-config.ts";

describe("WorkspaceConfigV1SchemaZ", () => {
  it("accepts a minimal versioned workspace", () => {
    expect(WorkspaceConfigV1SchemaZ.parse({ version: 1 })).toEqual({ version: 1 });
  });

  it("accepts unique workspace-safe pane ids and rejects duplicates", () => {
    expect(
      WorkspaceConfigV1SchemaZ.parse({
        version: 1,
        terminal: { rows: [{ panes: [{ id: "agent-1" }, { id: "shell" }] }] },
      }).terminal?.rows[0]?.panes.map((pane) => pane.id),
    ).toEqual(["agent-1", "shell"]);
    expect(() =>
      WorkspaceConfigV1SchemaZ.parse({
        version: 1,
        terminal: {
          rows: [{ panes: [{ id: "duplicate" }] }, { panes: [{ id: "duplicate" }] }],
        },
      }),
    ).toThrow(/Duplicate pane id/u);
  });

  it("keeps harnesses, adapters, commands, and models provider-neutral", () => {
    const result = WorkspaceConfigV1SchemaZ.parse({
      version: 1,
      name: "Mixed agents",
      terminal: {
        rows: [
          {
            size: "70%",
            panes: [{ title: "Lead", command: "claude", focus: true }],
          },
        ],
        theme: { accent: "colour75" },
      },
      app: {
        views: [
          { id: "home", panel: "home" },
          { id: "terminal", title: "IDE", panel: "terminals" },
          { id: "mission-board", panel: "missions" },
        ],
      },
      harnesses: {
        claude: { adapter: "claude-code", command: ["claude"] },
        codex: { adapter: "codex", command: ["codex", "--ask-for-approval", "never"] },
        droid: { adapter: "droid", command: "droid" },
        custom: {
          adapter: "acme/custom-v4",
          command: ["my-review-agent", "--interactive"],
          env: { REVIEW_MODE: "strict" },
        },
      },
      agents: {
        lead: { harness: "claude", model: "claude-fable-5", role: "manager" },
        worker: { harness: "codex", model: "gpt-5.5", role: "implementer" },
        researcher: { harness: "droid", model: "anything/new", role: "researcher" },
        reviewer: { harness: "custom", role: "reviewer" },
      },
      missions: {
        manager: "lead",
        workers: ["worker", "researcher"],
        reviewer: "reviewer",
        isolation: "worktree",
        max_concurrent_tasks: 2,
      },
    });

    expect(result.harnesses?.custom?.adapter).toBe("acme/custom-v4");
    expect(result.agents?.researcher?.model).toBe("anything/new");
  });

  it("rejects unknown keys at every object boundary", () => {
    expect(() => WorkspaceConfigV1SchemaZ.parse({ version: 1, versoin: 1 })).toThrow();
    expect(() =>
      WorkspaceConfigV1SchemaZ.parse({
        version: 1,
        harnesses: { custom: { adapter: "generic", command: ["agent"], typo: true } },
      }),
    ).toThrow();
    expect(() =>
      WorkspaceConfigV1SchemaZ.parse({
        version: 1,
        terminal: { rows: [{ panes: [{ command: "shell", task: "legacy metadata" }] }] },
      }),
    ).toThrow();
  });

  it("rejects invalid panel, role, isolation, and concurrency values", () => {
    const invalidValues = [
      { version: 1, app: { views: [{ id: "bad", panel: "unknown" }] } },
      {
        version: 1,
        harnesses: { h: { adapter: "custom", command: "agent" } },
        agents: { a: { harness: "h", role: "lead" } },
      },
      { version: 1, missions: { isolation: "container" } },
      { version: 1, missions: { max_concurrent_tasks: 0 } },
      { version: 1, missions: { max_concurrent_tasks: 1.5 } },
    ];

    for (const value of invalidValues) {
      expect(WorkspaceConfigV1SchemaZ.safeParse(value).success).toBe(false);
    }
  });

  it("rejects broken harness and mission agent references with useful paths", () => {
    const result = WorkspaceConfigV1SchemaZ.safeParse({
      version: 1,
      agents: {
        worker: { harness: "missing-harness", role: "implementer" },
      },
      missions: {
        manager: "missing-manager",
        workers: ["worker", "missing-worker"],
        reviewer: "missing-reviewer",
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "agents.worker.harness",
        "missions.manager",
        "missions.workers.1",
        "missions.reviewer",
      ]),
    );
  });

  it("requires unique stable view IDs", () => {
    const result = WorkspaceConfigV1SchemaZ.safeParse({
      version: 1,
      app: {
        views: [
          { id: "ide", panel: "terminals" },
          { id: "ide", panel: "files" },
        ],
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("Duplicate view id");
  });

  it("accepts composite split/tab application views while preserving shorthand views", () => {
    const result = WorkspaceConfigV1SchemaZ.parse({
      version: 1,
      app: {
        views: [
          { id: "home", panel: "home" },
          {
            id: "ide",
            title: "IDE",
            layout: {
              type: "split",
              id: "ide-root",
              direction: "horizontal",
              weights: [72, 28],
              children: [
                { type: "panel", id: "terminal-main", panel: "terminals", min_size: 40 },
                {
                  type: "tabs",
                  id: "inspection-dock",
                  active: "files-tab",
                  children: [
                    { type: "panel", id: "files-tab", panel: "files", min_size: 24 },
                    { type: "panel", id: "diff-tab", panel: "diff", min_size: 24 },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(result.app?.views[0]).toEqual({ id: "home", panel: "home" });
    expect(result.app?.views[1]).toMatchObject({ id: "ide", title: "IDE" });
  });

  it("rejects invalid composite layout trees with precise paths", () => {
    const cases = [
      {
        value: {
          version: 1,
          app: {
            views: [
              {
                id: "bad",
                layout: {
                  type: "split",
                  id: "root",
                  direction: "horizontal",
                  weights: [1],
                  children: [
                    { type: "panel", id: "a", panel: "files" },
                    { type: "panel", id: "b", panel: "diff" },
                  ],
                },
              },
            ],
          },
        },
        path: "app.views.0.layout.weights",
      },
      {
        value: {
          version: 1,
          app: {
            views: [
              {
                id: "bad",
                layout: {
                  type: "tabs",
                  id: "tabs",
                  active: "missing",
                  children: [{ type: "panel", id: "a", panel: "files" }],
                },
              },
            ],
          },
        },
        path: "app.views.0.layout.active",
      },
      {
        value: {
          version: 1,
          app: {
            views: [
              {
                id: "bad",
                layout: {
                  type: "split",
                  id: "root",
                  direction: "vertical",
                  children: [
                    { type: "panel", id: "dup", panel: "files" },
                    { type: "panel", id: "dup", panel: "diff" },
                  ],
                },
              },
            ],
          },
        },
        path: "app.views.0.layout.children.1.id",
      },
    ];

    for (const item of cases) {
      const result = WorkspaceConfigV1SchemaZ.safeParse(item.value);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(item.path);
      }
    }
  });

  it("rejects composite layouts beyond the depth and node-count bounds", () => {
    let deep: WorkspaceAppLayoutNode = { type: "panel", id: "deep-leaf", panel: "files" };
    for (let index = 0; index < 8; index += 1) {
      deep = { type: "tabs", id: `deep-${index}`, children: [deep] };
    }

    let nextId = 0;
    const broad = (depth: number): WorkspaceAppLayoutNode => {
      const id = `node-${nextId++}`;
      if (depth === 0) return { type: "panel", id, panel: "files" };
      return {
        type: "split",
        id,
        direction: "horizontal",
        children: Array.from({ length: 4 }, () => broad(depth - 1)),
      };
    };

    const issuesFor = (layout: WorkspaceAppLayoutNode) => {
      const result = WorkspaceConfigV1SchemaZ.safeParse({
        version: 1,
        app: { views: [{ id: "bounded", layout }] },
      });
      expect(result.success).toBe(false);
      return result.success ? [] : result.error.issues.map((issue) => issue.message);
    };

    expect(issuesFor(deep)).toContain("Composite view layout must not be deeper than 8 nodes");
    expect(issuesFor(broad(3))).toContain("Composite view layout must not exceed 64 nodes");
  });
});
