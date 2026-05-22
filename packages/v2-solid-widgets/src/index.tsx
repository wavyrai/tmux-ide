import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ActivityView } from "./widgets/Activity";

export { WidgetHost } from "./lib/WidgetHost";
import { ChangesView } from "./widgets/Changes";
import { CostsDashboardView } from "./widgets/CostsDashboard";
import { DiffsViewerView } from "./widgets/DiffsViewer";
import { ExplorerView } from "./widgets/Explorer";
import { ExplorerDashboardView } from "./widgets/ExplorerDashboard";
import { InspectorView } from "./widgets/Inspector";
import { KanbanBoardView } from "./widgets/KanbanBoard";
import { MissionControlDashboardView } from "./widgets/MissionControlDashboard";
import { CommandPaletteView } from "./widgets/CommandPalette";
import { PlansPanelView } from "./widgets/PlansPanel";
import { PlansRailView } from "./widgets/PlansRail";
import { SkillsViewView } from "./widgets/SkillsView";
import { TasksViewView } from "./widgets/TasksView";
import { NotesView } from "./widgets/Notes";
import type {
  ActivityMountHandle,
  ActivityMountOptions,
  BaseMountOptions,
  CommandPaletteMountHandle,
  CommandPaletteMountOptions,
  CostsDashboardMountHandle,
  CostsDashboardMountOptions,
  DiffsViewerMountHandle,
  DiffsViewerMountOptions,
  ExplorerDashboardMountHandle,
  ExplorerDashboardMountOptions,
  ExplorerMountHandle,
  ExplorerMountOptions,
  InspectorMountHandle,
  InspectorMountOptions,
  KanbanBoardMountHandle,
  KanbanBoardMountOptions,
  MissionControlDashboardMountHandle,
  MissionControlDashboardMountOptions,
  MountHandle,
  PlansPanelMountHandle,
  PlansPanelMountOptions,
  PlansRailMountHandle,
  PlansRailMountOptions,
  SkillsViewMountHandle,
  SkillsViewMountOptions,
  TasksViewMountHandle,
  TasksViewMountOptions,
  NotesMountHandle,
  NotesMountOptions,
} from "./types";

export type {
  ActivityEvent,
  ActivityMountHandle,
  ActivityMountOptions,
  BaseMountOptions,
  CommandPaletteMountHandle,
  CommandPaletteMountOptions,
  PaletteCategory,
  PaletteCategoryDef,
  PaletteItem,
  CostsAgentEntry,
  CostsDashboardMountHandle,
  CostsDashboardMountOptions,
  CostsDashboardSnapshot,
  CostsMilestoneEntry,
  CostsTimelineEntry,
  DashboardAgent,
  DashboardEvent,
  DashboardMilestone,
  DashboardMissionInfo,
  DashboardTask,
  DashboardValidationSummary,
  DiffsViewerMountHandle,
  DiffsViewerMountOptions,
  ExplorerDashboardMountHandle,
  ExplorerDashboardMountOptions,
  ExplorerMountHandle,
  ExplorerMountOptions,
  ExplorerNode,
  InspectorMountHandle,
  InspectorMountOptions,
  InspectorScope,
  InspectorSeverityFilter,
  KanbanBoardMountHandle,
  KanbanBoardMountOptions,
  KanbanGroupBy,
  KanbanTask,
  KanbanTaskStatus,
  MissionControlDashboardMountHandle,
  MissionControlDashboardMountOptions,
  MissionControlDashboardSnapshot,
  MountHandle,
  PlansPanelAuthorship,
  PlansPanelAuthorshipSection,
  PlansPanelMountHandle,
  PlansPanelMountOptions,
  PlansPanelPlanData,
  PlansPanelPlanSummary,
  PlansRailMountHandle,
  PlansRailMountOptions,
  SkillsViewMountHandle,
  SkillsViewMountOptions,
  SkillSummary,
  TasksTask,
  TasksTaskStatus,
  TasksGoalSummary,
  TasksMilestoneSummary,
  TasksViewMountHandle,
  TasksViewMountOptions,
  NotesMountHandle,
  NotesMountOptions,
} from "./types";

/**
 * Mount the Explorer widget as a Solid DOM island. Accepts
 * ExplorerMountOptions which include an optional onOpenFile(path)
 * callback fired when the user activates a file (Enter / l / right or
 * click on a non-directory row).
 */
