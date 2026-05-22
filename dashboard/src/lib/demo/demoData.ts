/**
 * Canned data for demo mode (`?demo=1` URL param).
 *
 * Every response here mirrors the shape the real daemon returns at the
 * matching endpoint, so the dashboard renders unchanged. The fetch
 * interceptor in `./install.ts` maps path → response.
 *
 * Keep this file the SINGLE source of truth — components stay
 * daemon-agnostic; switching demo on or off only toggles the fetch shim.
 */

const PROJECT_NAME = "demo-todo-app";
const PROJECT_DIR = "/demo/todo-app";

export const demoProject = {
  name: PROJECT_NAME,
  dir: PROJECT_DIR,
  hasIdeYml: true,
  gitOrigin: "https://github.com/example/demo-todo-app.git",
  gitBranch: "main",
  registeredAt: "2026-05-22T10:00:00Z",
};

export const demoSession = {
  name: PROJECT_NAME,
  dir: PROJECT_DIR,
  mission: {
    title: "Ship v1 of the todo app",
    description: "Implement add/remove/toggle, persist to localStorage, write tests.",
  },
  goals: [],
  tasks: [],
  panes: [
    { id: "%1", title: "Claude 1", index: 0, command: "claude", active: true, dir: PROJECT_DIR },
    {
      id: "%2",
      title: "Dev Server",
      index: 1,
      command: "pnpm dev",
      active: false,
      dir: PROJECT_DIR,
    },
    { id: "%3", title: "Shell", index: 2, command: null, active: false, dir: PROJECT_DIR },
  ],
};

export const demoProjectDetail = {
  session: PROJECT_NAME,
  dir: PROJECT_DIR,
  mission: demoSession.mission,
  goals: [],
  tasks: [],
  agents: [
    {
      paneTitle: "Claude 1",
      paneId: "%1",
      isBusy: false,
      taskTitle: null,
      taskId: null,
      elapsedMs: 0,
    },
  ],
  panes: demoSession.panes,
  orchestrator: null,
};

export const demoFileTree = [
  { name: "src", path: "src", isDir: true },
  { name: "package.json", path: "package.json", isDir: false },
  { name: "README.md", path: "README.md", isDir: false },
  { name: "plans", path: "plans", isDir: true },
];

export const demoFileChildren: Record<
  string,
  Array<{ name: string; path: string; isDir: boolean }>
> = {
  src: [
    { name: "App.tsx", path: "src/App.tsx", isDir: false },
    { name: "components", path: "src/components", isDir: true },
    { name: "main.tsx", path: "src/main.tsx", isDir: false },
  ],
  "src/components": [
    { name: "TodoList.tsx", path: "src/components/TodoList.tsx", isDir: false },
    { name: "TodoItem.tsx", path: "src/components/TodoItem.tsx", isDir: false },
  ],
  plans: [{ name: "v1.md", path: "plans/v1.md", isDir: false }],
};

export const demoFileContents: Record<string, string> = {
  "src/App.tsx": `import { TodoList } from "./components/TodoList";

export function App() {
  return (
    <main>
      <h1>tmux-ide demo · todo app</h1>
      <TodoList />
    </main>
  );
}
`,
  "src/components/TodoList.tsx": `import { createSignal } from "solid-js";
import { TodoItem } from "./TodoItem";

export function TodoList() {
  const [items, setItems] = createSignal([
    { id: 1, text: "Try tmux-ide", done: true },
    { id: 2, text: "Open the chat", done: false },
    { id: 3, text: "Switch projects from the left rail", done: false },
  ]);

  return (
    <ul>
      {items().map((it) => (
        <TodoItem item={it} />
      ))}
    </ul>
  );
}
`,
  "src/components/TodoItem.tsx": `export function TodoItem(props: { item: { text: string; done: boolean } }) {
  return (
    <li class={props.item.done ? "done" : ""}>
      <input type="checkbox" checked={props.item.done} />
      <span>{props.item.text}</span>
    </li>
  );
}
`,
  "src/main.tsx": `import { render } from "solid-js/web";
import { App } from "./App";
render(() => <App />, document.getElementById("root")!);
`,
  "package.json": `{
  "name": "demo-todo-app",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest"
  }
}
`,
  "README.md": `# demo-todo-app

A tiny todo app, used as the playground for the **tmux-ide** dashboard demo.

Open the chat panel on the right to talk with a Claude (scripted in this demo).
Edit a file in the editor — your changes are local-only.
`,
  "plans/v1.md": `# v1 plan

- [x] scaffold app
- [x] add list rendering
- [ ] persist to localStorage
- [ ] write tests
`,
};

export const demoThreads = [
  {
    id: "thr_refactor",
    title: "Refactor TodoList to use a store",
    provider: { kind: "claude-code", model: "claude-sonnet-4-6" },
    createdAt: "2026-05-22T09:30:00Z",
    updatedAt: "2026-05-22T10:15:00Z",
    projectDir: PROJECT_DIR,
    turnCount: 4,
  },
  {
    id: "thr_tests",
    title: "Add Vitest setup + first test",
    provider: { kind: "codex", model: "gpt-5-codex" },
    createdAt: "2026-05-22T10:20:00Z",
    updatedAt: "2026-05-22T10:25:00Z",
    projectDir: PROJECT_DIR,
    turnCount: 2,
  },
];

export const demoEvents = [
  {
    id: "evt_1",
    type: "chat.thread.created",
    timestamp: "2026-05-22T09:30:00Z",
    sessionName: PROJECT_NAME,
    payload: { threadId: "thr_refactor", title: "Refactor TodoList to use a store" },
  },
  {
    id: "evt_2",
    type: "chat.session.completed",
    timestamp: "2026-05-22T09:32:11Z",
    sessionName: PROJECT_NAME,
    payload: { threadId: "thr_refactor", turnId: "turn_1" },
  },
  {
    id: "evt_3",
    type: "project.launch",
    timestamp: "2026-05-22T10:00:00Z",
    sessionName: PROJECT_NAME,
    payload: { dir: PROJECT_DIR, started: true },
  },
];

