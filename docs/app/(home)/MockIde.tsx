"use client";

/**
 * MockIde — a hand-built React mock of the tmux-ide dashboard for the
 * landing page. Not the real dashboard SPA: every "click" toggles local
 * React state and swaps canned content. Cheap, ships everywhere, no
 * iframe gymnastics.
 *
 * If you want to update what visitors see, change the constants at the
 * top (PROJECTS, FILES, THREADS, COMMITS) — the rendering is dumb.
 */

import { useState, type ReactNode } from "react";
import { DotAvatar } from "../../components/dot-avatar";

type ViewId = "files" | "chat" | "diffs" | "plans";

interface Project {
  id: string;
  name: string;
  branch: string;
  initial: string;
}

interface FileEntry {
  path: string;
  language: string;
  content: string;
}

interface ThreadEntry {
  id: string;
  title: string;
  provider: "claude-code" | "codex";
  model: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

interface DiffHunk {
  before: number;
  after: number;
  lines: Array<{ kind: "ctx" | "add" | "del"; text: string }>;
}

interface Commit {
  sha: string;
  subject: string;
  author: string;
  ago: string;
  filePath: string;
  hunks: DiffHunk[];
}

const PROJECTS: Project[] = [
  { id: "demo-todo-app", name: "demo-todo-app", branch: "main", initial: "T" },
  { id: "ceo-cli", name: "ceo-cli", branch: "feat/intake-v2", initial: "C" },
  { id: "my-blog", name: "my-blog", branch: "main", initial: "B" },
];

const FILES: FileEntry[] = [
  {
    path: "src/App.tsx",
    language: "tsx",
    content: `import { TodoList } from "./components/TodoList";

export function App() {
  return (
    <main>
      <h1>todo app</h1>
      <TodoList />
    </main>
  );
}
`,
  },
  {
    path: "src/components/TodoList.tsx",
    language: "tsx",
    content: `import { createSignal } from "solid-js";
import { TodoItem } from "./TodoItem";

export function TodoList() {
  const [items] = createSignal([
    { id: 1, text: "try tmux-ide", done: true },
    { id: 2, text: "open the chat", done: false },
    { id: 3, text: "switch projects", done: false },
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
  },
  {
    path: "package.json",
    language: "json",
    content: `{
  "name": "demo-todo-app",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "test": "vitest"
  }
}
`,
  },
];

const THREADS: ThreadEntry[] = [
  {
    id: "thr_refactor",
    title: "Refactor TodoList to use a store",
    provider: "claude-code",
    model: "claude-sonnet-4-6",
    messages: [
      {
        role: "user",
        text: "Can you pull the items state out of TodoList into a separate store so I can hydrate it from localStorage?",
      },
      {
        role: "assistant",
        text: "Sure — I'll create `src/stores/todos.ts` with a Solid signal + persistence layer, then have TodoList import it.",
      },
      {
        role: "user",
        text: "Sounds good. Make the localStorage key configurable so we can swap to sessionStorage in tests.",
      },
      {
        role: "assistant",
        text: "Done. The store now takes a `storage` option (defaults to localStorage). Tests can inject a stub. Updated TodoList + added 4 unit tests.",
      },
    ],
  },
  {
    id: "thr_tests",
    title: "Add Vitest setup + first test",
    provider: "codex",
    model: "gpt-5-codex",
    messages: [
      {
        role: "user",
        text: "Set up Vitest and write a test for the TodoList component using @solidjs/testing-library.",
      },
      {
        role: "assistant",
        text: "Installed `vitest`, `@solidjs/testing-library`, `jsdom`. Added vitest.config.ts pointing at jsdom. First test asserts the rendered list shows the seeded items.",
      },
    ],
  },
];

const COMMITS: Commit[] = [
  {
    sha: "a8f3e21",
    subject: "feat(todos): persist to localStorage via store",
    author: "you",
    ago: "12m",
    filePath: "src/stores/todos.ts",
    hunks: [
      {
        before: 1,
        after: 1,
        lines: [
          { kind: "add", text: 'import { createSignal, createEffect } from "solid-js";' },
          { kind: "add", text: "" },
          {
            kind: "add",
            text: "export function createTodoStore(opts: { storage?: Storage } = {}) {",
          },
          { kind: "add", text: "  const storage = opts.storage ?? localStorage;" },
          { kind: "add", text: '  const stored = storage.getItem("todos");' },
          { kind: "add", text: "  const [items, setItems] = createSignal(" },
          { kind: "add", text: "    stored ? JSON.parse(stored) : []," },
          { kind: "add", text: "  );" },
          { kind: "add", text: "" },
          { kind: "add", text: "  createEffect(() => {" },
          { kind: "add", text: '    storage.setItem("todos", JSON.stringify(items()));' },
          { kind: "add", text: "  });" },
          { kind: "add", text: "" },
          { kind: "add", text: "  return { items, setItems };" },
          { kind: "add", text: "}" },
        ],
      },
    ],
  },
  {
    sha: "6c10b9d",
    subject: "test(todos): vitest setup + TodoList render test",
    author: "you",
    ago: "1h",
    filePath: "src/components/TodoList.test.tsx",
    hunks: [
      {
        before: 1,
        after: 1,
        lines: [
          { kind: "add", text: 'import { render } from "@solidjs/testing-library";' },
          { kind: "add", text: 'import { describe, it, expect } from "vitest";' },
          { kind: "add", text: 'import { TodoList } from "./TodoList";' },
          { kind: "add", text: "" },
          { kind: "add", text: 'describe("TodoList", () => {' },
          { kind: "add", text: '  it("renders all seeded items", () => {' },
          { kind: "add", text: "    const { getAllByRole } = render(() => <TodoList />);" },
          { kind: "add", text: '    expect(getAllByRole("listitem")).toHaveLength(3);' },
          { kind: "add", text: "  });" },
          { kind: "add", text: "});" },
        ],
      },
    ],
  },
];

const PLAN_BODY = `# v1 plan

- [x] scaffold the app
- [x] add list rendering
- [x] persist to localStorage
- [ ] write tests for TodoItem
- [ ] ship to production

## Notes

We picked Solid over React because the dashboard demo is showing off
the **chat + LSP + multi-project rail** more than the framework choice.
The localStorage layer should fall back to in-memory if storage is
disabled (Safari private mode).
`;

export function MockIde() {
  const [activeProject, setActiveProject] = useState(PROJECTS[0].id);
  const [view, setView] = useState<ViewId>("files");
  const [activeFile, setActiveFile] = useState(FILES[0].path);
  const [activeThread, setActiveThread] = useState(THREADS[0].id);
  const [activeCommit, setActiveCommit] = useState(COMMITS[0].sha);
  const [bottomTab, setBottomTab] = useState<"terminal" | "problems" | "output">("terminal");

  const project = PROJECTS.find((p) => p.id === activeProject) ?? PROJECTS[0];

  return (
    <div className="relative border border-fd-border bg-fd-background font-mono text-[12px] text-fd-foreground">
      {/* Floating agent ghosts — mirrors the Prototyper "agents on the
          canvas" visual, where each ghost is a live agent paired to the
          surface it's working on. Pure decoration here; the real
          dashboard surfaces these through chat-thread provider chips. */}
      <div className="pointer-events-none absolute -top-4 -right-2 z-10 hidden sm:flex items-center gap-1.5">
        <DotAvatar theme="ember" face="happy" size={36} glow title="claude code" />
        <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[10px] text-white">
          ● claude code
        </span>
      </div>
      <div className="pointer-events-none absolute -bottom-3 -left-2 z-10 hidden sm:flex items-center gap-1.5">
        <DotAvatar theme="phantom" face="sparkle" size={36} glow title="codex" />
        <span className="rounded-full bg-purple-500 px-2 py-0.5 text-[10px] text-white">
          ● codex
        </span>
      </div>

      {/* Browser chrome */}
      <div className="flex items-center gap-2 border-b border-fd-border bg-fd-muted/30 px-3 py-1.5">
        <div className="flex gap-1.5">
          <span className="h-2 w-2 rounded-full bg-red-400/60" />
          <span className="h-2 w-2 rounded-full bg-yellow-400/60" />
          <span className="h-2 w-2 rounded-full bg-green-400/60" />
        </div>
        <div className="flex-1 mx-2">
          <div className="border border-fd-border bg-fd-background px-2 py-0.5 text-[10px] text-fd-muted-foreground">
            localhost:6060/project/{project.name}
          </div>
        </div>
        <span className="text-[10px] uppercase tracking-wider text-fd-muted-foreground">
          interactive mockup
        </span>
      </div>

      {/* IDE body */}
      <div className="flex" style={{ height: 540 }}>
        {/* Project rail */}
        <div className="flex flex-col items-center gap-1 border-r border-fd-border bg-fd-muted/30 px-1.5 py-2">
          {PROJECTS.map((p) => {
            const active = p.id === activeProject;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setActiveProject(p.id)}
                title={p.name}
                className={`flex h-8 w-8 items-center justify-center border text-[11px] transition-colors ${
                  active
                    ? "border-fd-primary bg-fd-primary/10 text-fd-primary"
                    : "border-transparent text-fd-muted-foreground hover:border-fd-border hover:text-fd-foreground"
                }`}
              >
                {p.initial}
              </button>
            );
          })}
          <button
            type="button"
            title="add project"
            className="mt-1 flex h-8 w-8 items-center justify-center border border-dashed border-fd-border text-fd-muted-foreground hover:text-fd-foreground"
          >
            +
          </button>
        </div>

        {/* Activity bar */}
        <div className="flex w-12 flex-col items-center gap-1 border-r border-fd-border bg-fd-muted/20 py-2">
          <ActivityIcon
            label="files"
            active={view === "files"}
            onClick={() => setView("files")}
            icon="▤"
          />
          <ActivityIcon
            label="chat"
            active={view === "chat"}
            onClick={() => setView("chat")}
            icon="◌"
          />
          <ActivityIcon
            label="diffs"
            active={view === "diffs"}
            onClick={() => setView("diffs")}
            icon="±"
          />
          <ActivityIcon
            label="plans"
            active={view === "plans"}
            onClick={() => setView("plans")}
            icon="☰"
          />
        </div>

        {/* Sidebar */}
        <div className="w-56 shrink-0 overflow-y-auto border-r border-fd-border bg-fd-muted/10">
          {view === "files" && (
            <FileTree files={FILES} activeFile={activeFile} onSelect={(p) => setActiveFile(p)} />
          )}
          {view === "chat" && (
            <ThreadList
              threads={THREADS}
              activeThread={activeThread}
              onSelect={(id) => setActiveThread(id)}
            />
          )}
          {view === "diffs" && (
            <CommitList
              commits={COMMITS}
              activeCommit={activeCommit}
              onSelect={(s) => setActiveCommit(s)}
            />
          )}
          {view === "plans" && (
            <SidebarHeading label="plans">
              <SidebarRow active>v1 plan</SidebarRow>
              <SidebarRow>v2 mobile</SidebarRow>
              <SidebarRow>onboarding</SidebarRow>
            </SidebarHeading>
          )}
        </div>

        {/* Main editor area */}
        <div className="flex-1 min-w-0 flex flex-col">
          {view === "files" && (
            <FileEditor
              file={FILES.find((f) => f.path === activeFile) ?? FILES[0]}
              openTabs={FILES.map((f) => f.path)}
              activeFile={activeFile}
              onTab={(p) => setActiveFile(p)}
            />
          )}
          {view === "chat" && (
            <ChatView thread={THREADS.find((t) => t.id === activeThread) ?? THREADS[0]} />
          )}
          {view === "diffs" && (
            <DiffView commit={COMMITS.find((c) => c.sha === activeCommit) ?? COMMITS[0]} />
          )}
          {view === "plans" && <PlanView body={PLAN_BODY} />}
        </div>
      </div>

      {/* Bottom panel */}
      <div className="border-t border-fd-border bg-fd-muted/20">
        <div className="flex h-7 items-center gap-3 border-b border-fd-border px-3">
          {(["terminal", "problems", "output"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setBottomTab(t)}
              className={`text-[11px] transition-colors ${
                bottomTab === t
                  ? "text-fd-primary border-b-2 border-fd-primary"
                  : "text-fd-muted-foreground hover:text-fd-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="px-3 py-2" style={{ minHeight: 80 }}>
          {bottomTab === "terminal" && (
            <pre className="text-[11px] leading-relaxed text-fd-muted-foreground">
              {`~ $ pnpm test
 ✓ TodoList > renders all seeded items
 ✓ TodoList > toggles done state on click
 ✓ todoStore > hydrates from localStorage

 Test Files  1 passed (1)
      Tests  3 passed (3)`}
            </pre>
          )}
          {bottomTab === "problems" && (
            <p className="text-[11px] text-fd-muted-foreground">
              <span className="text-green-500">✓</span> No problems detected.
            </p>
          )}
          {bottomTab === "output" && (
            <pre className="text-[11px] leading-relaxed text-fd-muted-foreground">
              {`12:14 project.launch       demo-todo-app
12:14 chat.thread.created   "Refactor TodoList…"
12:15 chat.session.completed turn_1
12:18 file.changed          src/stores/todos.ts`}
            </pre>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 border-t border-fd-border bg-fd-muted/30 px-3 py-1 text-[10px] text-fd-muted-foreground">
        <span>⎇ {project.branch}</span>
        <span>·</span>
        <span>↑0</span>
        <span>·</span>
        <span>{project.name}</span>
        <span className="ml-auto">claude-sonnet-4-6 · codex</span>
      </div>
    </div>
  );
}

function ActivityIcon(props: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.label}
      className={`flex h-8 w-8 items-center justify-center border text-[14px] transition-colors ${
        props.active
          ? "border-fd-primary text-fd-primary"
          : "border-transparent text-fd-muted-foreground hover:border-fd-border hover:text-fd-foreground"
      }`}
    >
      {props.icon}
    </button>
  );
}

function SidebarHeading(props: { label: string; children: ReactNode }) {
  return (
    <div className="py-2">
      <div className="px-3 pb-1.5 text-[10px] uppercase tracking-wider text-fd-muted-foreground">
        {props.label}
      </div>
      {props.children}
    </div>
  );
}

function SidebarRow(props: { active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] transition-colors ${
        props.active
          ? "bg-fd-primary/10 text-fd-foreground"
          : "text-fd-muted-foreground hover:text-fd-foreground"
      }`}
    >
      {props.children}
    </button>
  );
}

function FileTree(props: {
  files: FileEntry[];
  activeFile: string;
  onSelect: (path: string) => void;
}) {
  // Group by top dir for a more tree-like look.
  const dirs = new Map<string, FileEntry[]>();
  for (const f of props.files) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts[0] : "";
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(f);
  }
  return (
    <SidebarHeading label="files">
      {Array.from(dirs.entries()).map(([dir, files]) => (
        <div key={dir || "root"}>
          {dir && <div className="px-3 py-0.5 text-[11px] text-fd-foreground">▾ {dir}/</div>}
          {files.map((f) => {
            const name = f.path.replace(`${dir}/`, "");
            return (
              <SidebarRow
                key={f.path}
                active={f.path === props.activeFile}
                onClick={() => props.onSelect(f.path)}
              >
                <span className="text-fd-muted-foreground">{dir ? "  " : ""}</span>
                <span>{name}</span>
              </SidebarRow>
            );
          })}
        </div>
      ))}
    </SidebarHeading>
  );
}

function FileEditor(props: {
  file: FileEntry;
  openTabs: string[];
  activeFile: string;
  onTab: (path: string) => void;
}) {
  return (
    <>
      <div className="flex items-center gap-0 border-b border-fd-border bg-fd-muted/20 px-2">
        {props.openTabs.map((p) => {
          const active = p === props.activeFile;
          const name = p.split("/").pop();
          return (
            <button
              key={p}
              type="button"
              onClick={() => props.onTab(p)}
              className={`border-r border-fd-border px-3 py-1.5 text-[11px] transition-colors ${
                active
                  ? "bg-fd-background text-fd-foreground"
                  : "text-fd-muted-foreground hover:text-fd-foreground"
              }`}
            >
              {name}
            </button>
          );
        })}
      </div>
      <pre className="flex-1 min-h-0 overflow-auto bg-fd-background px-4 py-3 text-[11px] leading-relaxed text-fd-foreground">
        <code>{props.file.content}</code>
      </pre>
    </>
  );
}

function ThreadList(props: {
  threads: ThreadEntry[];
  activeThread: string;
  onSelect: (id: string) => void;
}) {
  return (
    <SidebarHeading label="chat">
      {props.threads.map((t) => (
        <SidebarRow
          key={t.id}
          active={t.id === props.activeThread}
          onClick={() => props.onSelect(t.id)}
        >
          <div className="flex flex-col">
            <span className="truncate">{t.title}</span>
            <span className="text-[9px] uppercase tracking-wider text-fd-muted-foreground">
              {t.provider}
            </span>
          </div>
        </SidebarRow>
      ))}
      <div className="px-3 pt-2">
        <div className="border border-dashed border-fd-border px-2 py-1 text-center text-[10px] text-fd-muted-foreground">
          + new chat
        </div>
      </div>
    </SidebarHeading>
  );
}

function ChatView(props: { thread: ThreadEntry }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-fd-border bg-fd-muted/20 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate text-[11px] text-fd-foreground">{props.thread.title}</span>
          <span className="shrink-0 rounded border border-fd-border px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-fd-muted-foreground">
            {props.thread.provider}
          </span>
        </div>
        <span className="text-[10px] text-fd-muted-foreground">{props.thread.model}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-3 space-y-3">
        {props.thread.messages.map((m, i) => (
          <div key={i} className="flex flex-col gap-1">
            <span
              className={`text-[9px] uppercase tracking-wider ${
                m.role === "user" ? "text-fd-primary" : "text-fd-muted-foreground"
              }`}
            >
              {m.role}
            </span>
            <p className="text-[11px] leading-relaxed text-fd-foreground">{m.text}</p>
          </div>
        ))}
      </div>
      <div className="border-t border-fd-border px-3 py-2">
        <div className="border border-fd-border bg-fd-background px-2 py-1.5 text-[11px] text-fd-muted-foreground">
          Ask the agent…
        </div>
      </div>
    </>
  );
}

function CommitList(props: {
  commits: Commit[];
  activeCommit: string;
  onSelect: (sha: string) => void;
}) {
  return (
    <SidebarHeading label="history">
      {props.commits.map((c) => (
        <SidebarRow
          key={c.sha}
          active={c.sha === props.activeCommit}
          onClick={() => props.onSelect(c.sha)}
        >
          <div className="flex flex-col min-w-0">
            <span className="truncate">{c.subject}</span>
            <span className="text-[9px] text-fd-muted-foreground">
              {c.sha} · {c.ago}
            </span>
          </div>
        </SidebarRow>
      ))}
    </SidebarHeading>
  );
}

function DiffView(props: { commit: Commit }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-fd-border bg-fd-muted/20 px-3 py-2">
        <span className="truncate text-[11px] text-fd-foreground">{props.commit.filePath}</span>
        <span className="text-[10px] text-fd-muted-foreground">
          {props.commit.sha} · {props.commit.subject}
        </span>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto px-0 py-0 text-[11px] leading-relaxed">
        {props.commit.hunks.flatMap((h, hi) =>
          h.lines.map((l, li) => (
            <div
              key={`${hi}:${li}`}
              className={`flex gap-2 px-3 ${
                l.kind === "add"
                  ? "bg-green-500/10 text-green-500"
                  : l.kind === "del"
                    ? "bg-red-500/10 text-red-500"
                    : "text-fd-muted-foreground"
              }`}
            >
              <span className="w-4 shrink-0 select-none">
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
              </span>
              <span className="whitespace-pre">{l.text}</span>
            </div>
          )),
        )}
      </pre>
    </>
  );
}

function PlanView(props: { body: string }) {
  // Cheap markdown rendering: split by lines, handle # headers + [x] todos.
  const lines = props.body.split("\n");
  return (
    <div className="flex-1 min-h-0 overflow-auto px-6 py-4 text-[12px] leading-relaxed text-fd-foreground">
      {lines.map((line, i) => {
        if (line.startsWith("# ")) {
          return (
            <h2 key={i} className="mb-2 mt-3 text-[14px] font-medium text-fd-foreground">
              {line.slice(2)}
            </h2>
          );
        }
        if (line.startsWith("## ")) {
          return (
            <h3 key={i} className="mb-2 mt-3 text-[12px] font-medium text-fd-foreground">
              {line.slice(3)}
            </h3>
          );
        }
        if (line.startsWith("- [x] ")) {
          return (
            <div key={i} className="flex items-start gap-2 text-fd-muted-foreground">
              <span className="text-green-500">✓</span>
              <span className="line-through">{line.slice(6)}</span>
            </div>
          );
        }
        if (line.startsWith("- [ ] ")) {
          return (
            <div key={i} className="flex items-start gap-2">
              <span className="text-fd-muted-foreground">○</span>
              <span>{line.slice(6)}</span>
            </div>
          );
        }
        if (line.trim().startsWith("**")) {
          return (
            <p key={i} className="my-1">
              {line.split(/(\*\*[^*]+\*\*)/g).map((seg, si) =>
                seg.startsWith("**") ? (
                  <strong key={si} className="text-fd-foreground">
                    {seg.slice(2, -2)}
                  </strong>
                ) : (
                  <span key={si}>{seg}</span>
                ),
              )}
            </p>
          );
        }
        if (line.trim()) {
          return (
            <p key={i} className="my-1 text-fd-muted-foreground">
              {line.split(/(\*\*[^*]+\*\*)/g).map((seg, si) =>
                seg.startsWith("**") ? (
                  <strong key={si} className="text-fd-foreground">
                    {seg.slice(2, -2)}
                  </strong>
                ) : (
                  <span key={si}>{seg}</span>
                ),
              )}
            </p>
          );
        }
        return <div key={i} className="h-2" />;
      })}
    </div>
  );
}
