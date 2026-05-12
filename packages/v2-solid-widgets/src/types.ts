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
