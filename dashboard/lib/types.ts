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

export interface ProofSchema {
  tests?: { passed: number; total: number };
  pr?: { number: number; url?: string; status?: string };
  ci?: { status: string; url?: string };
  notes?: string;
  note?: string;
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
  proof: ProofSchema | null;
  depends_on: string[];
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  nextRetryAt: string | null;
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

export type EventType =
  | "dispatch"
  | "completion"
  | "stall"
  | "retry"
  | "reconcile"
  | "error"
  | "task_created"
  | "status_change";

export interface OrchestratorEvent {
  timestamp: string;
  type: EventType;
  taskId?: string;
  agent?: string;
  message: string;
  relative: string;
}
