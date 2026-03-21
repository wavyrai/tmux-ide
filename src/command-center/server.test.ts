import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import { createApp } from "./server.ts";

let tmpDir: string;
let restoreTmux: () => void;
let restoreDiscoveryTmux: () => void;
let mockPanes: PaneInfo[];

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "001",
    title: "Test task",
    description: "Task desc",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 1,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    branch: null,
    tags: [],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
    ...overrides,
  };
}

function makePane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: "%1",
    index: 0,
    title: "Agent 1",
    currentCommand: "claude",
    width: 80,
    height: 24,
    active: false,
    ...overrides,
  };
}

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
});