/**
 * Get-by-pattern helper. Returns the canned response for a URL path or
 * `undefined` if the path isn't covered by demo data (caller should fall
 * through to a no-op 404).
 */
export function resolveDemoResponse(
  url: URL,
  method: string,
  body: unknown,
): { status: number; body: unknown } | undefined {
  const path = url.pathname;

  // Action dispatcher — POST /api/v2/action/<name>
  if (path.startsWith("/api/v2/action/")) {
    const action = decodeURIComponent(path.slice("/api/v2/action/".length));
    return { status: 200, body: handleAction(action, body) };
  }

  // Sessions list + per-project detail
  if (path === "/api/sessions") {
    return { status: 200, body: { sessions: [demoSession] } };
  }
  if (path === "/api/projects") {
    return { status: 200, body: { projects: [demoProject] } };
  }
  if (path === `/api/projects/${PROJECT_NAME}`) {
    return { status: 200, body: { project: demoProject } };
  }
  if (path === `/api/project/${PROJECT_NAME}`) {
    return { status: 200, body: demoProjectDetail };
  }

  // Project-scoped resources
  if (path === `/api/project/${PROJECT_NAME}/events`) {
    return { status: 200, body: { events: demoEvents } };
  }
  if (path === `/api/project/${PROJECT_NAME}/git/status`) {
    return {
      status: 200,
      body: {
        branch: "main",
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      },
    };
  }
  if (path === `/api/project/${PROJECT_NAME}/git/checks`) {
    return { status: 200, body: { runs: [] } };
  }
  if (path.startsWith(`/api/project/${PROJECT_NAME}/files`)) {
    const subpath = url.searchParams.get("path") ?? "";
    if (!subpath) return { status: 200, body: { entries: demoFileTree } };
    const children = demoFileChildren[subpath];
    if (children) return { status: 200, body: { entries: children } };
    return { status: 200, body: { entries: [] } };
  }
  if (path.startsWith(`/api/project/${PROJECT_NAME}/file`)) {
    const filePath = url.searchParams.get("path") ?? "";
    const content = demoFileContents[filePath];
    if (content !== undefined) {
      return { status: 200, body: { path: filePath, content, size: content.length } };
    }
    return { status: 404, body: { error: "not-found" } };
  }
  if (path === `/api/project/${PROJECT_NAME}/diff`) {
    return { status: 200, body: { files: [] } };
  }
  if (path === `/api/project/${PROJECT_NAME}/skills`) {
    return { status: 200, body: { skills: [] } };
  }
  if (path === `/api/project/${PROJECT_NAME}/plans`) {
    return {
      status: 200,
      body: {
        plans: [{ name: "v1.md", path: "plans/v1.md", title: "v1 plan", status: "in-progress" }],
      },
    };
  }
  if (path === `/api/project/${PROJECT_NAME}/plans/v1.md`) {
    return {
      status: 200,
      body: {
        plan: { name: "v1.md", path: "plans/v1.md", title: "v1 plan", status: "in-progress" },
        content: demoFileContents["plans/v1.md"],
      },
    };
  }
  if (path === `/api/project/${PROJECT_NAME}/mission`) {
    return { status: 200, body: { mission: demoSession.mission, validation: null } };
  }
  if (path === `/api/project/${PROJECT_NAME}/panes`) {
    return { status: 200, body: { panes: demoSession.panes } };
  }
  if (path.startsWith("/api/chat/providers")) {
    return {
      status: 200,
      body: {
        providers: [
          {
            kind: "claude-code",
            available: true,
            models: ["claude-sonnet-4-6", "claude-opus-4-7"],
          },
          { kind: "codex", available: true, models: ["gpt-5-codex", "gpt-5.3-codex"] },
        ],
      },
    };
  }
  if (path.startsWith("/api/filesystem/browse")) {
    return {
      status: 200,
      body: {
        path: "/demo",
        parentPath: null,
        entries: [{ name: "todo-app", fullPath: "/demo/todo-app", isDir: true, isSymlink: false }],
      },
    };
  }

  return undefined;
}

function handleAction(action: string, body: unknown): unknown {
  const input = (body as Record<string, unknown>) ?? {};
  switch (action) {
    case "project.launch":
      return { ok: true, result: { sessionName: PROJECT_NAME, started: false } };
    case "chat.thread.list":
      return { ok: true, result: { threads: demoThreads } };
    case "chat.thread.create":
      return {
        ok: true,
        result: {
          thread: {
            id: `thr_demo_${Date.now()}`,
            title: "New chat",
            provider: { kind: "claude-code", model: "claude-sonnet-4-6" },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            projectDir: PROJECT_DIR,
            turnCount: 0,
          },
        },
      };
    case "chat.providers.list":
      return {
        ok: true,
        result: {
          providers: [
            {
              kind: "claude-code",
              available: true,
              models: [{ slug: "claude-sonnet-4-6", name: "Sonnet 4.6" }],
            },
            {
              kind: "codex",
              available: true,
              models: [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }],
            },
          ],
        },
      };
    case "chat.session.send":
      // The renderer expects a streamed turn; for the demo we return a static
      // "ok" — the canned thread already has prebaked messages the timeline
      // pulls in via chat.thread.read.
      return { ok: true, result: { turnId: `turn_demo_${Date.now()}` } };
    default:
      return { ok: true, result: {} };
  }
}
