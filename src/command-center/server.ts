import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import {
  discoverSessions,
  buildOverviews,
  buildProjectDetail,
  updateTask,
  type SessionOverview,
  type ProjectDetail,
} from "./discovery.ts";
import {
  ensureTasksDir,
  nextTaskId,
  saveTask,
  deleteTask,
  type Task,
} from "../lib/task-store.ts";
import { readEvents, type OrchestratorEvent } from "../lib/event-log.ts";
import { extractMarks, calculateStats, tagContent } from "../lib/authorship.ts";

export function createApp(): Hono {
  const app = new Hono();

  // Allow cross-origin (Next.js dashboard, Tailscale, etc.)
  app.use("/*", cors());

  // --- API routes ---

  app.get("/api/sessions", (c) => {
    const sessions = discoverSessions();
    const overviews = buildOverviews(sessions);
    return c.json({ sessions: overviews });
  });

  app.get("/api/project/:name", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const detail = buildProjectDetail(session);
    return c.json(detail);
  });

  app.post("/api/project/:name/task/:id", async (c) => {
    const name = c.req.param("name");
    const taskId = c.req.param("id");

    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = await c.req.json<{
      status?: string;
      assignee?: string;
      title?: string;
      description?: string;
      priority?: number;
    }>();
    const updated = updateTask(session.dir, taskId, body);
    if (!updated) {
      return c.json({ error: "Task not found" }, 404);
    }

    return c.json({ ok: true, task: updated });
  });

  // Create task
  app.post("/api/project/:name/task", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = await c.req.json<{
      title: string;
      description?: string;
      priority?: number;
      goal?: string;
      tags?: string[];
    }>();

    if (!body.title?.trim()) {
      return c.json({ error: "Title is required" }, 400);
    }

    ensureTasksDir(session.dir);
    const id = nextTaskId(session.dir);
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title: body.title.trim(),
      description: body.description ?? "",
      goal: body.goal ?? null,
      status: "todo",
      assignee: null,
      priority: body.priority ?? 2,
      created: now,
      updated: now,
      branch: null,
      tags: body.tags ?? [],
      proof: null,
      depends_on: [],
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
    };
    saveTask(session.dir, task);
    return c.json({ ok: true, task }, 201);
  });

  // Delete task
  app.delete("/api/project/:name/task/:id", (c) => {
    const name = c.req.param("name");
    const taskId = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    if (!deleteTask(session.dir, taskId)) {
      return c.json({ error: "Task not found" }, 404);
    }
    return c.json({ ok: true, deleted: taskId });
  });

  // List plan files
  app.get("/api/project/:name/plans", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const plansDir = join(session.dir, "plans");
    if (!existsSync(plansDir)) {
      return c.json({ plans: [] });
    }

    const plans = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ name: f.replace(/\.md$/, ""), path: f }));

    return c.json({ plans });
  });

  // Read a single plan file
  app.get("/api/project/:name/plans/:filename", (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Sanitize filename — no path traversal
    const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
    const filePath = join(session.dir, "plans", safeName.endsWith(".md") ? safeName : `${safeName}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: "Plan not found" }, 404);
    }

    const raw = readFileSync(filePath, "utf-8");
    const { content, marks } = extractMarks(raw);
    const stats = marks ? calculateStats(marks.marks) : null;
    return c.json({
      name: safeName.replace(/\.md$/, ""),
      content,
      marks: marks?.marks ?? null,
      stats,
    });
  });

  // Save a plan file (with authorship tagging)
  app.post("/api/project/:name/plans/:filename", async (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = await c.req.json<{ content: string }>();
    if (!body.content && body.content !== "") {
      return c.json({ error: "content is required" }, 400);
    }

    const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
    const filePath = join(session.dir, "plans", safeName.endsWith(".md") ? safeName : `${safeName}.md`);
    const plansDir = join(session.dir, "plans");
    if (!existsSync(plansDir)) mkdirSync(plansDir, { recursive: true });

    // Auto-tag uncovered character ranges as human-authored
    const tagged = tagContent(body.content, "human");
    writeFileSync(filePath, tagged);

    return c.json({ ok: true });
  });

  // Delete a plan file
  app.delete("/api/project/:name/plans/:filename", (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
    const filePath = join(session.dir, "plans", safeName.endsWith(".md") ? safeName : `${safeName}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: "Plan not found" }, 404);
    }

    unlinkSync(filePath);
    return c.json({ ok: true, deleted: safeName });
  });

  app.get("/api/project/:name/diff", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Get git diff (staged + unstaged vs HEAD)
    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD"], {
        cwd: session.dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // No HEAD yet or not a git repo — try unstaged only
    }
    if (!diff) {
      try {
        diff = execFileSync("git", ["diff"], {
          cwd: session.dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        // Not a git repo
      }
    }

    // Get list of changed files with stats
    interface DiffFile {
      file: string;
      additions: number;
      deletions: number;
    }
    let files: DiffFile[] = [];
    try {
      const numstat = execFileSync("git", ["diff", "--numstat", "HEAD"], {
        cwd: session.dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      files = numstat
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [added, removed, file] = line.split("\t");
          return {
            file: file!,
            additions: parseInt(added!, 10) || 0,
            deletions: parseInt(removed!, 10) || 0,
          };
        });
    } catch {
      // Fall back to unstaged
      try {
        const numstat = execFileSync("git", ["diff", "--numstat"], {
          cwd: session.dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        files = numstat
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [added, removed, file] = line.split("\t");
            return {
              file: file!,
              additions: parseInt(added!, 10) || 0,
              deletions: parseInt(removed!, 10) || 0,
            };
          });
      } catch {
        // Not a git repo
      }
    }

    return c.json({ diff, files });
  });

  // Per-file diff endpoint
  app.get("/api/project/:name/diff/:file{.+}", (c) => {
    const name = c.req.param("name");
    const file = c.req.param("file");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD", "--", file], {
        cwd: session.dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {}
    if (!diff) {
      try {
        diff = execFileSync("git", ["diff", "--", file], {
          cwd: session.dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {}
    }

    return c.json({ file, diff });
  });

  // Events endpoint — returns recent orchestrator events
  app.get("/api/project/:name/events", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const allEvents = readEvents(session.dir);
    // Return last 50 events, newest first
    const recent = allEvents.slice(-50).reverse();

    // Add relative timestamps
    const now = Date.now();
    const withRelative = recent.map((e) => {
      const ms = now - new Date(e.timestamp).getTime();
      let relative: string;
      if (ms < 60000) relative = `${Math.floor(ms / 1000)}s ago`;
      else if (ms < 3600000) relative = `${Math.floor(ms / 60000)}m ago`;
      else if (ms < 86400000) relative = `${Math.floor(ms / 3600000)}h ago`;
      else relative = `${Math.floor(ms / 86400000)}d ago`;
      return { ...e, relative };
    });

    return c.json({ events: withRelative });
  });

  // SSE endpoint — polls every 2s and emits changes
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let prevOverviews: SessionOverview[] = [];
      let prevDetails = new Map<string, ProjectDetail>();

      const poll = () => {
        const sessions = discoverSessions();
        const overviews = buildOverviews(sessions);

        // Detect session-level changes
        const prevNames = new Set(prevOverviews.map((s) => s.name));
        const currNames = new Set(overviews.map((s) => s.name));

        for (const overview of overviews) {
          if (!prevNames.has(overview.name)) {
            stream.writeSSE({
              event: "session_added",
              data: JSON.stringify(overview),
            });
            continue;
          }

          const prev = prevOverviews.find((s) => s.name === overview.name);
          if (
            prev &&
            (prev.stats.doneTasks !== overview.stats.doneTasks ||
              prev.stats.totalTasks !== overview.stats.totalTasks ||
              prev.stats.activeAgents !== overview.stats.activeAgents)
          ) {
            stream.writeSSE({
              event: "session_update",
              data: JSON.stringify(overview),
            });
          }
        }

        for (const prev of prevOverviews) {
          if (!currNames.has(prev.name)) {
            stream.writeSSE({
              event: "session_removed",
              data: JSON.stringify({ name: prev.name }),
            });
          }
        }

        // Detect task-level changes per session
        for (const session of sessions) {
          const detail = buildProjectDetail(session);
          const prevDetail = prevDetails.get(session.name);

          if (prevDetail) {
            const prevTaskMap = new Map(prevDetail.tasks.map((t) => [t.id, t]));
            for (const task of detail.tasks) {
              const prevTask = prevTaskMap.get(task.id);
              if (!prevTask) {
                stream.writeSSE({
                  event: "task_update",
                  data: JSON.stringify({
                    session: session.name,
                    taskId: task.id,
                    status: task.status,
                    title: task.title,
                  }),
                });
              } else if (prevTask.status !== task.status || prevTask.assignee !== task.assignee) {
                stream.writeSSE({
                  event: "task_update",
                  data: JSON.stringify({
                    session: session.name,
                    taskId: task.id,
                    status: task.status,
                    assignee: task.assignee,
                  }),
                });
              }
            }

            // Detect agent status changes
            const prevAgentMap = new Map(prevDetail.agents.map((a) => [a.paneTitle, a]));
            for (const agent of detail.agents) {
              const prevAgent = prevAgentMap.get(agent.paneTitle);
              if (!prevAgent || prevAgent.isBusy !== agent.isBusy) {
                stream.writeSSE({
                  event: "agent_status",
                  data: JSON.stringify({
                    session: session.name,
                    agent: agent.paneTitle,
                    busy: agent.isBusy,
                    taskId: agent.taskId,
                  }),
                });
              }
            }
          }

          prevDetails.set(session.name, detail);
        }

        prevOverviews = overviews;
      };

      // Initial snapshot
      poll();

      // Poll every 2 seconds
      while (true) {
        await stream.sleep(2000);
        poll();
      }
    });
  });

  // Root: API info
  app.get("/", (c) => {
    return c.json({
      status: "ok",
      message: "tmux-ide command center API",
      docs: "/api/sessions",
    });
  });

  return app;
}
