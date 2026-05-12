"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Panel, Group } from "react-resizable-panels";
import { VSeparator, HSeparator } from "../../_lib/Separators";
import { useSessionStream } from "@/lib/useSessionStream";
import type { Task, AgentDetail, Goal } from "@/lib/types";
import {
  createTask,
  deleteTaskApi,
  fetchFileDiff,
  fetchFilePreview,
  fetchMetrics,
  fetchProjectFiles,
  updateTask,
  type EventData,
  type FilePreview,
  type MetricsData,
  type ProjectFileNode,
} from "@/lib/api";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  DataTable,
  Grid,
  RowSpaceBetween,
  Window,
} from "@/components/v2-primitives";
import { KanbanBoardBridge } from "@/components/kanban-board-bridge";
import { SkillsViewBridge } from "@/components/skills-view-bridge";
import { V2PlansView } from "../../_lib/V2PlansView";
import { V2ChatView } from "../../_lib/V2ChatView";
import { V2CostsIsland } from "../../_lib/V2CostsIsland";
import { V2ExplorerIsland } from "../../_lib/V2ExplorerIsland";
import { V2ChangesIsland } from "../../_lib/V2ChangesIsland";
import { V2MissionControlIsland } from "../../_lib/V2MissionControlIsland";
import { DiffsViewerBridge } from "@/components/diffs-viewer-bridge";
import { MainTabsBar } from "@/components/MainTabsBar";
import { ExplorerBridge, type FileTreeEntry } from "@/components/explorer-bridge";
import { TasksViewBridge } from "@/components/tasks-view-bridge";
import { StatusBar } from "@/components/StatusBar";
import { InspectorBridge } from "@/components/inspector-bridge";
import { BottomPanel } from "@/components/BottomPanel";
import { TooltipProvider } from "@/components/ui";
import { V2ActivityBar, type ActivityBarViewId } from "../../_lib/V2ActivityBar";
import { useStoredLayout } from "../../_lib/useStoredLayout";
import { Terminal } from "@/components/Terminal";

type ViewId =
  | "mission"
  | "mission-control"
  | "kanban"
  | "tasks"
  | "plans"
  | "skills"
  | "chat"
  | "terminal"
  | "files"
  | "diffs"
  | "changes"
  | "preview"
  | "metrics"
  | "costs";

interface ViewSpec {
  id: ViewId;
  label: string;
  glyph: string;
}

const VIEWS: ViewSpec[] = [
  { id: "mission", label: "Mission", glyph: "◆" },
  { id: "mission-control", label: "Mission Control", glyph: "✦" },
  { id: "kanban", label: "Kanban", glyph: "⊟" },
  { id: "tasks", label: "Tasks", glyph: "≡" },
  { id: "plans", label: "Plans", glyph: "▦" },
  { id: "skills", label: "Skills", glyph: "✶" },
  { id: "chat", label: "Chat", glyph: "❯" },
  { id: "terminal", label: "Terminal", glyph: ">_" },
  { id: "files", label: "Files", glyph: "▤" },
  { id: "diffs", label: "Diffs", glyph: "⎇" },
  { id: "changes", label: "Changes", glyph: "Δ" },
  { id: "preview", label: "Preview", glyph: "◳" },
  { id: "metrics", label: "Metrics", glyph: "▬" },
  { id: "costs", label: "Costs", glyph: "◍" },
];
const VIEW_IDS = new Set<string>(VIEWS.map((v) => v.id));

