import { describe, expect, it } from "vitest";
import { WorkspaceConfigV1SchemaZ } from "../workspace-config.ts";

describe("WorkspaceConfigV1SchemaZ", () => {
  it("accepts a minimal versioned workspace", () => {
    expect(WorkspaceConfigV1SchemaZ.parse({ version: 1 })).toEqual({ version: 1 });
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
});
