import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentIdentifier } from "../lib/orchestrator.ts";
import {
  ensureTasksDir,
  saveMission,
  saveGoal,
  saveTask,
  loadTask,
  type Task,
} from "../lib/task-store.ts";
import { appendEvent } from "../lib/event-log.ts";
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
});

// GET /api/events (SSE) — skipped: streamSSE loops forever, can't test via app.request()
// Requires a real HTTP server + EventSource client for proper testing

describe("GET /", () => {
  it("returns health check", async () => {
    const app = createApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/project/:name/task (create)", () => {
  it("creates a new task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test", priority: 1 }),
    });

    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as { ok: boolean; task: Task };
    assert.strictEqual(body.ok, true);
    assert.ok(body.task.id);
    assert.strictEqual(body.task.status, "todo");
    assert.strictEqual(body.task.title, "Test");
    assert.strictEqual(body.task.priority, 1);
  });

  it("returns 400 when title is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  " }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test" }),
    });
    assert.strictEqual(res.status, 404);
  });
});

describe("DELETE /api/project/:name/task/:id", () => {
  it("deletes an existing task", async () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "todo" }));

    const app = createApp();
    const res = await app.request("/api/project/test-project/task/001", {
      method: "DELETE",
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean; deleted: string };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.deleted, "001");

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded, null);
  });

  it("returns 404 for unknown task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/999", {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 404);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/task/001", {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/project/:name/plans", () => {
  it("returns list of plan files", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "roadmap.md"), "# Roadmap\n\n**Status:** `pending`\n");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { plans: Array<{ name: string; path: string; title: string; status: string }> };
    assert.ok(Array.isArray(body.plans));
    assert.strictEqual(body.plans.length, 1);
    assert.strictEqual(body.plans[0]!.name, "roadmap");
    assert.strictEqual(body.plans[0]!.path, "roadmap.md");
    assert.strictEqual(body.plans[0]!.title, "Roadmap");
    assert.strictEqual(body.plans[0]!.status, "pending");
  });

  it("returns empty array when no plans dir", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/plans");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { plans: unknown[] };
    assert.deepStrictEqual(body.plans, []);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/plans");
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/project/:name/plans/:filename", () => {
  it("returns plan content with marks and stats", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test-plan.md"), "# Test Plan\n\nSome content here.");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/test-plan");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { name: string; content: string; marks: unknown; stats: unknown };
    assert.strictEqual(body.name, "test-plan");
    assert.ok(body.content.includes("Test Plan"));
    assert.ok("marks" in body);
    assert.ok("stats" in body);
  });

  it("returns 404 for missing plan", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/nonexistent");
    assert.strictEqual(res.status, 404);
  });
});

describe("POST /api/project/:name/plans/:filename", () => {
  it("saves plan content", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/new-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Test" }),
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.strictEqual(body.ok, true);

    // Verify the file was written
    const filePath = join(tmpDir, "plans", "new-plan.md");
    assert.ok(existsSync(filePath));
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/plans/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Test" }),
    });
    assert.strictEqual(res.status, 404);
  });
});

describe("DELETE /api/project/:name/plans/:filename", () => {
  it("deletes an existing plan", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "delete-me.md"), "# Delete Me");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/delete-me", {
      method: "DELETE",
    });

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean; deleted: string };
    assert.strictEqual(body.ok, true);
    assert.ok(!existsSync(join(plansDir, "delete-me.md")));
  });

  it("returns 404 for missing plan", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/nonexistent", {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/project/:name/diff", () => {
  it("returns diff and files shape (empty for non-git dir)", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/diff");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { diff: string; files: unknown[] };
    assert.strictEqual(typeof body.diff, "string");
    assert.ok(Array.isArray(body.files));
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/diff");
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/project/:name/diff/:file", () => {
  it("returns per-file diff shape", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/diff/src/index.ts");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { file: string; diff: string };
    assert.strictEqual(body.file, "src/index.ts");
    assert.strictEqual(typeof body.diff, "string");
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/diff/file.ts");
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/project/:name/events", () => {
  it("returns events array", async () => {
    appendEvent(tmpDir, {
      timestamp: new Date().toISOString(),
      type: "dispatch",
      taskId: "001",
      agent: "Agent 1",
      message: "Dispatched task 001",
    });

    const app = createApp();
    const res = await app.request("/api/project/test-project/events");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { events: Array<{ type: string; message: string; relative: string }> };
    assert.ok(Array.isArray(body.events));
    assert.strictEqual(body.events.length, 1);
    assert.strictEqual(body.events[0]!.type, "dispatch");
    assert.strictEqual(body.events[0]!.message, "Dispatched task 001");
    assert.ok(body.events[0]!.relative);
  });

  it("returns empty events when no log exists", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/events");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { events: unknown[] };
    assert.deepStrictEqual(body.events, []);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/events");
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/events (SSE)", () => {
  it("returns SSE content-type header", async () => {
    const app = createApp();
    const res = await app.request("/api/events");

    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get("content-type");
    assert.ok(contentType?.includes("text/event-stream"), `Expected SSE content-type, got: ${contentType}`);
  });
});

describe("GET / (health check)", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await app.request("/");
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { status: string; message: string; docs: string };
    assert.strictEqual(body.status, "ok");
    assert.strictEqual(body.message, "tmux-ide command center API");
    assert.strictEqual(body.docs, "/api/sessions");
  });
});
