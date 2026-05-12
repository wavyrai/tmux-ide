"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Panel, Group } from "react-resizable-panels";
import { VSeparator, HSeparator } from "../../_lib/Separators";
import Card from "@components/Card";
import Badge from "@components/Badge";
import RowSpaceBetween from "@components/RowSpaceBetween";
import DataTable from "@components/DataTable";
import Grid from "@components/Grid";
import Button from "@components/Button";
import CodeBlock from "@components/CodeBlock";
import Window from "@components/Window";
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
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { PlansPanel } from "@/components/PlansPanel";
import { V2PlansView } from "../../_lib/V2PlansView";
import { V2ChatView } from "../../_lib/V2ChatView";
import { V2CostsIsland } from "../../_lib/V2CostsIsland";
import { V2ExplorerIsland } from "../../_lib/V2ExplorerIsland";
import { V2ChangesIsland } from "../../_lib/V2ChangesIsland";
import { V2MissionControlIsland } from "../../_lib/V2MissionControlIsland";
import { DiffPanel } from "@/components/DiffPanel";
import { DiffPanel as ChangesPanel } from "@/components/diffs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MainTabsBar } from "@/components/MainTabsBar";
import { FileTree, type FileTreeEntry } from "@/components/tui-tree/FileTree";
import { ExplorerBridge } from "@/components/explorer-bridge";
import { TasksViewBridge } from "@/components/tasks-view-bridge";
import { CreateTaskDialog } from "@/components/kanban";
import { openCommandPalette } from "@/components/CommandPalette";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { useLayoutState } from "@/lib/useLayoutState";
import { TopBarActionButton, TopBarSeparator } from "../../_lib/TopBarActionButton";
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

export default function ProjectV2Page() {
  const params = useParams<{ name: string }>();
  const projectName = params?.name ?? "__fallback";
  const { snapshot } = useSessionStream(projectName === "__fallback" ? null : projectName);

  const [view, setView] = useState<ViewId>("kanban");
  const [hLayout, setHLayout] = useStoredLayout("project-h");
  const [vLayout, setVLayout] = useStoredLayout("project-v");
  const [bentoVLayout, setBentoVLayout] = useStoredLayout("project-bento-v");
  const [bentoHLayout, setBentoHLayout] = useStoredLayout("project-bento-h");
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

  const mission = snapshot?.mission?.mission ?? null;
  const milestones = snapshot?.milestones ?? [];
  const agents: AgentDetail[] = snapshot?.agents ?? [];
  const tasks: Task[] = snapshot?.tasks ?? [];
  const goals: Goal[] = snapshot?.goals ?? [];
  const events: EventData[] = snapshot?.events ?? [];
  const skills = snapshot?.skills ?? [];

  return (
    <div className="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <V2TopBar
        projectName={projectName}
        mission={mission?.title ?? null}
        view={view}
        goals={goals}
      />

      <MainTabsBar />

      <div className="flex flex-1 min-h-0">
        <V2ActivityBar view={view} onView={(id: ActivityBarViewId) => setView(id)} />
        <div className="flex-1 min-w-0">
          <Group orientation="horizontal" defaultLayout={hLayout} onLayoutChange={setHLayout}>
            <Panel
              id="sidebar"
              defaultSize={20}
              minSize={14}
              collapsible
              collapsedSize={4}
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

            <Panel id="center" defaultSize={56} minSize={30}>
              <Group orientation="vertical" defaultLayout={vLayout} onLayoutChange={setVLayout}>
                <Panel id="main" defaultSize={70} minSize={20}>
                  <Group
                    orientation="vertical"
                    defaultLayout={bentoVLayout}
                    onLayoutChange={setBentoVLayout}
                  >
                    <Panel id="bento" defaultSize={50} minSize={20}>
                      <Group
                        orientation="horizontal"
                        defaultLayout={bentoHLayout}
                        onLayoutChange={setBentoHLayout}
                      >
                        <Panel id="bento-left" defaultSize={50} minSize={20}>
                          <BentoColumn>
                            <BentoMissionTile mission={mission} milestones={milestones} />
                            <BentoTasksTile tasks={tasks} />
                          </BentoColumn>
                        </Panel>
                        <VSeparator />
                        <Panel id="bento-right" defaultSize={50} minSize={20}>
                          <BentoColumn>
                            <BentoMilestoneTile milestones={milestones} />
                            <BentoAgentsTile agents={agents} />
                          </BentoColumn>
                        </Panel>
                      </Group>
                    </Panel>
                    <HSeparator />
                    <Panel id="bento-detail" defaultSize={50} minSize={20}>
                      <MainContent
                        view={view}
                        projectName={projectName}
                        mission={mission}
                        milestones={milestones}
                        tasks={tasks}
                        agents={agents}
                        goals={goals}
                        events={events}
                        skills={skills}
                        metrics={metrics}
                        previewPath={previewPath}
                        setPreviewPath={setPreviewPath}
                        openInPreview={openInPreview}
                      />
                    </Panel>
                  </Group>
                </Panel>

                <HSeparator />

                <Panel id="terminal" defaultSize={30} minSize={10}>
                  <TerminalPane projectName={projectName} />
                </Panel>
              </Group>
            </Panel>

            <VSeparator />

            <Panel
              id="inspector"
              defaultSize={24}
              minSize={12}
              collapsible
              collapsedSize={4}
              className="border-l border-[var(--border)]"
            >
              <InspectorPane agents={agents} tasks={tasks} />
            </Panel>
          </Group>
        </div>
      </div>

      <V2StatusBar
        projectName={projectName}
        view={view}
        agentCount={agents.length}
        taskCount={tasks.length}
        missionTitle={mission?.title ?? null}
        running={agents.length > 0 || Boolean(snapshot)}
      />
    </div>
  );
}

