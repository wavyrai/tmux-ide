export interface SessionStats {
  totalTasks: number;
  doneTasks: number;
  agents: number;
  activeAgents: number;
  elapsed?: string;
}

export interface GoalSummary {
  id: string;
  title: string;
  progress: number;
}

export interface SessionOverview {
  name: string;
  dir: string;
  mission: { title: string; description: string } | null;
  stats: SessionStats;
  goals: GoalSummary[];
}

export interface Agent {
  paneTitle: string;
  isBusy: boolean;
  taskTitle: string | null;
  taskId: string | null;
  elapsed: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "review" | "done";
  assignee: string | null;
  priority: number;
  goal: string | null;
  proof: Record<string, unknown> | null;
  depends_on: string[];
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  acceptance: string;
}

export interface ActivityEntry {
  time: string;
  message: string;
}

export interface ProjectDetail {
  session: string;
  dir: string;
  mission: { title: string; description: string } | null;
  goals: Goal[];
  tasks: Task[];
  agents: Agent[];
  activity?: ActivityEntry[];
}
