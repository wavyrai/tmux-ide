export interface ProofSchema {
  tests?: { passed: number; total: number };
  pr?: { number: number; url?: string; status?: string };
  ci?: { status: string; url?: string };
  notes?: string;
}

export interface OrchestratorConfig {
  enabled?: boolean;
  auto_dispatch?: boolean;
  stall_timeout?: number; // ms, default 300000 (5 min)
  poll_interval?: number; // ms, default 5000
  worktree_root?: string; // default ".worktrees/"
  master_pane?: string; // pane title of the master agent
  before_run?: string; // shell command to run in worktree before dispatching to agent
  after_run?: string; // shell command to run in worktree after task completes
  cleanup_on_done?: boolean; // remove worktree when task completes (default false)
  dispatch_mode?: "tasks" | "goals"; // default: "tasks" (backward compat)
}

export interface IdeConfig {
  name?: string;
  before?: string;
  team?: { name: string };
  rows: Row[];
  theme?: ThemeConfig;
  orchestrator?: OrchestratorConfig;
}

export interface Row {
  size?: string;
  panes: Pane[];
}

export interface Pane {
  title?: string;
  command?: string;
  type?: "explorer" | "changes" | "preview" | "tasks" | "warroom" | "costs";
  target?: string;
  dir?: string;
  size?: string;
  focus?: boolean;
  env?: Record<string, string | number>;
  role?: "lead" | "teammate" | "planner";
  task?: string;
  specialty?: string; // comma-separated: "frontend, ui, css"
}

export interface ThemeConfig {
  accent?: string;
  border?: string;
  bg?: string;
  fg?: string;
}

export type TmuxCommand = string[];

export interface PaneAction {
  targetPane: string;
  title: string | null;
  chdir: string | null;
  exports: string[];
  command: string | null;
  widgetType: string | null;
  widgetTarget: string | null;
}

export interface SessionState {
  running: boolean;
  reason: string | null;
}
