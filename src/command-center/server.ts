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

export function createApp(): Hono {
  const app = new Hono();

  // Allow cross-origin (Tailscale, etc.)
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

    const body = await c.req.json<{ status?: string; assignee?: string }>();
    const updated = updateTask(session.dir, taskId, body);
    if (!updated) {
      return c.json({ error: "Task not found" }, 404);
    }

    return c.json({ ok: true, task: updated });
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

  // Inline web dashboard — no build step needed
  app.get("/", (c) => {
    return c.html(getDashboardHTML());
  });

  return app;
}

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>tmux-ide Command Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    /* ── Design tokens (opencode-style) ── */
    :root {
      --bg-base: #131010;
      --bg-raised: #1a1717;
      --bg-surface: #1f1c1c;
      --bg-hover: #252222;
      --bg-active: #2a2727;
      --text-primary: #e8e4e4;
      --text-secondary: #a09a9a;
      --text-muted: #6b6363;
      --border: rgba(255,255,255,0.06);
      --border-strong: rgba(255,255,255,0.1);
      --accent: #dcde8d;
      --success: #7dd87d;
      --warning: #e8c95a;
      --error: #e87d7d;
      --info: #7db4e8;
      --font: 'IBM Plex Mono', ui-monospace, monospace;
      --font-size: 13px;
      --line-height: 1.5;
    }

    /* ── Reset ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--font);
      font-size: var(--font-size);
      line-height: var(--line-height);
      background: var(--bg-base);
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }

    /* ── Header ── */
    .header {
      height: 40px;
      display: flex;
      align-items: center;
      padding: 0 16px;
      background: var(--bg-raised);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .header-left { display: flex; align-items: center; gap: 8px; flex: 1; }
    .header-right { display: flex; align-items: center; gap: 8px; }
    .header-brand { color: var(--accent); font-weight: 500; font-size: 13px; }
    .header-sep { color: var(--text-muted); font-size: 12px; }
    .header-project { color: var(--text-secondary); font-size: 12px; display: none; }
    .back-btn {
      background: none; border: none; color: var(--text-muted); cursor: pointer;
      font-family: var(--font); font-size: 12px; padding: 2px 4px; display: none;
    }
    .back-btn:hover { color: var(--text-primary); }
    .status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--text-muted);
    }
    .status-dot.live { background: var(--success); }
    .status-dot.error { background: var(--error); }
    .status-label { color: var(--text-muted); font-size: 11px; }

    /* ── Overview ── */
    .overview { max-width: 680px; margin: 0 auto; padding: 24px 16px; }
    .overview-stats {
      display: flex; gap: 16px; margin-bottom: 20px;
      padding-bottom: 16px; border-bottom: 1px solid var(--border);
    }
    .stat-item { font-size: 11px; color: var(--text-muted); }
    .stat-value { color: var(--text-secondary); font-weight: 500; }
    .sessions-list { display: flex; flex-direction: column; gap: 8px; }
    .empty-state {
      text-align: center; padding: 64px 0;
      color: var(--text-muted); font-size: 12px;
    }

    /* ── Project card ── */
    .project-card {
      background: var(--bg-raised); border: 1px solid var(--border);
      border-radius: 6px; padding: 14px 16px;
      cursor: pointer; transition: border-color 0.15s, background 0.15s;
    }
    .project-card:hover {
      border-color: var(--border-strong); background: var(--bg-surface);
    }
    .card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
    .card-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .card-mission { font-size: 11px; color: var(--text-secondary); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-no-mission { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
    .card-stats { display: flex; gap: 12px; }
    .card-stat { text-align: right; }
    .card-stat-value { font-size: 16px; font-weight: 500; color: var(--text-primary); line-height: 1; }
    .card-stat-value span { font-size: 11px; font-weight: 400; color: var(--text-muted); }
    .card-stat-label { font-size: 10px; color: var(--text-muted); margin-top: 2px; }

    /* ── Progress bar ── */
    .progress { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; }

    /* ── Goal rows ── */
    .goals { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
    .goal-row { display: flex; align-items: center; gap: 8px; }
    .goal-title { flex: 1; font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .goal-bar { width: 80px; }
    .goal-pct { width: 32px; text-align: right; font-size: 10px; color: var(--text-muted); }

    /* ── Project detail view ── */
    .detail { display: none; }
    .detail-body { max-width: 960px; margin: 0 auto; padding: 20px 16px; }
    .detail-header {
      display: flex; align-items: center; gap: 16px;
      padding-bottom: 16px; margin-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .detail-info { flex: 1; min-width: 0; }
    .detail-name { font-size: 14px; font-weight: 500; }
    .detail-mission-text { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
    .detail-pct { font-size: 12px; color: var(--text-secondary); font-weight: 500; text-align: right; }
    .detail-pct-sub { font-size: 10px; color: var(--text-muted); margin-top: 1px; }
    .detail-progress { margin-bottom: 20px; }

    /* ── Detail grid ── */
    .detail-grid { display: grid; grid-template-columns: 280px 1fr; gap: 20px; }
    @media (max-width: 768px) { .detail-grid { grid-template-columns: 1fr; } }

    .section-title {
      font-size: 10px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
    }
    .section + .section { margin-top: 16px; }

    /* ── Agent card ── */
    .agent-list { display: flex; flex-direction: column; gap: 4px; }
    .agent-row {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-radius: 4px;
      background: var(--bg-surface);
    }
    .agent-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .agent-dot.busy { background: var(--warning); box-shadow: 0 0 4px rgba(232,201,90,0.3); }
    .agent-dot.idle { background: var(--text-muted); }
    .agent-info { flex: 1; min-width: 0; }
    .agent-name { font-size: 12px; color: var(--text-primary); font-weight: 500; }
    .agent-task { font-size: 10px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-idle { font-size: 10px; color: var(--text-muted); }
    .agent-elapsed { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }

    /* ── Task table ── */
    .task-list { display: flex; flex-direction: column; gap: 2px; }
    .task-row {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-radius: 4px;
      background: var(--bg-surface);
    }
    .task-row:hover { background: var(--bg-hover); }
    .task-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .task-dot[data-s="todo"] { background: var(--text-muted); }
    .task-dot[data-s="in-progress"] { background: var(--warning); }
    .task-dot[data-s="review"] { background: var(--info); }
    .task-dot[data-s="done"] { background: var(--success); }
    .task-id { font-size: 10px; color: var(--text-muted); width: 32px; flex-shrink: 0; }
    .task-title { flex: 1; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-assignee { font-size: 10px; color: var(--text-muted); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .task-status {
      font-size: 9px; font-weight: 500; padding: 1px 6px;
      border-radius: 3px; flex-shrink: 0; text-transform: uppercase;
    }
    .task-status[data-s="todo"] { background: rgba(107,99,99,0.2); color: var(--text-muted); }
    .task-status[data-s="in-progress"] { background: rgba(232,201,90,0.12); color: var(--warning); }
    .task-status[data-s="review"] { background: rgba(125,180,232,0.12); color: var(--info); }
    .task-status[data-s="done"] { background: rgba(125,216,125,0.12); color: var(--success); }

    /* ── Terminal panels ── */
    .term-grid {
      display: none; height: calc(100vh - 40px);
    }
    .term-grid-inner {
      display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
      gap: 1px; height: 100%; background: var(--border);
    }
    .term-cell { background: var(--bg-base); display: flex; flex-direction: column; }
    .term-label {
      height: 28px; display: flex; align-items: center; padding: 0 10px;
      background: var(--bg-raised); border-bottom: 1px solid var(--border);
      font-size: 10px; color: var(--text-muted); font-weight: 500;
    }
    .term-panel { flex: 1; min-height: 0; overflow: hidden; }
    .term-panel .xterm { height: 100% !important; }
    .term-panel .xterm-viewport { overflow-y: auto !important; }

    /* ── Utilities ── */
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <button id="back-btn" class="back-btn" onclick="goBack()">&larr; back</button>
      <span class="header-brand">tmux-ide</span>
      <span class="header-sep">/</span>
      <span id="header-context" class="header-sep">command center</span>
    </div>
    <div class="header-right">
      <span id="status-label" class="status-label">connecting</span>
      <span id="status-dot" class="status-dot"></span>
    </div>
  </div>

  <!-- Overview (all projects) -->
  <div id="overview" class="overview">
    <div id="overview-stats" class="overview-stats"></div>
    <div id="sessions" class="sessions-list"></div>
  </div>

  <!-- Project detail (agents + tasks) -->
  <div id="detail" class="detail">
    <div class="detail-body">
      <div id="detail-content"></div>
    </div>
  </div>

  <!-- Terminal panels (widget PTYs) -->
  <div id="term-grid" class="term-grid">
    <div class="term-grid-inner">
      <div class="term-cell">
        <div class="term-label">war room</div>
        <div id="term-warroom" class="term-panel"></div>
      </div>
      <div class="term-cell">
        <div class="term-label">tasks</div>
        <div id="term-tasks" class="term-panel"></div>
      </div>
      <div class="term-cell">
        <div class="term-label">explorer</div>
        <div id="term-explorer" class="term-panel"></div>
      </div>
      <div class="term-cell">
        <div class="term-label">preview</div>
        <div id="term-preview" class="term-panel"></div>
      </div>
    </div>
  </div>

<script>
// ════════════════════════════════════════════════════════════
//  State
// ════════════════════════════════════════════════════════════
const $ = (id) => document.getElementById(id);
let selectedProject = null;
let pollInterval = null;
let activeTerminals = [];

// ════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function pct(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function progressFill(p) {
  const color = p >= 100 ? 'var(--success)' : 'var(--accent)';
  return '<div class="progress"><div class="progress-fill" style="width:' + p + '%;background:' + color + '"></div></div>';
}

// ════════════════════════════════════════════════════════════
//  Navigation
// ════════════════════════════════════════════════════════════
function showOverview() {
  $('overview').style.display = '';
  $('detail').style.display = 'none';
  $('term-grid').style.display = 'none';
  $('back-btn').style.display = 'none';
  $('header-context').textContent = 'command center';
}

function showDetail(name) {
  $('overview').style.display = 'none';
  $('detail').style.display = '';
  $('term-grid').style.display = 'none';
  $('back-btn').style.display = '';
  $('header-context').textContent = name;
}

function showTerminals(name) {
  $('overview').style.display = 'none';
  $('detail').style.display = 'none';
  $('term-grid').style.display = '';
  $('back-btn').style.display = '';
  $('header-context').textContent = name + ' / terminals';
}

function goBack() {
  if ($('term-grid').style.display !== 'none') {
    destroyTerminals();
    showDetail(selectedProject);
    return;
  }
  selectedProject = null;
  showOverview();
  fetchSessions();
  pollInterval = setInterval(fetchSessions, 2000);
}

// ════════════════════════════════════════════════════════════
//  Overview rendering
// ════════════════════════════════════════════════════════════
function renderOverviewStats(sessions) {
  const totA = sessions.reduce((s, x) => s + x.stats.agents, 0);
  const actA = sessions.reduce((s, x) => s + x.stats.activeAgents, 0);
  const totT = sessions.reduce((s, x) => s + x.stats.totalTasks, 0);
  const donT = sessions.reduce((s, x) => s + x.stats.doneTasks, 0);

  $('overview-stats').innerHTML =
    '<span class="stat-item"><span class="stat-value">' + sessions.length + '</span> projects</span>' +
    '<span class="stat-item"><span class="stat-value" style="color:var(--success)">' + actA + '</span>/' + totA + ' agents</span>' +
    '<span class="stat-item"><span class="stat-value">' + donT + '</span>/' + totT + ' tasks</span>';
}

function renderSessions(sessions) {
  renderOverviewStats(sessions);

  if (sessions.length === 0) {
    $('sessions').innerHTML = '<div class="empty-state">No tmux-ide sessions running.<br>Start a project to see it here.</div>';
    return;
  }

  $('sessions').innerHTML = sessions.map(s => {
    const p = pct(s.stats.doneTasks, s.stats.totalTasks);
    let html = '<div class="project-card" data-project="' + esc(s.name) + '">';

    // Header
    html += '<div class="card-header"><div style="min-width:0;flex:1">';
    html += '<div class="card-name">' + esc(s.name) + '</div>';
    html += s.mission
      ? '<div class="card-mission">' + esc(s.mission.title) + '</div>'
      : '<div class="card-no-mission">no mission</div>';
    html += '</div><div class="card-stats">';
    html += '<div class="card-stat"><div class="card-stat-value">' + s.stats.doneTasks + '<span>/' + s.stats.totalTasks + '</span></div><div class="card-stat-label">tasks</div></div>';
    html += '<div class="card-stat"><div class="card-stat-value">' + s.stats.agents + '</div><div class="card-stat-label">agents</div></div>';
    html += '</div></div>';

    // Progress
    html += '<div style="margin-bottom:10px">' + progressFill(p) + '</div>';

    // Goals
    if (s.goals && s.goals.length > 0) {
      html += '<div class="goals">';
      for (const g of s.goals) {
        html += '<div class="goal-row">';
        html += '<span class="goal-title">' + esc(g.title) + '</span>';
        html += '<div class="goal-bar">' + progressFill(g.progress) + '</div>';
        html += '<span class="goal-pct">' + g.progress + '%</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }).join('');

  // Click handlers
  $('sessions').querySelectorAll('[data-project]').forEach(el => {
    el.addEventListener('click', () => selectProject(el.dataset.project));
  });
}

// ════════════════════════════════════════════════════════════
//  Project detail rendering
// ════════════════════════════════════════════════════════════
function renderDetail(data) {
  const p = pct(
    data.tasks.filter(t => t.status === 'done').length,
    data.tasks.length,
  );

  let html = '';

  // Header
  html += '<div class="detail-header">';
  html += '<div class="detail-info">';
  html += '<div class="detail-name">' + esc(data.session) + '</div>';
  if (data.mission) html += '<div class="detail-mission-text">' + esc(data.mission.title) + '</div>';
  html += '</div>';
  html += '<div><div class="detail-pct">' + p + '%</div>';
  html += '<div class="detail-pct-sub">' + data.tasks.filter(t => t.status === 'done').length + '/' + data.tasks.length + ' tasks</div></div>';
  html += '</div>';

  // Progress
  html += '<div class="detail-progress">' + progressFill(p) + '</div>';

  // Grid
  html += '<div class="detail-grid">';

  // Left column: agents + goals
  html += '<div>';

  // Goals
  if (data.goals && data.goals.length > 0) {
    html += '<div class="section">';
    html += '<div class="section-title">goals</div>';
    for (const g of data.goals) {
      const gTasks = data.tasks.filter(t => t.goal === g.id);
      const gDone = gTasks.filter(t => t.status === 'done').length;
      const gPct = gTasks.length > 0 ? Math.round((gDone / gTasks.length) * 100) : 0;
      html += '<div style="margin-bottom:8px">';
      html += '<div style="display:flex;justify-content:space-between;margin-bottom:3px">';
      html += '<span style="font-size:11px;color:var(--text-secondary)">' + esc(g.title) + '</span>';
      html += '<span style="font-size:10px;color:var(--text-muted)">' + gPct + '%</span>';
      html += '</div>' + progressFill(gPct) + '</div>';
    }
    html += '</div>';
  }

  // Agents
  html += '<div class="section">';
  html += '<div class="section-title">agents (' + data.agents.length + ')</div>';
  if (data.agents.length === 0) {
    html += '<div style="font-size:11px;color:var(--text-muted)">No agents detected</div>';
  } else {
    html += '<div class="agent-list">';
    for (const a of data.agents) {
      html += '<div class="agent-row">';
      html += '<span class="agent-dot ' + (a.isBusy ? 'busy' : 'idle') + '"></span>';
      html += '<div class="agent-info">';
      html += '<div class="agent-name">' + esc(a.paneTitle) + '</div>';
      html += a.taskTitle
        ? '<div class="agent-task">' + esc(a.taskTitle) + '</div>'
        : '<div class="agent-idle">idle</div>';
      html += '</div>';
      if (a.elapsed) html += '<span class="agent-elapsed">' + esc(a.elapsed) + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Open terminals button
  html += '<div class="section">';
  html += '<button style="width:100%;padding:6px 0;font-family:var(--font);font-size:11px;background:var(--bg-surface);border:1px solid var(--border);border-radius:4px;color:var(--text-secondary);cursor:pointer" '
    + 'onmouseover="this.style.borderColor=\'var(--border-strong)\'" '
    + 'onmouseout="this.style.borderColor=\'var(--border)\'" '
    + 'onclick="openTerminals()">'
    + 'open terminal panels</button>';
  html += '</div>';

  html += '</div>'; // end left column

  // Right column: tasks
  html += '<div>';
  html += '<div class="section-title">tasks (' + data.tasks.length + ')</div>';
  if (data.tasks.length === 0) {
    html += '<div style="font-size:11px;color:var(--text-muted)">No tasks</div>';
  } else {
    const sorted = [...data.tasks].sort((a, b) => {
      const order = { 'in-progress': 0, 'todo': 1, 'review': 2, 'done': 3 };
      const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      return d !== 0 ? d : a.priority - b.priority;
    });
    html += '<div class="task-list">';
    for (const t of sorted) {
      html += '<div class="task-row">';
      html += '<span class="task-dot" data-s="' + t.status + '"></span>';
      html += '<span class="task-id">#' + esc(t.id) + '</span>';
      html += '<span class="task-title">' + esc(t.title) + '</span>';
      if (t.assignee) html += '<span class="task-assignee">' + esc(t.assignee) + '</span>';
      html += '<span class="task-status" data-s="' + t.status + '">' + t.status + '</span>';
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  html += '</div>'; // end grid

  $('detail-content').innerHTML = html;
}

// ════════════════════════════════════════════════════════════
//  Data fetching
// ════════════════════════════════════════════════════════════
async function fetchSessions() {
  if (selectedProject) return;
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    $('status-label').textContent = 'live';
    $('status-dot').className = 'status-dot live';
    renderSessions(data.sessions);
  } catch {
    $('status-label').textContent = 'offline';
    $('status-dot').className = 'status-dot error';
  }
}

async function fetchProject(name) {
  try {
    const res = await fetch('/api/project/' + encodeURIComponent(name));
    const data = await res.json();
    $('status-label').textContent = 'live';
    $('status-dot').className = 'status-dot live';
    renderDetail(data);
  } catch {
    $('status-label').textContent = 'offline';
    $('status-dot').className = 'status-dot error';
  }
}

function selectProject(name) {
  selectedProject = name;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  showDetail(name);
  fetchProject(name);
  pollInterval = setInterval(() => fetchProject(name), 2000);
}

// ════════════════════════════════════════════════════════════
//  Terminal panels (xterm.js)
// ════════════════════════════════════════════════════════════
let TerminalLib = null;
let FitAddonLib = null;

const TERM_THEME = {
  background: '#131010', foreground: '#e8e4e4',
  cursor: '#dcde8d', cursorAccent: '#131010',
  selectionBackground: 'rgba(220,222,141,0.3)',
  black: '#1a1717', red: '#e87d7d', green: '#7dd87d', yellow: '#e8c95a',
  blue: '#7db4e8', magenta: '#c49ae8', cyan: '#7dd8d0', white: '#e8e4e4',
  brightBlack: '#6b6363', brightRed: '#f5a0a0', brightGreen: '#a0f5a0',
  brightYellow: '#f5e088', brightBlue: '#a0ccf5', brightMagenta: '#d4b8f5',
  brightCyan: '#a0f5ef', brightWhite: '#ffffff',
};

async function loadTerminalLib() {
  if (TerminalLib) return;
  await new Promise((resolve, reject) => {
    if (document.querySelector('link[href*="xterm.css"]')) { resolve(); return; }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css';
    link.onload = resolve; link.onerror = reject;
    document.head.appendChild(link);
  });
  const xtermMod = await import('https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm');
  TerminalLib = xtermMod.Terminal;
  const fitMod = await import('https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/+esm');
  FitAddonLib = fitMod.FitAddon;
}

function createTerminalPanel(containerId, wsPath) {
  const container = $(containerId);
  if (!container) return null;
  container.innerHTML = '';

  const term = new TerminalLib({
    fontSize: 13, fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
    cursorBlink: true, cursorStyle: 'bar', scrollback: 5000,
    theme: TERM_THEME, allowProposedApi: true,
  });

  let fitAddon = null;
  if (FitAddonLib) { fitAddon = new FitAddonLib(); term.loadAddon(fitAddon); }
  term.open(container);
  if (fitAddon) requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(protocol + '//' + location.host + wsPath);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    if (fitAddon) try { fitAddon.fit(); } catch {}
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  };
  ws.onmessage = (e) => {
    term.write(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
  };
  ws.onerror = () => term.write('\\r\\n\\x1b[31m[connection error]\\x1b[0m\\r\\n');
  ws.onclose = () => term.write('\\r\\n\\x1b[33m[disconnected]\\x1b[0m\\r\\n');
  term.onData((d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });

  const observer = new ResizeObserver(() => {
    if (!fitAddon) return;
    try {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch {}
  });
  observer.observe(container);

  return { term, ws, fitAddon, observer, container };
}

function destroyTerminals() {
  for (const t of activeTerminals) {
    try { t.observer.disconnect(); } catch {}
    try { t.ws.close(); } catch {}
    try { t.term.dispose(); } catch {}
    t.container.innerHTML = '';
  }
  activeTerminals = [];
}

async function openTerminals() {
  if (!selectedProject) return;
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  showTerminals(selectedProject);
  await loadTerminalLib();
  for (const w of ['warroom', 'tasks', 'explorer', 'preview']) {
    const panel = createTerminalPanel('term-' + w, '/ws/' + w + '?session=' + encodeURIComponent(selectedProject));
    if (panel) activeTerminals.push(panel);
  }
}

// ════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════
fetchSessions();
pollInterval = setInterval(fetchSessions, 2000);
</script>
</body>
</html>`;
}

