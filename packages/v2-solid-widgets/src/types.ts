/**
 * Shared types for v2 Solid widget mounts.
 *
 * Each widget exports a `mount(container, opts)` function and returns a
 * MountHandle so the React side can update options without remount.
 */

export interface BaseMountOptions {
  /** Project name (matches a tmux-ide session). Used to derive API URLs. */
  sessionName: string;
  /** Daemon API base URL, e.g. http://127.0.0.1:6060 — usually empty for same-origin. */
  apiBaseUrl: string;
  /** Optional auth token for the daemon. */
  bearerToken: string | null;
}

export interface MountHandle {
  unmount(): void;
  setOptions(next: Partial<BaseMountOptions>): void;
}

export interface ExplorerMountOptions extends BaseMountOptions {
  /** Called when the user activates a file (Enter / l / right). The host
   *  decides what to do (e.g. switch to a Preview view). */
  onOpenFile?: (path: string) => void;
}

export interface ExplorerMountHandle {
  unmount(): void;
  setOptions(next: Partial<ExplorerMountOptions>): void;
}

export interface PlansRailMountOptions extends BaseMountOptions {
  /** Currently selected plan file (e.g. "design.md"). The rail highlights
   *  the row whose `path` matches; pass null/undefined for no selection. */
  selectedFile?: string | null;
  /** Called when the user activates a row (click or Enter). The host
   *  decides what to do — typically setSelectedFile + load detail. */
  onSelect?: (filename: string) => void;
  /** Called when the user clicks the "New plan" footer button. The host
   *  is responsible for creating a stub plan and selecting it. */
  onCreate?: () => void;
}

export interface PlansRailMountHandle {
  unmount(): void;
  setOptions(next: Partial<PlansRailMountOptions>): void;
}

// ---------------------------------------------------------------------------
// PlansPanel — prop-driven Solid port of dashboard/components/PlansPanel.tsx's
// detail half. Companion to PlansRail (rail = list, panel = detail). The host
// fetches plan body + authorship via lib/api.ts and pushes it through
// `setOptions({ planData })`. The widget never fetches; it renders the
// markdown body split by heading into authorship-bordered sections.
// ---------------------------------------------------------------------------

export interface PlansPanelAuthorshipSection {
  author: string;
  at: string;
  charCount: number;
}

export interface PlansPanelAuthorship {
  sections: Record<string, PlansPanelAuthorshipSection>;
  stats: { aiPercent: number; humanPercent: number; totalChars: number };
}

export interface PlansPanelPlanSummary {
  name: string;
  path: string;
  title: string;
  status: "in-progress" | "pending" | "done" | "archived" | string;
}

export interface PlansPanelPlanData {
  content: string;
  authorship: PlansPanelAuthorship | null;
  mtime?: number | null;
}

export interface PlansPanelMountOptions {
  /** Plan metadata for the header strip (status pill, title). Null until selected. */
  plan?: PlansPanelPlanSummary | null;
  /** Markdown body + section authorship. Null while loading or none selected. */
  planData?: PlansPanelPlanData | null;
  /** Fired when the user clicks the [edit] toggle. Host owns the editor surface. */
  onEdit?: () => void;
  /** Fired when the user clicks [mark done]. Host issues the API mutation. */
  onMarkDone?: () => void;
  /**
   * Fired when the user clicks the [delete] chip and confirms. Host
   * issues the API mutation. The widget renders no chip when this
   * handler is omitted — keeps the destructive affordance invisible
   * unless a host has explicitly opted in.
   */
  onDelete?: () => void;
}

export interface PlansPanelMountHandle {
  unmount(): void;
  setOptions(next: Partial<PlansPanelMountOptions>): void;
}

export interface DiffsViewerMountOptions extends BaseMountOptions {
  /** Initial diff view style; the toolbar can override. */
  initialDiffStyle?: "unified" | "split";
}

export interface DiffsViewerMountHandle {
  unmount(): void;
  setOptions(next: Partial<DiffsViewerMountOptions>): void;
}

// ---------------------------------------------------------------------------
// MissionControlDashboard — prop-driven variant of the polling MissionControl
// widget. Designed to be fed by the React host's SSE/WS snapshot stream
// (useSessionStream) rather than fetching on its own. Renders the same
// hero/KPI/milestone/agent/event layout as the React MissionView.
// ---------------------------------------------------------------------------

