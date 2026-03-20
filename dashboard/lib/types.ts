export interface SessionOverview {
  name: string;
  dir: string;
  mission: { title: string; description: string } | null;
  stats: {
    totalTasks: number;
    doneTasks: number;
    agents: number;
    activeAgents: number;
  };
  goals: { id: string; title: string; progress: number }[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  goal: string | null;
  status: "todo" | "in-progress" | "review" | "done";
  assignee: string | null;
  priority: number;
  branch: string | null;
  tags: string[];
}

export interface AgentDetail {
  paneTitle: string;
  isBusy: boolean;
  taskTitle: string | null;
  taskId: string | null;
  elapsed: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: string;
  acceptance: string;
  priority: number;
}

export interface ProjectDetail {
  session: string;
  dir: string;
  mission: { title: string; description: string } | null;
  goals: Goal[];
  tasks: Task[];
  agents: AgentDetail[];
}
