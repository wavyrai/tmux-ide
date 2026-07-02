/**
 * /project/:name — Solid port of the React IDE shell.
 *
 * Layout (5 regions, mirrors VSCode):
 *
 *   ┌────┬────────┬───────────────────────┬────────┐
 *   │ AB │ Side   │ Editor                │ Inspc  │   ← upper (~75%)
 *   │    │        │                       │        │
 *   ├────┴────────┴───────────────────────┴────────┤
 *   │ BottomPanel (Terminal / Problems / Output)   │   ← lower (~25%)
 *   ├──────────────────────────────────────────────┤
 *   │ StatusBar                                    │   ← 24px
 *   └──────────────────────────────────────────────┘
 *
 * G16-P2 specifics:
 *
 *   - Layout uses plain CSS grid with two row tracks (upper/lower)
 *     and three column tracks (sidebar/editor/inspector). Drag handles
 *     are out of scope for P2 — chrome toggles (Cmd+B / Cmd+Alt+B /
 *     Cmd+J) collapse a region to width/height 0. A `corvu`-based
 *     resizable replacement lands in P3.
 *   - Files / Chat / Terminal are wired against their actual Solid
 *     surfaces. Every other view ID renders a "Coming in G16-P3"
 *     placeholder so the route is exhaustive.
 *   - View id is URL-synced via `useViewParam` (the Solid analogue of
 *     the React `useViewParam.ts`).
 */

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { API_BASE } from "@/lib/api";
import { V2ActivityBar, type ActivityBarViewId } from "@/components/ActivityBar";
import { ProjectRail } from "@/components/ProjectRail";
import { StatusBar } from "@/components/StatusBar";
import { TerminalSurface } from "@/components/Terminal/TerminalSurface";
import { ChatView } from "@/components/ChatView";
import { DiffsView } from "@/components/DiffsView";
import { FilesSurface } from "@/components/files/FilesSurface";
import { MonacoDiffsView } from "@/components/diffs/MonacoDiffsView";
import { SearchView } from "@/components/search/SearchView";
import { ExplorerContextMenu } from "@/components/search/ExplorerContextMenu";
import { SymbolPicker } from "@/components/v2/SymbolPicker";
import { recordProjectOpened } from "@/components/projects/ProjectQuickSwitcher";
import { TopBar } from "@/components/TopBar";
import { NotesBridge } from "@/components/NotesBridge";
import {
  BottomPanelView,
  CostsView,
  InspectorPaneView,
  KanbanBoardView,
  MissionControlView,
  PlansSurfaceView,
  SkillsSurfaceView,
  TasksDashboardView,
} from "@/components/v2/views";
import { MissionStatementView } from "@/components/v2/MissionStatementView";
import { AgentsView } from "@/components/v2/AgentsView";
import { chrome, useChromeShortcuts } from "@/lib/chrome";
import { useViewParam } from "@/lib/viewParam";
import { DEFAULT_VIEW, isViewId, VIEWS, type ViewId } from "@/lib/views";
import { registerKeybinds } from "@/lib/keybinds";
import { setCurrentProjectName } from "@/lib/currentProject";

const ACTIVITY_BAR_VIEWS = new Set<ActivityBarViewId>([
  "files",
  "search",
  "diffs",
  "plans",
  "tasks",
  "skills",
  "notes",
  "mission",
  "agents",
  "chat",
  "terminal",
]);

