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
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>tmux-ide Command Center</title>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style type="text/tailwindcss">
    @theme {
      --color-bg-base: #131010;
      --color-bg-raised: #1a1717;
      --color-bg-surface: #1f1c1c;
      --color-bg-hover: #252222;
      --color-bg-active: #2a2727;
      --color-text-primary: #e8e4e4;
      --color-text-secondary: #a09a9a;
      --color-text-muted: #6b6363;
      --color-border-base: rgba(255,255,255,0.06);
      --color-border-strong: rgba(255,255,255,0.1);
      --color-accent: #dcde8d;
      --color-success: #7dd87d;
      --color-warning: #e8c95a;
      --color-error: #e87d7d;
      --color-info: #7db4e8;
    }
    body {
      background: var(--color-bg-base);
      color: var(--color-text-primary);
      font-family: 'Inter', system-ui, sans-serif;
    }
    .font-mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
    .progress-bar { height: 4px; border-radius: 2px; background: var(--color-border-base); overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 2px; transition: width 0.3s ease; }
    .terminal-panel { min-height: 0; }
    .terminal-panel .xterm { height: 100% !important; }
    .terminal-panel .xterm-viewport { overflow-y: auto !important; }
  </style>
</head>
<body class="min-h-screen">
  <!-- Header -->
  <header class="h-12 border-b border-border-base flex items-center px-6 bg-bg-raised sticky top-0 z-10">
    <div class="flex items-center gap-3 flex-1">
      <button id="back-btn" class="hidden text-text-secondary hover:text-text-primary transition-colors text-sm mr-2" onclick="goBack()">&larr;</button>
      <span class="font-mono text-sm text-accent font-medium">tmux-ide</span>
      <span class="text-text-muted text-sm">Command Center</span>
      <span id="project-label" class="hidden text-text-secondary text-sm"></span>
    </div>
    <div class="flex items-center gap-3">
      <span id="status" class="text-xs text-text-muted">connecting...</span>
      <span id="dot" class="w-2 h-2 rounded-full bg-text-muted"></span>
    </div>
  </header>

  <!-- Overview -->
  <main id="overview" class="max-w-4xl mx-auto px-6 py-8">
    <div id="sessions" class="space-y-4"></div>
  </main>

  <!-- Terminal project view -->
  <div id="terminal-view" class="hidden" style="height:calc(100vh - 48px)">
    <div class="grid grid-cols-2 grid-rows-2 gap-px h-full bg-border-base">
      <div class="bg-bg-base flex flex-col">
        <div class="h-8 flex items-center px-3 border-b border-border-base bg-bg-raised shrink-0">
          <span class="text-xs text-text-muted font-medium">War Room</span>
        </div>
        <div id="term-warroom" class="terminal-panel flex-1 overflow-hidden"></div>
      </div>
      <div class="bg-bg-base flex flex-col">
        <div class="h-8 flex items-center px-3 border-b border-border-base bg-bg-raised shrink-0">
          <span class="text-xs text-text-muted font-medium">Tasks</span>
        </div>
        <div id="term-tasks" class="terminal-panel flex-1 overflow-hidden"></div>
      </div>
      <div class="bg-bg-base flex flex-col">
        <div class="h-8 flex items-center px-3 border-b border-border-base bg-bg-raised shrink-0">
          <span class="text-xs text-text-muted font-medium">Explorer</span>
        </div>
        <div id="term-explorer" class="terminal-panel flex-1 overflow-hidden"></div>
      </div>
      <div class="bg-bg-base flex flex-col">
        <div class="h-8 flex items-center px-3 border-b border-border-base bg-bg-raised shrink-0">
          <span class="text-xs text-text-muted font-medium">Preview</span>
        </div>
        <div id="term-preview" class="terminal-panel flex-1 overflow-hidden"></div>
      </div>
    </div>
  </div>

  <script>
    // ---- State ----
    const sessionsEl = document.getElementById('sessions');
    const statusEl = document.getElementById('status');
    const dotEl = document.getElementById('dot');
    const overviewEl = document.getElementById('overview');
    const terminalViewEl = document.getElementById('terminal-view');
    const backBtn = document.getElementById('back-btn');
    const projectLabel = document.getElementById('project-label');

    let selectedProject = null;
    let pollInterval = null;
    let activeTerminals = [];

    // ---- Terminal loader ----
    let TerminalLib = null;
    let FitAddonLib = null;

    async function loadTerminalLib() {
      if (TerminalLib) return;

      // Use xterm.js — reliable, well-tested, handles all ANSI/OSC sequences
      await new Promise((resolve, reject) => {
        if (document.querySelector('link[href*="xterm.css"]')) { resolve(); return; }
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css';
        link.onload = resolve;
        link.onerror = reject;
        document.head.appendChild(link);
      });

      const xtermMod = await import('https://cdn.jsdelivr.net/npm/@xterm/xterm@5/+esm');
      TerminalLib = xtermMod.Terminal;

      const fitMod = await import('https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/+esm');
      FitAddonLib = fitMod.FitAddon;

      console.log('[cmd-center] Using xterm.js');
    }

    const TERM_THEME = {
      background: '#131010',
      foreground: '#e8e4e4',
      cursor: '#dcde8d',
      cursorAccent: '#131010',
      selectionBackground: 'rgba(220,222,141,0.3)',
      black: '#1a1717',
      red: '#e87d7d',
      green: '#7dd87d',
      yellow: '#e8c95a',
      blue: '#7db4e8',
      magenta: '#c49ae8',
      cyan: '#7dd8d0',
      white: '#e8e4e4',
      brightBlack: '#6b6363',
      brightRed: '#f5a0a0',
      brightGreen: '#a0f5a0',
      brightYellow: '#f5e088',
      brightBlue: '#a0ccf5',
      brightMagenta: '#d4b8f5',
      brightCyan: '#a0f5ef',
      brightWhite: '#ffffff',
    };

    function createTerminalPanel(containerId, wsPath) {
      const container = document.getElementById(containerId);
      if (!container) return null;
      container.innerHTML = '';

      const termOpts = {
        fontSize: 13,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        theme: TERM_THEME,
        allowProposedApi: true,
      };
      const term = new TerminalLib(termOpts);

      let fitAddon = null;
      if (FitAddonLib) {
        fitAddon = new FitAddonLib();
        term.loadAddon(fitAddon);
      }

      term.open(container);
      if (fitAddon) {
        // Delay first fit so container has layout dimensions
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      }

      // WebSocket
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(protocol + '//' + location.host + wsPath);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (fitAddon) {
          try { fitAddon.fit(); } catch {}
        }
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        const data = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data);
        term.write(data);
      };

      ws.onerror = () => {
        term.write('\\r\\n\\x1b[31m[connection error]\\x1b[0m\\r\\n');
      };

      ws.onclose = () => {
        term.write('\\r\\n\\x1b[33m[disconnected]\\x1b[0m\\r\\n');
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      });

      // Resize handling
      const observer = new ResizeObserver(() => {
        if (!fitAddon) return;
        try {
          fitAddon.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
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

    // ---- Navigation ----
    async function selectProject(name) {
      selectedProject = name;
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }

      overviewEl.classList.add('hidden');
      terminalViewEl.classList.remove('hidden');
      backBtn.classList.remove('hidden');
      projectLabel.classList.remove('hidden');
      projectLabel.textContent = '/ ' + name;

      await loadTerminalLib();

      const widgets = ['warroom', 'tasks', 'explorer', 'preview'];
      for (const w of widgets) {
        const panel = createTerminalPanel('term-' + w, '/ws/' + w + '?session=' + encodeURIComponent(name));
        if (panel) activeTerminals.push(panel);
      }
    }

    function goBack() {
      selectedProject = null;
      destroyTerminals();

      terminalViewEl.classList.add('hidden');
      overviewEl.classList.remove('hidden');
      backBtn.classList.add('hidden');
      projectLabel.classList.add('hidden');

      fetchSessions();
      pollInterval = setInterval(fetchSessions, 2000);
    }

    // ---- Overview data ----
    async function fetchSessions() {
      if (selectedProject) return;
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        statusEl.textContent = 'live';
        dotEl.className = 'w-2 h-2 rounded-full bg-success';
        renderSessions(data.sessions);
      } catch (e) {
        statusEl.textContent = 'offline';
        dotEl.className = 'w-2 h-2 rounded-full bg-error';
      }
    }

    function renderSessions(sessions) {
      sessionsEl.innerHTML = sessions.map(s => {
        const pct = s.stats.totalTasks > 0 ? Math.round((s.stats.doneTasks / s.stats.totalTasks) * 100) : 0;

        return '<div class="bg-bg-raised border border-border-base rounded-xl p-5 cursor-pointer hover:border-border-strong transition-all" data-project="' + s.name + '">'

          // Header row
          + '<div class="flex items-center justify-between mb-4">'
          + '  <div>'
          + '    <h2 class="text-base font-medium text-text-primary">' + s.name + '</h2>'
          + (s.mission ? '<p class="text-sm text-text-secondary mt-0.5">' + s.mission.title + '</p>' : '<p class="text-sm text-text-muted mt-0.5">No mission set</p>')
          + '  </div>'
          + '  <div class="flex items-center gap-4">'
          + '    <div class="text-right">'
          + '      <div class="text-2xl font-medium text-text-primary">' + s.stats.doneTasks + '<span class="text-text-muted text-sm font-normal">/' + s.stats.totalTasks + '</span></div>'
          + '      <div class="text-xs text-text-muted">tasks</div>'
          + '    </div>'
          + '    <div class="text-right">'
          + '      <div class="text-2xl font-medium text-text-primary">' + s.stats.agents + '</div>'
          + '      <div class="text-xs text-text-muted">agents</div>'
          + '    </div>'
          + '  </div>'
          + '</div>'

          // Progress bar
          + '<div class="progress-bar mb-4"><div class="progress-fill" style="width:' + pct + '%;background:' + (pct === 100 ? 'var(--color-success)' : 'var(--color-accent)') + '"></div></div>'

          // Goals
          + (s.goals && s.goals.length > 0
            ? '<div class="space-y-2 pt-3 border-t border-border-base">'
              + s.goals.map(g =>
                '<div class="flex items-center gap-3">'
                + '<span class="text-sm text-text-secondary flex-1 truncate">' + g.title + '</span>'
                + '<div class="progress-bar w-24"><div class="progress-fill" style="width:' + g.progress + '%;background:' + (g.progress === 100 ? 'var(--color-success)' : 'var(--color-accent)') + '"></div></div>'
                + '<span class="text-xs text-text-muted w-8 text-right">' + g.progress + '%</span>'
                + '</div>'
              ).join('')
              + '</div>'
            : '')

          + '</div>';
      }).join('');

      if (sessions.length === 0) {
        sessionsEl.innerHTML = '<div class="text-center text-text-muted py-20">No tmux-ide sessions running</div>';
      }

      // Attach click handlers
      sessionsEl.querySelectorAll('[data-project]').forEach(el => {
        el.addEventListener('click', () => selectProject(el.dataset.project));
      });
    }

    // ---- Boot ----
    fetchSessions();
    pollInterval = setInterval(fetchSessions, 2000);
  </script>
</body>
</html>`;
}