export interface DashboardMissionInfo {
  title: string;
  description: string;
  status: string;
  branch: string | null;
}

export interface DashboardValidationSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  blocked: number;
}

export interface DashboardMilestone {
  id: string;
  title: string;
  status: "locked" | "active" | "done" | "validating" | string;
  order: number;
  taskCount: number;
  tasksDone: number;
}

export interface DashboardTask {
  id: string;
  title: string;
  status: string;
  milestone?: string | null;
  assignee?: string | null;
}

export interface DashboardAgent {
  paneTitle: string;
  paneId: string;
  isBusy: boolean;
  taskTitle: string | null;
  taskId: string | null;
  elapsed: string;
}

export interface DashboardEvent {
  timestamp: string;
  type: string;
  message: string;
  agent?: string | null;
  taskId?: string;
  relative?: string;
}

export interface MissionControlDashboardSnapshot {
  mission: DashboardMissionInfo | null;
  validation: DashboardValidationSummary | null;
  milestones: DashboardMilestone[];
  tasks: DashboardTask[];
  agents: DashboardAgent[];
  events: DashboardEvent[];
}

export interface MissionControlDashboardMountOptions {
  /** Live snapshot of mission state. Null while the host is still loading. */
  snapshot?: MissionControlDashboardSnapshot | null;
  /** Recent-event limit shown in the event stream. Defaults to 20. */
  eventLimit?: number;
  /** Called when a task row is clicked. The host typically routes to kanban. */
  onTaskClick?: (taskId: string) => void;
  /** Called when an agent row is clicked. The host opens the agent dialog. */
  onAgentClick?: (paneId: string) => void;
  /** Called when "show all" is clicked under the event stream. */
  onShowAllEvents?: () => void;
}

export interface MissionControlDashboardMountHandle {
  unmount(): void;
  setOptions(next: Partial<MissionControlDashboardMountOptions>): void;
}

// ---------------------------------------------------------------------------
// CostsDashboard — prop-driven Solid widget for the dashboard's metrics
// surface (dashboard/components/views/MetricsView.tsx). The widget reads
// task throughput, per-agent utilization, milestone progress, mission
// validation, and a recent timeline. Cost in the tmux-ide context is
// "what the agent fleet is burning through" — task-minutes per agent,
// retry rate, completion rate — not LLM tokens (token tracking lives
// elsewhere in chat usage).
// ---------------------------------------------------------------------------

export interface CostsAgentEntry {
  name: string;
  totalTimeMs: number;
  activeTimeMs: number;
  idleTimeMs: number;
  taskCount: number;
  retryCount: number;
  utilization: number;
  specialties: string[];
}

export interface CostsMilestoneEntry {
  id: string;
  title: string;
  status: string;
  taskCount: number;
  completedCount: number;
  durationMs: number;
}

export interface CostsTimelineEntry {
  timestamp: string;
  completedTasks: number;
  activeTasks: number;
  busyAgents: number;
  idleAgents: number;
}

export interface CostsDashboardSnapshot {
  session: {
    startedAt: string | null;
    durationMs: number;
    status: string;
    agentCount: number;
  };
  tasks: {
    total: number;
    completed: number;
    failed: number;
    retried: number;
    completionRate: number;
    retryRate: number;
    avgDurationMs: number;
    medianDurationMs: number;
    p90DurationMs: number;
    byMilestone: CostsMilestoneEntry[];
  };
  agents: CostsAgentEntry[];
  mission: {
    title: string | null;
    status: string | null;
    milestonesCompleted: number;
    validationPassRate: number;
    wallClockMs: number;
  };
  timeline: CostsTimelineEntry[];
}

export interface CostsDashboardMountOptions {
  /** Live metrics snapshot from the React host's polling loop. */
  snapshot?: CostsDashboardSnapshot | null;
  /** Recent-timeline limit; defaults to 20. */
  timelineLimit?: number;
}

export interface CostsDashboardMountHandle {
  unmount(): void;
  setOptions(next: Partial<CostsDashboardMountOptions>): void;
}

// ---------------------------------------------------------------------------
// ExplorerDashboard — prop-driven Solid port of
// dashboard/components/tui-tree/FileTree.tsx. Recursive nested-tree
// renderer with per-node expand/collapse, gitignore filter, selection
// state, and a file-vs-dir click contract. The React host owns the
// fetched tree + the current selection; the widget owns expanded-set
// state internally (so its reactivity is fine-grained — expanding one
// folder only re-renders that subtree, not the whole tree).
// ---------------------------------------------------------------------------

