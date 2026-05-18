/**
 * Action contract for the v2 dispatcher.
 *
 * The dashboard (Agent 2) and CLI clients import the schemas in this file —
 * input + output Zod shapes for every action. The server-side dispatcher
 * (Agent 1) wires each name to a handler that consumes the input and returns
 * the typed result.
 *
 * Adding a new action:
 *  1. Define `<Name>InputSchemaZ` and `<Name>ResultSchemaZ` here
 *  2. Add it to {@link ActionContractsZ} below
 *  3. Add a handler in `handlers/` and register it in `registry.ts`
 *
 * Invariants:
 *  - Names are dot-namespaced (`<noun>.<verb>`)
 *  - Both schemas live here so the wire format never drifts between clients
 *  - Action names ARE the discriminator — keep them stable; never rename
 */

import { z } from "zod";
import { TimelineRowZ } from "./chat-timeline.ts";
import {
  GoalSchemaZ,
  MilestoneSchemaZ,
  MissionSchemaZ,
  ProofSchemaZ,
  TaskSchemaZ,
} from "./domain.ts";
import { IdeConfigSchema, PaneSchema, WebhookConfigSchema } from "./ide-config.ts";

const ProjectScopeInputZ = z.object({
  /**
   * Optional project/session scope. Dashboard calls include this so task
   * mutations target the selected project; CLI-style callers may omit it
   * to use the command-center process cwd.
   */
  name: z.string().min(1).optional(),
  sessionName: z.string().min(1).optional(),
});

const ProofInputZ = z.union([ProofSchemaZ, z.string()]);
const SkillSchemaZ = z.object({
  name: z.string(),
  specialties: z.array(z.string()),
  role: z.string(),
  description: z.string(),
  body: z.string(),
});

// ---------------------------------------------------------------------------
// project.openTerminal
// ---------------------------------------------------------------------------

export const ProjectOpenTerminalInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectOpenTerminalResultZ = z.object({
  sessionName: z.string(),
  cwd: z.string().min(1),
  terminalTabId: z.string(),
  /**
   * `true` when the dispatcher had to launch the tmux session as part of
   * resolving the terminal. `false` when the session was already running.
   */
  launched: z.boolean(),
});

// ---------------------------------------------------------------------------
// project.launch
// ---------------------------------------------------------------------------

export const ProjectLaunchInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectLaunchResultZ = z.object({
  sessionName: z.string(),
  /**
   * `false` when the session was already running (idempotent no-op),
   * `true` when this call started a fresh session.
   */
  started: z.boolean(),
});

// ---------------------------------------------------------------------------
// project.stop
// ---------------------------------------------------------------------------

export const ProjectStopInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectStopResultZ = z.object({
  sessionName: z.string(),
  /**
   * `false` when no session was running (idempotent no-op),
   * `true` when this call killed a session.
   */
  stopped: z.boolean(),
});

// ---------------------------------------------------------------------------
// project.restart
// ---------------------------------------------------------------------------

export const ProjectRestartInputZ = z.object({
  name: z.string().min(1),
});
export const ProjectRestartResultZ = z.object({
  sessionName: z.string(),
  restarted: z.literal(true),
});

// ---------------------------------------------------------------------------
// project.activate
// ---------------------------------------------------------------------------

export const ProjectActivateInputZ = z.object({
  name: z.string().min(1),
  orchestrate: z.boolean().optional(),
});
export const ProjectActivateResultZ = z.object({
  active: z.boolean(),
  projectName: z.string(),
});

// ---------------------------------------------------------------------------
// terminal.respawn
// ---------------------------------------------------------------------------

export const TerminalRespawnInputZ = z.object({
  sessionName: z.string().min(1),
  terminalId: z.string().min(1),
  /**
   * Optional cwd override. Omit to respawn at the bridge's current cwd
   * (re-using the `lastCwd` recorded by the PTY bridge).
   */
  cwd: z.string().min(1).optional(),
});
export const TerminalRespawnResultZ = z.object({
  respawned: z.literal(true),
  cwd: z.string().min(1),
});

