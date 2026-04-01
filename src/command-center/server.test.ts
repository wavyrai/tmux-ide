import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentIdentifier } from "../lib/orchestrator.ts";
import {
  ensureTasksDir,
  saveMission,
  saveTask,
  loadTask,
  loadMission,
  type Task,
} from "../lib/task-store.ts";
import { saveValidationState } from "../lib/validation.ts";
import { appendEvent } from "../lib/event-log.ts";
import { loadResearchState, saveResearchState } from "../lib/research.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import { createApp } from "./server.ts";
import { makeTask, makePane } from "../__tests__/support.ts";

let tmpDir: string;
let restoreTmux: () => void;
let restoreDiscoveryTmux: () => void;
let mockPanes: PaneInfo[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-cc-srv-test-"));
  ensureTasksDir(tmpDir);
  mockPanes = [];

  restoreTmux = _setExecutor((_cmd: string, args: string[]) => {
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}\t${p.role ?? ""}\t${p.name ?? ""}\t${p.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });

  restoreDiscoveryTmux = _setTmuxRunner((args: string[]) => {
    if (args[0] === "list-sessions") return "test-project";
    if (args[0] === "display-message") return tmpDir;
    return "";
  });
});

afterEach(() => {
  restoreTmux();
  restoreDiscoveryTmux();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/sessions", () => {
  it("returns discovered sessions", async () => {
    saveMission(tmpDir, {
      title: "Test mission",
      description: "",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    saveTask(tmpDir, makeTask({ id: "001", status: "done" }));
    saveTask(tmpDir, makeTask({ id: "002", status: "todo" }));

    const app = createApp();
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sessions: Array<{ name: string; stats: { totalTasks: number; doneTasks: number } }>;
    };
    expect(body.sessions.length).toBe(1);
    expect(body.sessions[0]!.name).toBe("test-project");
    expect(body.sessions[0]!.stats.totalTasks).toBe(2);
    expect(body.sessions[0]!.stats.doneTasks).toBe(1);
  });
});

describe("GET /api/project/:name", () => {
  it("returns project detail", async () => {
    const pane = makePane({ id: "%1", index: 0, title: "Agent 1", currentCommand: "claude" });
    const name = agentIdentifier(pane);
    saveTask(tmpDir, makeTask({ id: "001", status: "in-progress", assignee: name }));
    mockPanes = [pane];

    const app = createApp();
    const res = await app.request("/api/project/test-project");
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      session: string;
      tasks: Task[];
      agents: Array<{ paneTitle: string }>;
    };
    expect(body.session).toBe("test-project");
    expect(body.tasks.length).toBe(1);
    expect(body.agents.length).toBe(1);
    expect(body.agents[0]!.paneTitle).toBe(name);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/project/:name/task/:id", () => {
  it("updates task status", async () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "todo" }));

    const app = createApp();
    const res = await app.request("/api/project/test-project/task/001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in-progress" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; task: Task };
    expect(body.ok).toBe(true);
    expect(body.task.status).toBe("in-progress");

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.status).toBe("in-progress");
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/task/001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects invalid status via zod validation", async () => {
    saveTask(tmpDir, makeTask({ id: "001" }));
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid-status" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/project/:name/task (create)", () => {
  it("creates a task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New task", priority: 1 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; task: Task };
    expect(body.ok).toBe(true);
    expect(body.task.title).toBe("New task");
    expect(body.task.status).toBe("todo");
    expect(body.task.id).toBeTruthy();
  });

  it("returns 400 when title is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no title" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when title is only whitespace", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/project/:name/task/:id", () => {
  it("deletes a task", async () => {
    saveTask(tmpDir, makeTask({ id: "001" }));
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/001", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(loadTask(tmpDir, "001")).toBe(null);
  });

  it("returns 404 for unknown task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/999", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/task/001", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/project/:name/plans", () => {
  it("returns plan list with metadata", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, "01-test.md"),
      "# Plan 01\n\n**Status:** `pending`\n**Effort:** Low\n",
    );

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: Array<{ name: string; status: string }> };
    expect(body.plans.length >= 1).toBeTruthy();
    const plan = body.plans.find((p) => p.name === "01-test");
    expect(plan).toBeTruthy();
    expect(plan!.status).toBe("pending");
  });
});