export interface ExplorerNode {
  /** Display name (the path's last segment). */
  name: string;
  /** Path relative to the project root — unique identifier per node. */
  path: string;
  /** True for directories, false for regular files. */
  isDir: boolean;
  /** Optional; when true the entry is gitignored. Hidden by default. */
  ignored?: boolean;
  /**
   * Loaded children. `undefined` means "not yet expanded / not yet loaded".
   * An empty array means "expanded, confirmed empty". Only meaningful when
   * `isDir` is true.
   */
  children?: ExplorerNode[];
}

export interface ExplorerDashboardMountOptions {
  /** Root-level entries. Falsy = empty / loading. */
  rootEntries?: ReadonlyArray<ExplorerNode>;
  /** Currently-selected path. Pass null for no selection highlight. */
  selectedPath?: string | null;
  /** When true (default) gitignored entries are hidden. */
  gitignoreFilter?: boolean;
  /** Open all directories on first render. Defaults to false. */
  defaultExpanded?: boolean;
  /**
   * Fired when the user clicks a node (file or directory). For directories
   * the widget *also* toggles expand internally; this callback exists so
   * the host can track selectedPath + open files in a preview pane.
   */
  onSelect?: (path: string, isDir: boolean) => void;
}

export interface ExplorerDashboardMountHandle {
  unmount(): void;
  setOptions(next: Partial<ExplorerDashboardMountOptions>): void;
}

// ---------------------------------------------------------------------------
// Activity — prop-driven Solid port of
// dashboard/components/activity/ActivityView.tsx. Stream-driven timeline:
// the React host owns the SessionSnapshot's `events` array (sourced from
// the WebSocket bus) and pushes it through `setOptions({ events })`. The
// widget owns filter chip state, search query, and live-tail toggle
// internally.
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  timestamp: string;
  type: string;
  message: string;
  agent?: string | null;
  taskId?: string;
  relative?: string;
}

export interface ActivityMountOptions {
  /** Live event list from the host's WebSocket snapshot. */
  events?: ReadonlyArray<ActivityEvent>;
  /** Hide `agent_heartbeat` (and similar noise) from the list. Default true. */
  hideHeartbeats?: boolean;
}

export interface ActivityMountHandle {
  unmount(): void;
  setOptions(next: Partial<ActivityMountOptions>): void;
}

// ---------------------------------------------------------------------------
// Inspector — right-rail composite for the v2 IDE shell. Wraps the
// Activity timeline in a narrow ~300px frame with a header (collapse
// caret + count badge) and a severity filter footer. Scope-aware: the
// host pushes a `currentView` (e.g. "chat", "files", "tasks") and the
// Inspector trims events to those that match the scope.
// ---------------------------------------------------------------------------

/**
 * Severity bucket exposed by the Inspector footer chips. "all" leaves
 * the event list untouched; the other buckets filter by event type
 * (errors / completions). New buckets land here as the daemon emits new
 * event kinds — keep the type union narrow so chip rendering stays
 * exhaustive.
 */
export type InspectorSeverityFilter = "all" | "errors" | "completions";

/**
 * Coarse "what view is the user looking at?" hint. Used to scope the
 * event list — e.g. "files" suppresses dispatch/completion noise that
 * isn't file-related. Open string so hosts can experiment with new
 * scope keys without a contract bump.
 */
export type InspectorScope =
  | "chat"
  | "files"
  | "tasks"
  | "diffs"
  | "plans"
  | "mission"
  | "metrics"
  | "all"
  | (string & {});

export interface InspectorMountOptions {
  /** Live event list — same shape Activity consumes. */
  events?: ReadonlyArray<ActivityEvent>;
  /** Drop agent_heartbeat noise. Defaults to true. */
  hideHeartbeats?: boolean;
  /** Current view the user is looking at; scopes the event filter. */
  currentView?: InspectorScope;
  /**
   * Controlled expanded state. When omitted the widget owns its own
   * `expanded` signal (uncontrolled). When provided the host owns it.
   */
  expanded?: boolean;
  /** Fired when the collapse caret is clicked. */
  onToggleExpanded?: (next: boolean) => void;
  /** Override the initial uncontrolled expanded value (default true). */
  defaultExpanded?: boolean;
  /** Override the initial uncontrolled severity filter (default "all"). */
  defaultSeverityFilter?: InspectorSeverityFilter;
}