export default function ProjectV2Page() {
  const params = useParams<{ name: string }>();
  const projectName = params?.name ?? "__fallback";
  const { snapshot } = useSessionStream(projectName === "__fallback" ? null : projectName);

  const [view, setView] = useState<ViewId>("kanban");
  // Layout persistence keys mirror the VSCode-style regions:
  //   shell-h        = sidebar | editor | inspector horizontal split
  //   shell-v        = upper | bottom-panel vertical split
  const [shellH, setShellH] = useStoredLayout("shell-h");
  const [shellV, setShellV] = useStoredLayout("shell-v");
  const metrics = useMetricsPoll(
    projectName === "__fallback" ? null : projectName,
    view === "metrics",
  );

  // Preview path is owned at the page level so the Files view can request a
  // file → switch to Preview without round-tripping through localStorage. The
  // Preview view itself is the canonical writer to localStorage; this state is
  // seeded from there on first render and the view keeps it in sync.
  const [previewPath, setPreviewPath] = useState<string>(() => {
    if (typeof window === "undefined" || projectName === "__fallback") return "";
    return window.localStorage.getItem(`${PREVIEW_LAST_PATH_KEY}:${projectName}`) ?? "";
  });

  function openInPreview(path: string) {
    setPreviewPath(path);
    setView("preview");
  }

  // Command-palette → page-view bridge. The Solid CommandPalette dispatches
  // a window-scoped CustomEvent("tmuxide.palette-select-view", detail=ViewId)
  // when the user picks a view/skill/task/thread result; we listen here so
  // selection routes to the local view state without a layout-level store.
  useEffect(() => {
    function onPaletteView(ev: Event) {
      const id = (ev as CustomEvent<string>).detail;
      if (typeof id === "string" && VIEW_IDS.has(id)) {
        setView(id as ViewId);
      }
    }
    window.addEventListener("tmuxide.palette-select-view", onPaletteView);
    return () =>
      window.removeEventListener("tmuxide.palette-select-view", onPaletteView);
  }, []);

  const mission = snapshot?.mission?.mission ?? null;
  const milestones = snapshot?.milestones ?? [];
  const agents: AgentDetail[] = snapshot?.agents ?? [];
  const tasks: Task[] = snapshot?.tasks ?? [];
  const goals: Goal[] = snapshot?.goals ?? [];
  const events: EventData[] = snapshot?.events ?? [];

  // VSCode-style IDE shell — five logical regions:
  //   1. ActivityBar    (left, fixed 48px) — view switcher icons
  //   2. LeftSidebar    (resizable, contextual to active activity)
  //   3. Editor         (resizable, the MainContent router)
  //   4. RightInspector (resizable) — InspectorBridge: live event timeline
  //                      scoped to the current view; sources from the WS bus.
  //   5. BottomPanel    (resizable) — BottomPanel: Terminal / Problems /
  //                      Output tab strip. The Terminal tab embeds the real
  //                      xterm-backed <Terminal /> (always-mounted host).
  //   + StatusBar       (24px fixed footer with branch, session, agents, latest event)
  return (
    <TooltipProvider delay={200}>
      <div className="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
        <MainTabsBar />

        <div className="flex flex-1 min-h-0">
          <V2ActivityBar view={view} onView={(id: ActivityBarViewId) => setView(id)} />
          <div className="flex-1 min-w-0">
            <Group orientation="vertical" defaultLayout={shellV} onLayoutChange={setShellV}>
              <Panel id="upper" defaultSize={75} minSize={20}>
                <Group orientation="horizontal" defaultLayout={shellH} onLayoutChange={setShellH}>
                  <Panel
                    id="left-sidebar"
                    defaultSize={18}
                    minSize={10}
                    collapsible
                    collapsedSize={0}
                    className="border-r border-[var(--border)]"
                  >
                    <ProjectSidebar
                      projectName={projectName}
                      projectDir={snapshot?.project?.dir ?? null}
                      milestones={milestones}
                      view={view}
                      onView={setView}
                    />
                  </Panel>

                  <VSeparator />

                  <Panel id="editor" defaultSize={58} minSize={30}>
                    <div className="flex h-full min-h-0 flex-col">
                      <div className="min-h-0 flex-1">
                        <MainContent
                          view={view}
                          projectName={projectName}
                          mission={mission}
                          milestones={milestones}
                          tasks={tasks}
                          agents={agents}
                          goals={goals}
                          events={events}
                          metrics={metrics}
                          previewPath={previewPath}
                          setPreviewPath={setPreviewPath}
                          openInPreview={openInPreview}
                        />
                      </div>
                    </div>
                  </Panel>

                  <VSeparator />

                  <Panel
                    id="inspector"
                    defaultSize={24}
                    minSize={12}
                    collapsible
                    collapsedSize={0}
                    className="border-l border-[var(--border)]"
                  >
                    <InspectorBridge projectName={projectName} currentView={view} />
                  </Panel>
                </Group>
              </Panel>

              <HSeparator />

              <Panel
                id="bottom-panel"
                defaultSize={25}
                minSize={6}
                collapsible
                collapsedSize={6}
                className="border-t border-[var(--border)]"
              >
                <BottomPanel projectName={projectName} />
              </Panel>
            </Group>
          </div>
        </div>

        <StatusBar
          projectName={projectName}
          running={agents.length > 0 || Boolean(snapshot)}
          agentCount={agents.length}
          events={events}
        />
      </div>
    </TooltipProvider>
  );
}

