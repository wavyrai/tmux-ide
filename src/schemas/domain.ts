import { z } from "zod";

// ---------------------------------------------------------------------------
// ProofSchema (from src/types.ts)
// ---------------------------------------------------------------------------

export const ProofSchemaZ = z.object({
  tests: z.object({ passed: z.number(), total: z.number() }).optional(),
  pr: z
    .object({
      number: z.number(),
      url: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
  ci: z.object({ status: z.string(), url: z.string().optional() }).optional(),
  notes: z.string().optional(),
});

export type ProofSchema = z.infer<typeof ProofSchemaZ>;

// ---------------------------------------------------------------------------
// Task / Goal / Mission (from src/lib/task-store.ts)
// ---------------------------------------------------------------------------

export const MilestoneSchemaZ = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["locked", "active", "done", "validating"]),
  order: z.number(),
  created: z.string(),
  updated: z.string(),
});

export const MissionSchemaZ = z.object({
  title: z.string(),
  description: z.string(),
  status: z.enum(["planning", "active", "validating", "complete"]),
  branch: z.string().nullable(),
  milestones: z.array(MilestoneSchemaZ),
  created: z.string(),
  updated: z.string(),
});

export const GoalSchemaZ = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["todo", "in-progress", "done"]),
  acceptance: z.string(),
  priority: z.number(),
  created: z.string(),
  updated: z.string(),
  assignee: z.string().nullable(),
  specialty: z.string().nullable(),
  milestone: z.string().nullable(),
});

export const TaskSchemaZ = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  goal: z.string().nullable(),
  status: z.enum(["todo", "in-progress", "review", "done"]),
  assignee: z.string().nullable(),
  priority: z.number(),
  created: z.string(),
  updated: z.string(),
  tags: z.array(z.string()),
  proof: ProofSchemaZ.nullable(),
  retryCount: z.number(),
  maxRetries: z.number(),
  lastError: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  depends_on: z.array(z.string()),
  milestone: z.string().nullable(),
  specialty: z.string().nullable(),
  fulfills: z.array(z.string()),
  discoveredIssues: z.array(z.string()),
  salientSummary: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// EventType / OrchestratorEvent (from src/lib/event-log.ts)
// ---------------------------------------------------------------------------

export const EventTypeSchemaZ = z.enum([
  "dispatch",
  "stall",
  "completion",
  "retry",
  "reconcile",
  "error",
  "task_created",
  "status_change",
  "send",
  "notify",
  "milestone_validating",
  "milestone_complete",
  "validation_dispatch",
  "remediation",
  "validation_failed",
  "planning",
  "mission_complete",
  "discovered_issue",
  "research_dispatch",
  "research_finding",
  "agent_heartbeat",
  "session_start",
  "session_end",
]);

export const OrchestratorEventSchemaZ = z.object({
  timestamp: z.string(),
  type: EventTypeSchemaZ,
  taskId: z.string().optional(),
  agent: z.string().optional(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// StructuredEvent — discriminated union on "type" with typed payloads
// ---------------------------------------------------------------------------

const DispatchEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("dispatch"),
  taskId: z.string(),
  agent: z.string(),
});

const CompletionEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("completion"),
  taskId: z.string(),
  agent: z.string(),
  durationMs: z.number().optional(),
});

const StallEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("stall"),
  taskId: z.string(),
  agent: z.string(),
  elapsedMs: z.number(),
});

const RetryEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("retry"),
  taskId: z.string(),
  attempt: z.number(),
  maxRetries: z.number(),
  reason: z.string(),
});

const ReconcileEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("reconcile"),
  taskId: z.string(),
  previousAgent: z.string(),
  action: z.string(),
});

const ErrorEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("error"),
  taskId: z.string().optional(),
  agent: z.string().optional(),
  message: z.string(),
  code: z.string().optional(),
});

const TaskCreatedEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("task_created"),
  taskId: z.string(),
  title: z.string(),
});

const StatusChangeEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("status_change"),
  taskId: z.string(),
  from: z.string(),
  to: z.string(),
});

const SendEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("send"),
  target: z.string(),
  paneId: z.string(),
  message: z.string(),
});

const NotifyEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("notify"),
  target: z.string(),
  paneId: z.string(),
  message: z.string(),
});

const MilestoneValidatingEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("milestone_validating"),
  milestoneId: z.string().optional(),
  title: z.string().optional(),
});

const MilestoneCompleteEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("milestone_complete"),
  milestoneId: z.string().optional(),
  title: z.string().optional(),
});

const ValidationDispatchEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("validation_dispatch"),
  milestoneId: z.string().optional(),
  title: z.string().optional(),
  target: z.string().optional(),
});

const RemediationEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("remediation"),
  taskId: z.string(),
  assertionId: z.string().optional(),
});

const ValidationFailedEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("validation_failed"),
  milestoneId: z.string().optional(),
  title: z.string().optional(),
  failedCount: z.number().optional(),
});

const PlanningEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("planning"),
  target: z.string().optional(),
});

const MissionCompleteEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("mission_complete"),
  title: z.string().optional(),
  milestoneCount: z.number().optional(),
  taskCount: z.number().optional(),
  prNumber: z.number().optional(),
});

const DiscoveredIssueEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("discovered_issue"),
  taskId: z.string(),
  sourceTaskId: z.string().optional(),
  issue: z.string().optional(),
});

const ResearchDispatchEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("research_dispatch"),
  taskId: z.string(),
  target: z.string().optional(),
  researchType: z.string().optional(),
});

const ResearchFindingEventZ = z.object({
  timestamp: z.string(),
  type: z.literal("research_finding"),
  taskId: z.string(),
  researchType: z.string().optional(),
  summary: z.string().optional(),
});

export const StructuredEventSchemaZ = z.union([
  DispatchEventZ,
  CompletionEventZ,
  StallEventZ,
  RetryEventZ,
  ReconcileEventZ,
  ErrorEventZ,
  TaskCreatedEventZ,
  StatusChangeEventZ,
  SendEventZ,
  NotifyEventZ,
  MilestoneValidatingEventZ,
  MilestoneCompleteEventZ,
  ValidationDispatchEventZ,
  RemediationEventZ,
  ValidationFailedEventZ,
  PlanningEventZ,
  MissionCompleteEventZ,
  DiscoveredIssueEventZ,
  ResearchDispatchEventZ,
  ResearchFindingEventZ,
]);

// ---------------------------------------------------------------------------
// MarkRange / Mark / AuthorshipStats (from src/lib/authorship.ts)
// ---------------------------------------------------------------------------

export const MarkRangeSchemaZ = z.object({
  from: z.number(),
  to: z.number(),
});

export const MarkSchemaZ = z.object({
  id: z.string(),
  kind: z.enum(["authored", "approved", "flagged", "comment", "insert", "delete", "replace"]),
  by: z.string(),
  at: z.string(),
  range: MarkRangeSchemaZ,
  quote: z.string(),
  orphaned: z.boolean().optional(),
});

export const AuthorshipStatsSchemaZ = z.object({
  aiPercent: z.number(),
  humanPercent: z.number(),
  totalChars: z.number(),
});

// ---------------------------------------------------------------------------
// PlanStatus / PlanMeta (from src/lib/plan-store.ts)
// ---------------------------------------------------------------------------

export const PlanStatusSchemaZ = z.enum(["pending", "in-progress", "done", "archived"]);

export const PlanMetaSchemaZ = z.object({
  name: z.string(),
  path: z.string(),
  title: z.string(),
  status: PlanStatusSchemaZ,
  effort: z.string().optional(),
  gate: z.string().optional(),
  completed: z.string().optional(),
});

// ---------------------------------------------------------------------------
// PaneInfo (from src/widgets/lib/pane-comms.ts)
// ---------------------------------------------------------------------------

export const PaneInfoSchemaZ = z.object({
  id: z.string(),
  index: z.number(),
  title: z.string(),
  currentCommand: z.string(),
  width: z.number(),
  height: z.number(),
  active: z.boolean(),
  role: z
    .enum(["lead", "teammate", "planner", "validator", "researcher", "widget", "shell"])
    .nullable(),
  name: z.string().nullable(),
  type: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// AgentDetail / SessionStats / SessionOverview / ProjectDetail
// (from src/command-center/discovery.ts)
// ---------------------------------------------------------------------------

export const AgentDetailSchemaZ = z.object({
  paneTitle: z.string(),
  paneId: z.string(),
  isBusy: z.boolean(),
  taskTitle: z.string().nullable(),
  taskId: z.string().nullable(),
  elapsed: z.string(),
});

export const SessionStatsSchemaZ = z.object({
  totalTasks: z.number(),
  doneTasks: z.number(),
  agents: z.number(),
  activeAgents: z.number(),
});

export const SessionOverviewSchemaZ = z.object({
  name: z.string(),
  dir: z.string(),
  mission: MissionSchemaZ.nullable(),
  stats: SessionStatsSchemaZ,
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      progress: z.number(),
    }),
  ),
});

export const ProjectDetailSchemaZ = z.object({
  session: z.string(),
  dir: z.string(),
  mission: MissionSchemaZ.nullable(),
  goals: z.array(GoalSchemaZ),
  tasks: z.array(TaskSchemaZ),
  agents: z.array(AgentDetailSchemaZ),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Mission = z.infer<typeof MissionSchemaZ>;
export type Goal = z.infer<typeof GoalSchemaZ>;
export type Task = z.infer<typeof TaskSchemaZ>;
export type EventType = z.infer<typeof EventTypeSchemaZ>;
export type Mark = z.infer<typeof MarkSchemaZ>;
export type MarkRange = z.infer<typeof MarkRangeSchemaZ>;
export type AuthorshipStats = z.infer<typeof AuthorshipStatsSchemaZ>;
export type AgentDetail = z.infer<typeof AgentDetailSchemaZ>;
export type SessionOverview = z.infer<typeof SessionOverviewSchemaZ>;
export type ProjectDetail = z.infer<typeof ProjectDetailSchemaZ>;