export function mountExplorer(
  container: HTMLElement,
  opts: ExplorerMountOptions,
): ExplorerMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <ExplorerView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Changes widget — git diff browser. Read-only patch viewer
 * with a left file rail and right unified/split patch view. Backed by
 * /api/project/:name/diff and /api/project/:name/diff/:file.
 */
export function mountChanges(container: HTMLElement, opts: BaseMountOptions): MountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <ChangesView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Activity timeline — prop-driven Solid port of
 * dashboard/components/activity/ActivityView.tsx. The React host feeds
 * the live event list (sourced from useSessionStream / the WebSocket
 * bus) via `setOptions({ events })`. The widget owns search / filter
 * chips / KPI filter / live-tail toggle internally.
 */
export function mountActivity(
  container: HTMLElement,
  opts: ActivityMountOptions,
): ActivityMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <ActivityView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Explorer dashboard — prop-driven Solid port of
 * dashboard/components/tui-tree/FileTree.tsx. Recursive file-tree
 * renderer; the React host pushes the fetched tree + selectedPath via
 * `setOptions`. The widget owns expand/collapse state internally
 * (single `Set<string>` signal) so toggling one folder re-renders only
 * that subtree — the recursive Solid case the silo investment was
 * supposed to make cheap.
 */
export function mountExplorerDashboard(
  container: HTMLElement,
  opts: ExplorerDashboardMountOptions,
): ExplorerDashboardMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <ExplorerDashboardView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Costs dashboard — prop-driven Solid port of
 * dashboard/components/views/MetricsView.tsx. Same data flow as the
 * Mission Control dashboard: React host owns the polling loop and
 * pushes MetricsData snapshots through `setOptions({ snapshot })`.
 *
 * Renders: KPI grid (session duration / completion rate / avg
 * utilization / retry rate), task summary line, milestone progress
 * rows, per-agent utilization bars, mission validation card, recent
 * activity timeline.
 */
export function mountCostsDashboard(
  container: HTMLElement,
  opts: CostsDashboardMountOptions,
): CostsDashboardMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <CostsDashboardView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Mission Control dashboard — prop-driven Solid port of
 * dashboard/components/mission/MissionView.tsx. The React host owns the
 * SessionSnapshot stream (useSessionStream + the WebSocket bus) and
 * pushes it through `setOptions({ snapshot })`. The widget never fetches.
 *
 * Layout: HeroStrip + KpiStrip + MilestoneLadder + AgentActivityRail +
 * EventStream. Same data-* semantic hooks t3's dashboard uses for CSS
 * overrides.
 */
export function mountMissionControlDashboard(
  container: HTMLElement,
  opts: MissionControlDashboardMountOptions,
): MissionControlDashboardMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <MissionControlDashboardView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Diffs viewer — production replacement for
 * dashboard/components/diffs/DiffPanel.tsx. File rail on the left,
 * unified-diff body on the right, toolbar with file count + +adds /
 * −dels summary + unified/split toggle.
 *
 * Fetches the project-wide diff summary from /api/project/:name/diff
 * (polled every 5s) and per-file patches on selection. Visual language
 * is t3-aligned — semantic data-* hooks (`data-diffs-header`,
 * `data-diff-file-path`, `data-diff-line-kind`) and a color-mix() based
 * palette mirror context/t3code/apps/web/src/components/DiffPanel.tsx.
 */
export function mountDiffsViewer(
  container: HTMLElement,
  opts: DiffsViewerMountOptions,
): DiffsViewerMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <DiffsViewerView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Plans rail — left-rail navigator for the plans surface.
 * Backed by /api/project/:name/plans. Owns search / sort / collapsed-
 * group state internally; the host owns the currently-selected file
 * (push it via setOptions) and the row-activate + create callbacks.
 *
 * Polls every 5s. Visual + behavior parity with the React rail at
 * dashboard/components/plans/PlansView.tsx → PlanListNavigator.
 */
export function mountPlansRail(
  container: HTMLElement,
  opts: PlansRailMountOptions,
): PlansRailMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <PlansRailView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Plans panel — markdown body detail companion to
 * [[mountPlansRail]]. Prop-driven: the React host fetches plan body +
 * authorship via lib/api.ts and pushes the PlanData snapshot through
 * `setOptions({ planData, plan })`. The widget renders the markdown
 * body split by heading into authorship-bordered sections (AI/human
 * border + author badge + relative timestamp).
 */