// ---------------- Sidebar ----------------

interface SidebarProps {
  projectName: string;
  projectDir: string | null;
  milestones: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    taskCount: number;
    tasksDone: number;
  }>;
  view: ViewId;
  onView: (v: ViewId) => void;
}

function ProjectSidebar({ projectName, projectDir, milestones, view, onView }: SidebarProps) {
  const rowCls = "flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors";
  const inactiveCls = `${rowCls} text-[var(--fg)] hover:bg-[var(--surface-hover)]`;
  const activeCls = `${rowCls} bg-[var(--surface-hover)] text-[var(--accent)]`;
  const inactiveStyle: React.CSSProperties = { borderLeft: "2px solid transparent" };
  const activeStyle: React.CSSProperties = { borderLeft: "2px solid var(--accent)" };
  return (
    <nav className="flex h-full flex-col overflow-y-auto py-2 text-[12px]">
      <div className="mb-1 px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        project
      </div>
      <div
        className="mb-3 flex items-center gap-2 px-2 py-1 text-[var(--accent)]"
        style={activeStyle}
      >
        <span aria-hidden="true" className="w-4 text-center">
          ●
        </span>
        <span className="truncate font-medium">{projectName}</span>
      </div>

      <div className="mb-1 mt-1 border-t border-[var(--border-weak)] pt-2 px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
        views
      </div>
      {VIEWS.map((v) => {
        const isActive = v.id === view;
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onView(v.id)}
            className={isActive ? activeCls : inactiveCls}
            style={isActive ? activeStyle : inactiveStyle}
          >
            <span aria-hidden="true" className="w-4 text-center">
              {v.glyph}
            </span>
            <span className="truncate">{v.label}</span>
          </button>
        );
      })}

      {projectDir && (
        <>
          <div className="mb-1 mt-3 border-t border-[var(--border-weak)] pt-2 px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
            widgets
          </div>
          <Link
            href={`/v2/widget/explorer?session=${encodeURIComponent(projectName)}&dir=${encodeURIComponent(projectDir)}`}
            className={inactiveCls}
            style={inactiveStyle}
            data-testid="project-sidebar-files-link"
          >
            <span aria-hidden="true" className="w-4 text-center">
              ▤
            </span>
            <span className="truncate">Files</span>
          </Link>
          <Link
            href={`/v2/widget/mission-control?session=${encodeURIComponent(projectName)}&dir=${encodeURIComponent(projectDir)}`}
            className={inactiveCls}
            style={inactiveStyle}
            data-testid="project-sidebar-mission-control-link"
          >
            <span aria-hidden="true" className="w-4 text-center">
              ◈
            </span>
            <span className="truncate">Mission Control</span>
          </Link>
        </>
      )}

      {milestones.length > 0 && (
        <>
          <div className="mb-1 mt-3 border-t border-[var(--border-weak)] pt-2 px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
            milestones
          </div>
          {milestones.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onView("mission")}
              className={inactiveCls}
              style={inactiveStyle}
            >
              <span aria-hidden="true" className="w-4 text-center">
                {milestoneGlyph(m.status)}
              </span>
              <span className="truncate">{m.title}</span>
              {m.taskCount > 0 && (
                <span className="ml-auto text-[10px] text-[var(--dim)]">
                  {m.tasksDone}/{m.taskCount}
                </span>
              )}
            </button>
          ))}
        </>
      )}
    </nav>
  );
}

function milestoneGlyph(status: string): string {
  switch (status) {
    case "done":
      return "●";
    case "active":
      return "◐";
    case "validating":
      return "◑";
    default:
      return "○";
  }
}

// ---------------- Main content switcher ----------------

