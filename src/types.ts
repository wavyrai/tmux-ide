export interface OrchestratorConfig {
  enabled?: boolean;
  auto_dispatch?: boolean;
  stall_timeout?: number; // ms, default 300000 (5 min)
  poll_interval?: number; // ms, default 5000
  worktree_root?: string; // default ".worktrees/"
  master_pane?: string; // pane title of the master agent
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
  type?: "explorer" | "changes" | "preview" | "tasks" | "warroom";
  target?: string;
  dir?: string;
  size?: string;
  focus?: boolean;
  env?: Record<string, string | number>;
  role?: "lead" | "teammate";
  task?: string;
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