// ---------------- Topbar ----------------

function V2TopBar({
  projectName,
  mission,
  view,
  goals,
}: {
  projectName: string;
  mission: string | null;
  view: ViewId;
  goals: Goal[];
}) {
  const viewLabel = VIEWS.find((v) => v.id === view)?.label ?? view;
  const { toggleTerminal } = useLayoutState();
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  return (
    <TooltipProvider delay={200}>
      <header className="flex h-7 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-strong)] pl-3 text-[11px] tabular-nums">
        <Link
          href="/v2"
          className="mr-2 inline-flex items-center gap-1 text-[var(--fg)] hover:text-[var(--accent)]"
        >
          <span aria-hidden="true">◇</span>
          <span className="font-medium">tmux-ide</span>
        </Link>
        <button
          type="button"
          onClick={openCommandPalette}
          aria-label="Switch project"
          data-testid="v2-topbar-project-switcher"
          className="inline-flex h-5 items-center gap-1 px-2 text-[var(--accent)] hover:bg-[var(--surface-hover)]"
        >
          <span aria-hidden="true" className="text-[var(--dim)]">
            ▾
          </span>
          <span className="font-medium">{projectName}</span>
        </button>
        <span className="mx-1 text-[var(--dimmer)]">·</span>
        <span className="text-[var(--fg-secondary)]">{viewLabel}</span>
        {mission && (
          <>
            <span className="mx-2 text-[var(--dimmer)]">·</span>
            <span className="truncate text-[var(--dim)]">{mission}</span>
          </>
        )}
        <span className="flex-1" />
        <TopBarSeparator />
        <TopBarActionButton
          icon="⌕"
          tooltip="Search · ⌘K"
          ariaLabel="Search"
          onClick={openCommandPalette}
          testId="v2-topbar-find"
        />
        <TopBarActionButton
          icon=">_"
          tooltip="Toggle terminal · ⌘J"
          ariaLabel="Toggle terminal"
          onClick={toggleTerminal}
          testId="v2-topbar-terminal"
          glyphSize={12}
        />
        <TopBarActionButton
          icon="+"
          tooltip="New task"
          ariaLabel="New task"
          onClick={() => setNewTaskOpen(true)}
          testId="v2-topbar-new-task"
          glyphSize={14}
        />
        <TopBarActionButton
          icon="⌘"
          tooltip="Command palette · ⌘K"
          ariaLabel="Command palette"
          onClick={openCommandPalette}
          testId="v2-topbar-palette"
        />
        <ThemeToggle />
      </header>

      <CreateTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        sessionName={projectName}
        goals={goals}
      />
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
  skills: ReadonlyArray<{ name: string; specialties?: string[] }>;
  metrics: MetricsData | null;
  previewPath: string;
  setPreviewPath: (path: string) => void;
  openInPreview: (path: string) => void;
}

// ---------------- Bento tiles ----------------

function BentoColumn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Grid>{children}</Grid>
    </div>
  );
}