export interface InspectorMountHandle {
  unmount(): void;
  setOptions(next: Partial<InspectorMountOptions>): void;
}

// ---------------------------------------------------------------------------
// TasksView — prop-driven Solid port of dashboard's React TasksView.
// Composite dashboard surface mirroring MissionControlDashboard's prop-
// driven pattern: the React host owns the canonical task list (sourced
// from /api/project/:name) and pushes it through `setOptions({ tasks })`.
// The widget owns its own filter chip + detail-panel state.
// ---------------------------------------------------------------------------

export type TasksTaskStatus = "todo" | "in-progress" | "review" | "done";

export interface TasksTask {
  id: string;
  title: string;
  status: TasksTaskStatus | string;
  /** 1 (highest) – 4 (lowest). Renders as a coloured dot in the row. */
  priority: number;
  assignee?: string | null;
  /** Goal id (e.g. "01", "13", "14"). */
  goal?: string | null;
  milestone?: string | null;
  /** Other task ids this one is blocked by. Rendered as a "⛓ N" badge. */
  depends_on?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  description?: string | null;
  created?: string;
  updated?: string;
  /** Free-form proof payload from the daemon — surfaced verbatim in the detail panel. */
  proof?: unknown;
}

export interface TasksGoalSummary {
  id: string;
  title: string;
}

export interface TasksMilestoneSummary {
  id: string;
  title?: string;
  order?: number;
}

export interface TasksViewMountOptions {
  /** Canonical task list. Updates flow in via setOptions. */
  tasks?: ReadonlyArray<TasksTask>;
  /** Goal index — used by the goal filter chip group. */
  goals?: ReadonlyArray<TasksGoalSummary>;
  /** Milestone index — used by the milestone filter chip group. */
  milestones?: ReadonlyArray<TasksMilestoneSummary>;
  /** Optional initial filter state. Useful for deep-linking via URL params. */
  initialFilters?: {
    status?: TasksTaskStatus[];
    goalIds?: string[];
    milestoneIds?: string[];
    priorities?: number[];
    assignees?: string[];
    search?: string;
  };
  /** Click handler — host routes to the kanban detail or opens a dialog. */
  onTaskClick?: (taskId: string) => void;
  /** Fired when the user clicks "New task" in the toolbar. */
  onCreateTask?: () => void;
  /** Optional density override; defaults to "compact". */
  density?: "compact" | "regular";
}

export interface TasksViewMountHandle {
  unmount(): void;
  setOptions(next: Partial<TasksViewMountOptions>): void;
}

// ---------------------------------------------------------------------------
// KanbanBoard — prop-driven Solid port of dashboard/components/kanban/
// KanbanBoard.tsx. Status-column board with task cards, filters, and
// click-to-cycle status mutation. The React host owns the canonical task
// list (sourced from /api/project/:name) and pushes it through
// `setOptions({ tasks })`. The widget owns its own filter/group/search
// state. Mutation flows out via onTaskStatusChange — the host issues the
// API call (POST /api/project/:name/task/:id) and the next snapshot lands
// back in via setOptions.
// ---------------------------------------------------------------------------

export type KanbanTaskStatus = "todo" | "in-progress" | "review" | "done";

export type KanbanGroupBy = "status" | "priority";

export interface KanbanTask {
  id: string;
  title: string;
  status: KanbanTaskStatus | string;
  /** 1 (highest) – 4 (lowest). Renders as a coloured dot. */
  priority: number;
  assignee?: string | null;
  goal?: string | null;
  milestone?: string | null;
  depends_on?: ReadonlyArray<string>;
  tags?: ReadonlyArray<string>;
  description?: string | null;
  created?: string;
  updated?: string;
}

export interface KanbanBoardMountOptions {
  /** Canonical task list. Updates flow in via setOptions. */
  tasks?: ReadonlyArray<KanbanTask>;
  /** Optional initial filter state. */
  initialFilters?: {
    priorities?: number[];
    agents?: string[];
    milestones?: string[];
    search?: string;
  };
  /** Initial group-by mode; the toolbar can change it. Defaults to "status". */
  initialGroupBy?: KanbanGroupBy;
  /** Click handler for a card body — host typically opens a detail panel. */
  onTaskClick?: (taskId: string) => void;
  /** Fired when the user cycles the status dot on a card. Host issues the
   *  API mutation; the next snapshot will replace the optimistic value. */
  onTaskStatusChange?: (taskId: string, nextStatus: KanbanTaskStatus) => void;
  /** Fired when the user clicks "+ New task". */
  onCreateTask?: () => void;
  /** Optional density override; defaults to "compact". */
  density?: "compact" | "regular";
}