// ---------------------------------------------------------------------------
// terminal.stop
// ---------------------------------------------------------------------------

export const TerminalStopInputZ = z.object({
  sessionName: z.string().min(1),
  terminalId: z.string().min(1),
});
export const TerminalStopResultZ = z.object({
  stopped: z.literal(true),
});

// ---------------------------------------------------------------------------
// task.*
// ---------------------------------------------------------------------------

export const TaskCreateInputZ = ProjectScopeInputZ.extend({
  title: z.string().min(1),
  goalId: z.string().min(1).optional(),
  priority: z.number().int().positive().optional(),
  assign: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  depends: z.array(z.string()).optional(),
  description: z.string().optional(),
  milestone: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  fulfills: z.array(z.string()).optional(),
});
export const TaskCreateResultZ = z.object({
  taskId: z.string(),
  task: TaskSchemaZ,
});

export const TaskUpdateInputZ = ProjectScopeInputZ.extend({
  taskId: z.string().min(1),
  status: z.enum(["todo", "in-progress", "review", "done"]).optional(),
  proof: ProofInputZ.optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().int().positive().optional(),
  assign: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  depends: z.array(z.string()).optional(),
  milestone: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  fulfills: z.array(z.string()).optional(),
  summary: z.string().nullable().optional(),
});
export const TaskUpdateResultZ = z.object({
  task: TaskSchemaZ,
});

export const TaskClaimInputZ = ProjectScopeInputZ.extend({
  taskId: z.string().min(1),
  assign: z.string().min(1),
});
export const TaskClaimResultZ = z.object({
  task: TaskSchemaZ,
});

export const TaskDoneInputZ = ProjectScopeInputZ.extend({
  taskId: z.string().min(1),
  proof: ProofInputZ.optional(),
});
export const TaskDoneResultZ = z.object({
  task: TaskSchemaZ,
});

export const TaskDeleteInputZ = ProjectScopeInputZ.extend({
  taskId: z.string().min(1),
});
export const TaskDeleteResultZ = z.object({
  deleted: z.literal(true),
});

// ---------------------------------------------------------------------------
// goal.*
// ---------------------------------------------------------------------------

export const GoalCreateInputZ = ProjectScopeInputZ.extend({
  title: z.string().min(1),
  priority: z.number().int().positive().optional(),
  acceptance: z.string().optional(),
  description: z.string().optional(),
  milestone: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
});
export const GoalCreateResultZ = z.object({
  goalId: z.string(),
  goal: GoalSchemaZ,
});