function BentoMissionTile({
  mission,
  milestones,
}: {
  mission: { title: string; description?: string; status?: string } | null;
  milestones: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    taskCount: number;
    tasksDone: number;
  }>;
}) {
  const totalTasks = milestones.reduce((acc, m) => acc + m.taskCount, 0);
  const doneTasks = milestones.reduce((acc, m) => acc + m.tasksDone, 0);
  return (
    <Card title="MISSION" mode="left">
      {mission ? (
        <>
          <RowSpaceBetween>
            <span className="truncate">{mission.title}</span>
            <Badge>{mission.status ?? "—"}</Badge>
          </RowSpaceBetween>
          {milestones.length > 0 && (
            <RowSpaceBetween>
              <span>Milestones</span>
              <Badge>
                <span className="tabular-nums">
                  {doneTasks}/{totalTasks}
                </span>
              </Badge>
            </RowSpaceBetween>
          )}
        </>
      ) : (
        <p className="text-[var(--dim)]">No mission set yet.</p>
      )}
    </Card>
  );
}

function BentoMilestoneTile({
  milestones,
}: {
  milestones: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    taskCount: number;
    tasksDone: number;
  }>;
}) {
  const active =
    milestones.find((m) => m.status === "active") ??
    milestones.find((m) => m.status === "todo") ??
    milestones[0] ??
    null;
  return (
    <Card title="ACTIVE MILESTONE" mode="left">
      {active ? (
        <>
          <RowSpaceBetween>
            <span className="truncate">{active.title}</span>
            <Badge>{active.status}</Badge>
          </RowSpaceBetween>
          <RowSpaceBetween>
            <span>Progress</span>
            <Badge>
              <span className="tabular-nums">
                {active.tasksDone}/{active.taskCount}
              </span>
            </Badge>
          </RowSpaceBetween>
        </>
      ) : (
        <p className="text-[var(--dim)]">No milestones yet.</p>
      )}
    </Card>
  );
}

function BentoTasksTile({ tasks }: { tasks: Task[] }) {
  const todo = tasks.filter((t) => t.status === "todo").length;
  const inProgress = tasks.filter((t) => t.status === "in-progress").length;
  const review = tasks.filter((t) => t.status === "review").length;
  const done = tasks.filter((t) => t.status === "done").length;
  return (
    <Card title="TASKS" mode="left">
      <RowSpaceBetween>
        <span>Todo</span>
        <Badge>
          <span className="tabular-nums">{todo}</span>
        </Badge>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>In progress</span>
        <Badge>
          <span className="tabular-nums">{inProgress}</span>
        </Badge>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Review</span>
        <Badge>
          <span className="tabular-nums">{review}</span>
        </Badge>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Done</span>
        <Badge>
          <span className="tabular-nums">{done}</span>
        </Badge>
      </RowSpaceBetween>
    </Card>
  );
}

