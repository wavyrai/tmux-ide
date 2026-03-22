import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}`,
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
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { sessions: Array<{ name: string; stats: { totalTasks: number; doneTasks: number } }> };
    assert.strictEqual(body.sessions.length, 1);
    assert.strictEqual(body.sessions[0]!.name, "test-project");
    assert.strictEqual(body.sessions[0]!.stats.totalTasks, 2);
    assert.strictEqual(body.sessions[0]!.stats.doneTasks, 1);
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
    assert.strictEqual(res.status, 200);

    const body = (await res.json()) as { session: string; tasks: Task[]; agents: Array<{ paneTitle: string }> };
    assert.strictEqual(body.session, "test-project");
    assert.strictEqual(body.tasks.length, 1);
    assert.strictEqual(body.agents.length, 1);
    assert.strictEqual(body.agents[0]!.paneTitle, name);
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent");
    assert.strictEqual(res.status, 404);
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

    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean; task: Task };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.task.status, "in-progress");

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.status, "in-progress");
  });

  it("returns 404 for unknown session", async () => {
    const app = createApp();
    const res = await app.request("/api/project/nonexistent/task/001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("returns 404 for unknown task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/999", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.strictEqual(res.status, 404);
  });

  it("rejects invalid status via zod validation", async () => {
    saveTask(tmpDir, makeTask({ id: "001" }));
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/001", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "invalid-status" }),
    });
    assert.strictEqual(res.status, 400);
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
    assert.strictEqual(res.status, 201);
    const body = (await res.json()) as { ok: boolean; task: Task };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.task.title, "New task");
    assert.strictEqual(body.task.status, "todo");
    assert.ok(body.task.id);
  });

  it("returns 400 when title is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "no title" }),
    });
    assert.strictEqual(res.status, 400);
  });
});

describe("DELETE /api/project/:name/task/:id", () => {
  it("deletes a task", async () => {
    saveTask(tmpDir, makeTask({ id: "001" }));
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/001", {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(loadTask(tmpDir, "001"), null);
  });

  it("returns 404 for unknown task", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/task/999", {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 404);
  });
});

describe("GET /api/project/:name/plans", () => {
  it("returns plan list with metadata", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "01-test.md"), "# Plan 01\n\n**Status:** `pending`\n**Effort:** Low\n");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans");
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { plans: Array<{ name: string; status: string }> };
    assert.ok(body.plans.length >= 1);
    const plan = body.plans.find((p) => p.name === "01-test");
    assert.ok(plan);
    assert.strictEqual(plan!.status, "pending");
  });
});

describe("GET /api/project/:name/plans/:filename", () => {
  it("returns plan content", async () => {
    const plansDir = join(tmpDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test-plan.md"), "# Test Plan\n\nSome content.");

    const app = createApp();
    const res = await app.request("/api/project/test-project/plans/test-plan");
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { name: string; content: string; marks: unknown };
    assert.ok(body.content.includes("Test Plan"));
  });

  it("returns 404 for missing plan", async () => {
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
      body: JSON.stringify({ content: "# New Plan\n\nContent here." }),
    });
    assert.strictEqual(res.status, 200);

    const getRes = await app.request("/api/project/test-project/plans/new-plan");
    assert.strictEqual(getRes.status, 200);
    const body = (await getRes.json()) as { content: string };
    assert.ok(body.content.includes("New Plan"));
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
    assert.strictEqual(res.status, 200);

    const getRes = await app.request("/api/project/test-project/plans/to-delete");
    assert.strictEqual(getRes.status, 404);
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
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { ok: boolean; plan: { status: string } };
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.plan.status, "done");
  });
});

describe("GET /api/project/:name/diff", () => {
  it("returns diff shape", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/diff");
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { diff: string; files: unknown[] };
    assert.strictEqual(typeof body.diff, "string");
    assert.ok(Array.isArray(body.files));
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
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { events: Array<{ type: string; message: string; relative: string }> };
    assert.ok(body.events.length >= 1);
    assert.strictEqual(body.events[0]!.message, "Test event");
    assert.ok(body.events[0]!.relative);
  });
});

// GET /api/events (SSE) — skipped: streamSSE loops forever, can't test via app.request()
// Requires a real HTTP server + EventSource client for proper testing

describe("GET /", () => {
  it("returns health check", async () => {
    const app = createApp();
    const res = await app.request("/");
    assert.strictEqual(res.status, 200);
  });
});