export const GoalUpdateInputZ = ProjectScopeInputZ.extend({
  goalId: z.string().min(1),
  status: z.enum(["todo", "in-progress", "done"]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  acceptance: z.string().optional(),
  priority: z.number().int().positive().optional(),
  milestone: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  assign: z.string().nullable().optional(),
});
export const GoalUpdateResultZ = z.object({
  goal: GoalSchemaZ,
});

export const GoalDoneInputZ = ProjectScopeInputZ.extend({
  goalId: z.string().min(1),
});
export const GoalDoneResultZ = z.object({
  goal: GoalSchemaZ,
});

export const GoalDeleteInputZ = ProjectScopeInputZ.extend({
  goalId: z.string().min(1),
});
export const GoalDeleteResultZ = z.object({
  deleted: z.literal(true),
});

// ---------------------------------------------------------------------------
// milestone.*
// ---------------------------------------------------------------------------

export const MilestoneCreateInputZ = ProjectScopeInputZ.extend({
  title: z.string().min(1),
  sequence: z.number().int().positive().optional(),
  description: z.string().optional(),
});
export const MilestoneCreateResultZ = z.object({
  milestoneId: z.string(),
  milestone: MilestoneSchemaZ,
});

export const MilestoneUpdateInputZ = ProjectScopeInputZ.extend({
  milestoneId: z.string().min(1),
  status: z.enum(["locked", "active", "done", "validating"]).optional(),
});
export const MilestoneUpdateResultZ = z.object({
  milestone: MilestoneSchemaZ,
});

// ---------------------------------------------------------------------------
// mission.*
// ---------------------------------------------------------------------------

export const MissionSetInputZ = ProjectScopeInputZ.extend({
  title: z.string().min(1),
  description: z.string().optional(),
});
export const MissionSetResultZ = z.object({
  mission: MissionSchemaZ,
});

export const MissionPlanCompleteInputZ = ProjectScopeInputZ;
export const MissionPlanCompleteResultZ = z.object({
  mission: MissionSchemaZ,
});

export const MissionClearInputZ = ProjectScopeInputZ;
export const MissionClearResultZ = z.object({
  cleared: z.literal(true),
});

// ---------------------------------------------------------------------------
// skill.*
// ---------------------------------------------------------------------------

export const SkillCreateInputZ = z.object({
  projectName: z.string().min(1).optional(),
  name: z.string().min(1),
  content: z.string().min(1),
});
export const SkillCreateResultZ = z.object({
  skill: SkillSchemaZ,
});

export const SkillUpdateInputZ = SkillCreateInputZ;
export const SkillUpdateResultZ = SkillCreateResultZ;

export const SkillDeleteInputZ = z.object({
  projectName: z.string().min(1).optional(),
  name: z.string().min(1),
});
export const SkillDeleteResultZ = z.object({
  deleted: z.literal(true),
});

// ---------------------------------------------------------------------------
// config.*
// ---------------------------------------------------------------------------

export const ConfigSetInputZ = z.object({
  projectName: z.string().min(1).optional(),
  path: z.string().min(1),
  value: z.unknown(),
});
export const ConfigResultZ = z.object({
  config: IdeConfigSchema,
});

export const ConfigAddPaneInputZ = PaneSchema.partial().extend({
  projectName: z.string().min(1).optional(),
  rowIndex: z.number().int().min(0),
});
export const ConfigAddPaneResultZ = ConfigResultZ;

export const ConfigRemovePaneInputZ = z.object({
  projectName: z.string().min(1).optional(),
  rowIndex: z.number().int().min(0),
  paneIndex: z.number().int().min(0),
});
export const ConfigRemovePaneResultZ = ConfigResultZ;

export const ConfigAddRowInputZ = z.object({
  projectName: z.string().min(1).optional(),
  size: z.string().optional(),
});
export const ConfigAddRowResultZ = ConfigResultZ;

export const ConfigEnableTeamInputZ = z.object({
  projectName: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
export const ConfigEnableTeamResultZ = ConfigResultZ;

export const ConfigDisableTeamInputZ = z.object({
  projectName: z.string().min(1).optional(),
});
export const ConfigDisableTeamResultZ = ConfigResultZ;

// ---------------------------------------------------------------------------
// validation.*
// ---------------------------------------------------------------------------

const AssertionEntryZ = z.object({
  id: z.string(),
  status: z.enum(["pending", "passing", "failing", "blocked"]),
  verifiedBy: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  evidence: z.string().nullable(),
  blockedBy: z.string().nullable(),
});

const ValidationReportZ = z.object({
  total: z.number(),
  passing: z.number(),
  failing: z.number(),
  pending: z.number(),
  blocked: z.number(),
});

export const ValidationAssertInputZ = z.object({
  projectName: z.string().min(1).optional(),
  assertId: z.string().min(1),
  status: z.enum(["pending", "passing", "failing", "blocked"]),
  evidence: z.string().optional(),
});
export const ValidationAssertResultZ = z.object({
  assertion: AssertionEntryZ,
});

export const ValidationReportInputZ = z.object({
  projectName: z.string().min(1).optional(),
});
export const ValidationReportResultZ = z.object({
  report: ValidationReportZ,
});

// ---------------------------------------------------------------------------
// webhook.*
// ---------------------------------------------------------------------------

export const WebhookAddInputZ = WebhookConfigSchema.extend({
  projectName: z.string().min(1).optional(),
});
export const WebhookAddResultZ = z.object({
  webhookId: z.string(),
  webhook: WebhookConfigSchema,
});

export const WebhookRemoveInputZ = z.object({
  projectName: z.string().min(1).optional(),
  webhookId: z.string().min(1),
});
export const WebhookRemoveResultZ = z.object({
  deleted: z.literal(true),
});

export const WebhookTestInputZ = WebhookRemoveInputZ;
export const WebhookTestResultZ = z.object({
  status: z.number(),
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// app.*
// ---------------------------------------------------------------------------

export const AppSetRemoteAccessInputZ = z.object({
  enabled: z.boolean(),
});
export const AppSetRemoteAccessResultZ = z.object({
  enabled: z.boolean(),
  url: z.string().nullable(),
  token: z.string().nullable(),
  qrPayload: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// daemon.*
// ---------------------------------------------------------------------------

export const DaemonShutdownInputZ = z.object({
  reason: z.string().optional(),
});
export const DaemonShutdownResultZ = z.object({
  stopping: z.literal(true),
});

// ---------------------------------------------------------------------------
// chat.*
// ---------------------------------------------------------------------------

export const StopReasonZ = z.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

export const AgentProviderZ = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude-code"), binary: z.string().optional() }).strict(),
  z.object({ kind: z.literal("codex"), binary: z.string().optional() }).strict(),
  z.object({ kind: z.literal("gemini"), binary: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal("custom"),
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);

export const ContentBlockZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z.object({ type: z.literal("image") }).passthrough(),
  z.object({ type: z.literal("audio") }).passthrough(),
  z.object({ type: z.literal("resource") }).passthrough(),
  z.object({ type: z.literal("resource_link") }).passthrough(),
]);

export const SessionUpdateZ = z.object({ sessionUpdate: z.string().min(1) }).passthrough();

export const ChatThreadUsageSummaryZ = z
  .object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheWriteTokens: z.number().int().min(0).optional(),
    totalCostUsd: z.number().min(0).optional(),
    contextWindowMaxTokens: z.number().int().min(0).optional(),
    contextWindowUsedTokens: z.number().int().min(0).optional(),
  })
  .strict();

export const ThreadMessageZ = z.discriminatedUnion("_tag", [
  z.object({
    _tag: z.literal("UserPrompt"),
    id: z.string().min(1),
    createdAt: z.string().min(1),
    content: z.array(ContentBlockZ),
  }),
  z.object({
    _tag: z.literal("AgentUpdate"),
    id: z.string().min(1),
    createdAt: z.string().min(1),
    update: SessionUpdateZ,
  }),
]);

export const ThreadIndexEntryZ = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    providerKind: z.enum(["claude-code", "codex", "gemini", "custom"]),
    projectDir: z.string().optional(),
    messageCount: z.number().int().min(0),
    lastStopReason: StopReasonZ.optional(),
  })
  .strict();

export const ThreadStateZ = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    provider: AgentProviderZ,
    projectDir: z.string().optional(),
    acpSessionId: z.string().optional(),
    usage: ChatThreadUsageSummaryZ.optional(),
    messages: z.array(ThreadMessageZ),
  })
  .strict();