describe("research endpoints", () => {
  it("returns research state, active task, and recent findings", async () => {
    saveTask(
      tmpDir,
      makeTask({
        id: "010",
        title: "Research: mission start",
        status: "done",
        updated: "2026-01-02T00:00:00Z",
        tags: ["research", "mission_start"],
        salientSummary: "Initial audit completed",
      }),
    );
    saveTask(
      tmpDir,
      makeTask({
        id: "011",
        title: "Research: periodic",
        status: "in-progress",
        updated: "2026-01-03T00:00:00Z",
        tags: ["research", "periodic"],
      }),
    );
    saveResearchState(tmpDir, {
      lastResearchAt: { periodic: "2026-01-03T00:00:00Z" },
      missionStartAnalyzed: true,
      milestoneTaskCounts: {},
      activeResearchTaskId: "011",
      retryWindow: [],
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/research");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { activeResearchTaskId: string | null; missionStartAnalyzed: boolean };
      activeTask: Task | null;
      findings: Task[];
    };
    expect(body.state.activeResearchTaskId).toBe("011");
    expect(body.state.missionStartAnalyzed).toBe(true);
    expect(body.activeTask?.id).toBe("011");
    expect(body.findings.map((task) => task.id)).toEqual(["010"]);
  });

  it("manually dispatches research through the API", async () => {
    mockPanes = [
      makePane({
        id: "%2",
        index: 1,
        title: "Researcher",
        role: "researcher",
        currentCommand: "zsh",
      }),
    ];

    const app = createApp();
    const res = await app.request("/api/project/test-project/research/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "periodic" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; task: Task };
    expect(body.ok).toBe(true);
    expect(body.task.tags).toEqual(["research", "periodic"]);
    expect(body.task.specialty).toBe("researcher");

    const persisted = loadTask(tmpDir, body.task.id);
    expect(persisted?.status).toBe("in-progress");
    expect(loadResearchState(tmpDir).activeResearchTaskId).toBe(body.task.id);
  });
});

describe("GET /api/project/:name/plans/:filename", () => {
  it("returns plan content", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test-plan.md"), "# Test Plan\n\nSome content.");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/test-plan");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; content: string; marks: unknown };
    expect(body.content.includes("Test Plan")).toBeTruthy();
  });

  it("returns 404 for missing plan", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/project/:name/plans/:filename", () => {
  it("saves plan content", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/new-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# New Plan\n\nContent here." }),
    });
    expect(res.status).toBe(200);

    const getRes = await app.request("/api/project/test-project/plans/new-plan");
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { content: string };
    expect(body.content.includes("New Plan")).toBeTruthy();
  });
});

describe("DELETE /api/project/:name/plans/:filename", () => {
  it("deletes a plan file", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "to-delete.md"), "# Delete me");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/to-delete", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const getRes = await app.request("/api/project/test-project/plans/to-delete");
    expect(getRes.status).toBe(404);
  });
});

describe("POST /api/project/:name/plans/:filename/done", () => {
  it("marks a plan as done", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "70-test.md"), "# Plan 70\n\n**Status:** `in-progress`\n");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/70-test/done", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; plan: { status: string } };
    expect(body.ok).toBe(true);
    expect(body.plan.status).toBe("done");
  });
});

describe("GET /api/project/:name/diff", () => {
  it("returns diff shape", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/diff");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { diff: string; files: unknown[] };
    expect(typeof body.diff).toBe("string");
    expect(Array.isArray(body.files)).toBeTruthy();
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/diff");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/project/:name/events", () => {
  it("returns recent events", async () => {
    appendEvent(tmpDir, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: "001",
      message: "Test event",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ type: string; message: string; relative: string }>;
    };
    expect(body.events.length >= 1).toBeTruthy();
    expect(body.events[0]!.message).toBe("Test event");
    expect(body.events[0]!.relative).toBeTruthy();
  });

  it("returns empty events when no log exists", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[] };
    expect(body.events).toEqual([]);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/events");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/project/:name/diff/:file", () => {
  it("returns per-file diff shape", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/diff/src/index.ts");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { file: string; diff: string };
    expect(body.file).toBe("src/index.ts");
    expect(typeof body.diff).toBe("string");
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/diff/file.ts");
    expect(res.status).toBe(404);
  });
});

// GET /api/events (SSE) — stream endpoint; smoke-test headers only
describe("GET /api/events (SSE)", () => {
  it("returns SSE content-type header", async () => {
    const app = createApp();
    const res = await app.request("/api/events");

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType?.includes("text/event-stream")).toBeTruthy();
  });
});

describe("GET /", () => {
  it("returns a response for root path", async () => {
    const app = createApp();
    const res = await app.request("/");
    // With dashboard/out: serves HTML (200). Without: middleware falls through (404).
    expect([200, 404]).toContain(res.status);
  });
});

