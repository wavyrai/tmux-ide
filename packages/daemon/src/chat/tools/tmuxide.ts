/**
 * `tmuxide.*` chat-tool surface — lets the chat agent introspect and
 * drive tmux-ide itself.
 *
 * Every tool wraps an EXISTING capability rather than inventing a new
 * API:
 *   - Mutating verbs delegate to the v2 action-contract handlers
 *     (`getLooseActionEntry(name).handler`), validating input + output
 *     against the same Zod contract the HTTP dispatcher uses.
 *   - Read introspection delegates to the same services discovery /
 *     task-store / tmux-bridge already expose.
 *   - Pane list/split/send wrap the tmux-bridge helpers.
 *
 * Guardrails (the whole point of this surface):
 *   - Every tool is classified READ | MUTATING | DESTRUCTIVE.
 *   - READ tools execute freely.
 *   - MUTATING tools route through the chat permission flow
 *     (`requestApproval`) so the user approves/denies inline before the
 *     action runs. This includes every dispatch/mission-mutating verb,
 *     so the recursion case (an agent driving the orchestrator that
 *     dispatches agents) is always approval-gated, never automatic.
 *   - DESTRUCTIVE tools (`*.delete`, `project.stop`, `daemon.shutdown`)
 *     are default-DENIED: they refuse without even prompting unless the
 *     surface is constructed with `allowDestructive: true`, and even
 *     then they still route through approval.
 *
 * The permission round-trip itself is reused, not duplicated:
 * {@link makePermissionApprovalRequester} adapts a
 * `PermissionCoordinator.request` into the `requestApproval` callback,
 * mapping an `allow_*` selection to "approved" and anything else
 * (reject / cancel / timeout) to "denied".
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../../acp/index.ts";
import { getLooseActionEntry } from "../../command-center/actions/registry.ts";
import type { ActionName } from "../../command-center/actions/contract.ts";
import { discoverSessions, computeStats } from "../../command-center/discovery.ts";
import type { SessionInfo } from "../../command-center/discovery.ts";
import {
  getSessionCwd,
  splitPane as bridgeSplitPane,
  sendKeys as bridgeSendKeys,
} from "@tmux-ide/tmux-bridge";
import { listSessionPanes } from "../../widgets/lib/pane-comms.ts";
import type { PaneInfo } from "../../widgets/lib/pane-comms.ts";
import { resolvePane } from "../../send.ts";
import { loadMission, loadGoals, loadTasks } from "../../lib/task-store.ts";
import type { Mission, Goal, Task } from "../../lib/task-store.ts";
import type { ChatTool } from "../tool-registry.ts";
import type { ToolResult } from "./tmux.ts";

// ---------------------------------------------------------------------
// Classification + approval contract
// ---------------------------------------------------------------------

export type TmuxideClassification = "read" | "mutating" | "destructive";

export interface TmuxideApprovalRequest {
  /** Fully-qualified tool name, e.g. `tmuxide.task.create`. */
  toolName: string;
  /** Why approval is being asked — `mutating` or `destructive`. */
  classification: Exclude<TmuxideClassification, "read">;
  /** The validated input the action will run with, for the prompt. */
  input: unknown;
}

export interface TmuxideApprovalDecision {
  approved: boolean;
  /** Surfaced to the agent as the tool error when `approved` is false. */
  reason?: string;
}

export type TmuxideApprovalRequester = (
  req: TmuxideApprovalRequest,
) => Promise<TmuxideApprovalDecision>;

// ---------------------------------------------------------------------
// Permission-flow adapter
// ---------------------------------------------------------------------