export const ChatThreadListInputZ = z
  .object({
    /**
     * Filter to threads whose `projectDir` matches. Pass the workspace
     * absolute path. Omit for the legacy global view (returns every
     * thread across every project).
     */
    projectDir: z.string().optional(),
  })
  .strict();
export const ChatThreadListResultZ = z
  .object({
    threads: z.array(ThreadIndexEntryZ),
  })
  .strict();

export const ChatProvidersListInputZ = z.object({}).strict();
export const ChatProvidersListResultZ = z
  .object({
    providers: z.array(
      z
        .object({
          kind: z.enum(["claude-code", "codex"]),
          name: z.string().min(1),
          description: z.string().min(1),
          available: z.boolean(),
          binary: z.string().optional(),
          version: z.string().optional(),
          error: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const ChatThreadCreateInputZ = z
  .object({
    provider: AgentProviderZ,
    projectDir: z.string().optional(),
    title: z.string().optional(),
  })
  .strict();
export const ChatThreadCreateResultZ = z
  .object({
    thread: ThreadIndexEntryZ,
  })
  .strict();

export const ChatThreadDeleteInputZ = z.object({ id: z.string().min(1) }).strict();
export const ChatThreadDeleteResultZ = z.object({ deleted: z.literal(true) }).strict();

export const ChatThreadRenameInputZ = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
  })
  .strict();
export const ChatThreadRenameResultZ = z.object({ thread: ThreadIndexEntryZ }).strict();

export const ChatThreadSetProviderInputZ = z
  .object({
    id: z.string().min(1),
    provider: AgentProviderZ,
  })
  .strict();
export const ChatThreadSetProviderResultZ = z.object({ thread: ThreadIndexEntryZ }).strict();

export const ChatThreadGetInputZ = z.object({ id: z.string().min(1) }).strict();
/**
 * `thread` keeps the raw durable event log (back-compat: persistence,
 * editFromTurn, the daemon test harness all read it). `timeline` is the
 * server-materialized projection the client renders directly — the
 * client no longer reduces ACP chunks into the transcript.
 */
export const ChatThreadGetResultZ = z
  .object({ thread: ThreadStateZ, timeline: z.array(TimelineRowZ) })
  .strict();

export const ChatThreadUsageInputZ = z.object({ id: z.string().min(1) }).strict();
export const ChatThreadUsageResultZ = z
  .object({ usage: ChatThreadUsageSummaryZ.nullable() })
  .strict();

export const ChatSessionSendInputZ = z
  .object({
    threadId: z.string().min(1),
    content: z.array(ContentBlockZ).min(1),
  })
  .strict();
export const ChatSessionSendResultZ = z
  .object({
    accepted: z.literal(true),
    promptId: z.string().min(1),
  })
  .strict();

export const ChatSessionCancelInputZ = z.object({ threadId: z.string().min(1) }).strict();
export const ChatSessionCancelResultZ = z.object({ cancelled: z.literal(true) }).strict();

/**
 * Rewind the thread to just BEFORE the supplied user message id and
 * re-prompt with the new content. The daemon drops every message at
 * or after that user message (history truncation), then dispatches
 * the new prompt as if the user had sent it from the original point
 * in the conversation.
 *
 * Result includes:
 *   - `promptId` — same id surface as `chat.session.send`.
 *   - `truncatedCount` — number of messages that were dropped; the
 *     UI uses this to render an undo toast or animate the rewind.
 *
 * Error modes:
 *   - thread not found → standard `NotFound`.
 *   - user message id not found in the thread → `InvalidInput`.
 *   - the targeted entry is not a user message → `InvalidInput`.
 */
export const ChatSessionEditFromTurnInputZ = z
  .object({
    threadId: z.string().min(1),
    userMessageId: z.string().min(1),
    content: z.array(ContentBlockZ).min(1),
  })
  .strict();
export const ChatSessionEditFromTurnResultZ = z
  .object({
    accepted: z.literal(true),
    promptId: z.string().min(1),
    truncatedCount: z.number().int().nonnegative(),
  })
  .strict();

export const ChatPermissionRespondInputZ = z
  .object({
    threadId: z.string().min(1),
    requestId: z.string().min(1),
    optionId: z.string().min(1),
  })
  .strict();
export const ChatPermissionRespondResultZ = z.object({ responded: z.literal(true) }).strict();

export const ChatContextCaptureTerminalInputZ = z
  .object({
    sessionName: z.string().min(1),
    paneId: z.string().min(1),
  })
  .strict();
export const ChatContextCaptureTerminalResultZ = z
  .object({
    pane: z
      .object({
        id: z.string().min(1),
        title: z.string(),
      })
      .strict(),
    content: z.string(),
    capturedAt: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Registry of action contracts (name → input/output schemas)
// ---------------------------------------------------------------------------

export const ActionContractsZ = {
  "project.openTerminal": {
    input: ProjectOpenTerminalInputZ,
    result: ProjectOpenTerminalResultZ,
  },
  "project.launch": {
    input: ProjectLaunchInputZ,
    result: ProjectLaunchResultZ,
  },
  "project.stop": {
    input: ProjectStopInputZ,
    result: ProjectStopResultZ,
  },
  "project.restart": {
    input: ProjectRestartInputZ,
    result: ProjectRestartResultZ,
  },
  "project.activate": {
    input: ProjectActivateInputZ,
    result: ProjectActivateResultZ,
  },
  "terminal.respawn": {
    input: TerminalRespawnInputZ,
    result: TerminalRespawnResultZ,
  },
  "terminal.stop": {
    input: TerminalStopInputZ,
    result: TerminalStopResultZ,
  },
  "task.create": {
    input: TaskCreateInputZ,
    result: TaskCreateResultZ,
  },
  "task.update": {
    input: TaskUpdateInputZ,
    result: TaskUpdateResultZ,
  },
  "task.claim": {
    input: TaskClaimInputZ,
    result: TaskClaimResultZ,
  },
  "task.done": {
    input: TaskDoneInputZ,
    result: TaskDoneResultZ,
  },
  "task.delete": {
    input: TaskDeleteInputZ,
    result: TaskDeleteResultZ,
  },
  "goal.create": {
    input: GoalCreateInputZ,
    result: GoalCreateResultZ,
  },
  "goal.update": {
    input: GoalUpdateInputZ,
    result: GoalUpdateResultZ,
  },
  "goal.done": {
    input: GoalDoneInputZ,
    result: GoalDoneResultZ,
  },
  "goal.delete": {
    input: GoalDeleteInputZ,
    result: GoalDeleteResultZ,
  },
  "milestone.create": {
    input: MilestoneCreateInputZ,
    result: MilestoneCreateResultZ,
  },
  "milestone.update": {
    input: MilestoneUpdateInputZ,
    result: MilestoneUpdateResultZ,
  },
  "mission.set": {
    input: MissionSetInputZ,
    result: MissionSetResultZ,
  },
  "mission.planComplete": {
    input: MissionPlanCompleteInputZ,
    result: MissionPlanCompleteResultZ,
  },
  "mission.clear": {
    input: MissionClearInputZ,
    result: MissionClearResultZ,
  },
  "skill.create": {
    input: SkillCreateInputZ,
    result: SkillCreateResultZ,
  },
  "skill.update": {
    input: SkillUpdateInputZ,
    result: SkillUpdateResultZ,
  },
  "skill.delete": {
    input: SkillDeleteInputZ,
    result: SkillDeleteResultZ,
  },
  "config.set": {
    input: ConfigSetInputZ,
    result: ConfigResultZ,
  },
  "config.addPane": {
    input: ConfigAddPaneInputZ,
    result: ConfigAddPaneResultZ,
  },
  "config.removePane": {
    input: ConfigRemovePaneInputZ,
    result: ConfigRemovePaneResultZ,
  },
  "config.addRow": {
    input: ConfigAddRowInputZ,
    result: ConfigAddRowResultZ,
  },
  "config.enableTeam": {
    input: ConfigEnableTeamInputZ,
    result: ConfigEnableTeamResultZ,
  },
  "config.disableTeam": {
    input: ConfigDisableTeamInputZ,
    result: ConfigDisableTeamResultZ,
  },
  "validation.assert": {
    input: ValidationAssertInputZ,
    result: ValidationAssertResultZ,
  },
  "validation.report": {
    input: ValidationReportInputZ,
    result: ValidationReportResultZ,
  },
  "webhook.add": {
    input: WebhookAddInputZ,
    result: WebhookAddResultZ,
  },
  "webhook.remove": {
    input: WebhookRemoveInputZ,
    result: WebhookRemoveResultZ,
  },
  "webhook.test": {
    input: WebhookTestInputZ,
    result: WebhookTestResultZ,
  },
  "app.setRemoteAccess": {
    input: AppSetRemoteAccessInputZ,
    result: AppSetRemoteAccessResultZ,
  },
  "daemon.shutdown": {
    input: DaemonShutdownInputZ,
    result: DaemonShutdownResultZ,
  },
  "chat.thread.list": {
    input: ChatThreadListInputZ,
    result: ChatThreadListResultZ,
  },
  "chat.providers.list": {
    input: ChatProvidersListInputZ,
    result: ChatProvidersListResultZ,
  },
  "chat.thread.create": {
    input: ChatThreadCreateInputZ,
    result: ChatThreadCreateResultZ,
  },
  "chat.thread.delete": {
    input: ChatThreadDeleteInputZ,
    result: ChatThreadDeleteResultZ,
  },
  "chat.thread.rename": {
    input: ChatThreadRenameInputZ,
    result: ChatThreadRenameResultZ,
  },
  "chat.thread.setProvider": {
    input: ChatThreadSetProviderInputZ,
    result: ChatThreadSetProviderResultZ,
  },
  "chat.thread.get": {
    input: ChatThreadGetInputZ,
    result: ChatThreadGetResultZ,
  },
  "chat.thread.usage": {
    input: ChatThreadUsageInputZ,
    result: ChatThreadUsageResultZ,
  },
  "chat.session.send": {
    input: ChatSessionSendInputZ,
    result: ChatSessionSendResultZ,
  },
  "chat.session.cancel": {
    input: ChatSessionCancelInputZ,
    result: ChatSessionCancelResultZ,
  },
  "chat.session.editFromTurn": {
    input: ChatSessionEditFromTurnInputZ,
    result: ChatSessionEditFromTurnResultZ,
  },
  "chat.permission.respond": {
    input: ChatPermissionRespondInputZ,
    result: ChatPermissionRespondResultZ,
  },
  "chat.context.captureTerminal": {
    input: ChatContextCaptureTerminalInputZ,
    result: ChatContextCaptureTerminalResultZ,
  },
} as const;

export type ActionName = keyof typeof ActionContractsZ;

export const ACTION_NAMES = Object.keys(ActionContractsZ) as ActionName[];

// ---------------------------------------------------------------------------
// Typed input / result helpers
// ---------------------------------------------------------------------------

export type ActionInput<N extends ActionName> = z.infer<(typeof ActionContractsZ)[N]["input"]>;
export type ActionResult<N extends ActionName> = z.infer<(typeof ActionContractsZ)[N]["result"]>;

// ---------------------------------------------------------------------------
// Wire envelope (what the HTTP endpoint actually returns)
// ---------------------------------------------------------------------------

export interface ActionErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ActionOkEnvelope<R> {
  ok: true;
  result: R;
}

export type ActionResponse<N extends ActionName> =
  | ActionOkEnvelope<ActionResult<N>>
  | ActionErrorEnvelope;

/**
 * Validate that a string is a known action name. Used by the dispatcher to
 * narrow URL params before looking up the handler.
 */
export function isActionName(name: string): name is ActionName {
  return name in ActionContractsZ;
}

/**
 * Helper for a tagged WS broadcast frame so subscribers can decode without
 * special-casing every action name.
 */
export interface ActionCompleteFrame<N extends ActionName = ActionName> {
  type: "action.complete";
  name: N;
  result: ActionResult<N>;
}