describe("GET /api/project/:name/milestones", () => {
  it("returns milestones with task counts", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "active",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "Phase 1",
          description: "",
          status: "active",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
        {
          id: "M2",
          title: "Phase 2",
          description: "",
          status: "locked",
          order: 2,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    saveTask(tmpDir, makeTask({ id: "001", milestone: "M1" }));
    saveTask(tmpDir, makeTask({ id: "002", milestone: "M1", status: "done" }));
    saveTask(tmpDir, makeTask({ id: "003", milestone: "M2" }));

    const app = createApp();
    const res = await app.request("/api/project/test-project/milestones");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      milestones: Array<{ id: string; taskCount: number; tasksDone: number }>;
    };
    expect(body.milestones.length).toBe(2);
    expect(body.milestones[0]!.id).toBe("M1");
    expect(body.milestones[0]!.taskCount).toBe(2);
    expect(body.milestones[0]!.tasksDone).toBe(1);
    expect(body.milestones[1]!.id).toBe("M2");
    expect(body.milestones[1]!.taskCount).toBe(1);
  });
});

describe("POST /api/project/:name/milestones", () => {
  it("creates a milestone", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "planning",
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/milestones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Foundation", sequence: 1 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; milestone: { id: string; status: string } };
    expect(body.ok).toBe(true);
    expect(body.milestone.id).toBe("M1");
    expect(body.milestone.status).toBe("active");

    // Verify persisted
    const mission = loadMission(tmpDir)!;
    expect(mission.milestones.length).toBe(1);
  });

  it("updates a milestone status", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "active",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "Phase 1",
          description: "",
          status: "active",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/milestones/M1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "validating" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; milestone: { status: string } };
    expect(body.milestone.status).toBe("validating");
  });

  it("rejects invalid milestone transitions", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "active",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "Phase 1",
          description: "",
          status: "locked",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/milestones/M1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Invalid milestone status transition");
  });

  it("rejects invalid milestone status payloads", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "active",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "Phase 1",
          description: "",
          status: "active",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/milestones/M1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/project/:name/validation", () => {
  it("returns validation state and contract", async () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    writeFileSync(join(tmpDir, ".tasks", "validation-contract.md"), "**ASSERT01**: Auth works");
    saveValidationState(tmpDir, {
      assertions: {
        ASSERT01: {
          status: "passing",
          verifiedBy: "v",
          verifiedAt: "2026-01-01T00:00:00Z",
          evidence: "ok",
          blockedBy: null,
        },
      },
      lastVerified: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/validation");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contract: string;
      state: { assertions: Record<string, { status: string }> };
    };
    expect(body.contract).toContain("ASSERT01");
    expect(body.state.assertions["ASSERT01"]!.status).toBe("passing");
  });
});

describe("GET /api/project/:name/skills", () => {
  it("returns loaded skills", async () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "frontend.md"),
      `---\nname: frontend\nspecialties: [frontend, css]\nrole: teammate\ndescription: Frontend dev\n---\nYou build UIs.`,
    );

    const app = createApp();
    const res = await app.request("/api/project/test-project/skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skills: Array<{ name: string; specialties: string[] }> };
    expect(body.skills.length).toBe(1);
    expect(body.skills[0]!.name).toBe("frontend");
    expect(body.skills[0]!.specialties).toContain("frontend");
  });
});

describe("GET /api/project/:name/mission", () => {
  it("returns mission with validation summary", async () => {
    saveMission(tmpDir, {
      title: "Ship v2",
      description: "Major release",
      status: "active",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "Phase 1",
          description: "",
          status: "done",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    saveValidationState(tmpDir, {
      assertions: {
        A1: {
          status: "passing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
        A2: {
          status: "failing",
          verifiedBy: null,
          verifiedAt: null,
          evidence: null,
          blockedBy: null,
        },
      },
      lastVerified: null,
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/mission");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mission: { title: string };
      validationSummary: { total: number; passing: number; failing: number };
    };
    expect(body.mission.title).toBe("Ship v2");
    expect(body.validationSummary.total).toBe(2);
    expect(body.validationSummary.passing).toBe(1);
    expect(body.validationSummary.failing).toBe(1);
  });
});

describe("POST /api/project/:name/mission/plan-complete", () => {
  it("transitions mission from planning to active", async () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      status: "planning",
      branch: null,
      milestones: [
        {
          id: "M1",
          title: "Phase 1",
          description: "",
          status: "locked",
          order: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
        },
      ],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/mission/plan-complete", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mission: { status: string; milestones: Array<{ id: string; status: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.mission.status).toBe("active");
    expect(body.mission.milestones[0]!.status).toBe("active");
  });
});