export function mountPlansPanel(
  container: HTMLElement,
  opts: PlansPanelMountOptions,
): PlansPanelMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <PlansPanelView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Tasks view — production replacement for the React TasksView
 * at dashboard/app/project/[name]/ProjectV2Page.tsx (case "tasks").
 *
 * Composite dashboard surface mirroring MissionControlDashboard's prop-
 * driven pattern: the React host owns the canonical task list (sourced
 * from /api/project/:name) and pushes it through `setOptions({ tasks })`.
 * Filter chip state + selected-task id are owned internally.
 *
 * Visual + behavior parity with the React TasksView; see
 * packages/v2-solid-widgets/src/widgets/TasksView.tsx for the t3
 * alignment notes (semantic data-* hooks, status pill convention,
 * design-token palette).
 */
export function mountTasksView(
  container: HTMLElement,
  opts: TasksViewMountOptions,
): TasksViewMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <TasksViewView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Kanban board — production replacement for the React
 * dashboard/components/kanban/KanbanBoard.tsx composite.
 *
 * Prop-driven: the React host owns the canonical task list (sourced from
 * /api/project/:name) and pushes it through `setOptions({ tasks })`.
 * Filter / group / search state lives inside the widget. Mutations leave
 * the widget via `onTaskStatusChange(id, nextStatus)` — the host issues
 * the API call (POST /api/project/:name/task/:id) and the next snapshot
 * replaces the widget's optimistic patch.
 */
export function mountKanbanBoard(
  container: HTMLElement,
  opts: KanbanBoardMountOptions,
): KanbanBoardMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <KanbanBoardView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the SkillsView — restores the / "Skills" surface that the U5
 * orphan sweep retired. Two-pane composite: a left rail listing project
 * skills + a right detail panel rendering the selected skill's markdown
 * body (rendered inside `.chat-markdown`).
 *
 * Prop-driven: the React host fetches `/api/project/:name/skills` and
 * pushes the list via `setOptions({ skills })`. The widget owns the
 * selected-skill id + search filter internally. Row clicks fire
 * `onSelect(skillName)` so the host can deep-link via URL params.
 */
export function mountSkillsView(
  container: HTMLElement,
  opts: SkillsViewMountOptions,
): SkillsViewMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <SkillsViewView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Command Palette — unified-search overlay extending the t3
 * `providerSkillSearch` pattern to span Providers / Skills / Tasks /
 * Threads / Views / Commands. Prop-driven: the React host owns `open`
 * (toggled via openCommandPalette) and all data; the widget owns the
 * query and active-row index. Selection flows out via
 * `onSelect(category, id)` so the host can route per-category; dismiss
 * (Escape / outside-click) fires `onDismiss()`.
 */
export function mountCommandPalette(
  container: HTMLElement,
  opts: CommandPaletteMountOptions,
): CommandPaletteMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <CommandPaletteView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Notes widget — per-project markdown scratchpad backed by
 * `.tmux-ide/notes.md`. Prop-driven: the host (NotesBridge in the
 * dashboard) fetches the daemon's GET /api/project/:name/notes and
 * pushes `{ content, updatedAt }` via setOptions; user edits leave
 * the widget via `onSave(content)` so the host can PUT and
 * re-broadcast. See docs/feature-framework.md for the worked 7-file
 * pattern this exemplifies.
 */
export function mountNotes(container: HTMLElement, opts: NotesMountOptions): NotesMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <NotesView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}

/**
 * Mount the Inspector — right-rail composite. Wraps [[mountActivity]]'s
 * timeline in a narrow ~300px frame with a collapse caret, scope badge,
 * and severity filter footer. The host pushes the SessionSnapshot
 * event list + the current view (e.g. "chat", "files") and the widget
 * scopes the visible events accordingly. Designed to be parked in the
 * new v2 shell's right-sidebar slot (pane 1's shell refactor wires it
 * once the slot lands).
 */
export function mountInspector(
  container: HTMLElement,
  opts: InspectorMountOptions,
): InspectorMountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <InspectorView options={options} />, container);

  return {
    unmount() {
      dispose();
      container.classList.remove("v2-solid-widget");
    },
    setOptions(next) {
      setOpts((current) => ({ ...current, ...next }));
    },
  };
}