interface MainContentProps {
  view: ViewId;
  projectName: string;
  mission: { title: string; description?: string; status?: string } | null;
  milestones: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    taskCount: number;
    tasksDone: number;
  }>;
  tasks: Task[];
  agents: AgentDetail[];
  goals: Goal[];
  events: EventData[];
  metrics: MetricsData | null;
  previewPath: string;
  setPreviewPath: (path: string) => void;
  openInPreview: (path: string) => void;
}

function MainContent(props: MainContentProps) {
  switch (props.view) {
    case "mission":
      return (
        <MissionView mission={props.mission} milestones={props.milestones} tasks={props.tasks} />
      );
    case "mission-control":
      return <V2MissionControlIsland projectName={props.projectName} />;
    case "kanban":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <KanbanBoardBridge
            sessionName={props.projectName}
            tasks={props.tasks}
            goals={props.goals}
          />
        </div>
      );
    case "tasks":
      return <TasksTabContainer projectName={props.projectName} tasks={props.tasks} goals={props.goals} />;
    case "files":
      return <V2ExplorerIsland projectName={props.projectName} onOpenFile={props.openInPreview} />;
    case "preview":
      return (
        <PreviewView
          projectName={props.projectName}
          path={props.previewPath}
          onPathChange={props.setPreviewPath}
        />
      );
    case "skills":
      return <SkillsViewBridge projectName={props.projectName} />;
    case "metrics":
      return (
        <MetricsView
          tasks={props.tasks}
          agents={props.agents}
          milestones={props.milestones}
          metrics={props.metrics}
        />
      );
    case "plans":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <V2PlansView sessionName={props.projectName} tasks={props.tasks} />
        </div>
      );
    case "chat":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <V2ChatView projectName={props.projectName} />
        </div>
      );
    case "costs":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <V2CostsIsland projectName={props.projectName} />
        </div>
      );
    case "diffs":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <DiffsViewerBridge sessionName={props.projectName} />
        </div>
      );
    case "changes":
      return <V2ChangesIsland projectName={props.projectName} />;
    case "terminal":
      return (
        <div
          data-testid="v2-terminal-view"
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <Terminal id={`v2-${props.projectName}`} showHeader={true} />
        </div>
      );
    default:
      return null;
  }
}

function MissionView({
  mission,
  milestones,
  tasks,
}: {
  mission: MainContentProps["mission"];
  milestones: MainContentProps["milestones"];
  tasks: Task[];
}) {
  const taskRows = useMemo<string[][]>(() => {
    const head = ["ID", "TITLE", "STATUS", "ASSIGNEE"];
    const body = tasks.slice(0, 12).map((t) => [t.id, t.title, t.status, t.assignee ?? "—"]);
    return body.length > 0 ? [head, ...body] : [head, ["—", "no tasks yet", "—", "—"]];
  }, [tasks]);

  return (
    <div className="h-full overflow-y-auto p-3">
      {mission ? (
        <Card title={mission.title.toUpperCase()} mode="left">
          {mission.description ? (
            <p className="text-[var(--dim)]">{mission.description}</p>
          ) : (
            <p className="text-[var(--dim)]">No description.</p>
          )}
          <RowSpaceBetween>
            <span>Status</span>
            <Badge>{mission.status ?? "—"}</Badge>
          </RowSpaceBetween>
        </Card>
      ) : (
        <Card title="MISSION" mode="left">
          <p className="text-[var(--dim)]">No mission set for this project yet.</p>
        </Card>
      )}

      <br />

      <Card title="MILESTONES" mode="left">
        {milestones.length === 0 ? (
          <p className="text-[var(--dim)]">No milestones yet.</p>
        ) : (
          milestones.map((m) => (
            <RowSpaceBetween key={m.id}>
              <span>
                <span aria-hidden="true" className="mr-1">
                  {milestoneGlyph(m.status)}
                </span>
                {m.title}
              </span>
              <Badge>
                {m.tasksDone}/{m.taskCount}
              </Badge>
            </RowSpaceBetween>
          ))
        )}
      </Card>

      <br />

      <Card title="TASKS" mode="left">
        <DataTable data={taskRows} />
      </Card>
    </div>
  );
}

