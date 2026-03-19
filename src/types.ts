export interface IdeConfig {
  name?: string;
  before?: string;
  team?: { name: string };
  rows: Row[];
  theme?: ThemeConfig;
}

export interface Row {
  size?: string;
  panes: Pane[];
}

export interface Pane {
  title?: string;
  command?: string;
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
}

export interface SessionState {
  running: boolean;
  reason: string | null;
}