export interface KanbanBoardMountHandle {
  unmount(): void;
  setOptions(next: Partial<KanbanBoardMountOptions>): void;
}

// ---------------------------------------------------------------------------
// SkillsView — prop-driven Solid port of the (retired) React SkillsView.
// Two-pane composite: rail listing project skills + detail panel
// rendering the selected skill's markdown body. The React host owns the
// canonical skill list (sourced from /api/project/:name/skills) and
// pushes it via `setOptions({ skills })`. The widget owns the selected
// skill id + search filter.
// ---------------------------------------------------------------------------

export interface SkillSummary {
  name: string;
  specialties?: ReadonlyArray<string>;
  role?: string;
  description?: string;
  /** Markdown body. Rendered inside a `.chat-markdown` wrapper. */
  body?: string;
}

export interface SkillFormValues {
  name: string;
  role?: string;
  description?: string;
  specialties?: ReadonlyArray<string>;
  body?: string;
}

export interface SkillsViewMountOptions {
  /** Canonical skill list. Updates flow in via setOptions. */
  skills?: ReadonlyArray<SkillSummary>;
  /** Initial selected skill name. Useful for deep-linking via URL params. */
  initialSelected?: string | null;
  /** Fired when the user picks a skill from the rail. */
  onSelect?: (skillName: string) => void;
  /**
   * Optional CRUD handlers. When omitted, the matching UI affordance is
   * hidden (read-only mode). When provided, the host owns persistence +
   * refresh — the widget only collects the form values and dispatches.
   */
  onCreate?: (values: SkillFormValues) => void | Promise<void>;
  onUpdate?: (name: string, values: SkillFormValues) => void | Promise<void>;
  onDelete?: (name: string) => void | Promise<void>;
}

export interface SkillsViewMountHandle {
  unmount(): void;
  setOptions(next: Partial<SkillsViewMountOptions>): void;
}

// ---------------------------------------------------------------------------
// CommandPalette — prop-driven Solid port of the React command palette,
// extended with t3's providerSkillSearch pattern: unified ranked search
// across Providers / Skills / Tasks / Threads / Views / Commands. The
// React host owns ALL data (fetched from the daemon) + the open/close
// state. The widget owns the search query + selected-index. Selection
// fires `onSelect(category, id)` so the host can route per-category.
// ---------------------------------------------------------------------------

export type PaletteCategory =
  | "providers"
  | "skills"
  | "tasks"
  | "threads"
  | "views"
  | "commands";

export interface PaletteItem {
  /** Stable id within (category, items). */
  id: string;
  /** Display label — primary string we match against. */
  label: string;
  /** Optional second-line description; included in match scoring. */
  description?: string | null;
  /** Optional extra keywords; scored last but enable shortcut matches. */
  keywords?: ReadonlyArray<string>;
  /** Optional formatted keybind hint (e.g. "⌘K"). Renders right-aligned. */
  keybind?: string;
  /** Marks the item disabled — still rendered but greyed + not actionable. */
  disabled?: boolean;
}

export interface PaletteCategoryDef {
  category: PaletteCategory;
  /** Section header label rendered above the group. */
  label: string;
  items: ReadonlyArray<PaletteItem>;
}

export interface CommandPaletteMountOptions {
  /** When true, the widget renders the overlay; otherwise it renders null. */
  open?: boolean;
  /** Result groups — each scored independently then merged into a ranked list. */
  categories?: ReadonlyArray<PaletteCategoryDef>;
  /** Optional initial query; useful for deep-link scopes (e.g. "/skills "). */
  initialQuery?: string;
  /** Max results per category. Defaults to 6. */
  perCategoryLimit?: number;
  /** Fired when the user activates a row (Enter / click). */
  onSelect?: (category: PaletteCategory, id: string) => void;
  /** Fired when the user presses Escape or clicks outside the panel. */
  onDismiss?: () => void;
}

export interface CommandPaletteMountHandle {
  unmount(): void;
  setOptions(next: Partial<CommandPaletteMountOptions>): void;
}
