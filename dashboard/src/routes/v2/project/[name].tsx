/**
 * /v2/project/:name — Solid port of the React IDE shell.
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

import { onCleanup, onMount, Show, type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { V2ActivityBar, type ActivityBarViewId } from "@/components/ActivityBar";
import { StatusBar } from "@/components/StatusBar";
import { Terminal } from "@/components/Terminal";
import { ChatView } from "@/components/ChatView";
import { DiffsView } from "@/components/DiffsView";
import { FilesSurface } from "@/components/files/FilesSurface";
import { MonacoDiffsView } from "@/components/diffs/MonacoDiffsView";
import { SearchView } from "@/components/search/SearchView";
import { ExplorerContextMenu } from "@/components/search/ExplorerContextMenu";
import { SymbolPicker } from "@/components/v2/SymbolPicker";
import { recordProjectOpened } from "@/components/projects/ProjectQuickSwitcher";
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
import { chrome, useChromeShortcuts } from "@/lib/chrome";
import { useViewParam } from "@/lib/viewParam";
import { DEFAULT_VIEW, isViewId, VIEWS, type ViewId } from "@/lib/views";

const ACTIVITY_BAR_VIEWS = new Set<ActivityBarViewId>([
  "files",
  "search",
  "diffs",
  "plans",
  "tasks",
  "skills",
  "mission",
  "chat",
  "terminal",
]);

export default function ProjectV2Route(): JSX.Element {
  const params = useParams<{ name: string }>();
  const projectName = () => params.name ?? "__fallback";

  const [view, setView] = useViewParam<ViewId>(DEFAULT_VIEW, isViewId);

  useChromeShortcuts();

  onMount(() => recordProjectOpened(projectName()));

  function onActivityBarView(id: ActivityBarViewId) {
    // ActivityBarViewId is a strict subset of ViewId; the registry
    // guarantees both contain "files" / "chat" / "terminal" / etc.
    if (ACTIVITY_BAR_VIEWS.has(id) && isViewId(id)) setView(id);
  }

  // Global Cmd+Shift+F (Mac) / Ctrl+Shift+F (other) → repo search view.
  // Mirrors VS Code; reachable from any view, scrolls focus into the
  // SearchView's query input on mount.
  onMount(() => {
    function onKey(event: KeyboardEvent): void {
      const mod = navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
      if (!mod || !event.shiftKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      setView("search");
    }
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="flex h-screen w-screen min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--fg)]">
      {/* Document-level right-click handler for [data-dir-path]
          rows in the Files surface. Always mounted so the menu
          works from any view — closes itself on switch. */}
      <ExplorerContextMenu onRequestSearchView={() => setView("search")} />
      <SymbolPicker sessionName={projectName()} rootPath="/" />
      <div class="flex flex-1 min-h-0">
        <V2ActivityBar view={view()} onView={onActivityBarView} />

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
    </div>
  );
}

function ProjectSidebar(props: { projectName: string; view: ViewId; onView: (v: ViewId) => void }) {
  return (
    <nav
      data-testid="v2-project-sidebar"
      class="flex h-full min-h-0 flex-col overflow-y-auto py-2 text-[12px]"
    >
      <div class="mb-1 px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">project</div>
      <div class="mb-3 flex items-center gap-2 px-2 py-1 text-[var(--accent)]">
        <span aria-hidden="true" class="w-4 text-center">
          ●
        </span>
        <span class="truncate font-medium">{props.projectName}</span>
      </div>

      <div class="mb-1 mt-1 border-t border-[var(--border-weak)] px-3 pt-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">
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
              "flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors " +
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
          <Terminal id={`v2-${props.projectName}-main`} showHeader />
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
      <Show when={props.view === "metrics" || props.view === "costs"}>
        <CostsView projectName={props.projectName} />
      </Show>
    </div>
  );
}