// Polls the command-center metrics endpoint when the metrics view is open.
// Mirrors the original costs-widget cadence (5s) and degrades gracefully if
// the endpoint is unreachable — callers receive `null` and fall back to the
// snapshot-derived counts.
function useMetricsPoll(projectName: string | null, active: boolean): MetricsData | null {
  const [data, setData] = useState<MetricsData | null>(null);

  useEffect(() => {
    if (!projectName || !active) return;
    let cancelled = false;
    async function poll() {
      const next = await fetchMetrics(projectName!);
      if (!cancelled) setData(next);
    }
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectName, active]);

  return data;
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

function MetricsView({
  tasks,
  agents,
  milestones,
  metrics,
}: {
  tasks: Task[];
  agents: AgentDetail[];
  milestones: MainContentProps["milestones"];
  metrics: MetricsData | null;
}) {
  const done = tasks.filter((t) => t.status === "done").length;
  const todo = tasks.filter((t) => t.status === "todo").length;
  const inProgress = tasks.filter((t) => t.status === "in-progress").length;
  const review = tasks.filter((t) => t.status === "review").length;
  const busy = agents.filter((a) => a.isBusy).length;
  const milestonesDone = milestones.filter((m) => m.status === "done").length;

  const agentRows = useMemo<string[][]>(() => {
    const head = ["AGENT", "TASKS", "TOTAL TIME", "AVG/TASK", "UTIL"];
    const source = metrics?.agents;
    if (!source || source.length === 0) {
      return [head, ["—", "—", "—", "—", "—"]];
    }
    const sorted = [...source].sort((a, b) => b.totalTimeMs - a.totalTimeMs);
    const body = sorted.map((a) => [
      a.name,
      String(a.taskCount),
      formatDurationMs(a.totalTimeMs),
      a.taskCount > 0 ? formatDurationMs(a.totalTimeMs / a.taskCount) : "—",
      formatPercent(a.utilization),
    ]);
    return [head, ...body];
  }, [metrics]);

  const sessionElapsedMs = metrics?.session.durationMs ?? 0;
  const totalAgentTimeMs = metrics?.agents.reduce((sum, a) => sum + a.totalTimeMs, 0) ?? 0;
  const totalAgentTasks = metrics?.agents.reduce((sum, a) => sum + a.taskCount, 0) ?? 0;
  const completionRate = metrics?.tasks.completionRate ?? 0;
  const validationPassRate = metrics?.mission.validationPassRate ?? 0;
  const missionWallClockMs = metrics?.mission.wallClockMs ?? 0;
  const missionStatus = metrics?.mission.status ?? null;

  return (
    <div className="h-full overflow-y-auto p-3">
      <Card title="SESSION OVERVIEW" mode="left">
        <RowSpaceBetween>
          <span>Session elapsed</span>
          <Badge>{metrics ? formatDurationMs(sessionElapsedMs) : "—"}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Agent time (sum)</span>
          <Badge>{metrics ? formatDurationMs(totalAgentTimeMs) : "—"}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Tasks recorded</span>
          <Badge>{metrics ? totalAgentTasks : "—"}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Mission status</span>
          <Badge>{missionStatus ?? "—"}</Badge>
        </RowSpaceBetween>
        {!metrics && (
          <p className="mt-1 text-[var(--dim)]">
            Metrics endpoint unreachable — showing snapshot-derived counts only.
          </p>
        )}
      </Card>

      <br />

      <Card title="PER-AGENT SPEND" mode="left">
        <DataTable data={agentRows} />
      </Card>

      <br />

      <Card title="MISSION TOTALS" mode="left">
        <RowSpaceBetween>
          <span>Wall-clock</span>
          <Badge>{metrics ? formatDurationMs(missionWallClockMs) : "—"}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Task completion</span>
          <Badge>{metrics ? formatPercent(completionRate) : "—"}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Validation pass rate</span>
          <Badge>{metrics ? formatPercent(validationPassRate) : "—"}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Milestones done</span>
          <Badge>
            {milestonesDone}/{milestones.length}
          </Badge>
        </RowSpaceBetween>
      </Card>

      <br />

      <Card title="TASKS BY STATUS" mode="left">
        <RowSpaceBetween>
          <span>Done</span>
          <Badge>{done}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>In progress</span>
          <Badge>{inProgress}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Review</span>
          <Badge>{review}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Todo</span>
          <Badge>{todo}</Badge>
        </RowSpaceBetween>
      </Card>

      <br />

      <Card title="AGENT UTILIZATION" mode="left">
        <RowSpaceBetween>
          <span>Total</span>
          <Badge>{agents.length}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Busy</span>
          <Badge>{busy}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Idle</span>
          <Badge>{agents.length - busy}</Badge>
        </RowSpaceBetween>
      </Card>
    </div>
  );
}

// ---------------- Tasks ----------------


/**
 * Tasks tab now renders the Solid `TasksViewBridge` unconditionally — the
 * React TasksView + helpers + `?tasks=solid` feature flag retired in U2.
 */
function TasksTabContainer({
  projectName,
  tasks,
  goals,
}: {
  projectName: string;
  tasks: Task[];
  goals: Goal[];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <TasksViewBridge projectName={projectName} tasks={tasks} goals={goals} />
    </div>
  );
}


// ---------------- Preview ----------------

type PreviewMode = "content" | "diff";

const PREVIEW_POLL_MS = 5000;
const PREVIEW_LAST_PATH_KEY = "tmux-ide:preview:last-path";

interface PreviewViewProps {
  projectName: string;
  path: string;
  onPathChange: (path: string) => void;
}

function PreviewView({ projectName, path, onPathChange }: PreviewViewProps) {
  const [draftPath, setDraftPath] = useState<string>(path);
  const [mode, setMode] = useState<PreviewMode>("content");
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  // Re-seed the form input whenever the controlled path changes from outside
  // (e.g. the Files view dispatched openInPreview with a new path).
  useEffect(() => {
    setDraftPath(path);
  }, [path]);

  useEffect(() => {
    if (typeof window === "undefined" || !path) return;
    window.localStorage.setItem(`${PREVIEW_LAST_PATH_KEY}:${projectName}`, path);
  }, [path, projectName]);

  useEffect(() => {
    if (!path) {
      setPreview(null);
      setDiff("");
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [p, d] = await Promise.all([
          fetchFilePreview(projectName, path),
          fetchFileDiff(projectName, path),
        ]);
        if (cancelled) return;
        setPreview(p);
        setDiff(d);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    const id = setInterval(load, PREVIEW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [path, projectName]);

  function applyPath() {
    const next = draftPath.trim();
    if (next === path) return;
    onPathChange(next);
  }

  const language = useMemo(() => detectLanguage(path), [path]);
  const sizeLabel = preview?.size ? formatBytes(preview.size) : null;
  const errorMessage =
    preview?.error ?? (path && preview && !preview.exists ? "File not found." : null);
  const hasDiff = diff.trim().length > 0;

  return (
    <div className="flex h-full flex-col p-3">
      <Card title="PREVIEW" mode="left">
        <RowSpaceBetween>
          <span className="text-[var(--dim)]">
            Read-only preview. Polls every {PREVIEW_POLL_MS / 1000}s. Toggle content/diff with the
            buttons.
          </span>
          <div className="flex gap-1">
            <Button
              theme={mode === "content" ? "PRIMARY" : "SECONDARY"}
              onClick={() => setMode("content")}
            >
              Content
            </Button>
            <Button
              theme={mode === "diff" ? "PRIMARY" : "SECONDARY"}
              onClick={() => setMode("diff")}
              isDisabled={!hasDiff}
            >
              Diff
            </Button>
          </div>
        </RowSpaceBetween>
        <br />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            applyPath();
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={draftPath}
            onChange={(event) => setDraftPath(event.target.value)}
            placeholder="path/to/file (relative to project root)"
            className="flex-1 rounded border border-[var(--border)] bg-[var(--bg-strong)] px-2 py-1 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
          />
          <Button
            onClick={applyPath}
            theme="PRIMARY"
            isDisabled={!draftPath.trim() || draftPath.trim() === path}
          >
            Open
          </Button>
        </form>
        <RowSpaceBetween>
          <span className="text-[var(--dim)]">
            {path ? path : "No file selected."}
            {language ? ` · ${language}` : ""}
            {sizeLabel ? ` · ${sizeLabel}` : ""}
            {hasDiff ? " · has uncommitted changes" : ""}
          </span>
          <Badge>{loading ? "loading…" : mode}</Badge>
        </RowSpaceBetween>
        {errorMessage && <p className="mt-2 text-[var(--red)]">{errorMessage}</p>}
      </Card>

      <br />

      {path && !errorMessage && (
        <div className="min-h-0 flex-1 overflow-auto">
          <Window>
            {mode === "content" && preview && (
              <CodeBlock data-lang={language ?? undefined}>
                {preview.content || "(empty file)"}
              </CodeBlock>
            )}
            {mode === "diff" && (
              <CodeBlock data-lang="diff">{hasDiff ? diff : "(no uncommitted changes)"}</CodeBlock>
            )}
          </Window>
        </div>
      )}
    </div>
  );
}

function detectLanguage(path: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    sh: "bash",
    py: "python",
    rs: "rust",
    go: "go",
    css: "css",
    html: "html",
  };
  return map[ext] ?? ext;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------- Files ----------------

interface FilesViewProps {
  projectName: string;
  /** Called with the relative path when the user clicks a regular file. */
  onOpenFile: (path: string) => void;
}

function FilesView({ projectName, onOpenFile }: FilesViewProps) {
  // The Solid `ExplorerBridge` is the only render path after U2 retired
  // the React FileTree + `?explorer=solid` flag.
  const [tree, setTree] = useState<FileTreeEntry[]>([]);
  const [truncated, setTruncated] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [gitignoreFilter, setGitignoreFilter] = useState<boolean>(true);

  useEffect(() => {
    if (projectName === "__fallback") return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchProjectFiles(projectName);
        if (cancelled) return;
        setTree(res.tree.map(toFileTreeEntry));
        setTruncated(res.truncated);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectName]);

  function handleSelect(path: string, entry: FileTreeEntry) {
    setSelectedPath(path);
    if (!entry.isDir) onOpenFile(path);
  }

  return (
    <div className="flex h-full flex-col p-3">
      <Card title="FILES" mode="left">
        <RowSpaceBetween>
          <span className="text-[var(--dim)]">
            Click a file to open it in the Preview view. Click a directory to expand or collapse.
          </span>
          <div className="flex gap-1">
            <Button
              theme={gitignoreFilter ? "PRIMARY" : "SECONDARY"}
              onClick={() => setGitignoreFilter((value) => !value)}
            >
              {gitignoreFilter ? "Hiding ignored" : "Showing all"}
            </Button>
          </div>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span className="text-[var(--dim)]">
            {loading ? "loading…" : error ? "failed to load" : (selectedPath ?? "no selection")}
            {truncated ? " · tree truncated by API" : ""}
          </span>
          <Badge>{loading ? "…" : `${countFiles(tree)} files`}</Badge>
        </RowSpaceBetween>
        {error && <p className="mt-2 text-[var(--red)]">{error}</p>}
      </Card>

      <br />

      {!error && tree.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--border)] bg-[var(--bg-strong)] p-2 font-mono text-[12px] text-[var(--fg)]">
          <ExplorerBridge
            rootEntries={tree}
            selectedPath={selectedPath}
            onSelect={handleSelect}
            gitignoreFilter={gitignoreFilter}
            defaultExpanded={false}
          />
        </div>
      )}

      {!error && !loading && tree.length === 0 && (
        <Card title="EMPTY" mode="left">
          <p className="text-[var(--dim)]">No files returned by the API.</p>
        </Card>
      )}
    </div>
  );
}

// Map the wire-shape ProjectFileNode (from /api/project/:name/files) to the
// pure-render FileTreeEntry shape consumed by FileTree. The API has no
// `ignored` field today; if it adds one, surface it here.
function toFileTreeEntry(node: ProjectFileNode): FileTreeEntry {
  return {
    name: node.name,
    path: node.path,
    isDir: node.isDirectory,
    children: node.children?.map(toFileTreeEntry),
  };
}

function countFiles(entries: ReadonlyArray<FileTreeEntry>): number {
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDir) total += 1;
    if (entry.children) total += countFiles(entry.children);
  }
  return total;
}