function BentoAgentsTile({ agents }: { agents: AgentDetail[] }) {
  return (
    <Card title="AGENTS" mode="left">
      {agents.length === 0 ? (
        <p className="text-[var(--dim)]">No agents detected.</p>
      ) : (
        agents.map((a) => (
          <RowSpaceBetween key={a.paneId}>
            <span className="truncate">
              <span
                aria-hidden="true"
                className="mr-1"
                style={{ color: a.isBusy ? "var(--green)" : "var(--dim)" }}
              >
                {a.isBusy ? "●" : "○"}
              </span>
              {a.paneTitle}
            </span>
            <span className="text-[var(--dim)] tabular-nums">
              {a.elapsed || (a.isBusy ? "working" : "idle")}
            </span>
          </RowSpaceBetween>
        ))
      )}
    </Card>
  );
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
          <KanbanBoard
            sessionName={props.projectName}
            tasks={props.tasks}
            agents={props.agents}
            goals={props.goals}
            events={props.events}
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
      return <SkillsView skills={props.skills} />;
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
          <DiffPanel sessionName={props.projectName} />
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

function SkillsView({
  skills,
}: {
  skills: ReadonlyArray<{ name: string; specialties?: string[] }>;
}) {
  return (
    <div className="h-full overflow-y-auto p-3">
      <Card title="SKILLS" mode="left">
        {skills.length === 0 ? (
          <p className="text-[var(--dim)]">No skills registered for this project.</p>
        ) : (
          skills.map((s) => (
            <RowSpaceBetween key={s.name}>
              <span>
                <span aria-hidden="true" className="mr-1">
                  ✶
                </span>
                {s.name}
              </span>
              <span className="text-[var(--dim)]">{s.specialties?.[0] ?? "—"}</span>
            </RowSpaceBetween>
          ))
        )}
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

type TaskStatus = Task["status"];
type TasksMode = "list" | "detail" | "edit" | "create";

const TASK_STATUSES: TaskStatus[] = ["todo", "in-progress", "review", "done"];
const TASK_PRIORITIES: number[] = [1, 2, 3, 4];

/**
 * Feature flag: `?tasks=solid` swaps the React TasksView for the Solid
 * widget at @tmux-ide/v2-solid-widgets. Same data source (project page
 * snapshot.tasks + snapshot.goals); the Solid version owns its filter
 * chips + detail panel state internally.
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
  const searchParams = useSearchParams();
  const useSolid = searchParams?.get("tasks") === "solid";
  if (useSolid) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <TasksViewBridge projectName={projectName} tasks={tasks} goals={goals} />
      </div>
    );
  }
  return <TasksView projectName={projectName} tasks={tasks} />;
}

function TasksView({ projectName, tasks }: { projectName: string; tasks: Task[] }) {
  const [mode, setMode] = useState<TasksMode>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formPriority, setFormPriority] = useState(3);
  const [formStatus, setFormStatus] = useState<TaskStatus>("todo");

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const sortedTasks = useMemo(() => {
    const order: Record<TaskStatus, number> = {
      "in-progress": 0,
      review: 1,
      todo: 2,
      done: 3,
    };
    return [...tasks].sort(
      (a, b) =>
        order[a.status] - order[b.status] ||
        a.priority - b.priority ||
        a.created.localeCompare(b.created),
    );
  }, [tasks]);

  const taskRows = useMemo<string[][]>(() => {
    const head = ["ID", "TITLE", "STATUS", "PRI", "ASSIGNEE"];
    if (sortedTasks.length === 0) {
      return [head, ["—", "no tasks yet", "—", "—", "—"]];
    }
    const body = sortedTasks.map((t) => [
      t.id,
      t.title,
      t.status,
      `P${t.priority}`,
      t.assignee ?? "—",
    ]);
    return [head, ...body];
  }, [sortedTasks]);

  function openCreate() {
    setFormTitle("");
    setFormDescription("");
    setFormPriority(3);
    setFormStatus("todo");
    setError(null);
    setMode("create");
  }

  function openEdit() {
    if (!selected) return;
    setFormTitle(selected.title);
    setFormDescription(selected.description ?? "");
    setFormPriority(selected.priority);
    setFormStatus(selected.status);
    setError(null);
    setMode("edit");
  }

  function backToList() {
    setSelectedId(null);
    setError(null);
    setMode("list");
  }

  async function handleSave() {
    if (!formTitle.trim()) {
      setError("Title is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "create") {
        const created = await createTask(projectName, {
          title: formTitle.trim(),
          description: formDescription.trim() || undefined,
          priority: formPriority,
        });
        if (!created) {
          setError("Failed to create task.");
          return;
        }
        setSelectedId(created.id);
        setMode("detail");
      } else if (mode === "edit" && selectedId) {
        const updated = await updateTask(projectName, selectedId, {
          title: formTitle.trim(),
          description: formDescription,
          priority: formPriority,
          status: formStatus,
        });
        if (!updated) {
          setError("Failed to save task.");
          return;
        }
        setMode("detail");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      const ok = await deleteTaskApi(projectName, selectedId);
      if (!ok) {
        setError("Failed to delete task.");
        return;
      }
      backToList();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStatusChange(next: TaskStatus) {
    if (!selectedId || !selected || selected.status === next) return;
    setSubmitting(true);
    setError(null);
    try {
      const updated = await updateTask(projectName, selectedId, { status: next });
      if (!updated) setError("Failed to update status.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      {mode === "list" && (
        <Card title="TASKS" mode="left">
          <RowSpaceBetween>
            <span className="text-[var(--dim)]">
              Click a row to open detail. Sorted by status (in-progress first), then priority.
            </span>
            <Button onClick={openCreate} theme="PRIMARY">
              + New
            </Button>
          </RowSpaceBetween>
          <br />
          <div onClick={(event) => handleRowClick(event, sortedTasks, setSelectedId, setMode)}>
            <DataTable data={taskRows} />
          </div>
        </Card>
      )}

      {mode === "detail" && selected && (
        <TaskDetailCard
          task={selected}
          submitting={submitting}
          error={error}
          onEdit={openEdit}
          onDelete={() => void handleDelete()}
          onBack={backToList}
          onStatusChange={(s) => void handleStatusChange(s)}
        />
      )}

      {mode === "detail" && !selected && (
        <Card title="TASK NOT FOUND" mode="left">
          <p className="text-[var(--dim)]">The task may have been deleted.</p>
          <br />
          <Button onClick={backToList} theme="SECONDARY">
            Back
          </Button>
        </Card>
      )}

      {(mode === "create" || mode === "edit") && (
        <TaskFormCard
          mode={mode}
          submitting={submitting}
          error={error}
          title={formTitle}
          description={formDescription}
          priority={formPriority}
          status={formStatus}
          onTitleChange={setFormTitle}
          onDescriptionChange={setFormDescription}
          onPriorityChange={setFormPriority}
          onStatusChange={setFormStatus}
          onSubmit={() => void handleSave()}
          onCancel={() => (mode === "edit" && selectedId ? setMode("detail") : backToList())}
        />
      )}
    </div>
  );
}

// Click delegation: row click identifies the task by index in DataTable's
// rendered <tr> structure. DataTable doesn't expose row-level handlers, so we
// resolve the clicked row via DOM traversal — preserving TUI primitive use.
function handleRowClick(
  event: React.MouseEvent<HTMLDivElement>,
  source: Task[],
  setId: (id: string) => void,
  setMode: (m: TasksMode) => void,
) {
  const target = event.target as HTMLElement;
  const row = target.closest("tr");
  if (!row) return;
  const tbody = row.parentElement;
  if (!tbody) return;
  const rows = Array.from(tbody.children);
  const dataIndex = rows.indexOf(row) - 1;
  if (dataIndex < 0 || dataIndex >= source.length) return;
  const task = source[dataIndex];
  if (!task) return;
  setId(task.id);
  setMode("detail");
}

function TaskDetailCard({
  task,
  submitting,
  error,
  onEdit,
  onDelete,
  onBack,
  onStatusChange,
}: {
  task: Task;
  submitting: boolean;
  error: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onBack: () => void;
  onStatusChange: (next: TaskStatus) => void;
}) {
  return (
    <Card title={`TASK · ${task.id}`} mode="left">
      <RowSpaceBetween>
        <div className="flex gap-1">
          <Button onClick={onBack} theme="SECONDARY" isDisabled={submitting}>
            ← Back
          </Button>
          <Button onClick={onEdit} theme="PRIMARY" isDisabled={submitting}>
            Edit
          </Button>
          <Button onClick={onDelete} theme="SECONDARY" isDisabled={submitting}>
            Delete
          </Button>
        </div>
        <Badge>P{task.priority}</Badge>
      </RowSpaceBetween>
      <br />
      <RowSpaceBetween>
        <span className="font-semibold text-[var(--fg)]">{task.title}</span>
        <Badge>{task.status}</Badge>
      </RowSpaceBetween>
      {task.description && (
        <p className="mt-2 whitespace-pre-wrap text-[var(--fg-secondary)]">{task.description}</p>
      )}
      <br />
      <RowSpaceBetween>
        <span>Set status</span>
        <div className="flex gap-1">
          {TASK_STATUSES.map((s) => (
            <Button
              key={s}
              theme={s === task.status ? "PRIMARY" : "SECONDARY"}
              onClick={() => onStatusChange(s)}
              isDisabled={submitting}
            >
              {s}
            </Button>
          ))}
        </div>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Assignee</span>
        <Badge>{task.assignee ?? "—"}</Badge>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Goal</span>
        <Badge>{task.goal ?? "—"}</Badge>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Milestone</span>
        <Badge>{task.milestone ?? "—"}</Badge>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Created</span>
        <span className="text-[var(--dim)] tabular-nums">{task.created}</span>
      </RowSpaceBetween>
      <RowSpaceBetween>
        <span>Updated</span>
        <span className="text-[var(--dim)] tabular-nums">{task.updated}</span>
      </RowSpaceBetween>
      {task.depends_on.length > 0 && (
        <RowSpaceBetween>
          <span>Depends on</span>
          <Badge>{task.depends_on.join(", ")}</Badge>
        </RowSpaceBetween>
      )}
      {task.tags.length > 0 && (
        <RowSpaceBetween>
          <span>Tags</span>
          <Badge>{task.tags.join(", ")}</Badge>
        </RowSpaceBetween>
      )}
      {error && <p className="mt-2 text-[var(--red)]">{error}</p>}
    </Card>
  );
}

function TaskFormCard({
  mode,
  submitting,
  error,
  title,
  description,
  priority,
  status,
  onTitleChange,
  onDescriptionChange,
  onPriorityChange,
  onStatusChange,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "edit";
  submitting: boolean;
  error: string | null;
  title: string;
  description: string;
  priority: number;
  status: TaskStatus;
  onTitleChange: (v: string) => void;
  onDescriptionChange: (v: string) => void;
  onPriorityChange: (v: number) => void;
  onStatusChange: (v: TaskStatus) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const heading = mode === "create" ? "NEW TASK" : "EDIT TASK";
  const fieldClass =
    "w-full rounded border border-[var(--border)] bg-[var(--bg-strong)] px-2 py-1 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]";

  return (
    <Card title={heading} mode="left">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!submitting) onSubmit();
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">Title</span>
          <input
            type="text"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Short task title"
            className={fieldClass}
            autoFocus
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">
            Description
          </span>
          <textarea
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="Detailed description"
            rows={6}
            className={`${fieldClass} resize-y`}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">Priority</span>
            <select
              value={priority}
              onChange={(event) => onPriorityChange(Number(event.target.value))}
              className={fieldClass}
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </label>

          {mode === "edit" && (
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-[var(--dim)]">Status</span>
              <select
                value={status}
                onChange={(event) => onStatusChange(event.target.value as TaskStatus)}
                className={fieldClass}
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {error && <p className="text-[var(--red)]">{error}</p>}

        <RowSpaceBetween>
          <span className="text-[var(--dim)]">
            {mode === "create" ? "Create new task" : "Edit task"}
          </span>
          <div className="flex gap-1">
            <Button onClick={onCancel} theme="SECONDARY" isDisabled={submitting}>
              Cancel
            </Button>
            <Button onClick={onSubmit} theme="PRIMARY" isDisabled={submitting}>
              {submitting ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </Button>
          </div>
        </RowSpaceBetween>
      </form>
    </Card>
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
  // Feature flag: `?explorer=solid` swaps the React FileTree for the
  // Solid widget at @tmux-ide/v2-solid-widgets. Same data source +
  // same onSelect contract; the Solid version uses fine-grained
  // signals so toggling one folder only re-renders that subtree.
  const searchParams = useSearchParams();
  const useSolid = searchParams?.get("explorer") === "solid";
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
          {useSolid ? (
            <ExplorerBridge
              rootEntries={tree}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              gitignoreFilter={gitignoreFilter}
              defaultExpanded={false}
            />
          ) : (
            <FileTree
              rootEntries={tree}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              gitignoreFilter={gitignoreFilter}
              defaultExpanded={false}
            />
          )}
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

// ---------------- Terminal ----------------

function TerminalPane({ projectName }: { projectName: string }) {
  return (
    <div className="h-full overflow-hidden bg-[var(--bg-strong)] p-3 text-[11px] leading-tight">
      <div className="mb-2 flex items-center text-[10px] text-[var(--dim)]">
        <span aria-hidden="true" className="mr-1">
          {">_"}
        </span>
        <span>terminal · {projectName}:lead</span>
      </div>
      <pre className="whitespace-pre-wrap text-[var(--fg)]">
        {`$ tmux-ide attach ${projectName}
session ${projectName} attached
$ █`}
      </pre>
    </div>
  );
}

// ---------------- Inspector ----------------

function InspectorPane({ agents, tasks }: { agents: AgentDetail[]; tasks: Task[] }) {
  const busyCount = agents.filter((a) => a.isBusy).length;
  const idleCount = agents.length - busyCount;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const todoCount = tasks.filter((t) => t.status === "todo").length;

  return (
    <aside className="flex h-full flex-col overflow-y-auto p-3 text-[12px]">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--dim)]">inspector</div>

      <Card title="AGENTS" mode="left">
        {agents.length === 0 ? (
          <p className="text-[var(--dim)]">No agents detected.</p>
        ) : (
          <>
            <RowSpaceBetween>
              <span>Total</span>
              <Badge>{agents.length}</Badge>
            </RowSpaceBetween>
            <RowSpaceBetween>
              <span>Idle</span>
              <Badge>{idleCount}</Badge>
            </RowSpaceBetween>
            <RowSpaceBetween>
              <span>Busy</span>
              <Badge>{busyCount}</Badge>
            </RowSpaceBetween>
          </>
        )}
      </Card>

      <br />

      <Card title="TASK COUNTS" mode="left">
        <RowSpaceBetween>
          <span>Total</span>
          <Badge>{tasks.length}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Done</span>
          <Badge>{doneCount}</Badge>
        </RowSpaceBetween>
        <RowSpaceBetween>
          <span>Todo</span>
          <Badge>{todoCount}</Badge>
        </RowSpaceBetween>
      </Card>
    </aside>
  );
}

// ---------------- Statusbar ----------------

function V2StatusBar({
  projectName,
  view,
  agentCount,
  taskCount,
  missionTitle,
  running,
}: {
  projectName: string;
  view: ViewId;
  agentCount: number;
  taskCount: number;
  missionTitle: string | null;
  running: boolean;
}) {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  return (
    <footer className="flex h-6 shrink-0 items-center border-t border-[var(--border)] bg-[var(--bg-strong)] px-3 text-[10px] tabular-nums text-[var(--dim)]">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex items-center gap-1 text-[var(--accent)]">
              <span aria-hidden="true">{running ? "●" : "○"}</span>
              <span>{projectName}</span>
            </span>
          }
        />
        <TooltipContent side="top">
          {running ? "Project session is running" : "Project session is stopped"}
        </TooltipContent>
      </Tooltip>
      <span className="mx-2 opacity-30">│</span>
      <Tooltip>
        <TooltipTrigger render={<span>{view}</span>} />
        <TooltipContent side="top">Active view</TooltipContent>
      </Tooltip>
      <span className="mx-2 opacity-30">│</span>
      <Tooltip>
        <TooltipTrigger render={<span>{agentCount} agents</span>} />
        <TooltipContent side="top">Active agent panes</TooltipContent>
      </Tooltip>
      <span className="mx-2 opacity-30">│</span>
      <Tooltip>
        <TooltipTrigger render={<span>{taskCount} tasks</span>} />
        <TooltipContent side="top">Total tasks (all statuses)</TooltipContent>
      </Tooltip>
      {missionTitle && (
        <>
          <span className="mx-2 opacity-30">│</span>
          <Tooltip>
            <TooltipTrigger render={<span className="truncate">{missionTitle}</span>} />
            <TooltipContent side="top">Current mission</TooltipContent>
          </Tooltip>
        </>
      )}
      <span className="flex-1" />
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="mr-3 rounded-none border border-[var(--border-weak)] px-1.5 text-[var(--fg-secondary)]">
              v{version}
            </span>
          }
        />
        <TooltipContent side="top">tmux-ide v2 · build {version}</TooltipContent>
      </Tooltip>
      <Link href="/v2" className="hover:text-[var(--fg)]">
        overview
      </Link>
    </footer>
  );
}