export interface PermissionApprovalDeps {
  /** Exactly `PermissionCoordinator.request`. */
  request: (threadId: string, req: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  /** The chat thread the tool surface is bound to. */
  threadId: string;
}

/**
 * Adapt the existing chat permission coordinator into a
 * {@link TmuxideApprovalRequester}. The request carries the standard
 * allow/reject option pair the composer already renders; an `allow_*`
 * selection is "approved", reject/cancel/timeout is "denied".
 */
export function makePermissionApprovalRequester(
  deps: PermissionApprovalDeps,
): TmuxideApprovalRequester {
  return async ({ toolName, classification, input }) => {
    const options: PermissionOption[] = [
      { optionId: "allow_once", name: "Approve once", kind: "allow_once" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ];
    const req: RequestPermissionRequest = {
      options,
      sessionId: deps.threadId,
      toolCall: {
        toolCallId: randomUUID(),
        title: `tmux-ide ${classification} action: ${toolName}`,
        kind: "execute",
        rawInput: input,
      },
    };
    const res = await deps.request(deps.threadId, req);
    if (res.outcome.outcome !== "selected") {
      return { approved: false, reason: "Permission request cancelled" };
    }
    const selectedId = res.outcome.optionId;
    const selected = options.find((o) => o.optionId === selectedId);
    if (selected && selected.kind.startsWith("allow")) {
      return { approved: true };
    }
    return { approved: false, reason: "Denied by user" };
  };
}

// ---------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------

export interface CreateTmuxideToolsOptions {
  /** tmux session / project name this surface is scoped to. Used to
   *  pre-fill the action contract's optional scope fields and to scope
   *  read introspection. */
  session: string;
  /** Routes MUTATING + (enabled) DESTRUCTIVE calls through the chat
   *  permission flow. Required — without it there is no inline
   *  approval surface and the surface would be unsafe. */
  requestApproval: TmuxideApprovalRequester;
  /** Opt-in for the DESTRUCTIVE class (`*.delete`, `project.stop`,
   *  `daemon.shutdown`). Default false → those tools refuse without
   *  prompting. */
  allowDestructive?: boolean;
  /** Test seam: override the action runner. Production validates input
   *  + output against the contract and calls the registered handler,
   *  exactly like the HTTP dispatcher. */
  runAction?: (name: ActionName, input: unknown) => Promise<unknown>;
  /** Test seams for the read/tmux services. Production uses the real
   *  implementations. */
  listSessionPanes?: (session: string) => PaneInfo[];
  discoverSessions?: () => SessionInfo[];
  resolveSessionDir?: (session: string) => string;
  loadMission?: (dir: string) => Mission | null;
  loadGoals?: (dir: string) => Goal[];
  loadTasks?: (dir: string) => Task[];
  splitPane?: (target: string, direction: string, cwd: string, percent: number) => string;
  sendKeys?: (target: string, text: string, opts: { enter: boolean }) => void;
  resolvePane?: (panes: PaneInfo[], target: string) => PaneInfo | null;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function zodToJsonSchema(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return { title: name, additionalProperties: false, ...json };
}

async function safe<T>(fn: () => Promise<T> | T): Promise<ToolResult<T>> {
  try {
    return { ok: true, output: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function issuesMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

// ---------------------------------------------------------------------
// Action-backed tools
// ---------------------------------------------------------------------

interface ActionToolSpec {
  /** `tmuxide.*` tool name. */
  tool: string;
  /** Existing v2 action contract verb to delegate to. */
  action: ActionName;
  classification: TmuxideClassification;
  description: string;
}

const ACTION_TOOL_SPECS: ActionToolSpec[] = [
  // ---- task.* ----
  {
    tool: "tmuxide.task.create",
    action: "task.create",
    classification: "mutating",
    description: "Create a task in the bound project's task store.",
  },
  {
    tool: "tmuxide.task.update",
    action: "task.update",
    classification: "mutating",
    description: "Update a task (status, assignment, fields, proof).",
  },
  {
    tool: "tmuxide.task.claim",
    action: "task.claim",
    classification: "mutating",
    description: "Claim a task for an agent and mark it in-progress.",
  },
  {
    tool: "tmuxide.task.done",
    action: "task.done",
    classification: "mutating",
    description: "Mark a task done with optional proof.",
  },
  {
    tool: "tmuxide.task.delete",
    action: "task.delete",
    classification: "destructive",
    description: "Delete a task. Destructive — default-denied unless allowDestructive.",
  },
  // ---- goal.* ----
  {
    tool: "tmuxide.goal.create",
    action: "goal.create",
    classification: "mutating",
    description: "Create a goal.",
  },
  {
    tool: "tmuxide.goal.update",
    action: "goal.update",
    classification: "mutating",
    description: "Update a goal.",
  },
  {
    tool: "tmuxide.goal.done",
    action: "goal.done",
    classification: "mutating",
    description: "Mark a goal done.",
  },
  {
    tool: "tmuxide.goal.delete",
    action: "goal.delete",
    classification: "destructive",
    description: "Delete a goal. Destructive — default-denied unless allowDestructive.",
  },
  // ---- mission.* ----
  {
    tool: "tmuxide.mission.set",
    action: "mission.set",
    classification: "mutating",
    description: "Set the active mission. Mission-mutating — always approval-gated.",
  },
  {
    tool: "tmuxide.mission.clear",
    action: "mission.clear",
    classification: "mutating",
    description: "Clear the active mission. Mission-mutating — always approval-gated.",
  },
  // ---- milestone.* ----
  {
    tool: "tmuxide.milestone.create",
    action: "milestone.create",
    classification: "mutating",
    description: "Create a milestone.",
  },
  {
    tool: "tmuxide.milestone.update",
    action: "milestone.update",
    classification: "mutating",
    description: "Update a milestone's status.",
  },
  // ---- project.* ----
  {
    tool: "tmuxide.project.activate",
    action: "project.activate",
    classification: "mutating",
    description: "Activate (optionally orchestrate) a project.",
  },
  {
    tool: "tmuxide.project.launch",
    action: "project.launch",
    classification: "mutating",
    description: "Launch the project's tmux session (idempotent).",
  },
  {
    tool: "tmuxide.project.restart",
    action: "project.restart",
    classification: "mutating",
    description: "Stop and relaunch the project's tmux session.",
  },
  {
    tool: "tmuxide.project.stop",
    action: "project.stop",
    classification: "destructive",
    description:
      "Kill the project's tmux session. Destructive — default-denied unless allowDestructive.",
  },
  // ---- config.* ----
  {
    tool: "tmuxide.config.set",
    action: "config.set",
    classification: "mutating",
    description: "Set an ide.yml value by dot path.",
  },
  // ---- skill.* ----
  {
    tool: "tmuxide.skill.create",
    action: "skill.create",
    classification: "mutating",
    description: "Create a project skill.",
  },
  {
    tool: "tmuxide.skill.update",
    action: "skill.update",
    classification: "mutating",
    description: "Update a project skill's content.",
  },
  {
    tool: "tmuxide.skill.delete",
    action: "skill.delete",
    classification: "destructive",
    description: "Delete a project skill. Destructive — default-denied unless allowDestructive.",
  },
  // ---- terminal.* ----
  {
    tool: "tmuxide.terminal.respawn",
    action: "terminal.respawn",
    classification: "mutating",
    description: "Respawn a terminal's PTY bridge.",
  },
  {
    tool: "tmuxide.terminal.stop",
    action: "terminal.stop",
    classification: "mutating",
    description: "Stop a terminal's PTY bridge.",
  },
  // ---- validation.* ----
  {
    tool: "tmuxide.validation.assert",
    action: "validation.assert",
    classification: "mutating",
    description: "Set a validation assertion's status.",
  },
  {
    tool: "tmuxide.validation.report",
    action: "validation.report",
    classification: "read",
    description: "Read the validation report (counts by status).",
  },
  // ---- daemon.* ----
  {
    tool: "tmuxide.daemon.shutdown",
    action: "daemon.shutdown",
    classification: "destructive",
    description: "Shut down the daemon. Destructive — default-denied unless allowDestructive.",
  },
];

const SCOPE_KEYS = ["name", "sessionName", "projectName"] as const;

/**
 * Pre-fill the contract's optional scope fields with the bound session
 * so the agent doesn't have to repeat it. Any field the agent supplied
 * wins; the action's own Zod schema strips whichever scope key it
 * doesn't declare, so this never widens the contract.
 */
function injectScope(session: string, input: unknown): unknown {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const withScope: Record<string, unknown> = {};
    for (const k of SCOPE_KEYS) withScope[k] = session;
    return { ...withScope, ...obj };
  }
  return input;
}

interface ToolContext {
  session: string;
  requestApproval: TmuxideApprovalRequester;
  allowDestructive: boolean;
  runAction: (name: ActionName, input: unknown) => Promise<unknown>;
}

async function gate(
  toolName: string,
  classification: TmuxideClassification,
  input: unknown,
  ctx: ToolContext,
): Promise<void> {
  if (classification === "read") return;
  if (classification === "destructive" && !ctx.allowDestructive) {
    throw new Error(
      `Destructive tool "${toolName}" is disabled. It is default-denied; ` +
        "construct the tmux-ide tool surface with allowDestructive to enable it.",
    );
  }
  const decision = await ctx.requestApproval({ toolName, classification, input });
  if (!decision.approved) {
    throw new Error(decision.reason ?? "Denied by user");
  }
}

function buildActionTool(spec: ActionToolSpec, ctx: ToolContext): ChatTool {
  const entry = getLooseActionEntry(spec.action);
  const inputSchema = entry.inputSchema as z.ZodTypeAny;
  return {
    name: spec.tool,
    description: spec.description,
    inputSchema: inputSchema as z.ZodType<unknown>,
    jsonSchema: zodToJsonSchema(inputSchema, spec.tool),
    async handler(input: unknown) {
      return safe(async () => {
        const parsed = inputSchema.safeParse(injectScope(ctx.session, input));
        if (!parsed.success) {
          throw new Error(`Invalid input: ${issuesMessage(parsed.error)}`);
        }
        await gate(spec.tool, spec.classification, parsed.data, ctx);
        return ctx.runAction(spec.action, parsed.data);
      });
    },
  };
}

function defaultRunAction(name: ActionName, input: unknown): Promise<unknown> {
  const entry = getLooseActionEntry(name);
  return Promise.resolve(entry.handler(input)).then((result) => {
    const out = entry.resultSchema.safeParse(result);
    if (!out.success) {
      throw new Error(`Handler returned an invalid result for ${name}`);
    }
    return out.data;
  });
}

// ---------------------------------------------------------------------
// Custom read + tmux tools (no action contract verb exists for these)
// ---------------------------------------------------------------------

const EmptyInputZ = z.object({}).describe("No input.");
const TaskListInputZ = z.object({
  status: z.enum(["todo", "in-progress", "review", "done"]).optional(),
  goalId: z.string().min(1).optional(),
});
const PaneSplitInputZ = z.object({
  target: z
    .string()
    .min(1)
    .optional()
    .describe("Pane to split from (id/title/role). Defaults to the active pane."),
  direction: z.enum(["vertical", "horizontal"]).optional(),
  percent: z.number().int().min(5).max(95).optional(),
});
const PaneSendInputZ = z.object({
  target: z.string().min(1).describe("Pane target: id (%N), @ide name, title, or role."),
  text: z.string().describe("Literal text to type into the pane."),
  enter: z.boolean().optional().describe("Append Enter after the text. Defaults to true."),
});

function buildCustomTools(
  ctx: ToolContext,
  deps: {
    listSessionPanes: (session: string) => PaneInfo[];
    discoverSessions: () => SessionInfo[];
    resolveSessionDir: (session: string) => string;
    loadMission: (dir: string) => Mission | null;
    loadGoals: (dir: string) => Goal[];
    loadTasks: (dir: string) => Task[];
    splitPane: (target: string, direction: string, cwd: string, percent: number) => string;
    sendKeys: (target: string, text: string, opts: { enter: boolean }) => void;
    resolvePane: (panes: PaneInfo[], target: string) => PaneInfo | null;
  },
): ChatTool[] {
  const dirFor = () => {
    const dir = deps.resolveSessionDir(ctx.session);
    if (!dir) throw new Error(`Cannot resolve a directory for session "${ctx.session}"`);
    return dir;
  };
  const resolveTargetPane = (target: string): PaneInfo => {
    const panes = deps.listSessionPanes(ctx.session);
    if (panes.length === 0) {
      throw new Error(`tmux session "${ctx.session}" has no panes (is it running?)`);
    }
    const pane = deps.resolvePane(panes, target);
    if (!pane) {
      const available = panes.map((p) => `${p.id} ${p.name ?? p.title}`).join(", ");
      throw new Error(`Pane "${target}" not found. Available: ${available}`);
    }
    return pane;
  };

  const tool = (
    name: string,
    description: string,
    schema: z.ZodTypeAny,
    classification: TmuxideClassification,
    run: (input: unknown) => unknown,
  ): ChatTool => ({
    name,
    description,
    inputSchema: schema as z.ZodType<unknown>,
    jsonSchema: zodToJsonSchema(schema, name),
    async handler(input: unknown) {
      return safe(async () => {
        const parsed = schema.safeParse(input ?? {});
        if (!parsed.success) {
          throw new Error(`Invalid input: ${issuesMessage(parsed.error)}`);
        }
        await gate(name, classification, parsed.data, ctx);
        return run(parsed.data);
      });
    },
  });

  return [
    tool(
      "tmuxide.pane.list",
      "List the panes in the bound tmux session (id, title, role, command).",
      EmptyInputZ,
      "read",
      () => ({ session: ctx.session, panes: deps.listSessionPanes(ctx.session) }),
    ),
    tool(
      "tmuxide.session.list",
      "List discoverable tmux-ide sessions with a one-line summary each.",
      EmptyInputZ,
      "read",
      () => ({
        sessions: deps.discoverSessions().map((s) => ({
          name: s.name,
          dir: s.dir,
          mission: s.mission?.title ?? null,
          goals: s.goals.length,
          tasks: s.tasks.length,
          panes: s.panes.length,
        })),
      }),
    ),
    tool(
      "tmuxide.orchestrator.status",
      "Orchestrator status for the bound session: mission, goal/task/agent stats, panes.",
      EmptyInputZ,
      "read",
      () => {
        const info = deps.discoverSessions().find((s) => s.name === ctx.session);
        if (!info) return { session: ctx.session, running: false };
        return {
          session: ctx.session,
          running: true,
          mission: info.mission,
          stats: computeStats(info),
          goals: info.goals.map((g) => ({ id: g.id, title: g.title, status: g.status })),
          paneCount: info.panes.length,
        };
      },
    ),
    tool(
      "tmuxide.mission.show",
      "Show the bound project's current mission (or null).",
      EmptyInputZ,
      "read",
      () => ({ mission: deps.loadMission(dirFor()) }),
    ),
    tool("tmuxide.goal.list", "List the bound project's goals.", EmptyInputZ, "read", () => ({
      goals: deps.loadGoals(dirFor()),
    })),
    tool(
      "tmuxide.task.list",
      "List the bound project's tasks, optionally filtered by status and/or goal.",
      TaskListInputZ,
      "read",
      (input) => {
        const { status, goalId } = input as z.infer<typeof TaskListInputZ>;
        let tasks = deps.loadTasks(dirFor());
        if (status) tasks = tasks.filter((t) => t.status === status);
        if (goalId) tasks = tasks.filter((t) => t.goal === goalId);
        return { tasks };
      },
    ),
    tool(
      "tmuxide.pane.split",
      "Split a new pane in the bound session (never kills an existing pane).",
      PaneSplitInputZ,
      "mutating",
      (input) => {
        const { target, direction, percent } = input as z.infer<typeof PaneSplitInputZ>;
        const panes = deps.listSessionPanes(ctx.session);
        if (panes.length === 0) {
          throw new Error(`tmux session "${ctx.session}" has no panes (is it running?)`);
        }
        const base = target
          ? resolveTargetPane(target)
          : (panes.find((p) => p.active) ?? panes[0]!);
        const newPaneId = deps.splitPane(base.id, direction ?? "vertical", dirFor(), percent ?? 50);
        return { fromPaneId: base.id, paneId: newPaneId };
      },
    ),
    tool(
      "tmuxide.pane.send",
      "Send literal text to a pane in the bound session (Enter appended unless enter:false).",
      PaneSendInputZ,
      "mutating",
      (input) => {
        const { target, text, enter } = input as z.infer<typeof PaneSendInputZ>;
        const pane = resolveTargetPane(target);
        const withEnter = enter ?? true;
        deps.sendKeys(pane.id, text, { enter: withEnter });
        return {
          paneId: pane.id,
          title: pane.title,
          bytes: Buffer.byteLength(text, "utf8"),
          enter: withEnter,
        };
      },
    ),
  ];
}

// ---------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------

function defaultResolveSessionDir(session: string): string {
  try {
    const match = discoverSessions().find((s) => s.name === session);
    if (match?.dir) return match.dir;
  } catch {
    // discovery may throw if no tmux server — fall through.
  }
  return getSessionCwd(session) || "";
}

/**
 * Build the `tmuxide.*` tool set. Returns a name→tool record so the
 * registry can spread the values in alongside the other suites.
 */
export function createTmuxideTools(opts: CreateTmuxideToolsOptions): Record<string, ChatTool> {
  const ctx: ToolContext = {
    session: opts.session,
    requestApproval: opts.requestApproval,
    allowDestructive: opts.allowDestructive ?? false,
    runAction: opts.runAction ?? defaultRunAction,
  };

  const tools: ChatTool[] = ACTION_TOOL_SPECS.map((spec) => buildActionTool(spec, ctx));
  tools.push(
    ...buildCustomTools(ctx, {
      listSessionPanes: opts.listSessionPanes ?? listSessionPanes,
      discoverSessions: opts.discoverSessions ?? discoverSessions,
      resolveSessionDir: opts.resolveSessionDir ?? defaultResolveSessionDir,
      loadMission: opts.loadMission ?? loadMission,
      loadGoals: opts.loadGoals ?? loadGoals,
      loadTasks: opts.loadTasks ?? loadTasks,
      splitPane: opts.splitPane ?? bridgeSplitPane,
      sendKeys:
        opts.sendKeys ?? ((target, text, o) => bridgeSendKeys(target, text, { enter: o.enter })),
      resolvePane: opts.resolvePane ?? resolvePane,
    }),
  );

  const map: Record<string, ChatTool> = {};
  for (const t of tools) {
    if (map[t.name]) throw new Error(`Duplicate tmuxide tool: ${t.name}`);
    map[t.name] = t;
  }
  return map;
}