export default function ProjectV2Route(): JSX.Element {
  const params = useParams<{ name: string }>();
  const projectName = () => params.name ?? "__fallback";

  const [view, setView] = useViewParam<ViewId>(DEFAULT_VIEW, isViewId);

  useChromeShortcuts();

  // Session bootstrap. Three states:
  //   "checking" — fetching /api/sessions on mount (very brief)
  //   "launching" — session missing; project.launch dispatched, waiting
  //   "ready"     — session running OR launch errored (UI renders + may
  //                 show 404s; better than trapping the user in a spinner)
  // The IDE shell only mounts in "ready". Otherwise every project-scoped
  // /api/project/:name/* endpoint 404s and the console floods with errors
  // before the session is up.
  type SessionState = "checking" | "launching" | "ready";
  const [sessionState, setSessionState] = createSignal<SessionState>("checking");
  const [launchError, setLaunchError] = createSignal<string | null>(null);

  async function ensureSessionRunning(name: string): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
      const body = (await res.json()) as { sessions?: Array<{ name: string }> };
      const hasSession = body.sessions?.some((s) => s.name === name);
      if (hasSession) {
        setSessionState("ready");
        return;
      }
    } catch {
      // Fall through to launch attempt — if /api/sessions is down, the
      // launch dispatch will surface the real error.
    }
    setSessionState("launching");
    try {
      const res = await fetch(`${API_BASE}/api/v2/action/${encodeURIComponent("project.launch")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: { message?: string };
      };
      if (!body.ok) {
        setLaunchError(body.error?.message ?? `Failed to launch "${name}"`);
      }
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    } finally {
      // Always advance to "ready" — even on error we want the user to see
      // the shell + the error banner; trapping them in a spinner is worse.
      setSessionState("ready");
    }
  }

  onMount(() => {
    recordProjectOpened(projectName());
    setCurrentProjectName(projectName());
    void ensureSessionRunning(projectName());
    onCleanup(() => setCurrentProjectName(null));
  });

  function onActivityBarView(id: ActivityBarViewId) {
    // ActivityBarViewId is a strict subset of ViewId; the registry
    // guarantees both contain "files" / "chat" / "terminal" / etc.
    if (ACTIVITY_BAR_VIEWS.has(id) && isViewId(id)) setView(id);
  }

  // Global, project-scoped keybinds: search/chat/terminal/files view
  // jumps + palette + cheat sheet. Registered through the central
  // keybind registry so the Cmd+K palette and Cmd+/ overlay both
  // see them. The dispatcher (mounted at App root via
  // useGlobalKeybindDispatcher) handles the keydown.
  // palette.open (Cmd+K) and shortcuts.open (Cmd+/) are registered
  // globally in App.tsx so they work on every route. Project-scoped
  // view-jumps stay here.
  onMount(() => {
    const dispose = registerKeybinds(
      {
        id: "view.search",
        label: "Search across project",
        group: "Search",
        scope: "global",
        combo: { key: "f", shift: true },
        run: () => setView("search"),
      },
      {
        id: "view.chat",
        label: "Focus Chat view",
        group: "Chat",
        scope: "global",
        combo: { key: "c", shift: true },
        run: () => setView("chat"),
      },
      {
        id: "view.terminal",
        label: "Focus Terminal view",
        group: "Terminal",
        scope: "global",
        combo: { key: "t", shift: true },
        run: () => setView("terminal"),
      },
      {
        id: "view.files",
        label: "Focus Files view",
        group: "Editor",
        scope: "global",
        combo: { key: "e", shift: true },
        run: () => setView("files"),
      },
    );
    onCleanup(dispose);
  });

  return (
    <div class="flex h-screen w-screen min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--fg)]">
      {/* Until the tmux session is up, render ONLY a centered status
          screen — not the IDE shell. The shell components fire their
          data fetches on mount and would flood the console with 404s
          ("Session not found") for the few hundred ms before launch
          completes. */}
      <Show
        when={sessionState() === "ready" && !launchError()}
        fallback={
          <SessionBootScreen
            state={sessionState()}
            error={launchError()}
            projectName={projectName()}
            onRetry={() => {
              setLaunchError(null);
              setSessionState("checking");
              void ensureSessionRunning(projectName());
            }}
          />
        }
      >
        <ProjectShell
          projectName={projectName()}
          view={view()}
          setView={setView}
          onActivityBarView={onActivityBarView}
        />
      </Show>
    </div>
  );
}

function SessionBootScreen(props: {
  state: "checking" | "launching" | "ready";
  error: string | null;
  projectName: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div class="flex h-full w-full items-center justify-center bg-[var(--bg)]">
      <div class="flex max-w-md flex-col items-center gap-4 text-center">
        <Show
          when={props.error}
          fallback={
            <>
              <div class="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
              <span class="text-sm text-[var(--dim)]">
                {props.state === "checking"
                  ? `Opening ${props.projectName}…`
                  : `Launching ${props.projectName}…`}
              </span>
            </>
          }
        >
          <span class="text-md text-[var(--fg)]">Couldn't launch {props.projectName}</span>
          <span class="text-sm text-[var(--red-foreground,var(--red))]">{props.error}</span>
          <button
            type="button"
            onClick={props.onRetry}
            class="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--bg)] hover:opacity-90"
          >
            Retry launch
          </button>
        </Show>
      </div>
    </div>
  );
}

function ProjectShell(props: {
  projectName: string;
  view: ViewId;
  setView: (v: ViewId) => void;
  onActivityBarView: (id: ActivityBarViewId) => void;
}): JSX.Element {
  const projectName = () => props.projectName;
  const view = () => props.view;
  const setView = props.setView;
  return (
    <>
      {/* Document-level right-click handler for [data-dir-path]
          rows in the Files surface. Always mounted so the menu
          works from any view — closes itself on switch. */}
      <ExplorerContextMenu onRequestSearchView={() => setView("search")} />
      <SymbolPicker sessionName={projectName()} rootPath="/" />
      <TopBar projectName={projectName()} />
      <div class="flex flex-1 min-h-0">
        <ProjectRail activeName={projectName()} />
        <V2ActivityBar view={view()} onView={props.onActivityBarView} />

        <div
          class="grid flex-1 min-w-0"
          style={{
            "grid-template-columns": `${chrome().leftSidebarOpen ? "240px" : "0px"} minmax(0, 1fr) ${chrome().rightInspectorOpen ? "260px" : "0px"}`,
            "grid-template-rows": `minmax(0, 1fr) ${chrome().bottomPanelOpen ? "240px" : "0px"}`,
            "grid-template-areas": '"sidebar editor inspector" "bottom bottom bottom"',
          }}
        >
          <aside
            data-testid="v2-left-sidebar"
            class="overflow-hidden border-r border-[var(--border)] bg-[var(--bg-strong)]"
            style={{ "grid-area": "sidebar" }}
          >
            <Show when={chrome().leftSidebarOpen}>
              <ProjectSidebar projectName={projectName()} view={view()} onView={setView} />
            </Show>
          </aside>

          <main data-testid="v2-editor" class="overflow-hidden" style={{ "grid-area": "editor" }}>
            <MainContent projectName={projectName()} view={view()} />
          </main>

          <aside
            data-testid="v2-right-inspector"
            class="overflow-hidden border-l border-[var(--border)] bg-[var(--bg-strong)]"
            style={{ "grid-area": "inspector" }}
          >
            <Show when={chrome().rightInspectorOpen}>
              <InspectorPaneView projectName={projectName()} currentView={view()} />
            </Show>
          </aside>

          <section
            data-testid="v2-bottom-panel"
            class="overflow-hidden border-t border-[var(--border)] bg-[var(--bg-strong)]"
            style={{ "grid-area": "bottom" }}
          >
            <Show when={chrome().bottomPanelOpen}>
              <BottomPanelView projectName={projectName()} />
            </Show>
          </section>
        </div>
      </div>

      <StatusBar projectName={projectName()} running={false} agentCount={0} />
    </>
  );
}

function ProjectSidebar(props: { projectName: string; view: ViewId; onView: (v: ViewId) => void }) {
  return (
    <nav
      data-testid="v2-project-sidebar"
      class="flex h-full min-h-0 flex-col overflow-y-auto py-2 text-base"
    >
      <div class="mb-1 px-3 text-xs uppercase tracking-wider text-[var(--dim)]">project</div>
      <div class="mb-3 flex items-center gap-2 px-2 py-1 text-[var(--accent)]">
        <span aria-hidden="true" class="w-4 text-center">
          ●
        </span>
        <span class="truncate font-medium">{props.projectName}</span>
      </div>

      <div class="mb-1 mt-1 border-t border-[var(--border-weak)] px-3 pt-2 text-xs uppercase tracking-wider text-[var(--dim)]">
        views
      </div>
      {VIEWS.map((v) => {
        const isActive = () => v.id === props.view;
        return (
          <button
            type="button"
            data-testid={`v2-sidebar-view-${v.id}`}
            data-active={isActive() ? "true" : undefined}
            onClick={() => props.onView(v.id)}
            class={
              "flex w-full items-center gap-2 px-2 py-1 text-left text-base transition-colors " +
              (isActive()
                ? "bg-[var(--surface-hover)] text-[var(--accent)]"
                : "text-[var(--fg)] hover:bg-[var(--surface-hover)]")
            }
            style={{
              "border-left": isActive() ? "2px solid var(--accent)" : "2px solid transparent",
            }}
          >
            <span aria-hidden="true" class="w-4 text-center">
              {v.glyph}
            </span>
            <span class="truncate">{v.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function MainContent(props: { projectName: string; view: ViewId }) {
  return (
    <div data-testid="v2-view-root" data-view={props.view} class="flex h-full min-h-0 flex-col">
      <Show when={props.view === "chat"}>
        <div class="flex h-full min-h-0 flex-col overflow-hidden">
          <ChatView projectName={props.projectName} />
        </div>
      </Show>
      <Show when={props.view === "terminal"}>
        <div class="flex h-full min-h-0 flex-col">
          <TerminalSurface projectName={props.projectName} />
        </div>
      </Show>
      <Show when={props.view === "files"}>
        <FilesSurface projectName={props.projectName} />
      </Show>
      <Show when={props.view === "search"}>
        <SearchView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "diffs"}>
        <DiffsView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "changes"}>
        <MonacoDiffsView
          projectName={props.projectName}
          onAcceptHunk={(file, hunk) => {
            // Per-hunk write-through to disk lands with the buffer
            // store in G17-P5. Log the action so the test surface +
            // dev console can observe the wire-up.
            // eslint-disable-next-line no-console
            console.info("[diffs] accept hunk", file, hunk);
          }}
          onRejectHunk={(file, hunk) => {
            // eslint-disable-next-line no-console
            console.info("[diffs] reject hunk", file, hunk);
          }}
        />
      </Show>
      <Show when={props.view === "mission"}>
        <MissionStatementView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "mission-control"}>
        <MissionControlView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "agents"}>
        <AgentsView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "kanban"}>
        <KanbanBoardView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "tasks"}>
        <TasksDashboardView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "plans"}>
        <PlansSurfaceView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "skills"}>
        <SkillsSurfaceView projectName={props.projectName} />
      </Show>
      <Show when={props.view === "notes"}>
        <NotesBridge projectName={props.projectName} />
      </Show>
      <Show when={props.view === "metrics" || props.view === "costs"}>
        <CostsView projectName={props.projectName} />
      </Show>
    </div>
  );
}
