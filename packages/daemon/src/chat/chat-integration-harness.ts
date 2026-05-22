/**
 * Chat integration harness.
 *
 * Wires the chat subsystem's primitive stores + a temp git repo + mocked
 * tmux/provider backends into one bundle so integration tests can drive
 * end-to-end scenarios without standing up an HTTP server.
 *
 * Modeled after t3code's orchestrationEngine integration test harness:
 * a single `createHarness()` returns the wired bundle, helper methods
 * to advance the chat through realistic transitions, and an event bus
 * that captures every emission for assertions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CheckpointFile,
  CheckpointStatus,
  CheckpointSummary,
  LatestTurnState,
  ProposedPlan,
  Session,
  SessionRole,
  SourceProposedPlanReference,
  ThreadActivity,
  ThreadActivityTone,
} from "@tmux-ide/contracts";
import { makeActivityLog, type ActivityLog } from "./activity-log.ts";
import {
  makeCheckpointEngine,
  CheckpointEngineError,
  type CheckpointEngine,
  type CheckpointSnapshot,
} from "./checkpoint-engine.ts";
import { makeCheckpointStore, type CheckpointStore } from "./checkpoint-store.ts";
import { makeSessionStore, type SessionStore } from "./session-store.ts";
import { makeThreadStore, type ThreadStore } from "./thread-store.ts";
import { makeTurnStore, type TurnStore } from "./turn-store.ts";
import { createTmuxTools, type TmuxTool } from "./tools/tmux.ts";
import type { ChatEvent } from "./types.ts";
import type { PaneInfo } from "../widgets/lib/pane-comms.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/**
 * Bus events the harness records. The first three mirror the production
 * `ChatEvent` union; the remainder are integration-only events that model
 * the next-generation surface (turn lifecycle, activity log, plans,
 * checkpoints) before those wires are extruded onto the live event bus.
 */
export type HarnessEvent =
  | ChatEvent
  | {
      type: "turn.started";
      threadId: string;
      turnId: string;
      requestedAt: string;
      sessionId?: string;
      sourceProposedPlan?: SourceProposedPlanReference;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId: string;
      sessionId?: string;
      assistantMessageId: string | null;
      completedAt: string;
    }
  | {
      type: "turn.aborted";
      threadId: string;
      turnId: string;
      reason: string;
      sessionId?: string;
      state: LatestTurnState;
    }
  | {
      type: "activity.appended";
      threadId: string;
      activity: ThreadActivity;
    }
  | {
      type: "session.added";
      threadId: string;
      session: Session;
    }
  | {
      type: "session.removed";
      threadId: string;
      sessionId: string;
    }
  | {
      type: "plan.upserted";
      threadId: string;
      plan: ProposedPlan;
    }
  | {
      type: "plan.approved";
      threadId: string;
      plan: ProposedPlan;
      childTurnId: string;
    }
  | {
      type: "plan.rejected";
      threadId: string;
      plan: ProposedPlan;
    }
  | {
      type: "checkpoint.upserted";
      threadId: string;
      summary: CheckpointSummary;
    }
  | {
      type: "checkpoint.reverted";
      threadId: string;
      turnId: string;
      checkpointRef: string;
    }
  | {
      type: "tool.invoked";
      threadId: string;
      turnId: string | null;
      tool: string;
      input: unknown;
      ok: boolean;
      error?: string;
    };

export type EventType = HarnessEvent["type"];

// ---------------------------------------------------------------------------
// Fake clock / id generator
// ---------------------------------------------------------------------------

interface FakeClock {
  now(): Date;
  iso(): string;
  advance(ms: number): void;
  set(date: Date): void;
}

function createFakeClock(startIso = "2026-01-01T00:00:00.000Z"): FakeClock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current.getTime()),
    iso: () => new Date(current.getTime()).toISOString(),
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    set(date) {
      current = new Date(date.getTime());
    },
  };
}

interface DeterministicId {
  next(prefix: string): string;
}

function createDeterministicId(): DeterministicId {
  const counters = new Map<string, number>();
  return {
    next(prefix: string): string {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${String(n).padStart(4, "0")}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock provider adapter
// ---------------------------------------------------------------------------

export interface ScriptedActivity {
  tone: ThreadActivityTone;
  kind: string;
  summary: string;
  payload?: unknown;
  /** Optional delay applied before emitting (in fake-clock ms). */
  delayMs?: number;
}

export interface ScriptedTurnResponse {
  activities: ScriptedActivity[];
  /** Final assistant message id to record on the turn. Omit for abort. */
  assistantMessageId?: string;
  /** Optional plan to upsert during the turn. */
  proposedPlan?: { id?: string; planMarkdown: string };
  /** If set, the response throws instead of completing the turn. */
  abortReason?: string;
}

export interface MockProvider {
  /**
   * Push a scripted response keyed by prompt text. The first matching
   * prompt consumes the response.
   */
  scriptPrompt(matcher: string | RegExp, response: ScriptedTurnResponse): void;
  invocations(): ReadonlyArray<{ prompt: string; turnId: string }>;
}

interface ProviderScript {
  matcher: string | RegExp;
  response: ScriptedTurnResponse;
}

// ---------------------------------------------------------------------------
// Mock tmux backend
// ---------------------------------------------------------------------------

export interface MockTmuxBackend {
  setPanes(panes: PaneInfo[]): void;
  setPaneContent(paneId: string, content: string): void;
  sendCalls(): ReadonlyArray<{ target: string; text: string; enter: boolean }>;
  captureCalls(): ReadonlyArray<{ target: string; mode: "recent" | "scrollback"; arg: number }>;
}

interface MockTmuxState {
  panes: PaneInfo[];
  paneContent: Map<string, string>;
  sends: Array<{ target: string; text: string; enter: boolean }>;
  captures: Array<{ target: string; mode: "recent" | "scrollback"; arg: number }>;
}

function createMockTmuxBackend(initial: PaneInfo[] = []): {
  state: MockTmuxState;
  api: MockTmuxBackend;
  tools: ReturnType<typeof createTmuxTools>;
} {
  const state: MockTmuxState = {
    panes: initial.slice(),
    paneContent: new Map<string, string>(),
    sends: [],
    captures: [],
  };
  const tools = createTmuxTools("integration-session", {
    listPanes: () => state.panes,
    sendKeys: (target, text, opts) => {
      state.sends.push({ target, text, enter: opts.enter });
    },
    captureRecent: (target, lines) => {
      state.captures.push({ target, mode: "recent", arg: lines });
      return state.paneContent.get(target) ?? "";
    },
    capturePane: (target, opts) => {
      state.captures.push({ target, mode: "scrollback", arg: opts.scrollback });
      return state.paneContent.get(target) ?? "";
    },
  });
  return {
    state,
    tools,
    api: {
      setPanes(panes) {
        state.panes = panes.slice();
      },
      setPaneContent(paneId, content) {
        state.paneContent.set(paneId, content);
      },
      sendCalls: () => state.sends.slice(),
      captureCalls: () => state.captures.slice(),
    },
  };
}

// ---------------------------------------------------------------------------
// Plan store (in-memory)
// ---------------------------------------------------------------------------

export interface PlanStore {
  upsert(threadId: string, plan: ProposedPlan): ProposedPlan;
  get(threadId: string, planId: string): ProposedPlan | null;
  list(threadId: string): ProposedPlan[];
  markImplemented(threadId: string, planId: string, implementationThreadId: string): ProposedPlan;
  markRejected(threadId: string, planId: string, opts?: { reason?: string }): ProposedPlan;
}

function makePlanStore(): PlanStore {
  const byThread = new Map<string, Map<string, ProposedPlan>>();
  function bucket(threadId: string): Map<string, ProposedPlan> {
    let b = byThread.get(threadId);
    if (!b) {
      b = new Map();
      byThread.set(threadId, b);
    }
    return b;
  }
  return {
    upsert(threadId, plan) {
      bucket(threadId).set(plan.id, plan);
      return plan;
    },
    get(threadId, planId) {
      return byThread.get(threadId)?.get(planId) ?? null;
    },
    list(threadId) {
      const b = byThread.get(threadId);
      return b ? [...b.values()] : [];
    },
    markImplemented(threadId, planId, implementationThreadId) {
      const b = bucket(threadId);
      const existing = b.get(planId);
      if (!existing) {
        throw new Error(`Plan ${planId} not found on thread ${threadId}`);
      }
      const next: ProposedPlan = {
        ...existing,
        implementedAt: new Date().toISOString(),
        implementationThreadId,
        updatedAt: new Date().toISOString(),
      };
      b.set(planId, next);
      return next;
    },
    markRejected(threadId, planId, opts) {
      const b = bucket(threadId);
      const existing = b.get(planId);
      if (!existing) {
        throw new Error(`Plan ${planId} not found on thread ${threadId}`);
      }
      const at = new Date().toISOString();
      const rejection: NonNullable<ProposedPlan["rejected"]> =
        opts?.reason !== undefined ? { at, reason: opts.reason } : { at };
      const next: ProposedPlan = {
        ...existing,
        rejected: rejection,
        updatedAt: at,
      };
      b.set(planId, next);
      return next;
    },
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Harness",
  GIT_AUTHOR_EMAIL: "harness@example.com",
  GIT_COMMITTER_NAME: "Harness",
  GIT_COMMITTER_EMAIL: "harness@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  return stdout;
}

async function initGitWorkspace(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "chat-harness-git-"));
  await git(dir, "init", "--quiet", "--initial-branch=main");
  await git(dir, "config", "user.email", "harness@example.com");
  await git(dir, "config", "user.name", "Harness");
  await git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# harness\n");
  await git(dir, "add", "README.md");
  await git(dir, "commit", "--quiet", "-m", "initial");
  writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
  await git(dir, "add", "src.ts");
  await git(dir, "commit", "--quiet", "-m", "src");
  return dir;
}

// ---------------------------------------------------------------------------
// Harness shape
// ---------------------------------------------------------------------------

export interface ChatIntegrationHarness {
  // workspace dirs
  readonly persistenceDir: string;
  readonly workspaceDir: string;

  // stores
  readonly threadStore: ThreadStore;
  readonly turnStore: TurnStore;
  readonly sessionStore: SessionStore;
  readonly activityLog: ActivityLog;
  readonly checkpointStore: CheckpointStore;
  readonly checkpointEngine: CheckpointEngine;
  readonly planStore: PlanStore;

  // mocks / adapters
  readonly tmux: MockTmuxBackend;
  readonly tools: {
    send_to_pane: TmuxTool<unknown, unknown>;
    read_pane: TmuxTool<unknown, unknown>;
    capture_pane: TmuxTool<unknown, unknown>;
  };
  readonly provider: MockProvider;
  readonly bus: HarnessEventBus;
  readonly clock: FakeClock;

  // workflow helpers
  createThread(input?: Partial<CreateThreadInput>): Promise<HarnessThread>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  startTurn(input: StartTurnInput): Promise<HarnessTurn>;
  appendActivity(input: AppendActivityInput): ThreadActivity;
  invokeTool(input: InvokeToolInput): Promise<InvokeToolResult>;
  upsertPlan(threadId: string, input: { id?: string; planMarkdown: string }): ProposedPlan;
  approvePlan(input: { threadId: string; planId: string }): Promise<{
    childTurn: HarnessTurn;
    plan: ProposedPlan;
  }>;
  rejectPlan(input: { threadId: string; planId: string; reason?: string }): ProposedPlan;
  snapshotCheckpoint(input: { threadId: string; turnId: string }): Promise<CheckpointSummary>;
  revertCheckpoint(input: { threadId: string; turnId: string }): Promise<{
    summary: CheckpointSummary;
    refreshedStatus: CheckpointStatus;
  }>;
  completeTurn(input: {
    threadId: string;
    turnId: string;
    assistantMessageId?: string;
  }): Promise<HarnessTurn>;
  abortTurn(input: { threadId: string; turnId: string; reason: string }): Promise<HarnessTurn>;
  runScriptedTurn(input: {
    threadId: string;
    prompt: string;
    sessionId?: string;
    sourceProposedPlan?: SourceProposedPlanReference;
  }): Promise<HarnessTurn>;
  /** Multi-agent (T078): register a new Session on a Thread. */
  addSession(input: AddSessionInput): Session;
  /** Multi-agent (T078): drop a Session and (optionally) clean up any in-flight turn it owned. */
  removeSession(input: {
    threadId: string;
    sessionId: string;
    abortInFlightTurn?: boolean;
  }): Session | null;
  serialize(): HarnessSerialized;
  hydrateFrom(snapshot: HarnessSerialized): void;

  // teardown
  dispose(): Promise<void>;
}

export interface HarnessEventBus {
  emit(event: HarnessEvent): void;
  events(): readonly HarnessEvent[];
  ofType<T extends EventType>(type: T): ReadonlyArray<Extract<HarnessEvent, { type: T }>>;
  clear(): void;
  waitFor<T extends EventType>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<HarnessEvent, { type: T }>>;
}

export interface CreateThreadInput {
  title: string;
  provider: { kind: "claude-code" } | { kind: "codex" };
  projectDir?: string;
}

export interface HarnessThread {
  id: string;
  title: string;
  provider: { kind: string };
}

export interface StartTurnInput {
  threadId: string;
  turnId?: string;
  /** Multi-agent (T078): the owning Session. Optional for single-session compat. */
  sessionId?: string;
  sourceProposedPlan?: SourceProposedPlanReference;
}

export interface HarnessTurn {
  threadId: string;
  turnId: string;
  state: LatestTurnState;
  sessionId?: string;
}

export interface AppendActivityInput {
  threadId: string;
  turnId: string | null;
  tone: ThreadActivityTone;
  kind: string;
  summary: string;
  payload?: unknown;
  /** Multi-agent (T078): the producing Session. Optional. */
  sessionId?: string;
}

export interface AddSessionInput {
  threadId: string;
  id?: string;
  provider?: { kind: "claude-code" } | { kind: "codex" };
  role?: SessionRole;
  displayName?: string;
}

export interface InvokeToolInput {
  threadId: string;
  turnId: string | null;
  tool: "send_to_pane" | "read_pane" | "capture_pane";
  input: Record<string, unknown>;
  needsApproval?: boolean;
}

export type InvokeToolResult =
  | {
      ok: true;
      output: unknown;
      approvalActivity?: ThreadActivity;
      toolActivity: ThreadActivity;
    }
  | {
      ok: false;
      error: string;
      approvalActivity?: ThreadActivity;
      toolActivity: ThreadActivity;
    };

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface HarnessSerialized {
  schemaVersion: 1;
  threads: Array<{ id: string; title: string; createdAt: string; updatedAt: string }>;
  turns: Array<{
    threadId: string;
    turnId: string;
    state: LatestTurnState;
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    assistantMessageId: string | null;
  }>;
  activities: Array<{ threadId: string; activity: ThreadActivity }>;
  plans: Array<{ threadId: string; plan: ProposedPlan }>;
  checkpoints: Array<{ threadId: string; summary: CheckpointSummary }>;
}

// ---------------------------------------------------------------------------
// Harness implementation
// ---------------------------------------------------------------------------

export interface CreateHarnessOptions {
  panes?: PaneInfo[];
  startIso?: string;
}

export async function createHarness(
  opts: CreateHarnessOptions = {},
): Promise<ChatIntegrationHarness> {
  const persistenceDir = mkdtempSync(join(tmpdir(), "chat-harness-store-"));
  const workspaceDir = await initGitWorkspace();
  const clock = createFakeClock(opts.startIso);
  const ids = createDeterministicId();

  const threadStore = makeThreadStore({
    rootDir: persistenceDir,
    now: () => clock.now(),
    randomId: () => ids.next("thr"),
  });
  const turnStore = makeTurnStore();
  const activityLog = makeActivityLog({
    now: () => clock.now(),
    randomId: () => ids.next("evt"),
  });
  const checkpointStore = makeCheckpointStore();
  const checkpointEngine = makeCheckpointEngine();
  const planStore = makePlanStore();
  const sessionStore = makeSessionStore({
    now: () => clock.now(),
    randomId: () => ids.next("sess"),
  });

  const tmuxSetup = createMockTmuxBackend(opts.panes ?? defaultPanes());

  const bus = createEventBus();

  const scripts: ProviderScript[] = [];
  const providerInvocations: Array<{ prompt: string; turnId: string }> = [];
  const provider: MockProvider = {
    scriptPrompt(matcher, response) {
      scripts.push({ matcher, response });
    },
    invocations: () => providerInvocations.slice(),
  };

  function consumeScript(prompt: string): ScriptedTurnResponse | null {
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i]!;
      const ok =
        typeof script.matcher === "string"
          ? prompt.includes(script.matcher)
          : script.matcher.test(prompt);
      if (ok) {
        scripts.splice(i, 1);
        return script.response;
      }
    }
    return null;
  }

  async function createThread(input: Partial<CreateThreadInput> = {}): Promise<HarnessThread> {
    const state = await threadStore.create({
      provider: input.provider ?? { kind: "claude-code" },
      projectDir: input.projectDir ?? workspaceDir,
      title: input.title ?? "Integration",
    });
    bus.emit({ type: "chat.thread.index", threads: await threadStore.list() });
    return { id: state.id, title: state.title, provider: state.provider };
  }

  async function archiveThread(threadId: string): Promise<void> {
    // We don't have an archive field on the legacy store; emit a synthetic
    // index event with a tag so subscribers can observe "archive" intent.
    const list = await threadStore.list();
    bus.emit({
      type: "chat.thread.index",
      threads: list.map((entry) =>
        entry.id === threadId ? { ...entry, title: `[archived] ${entry.title}` } : entry,
      ),
    });
  }

  async function deleteThread(threadId: string): Promise<void> {
    await threadStore.delete(threadId);
    turnStore.clear(threadId);
    activityLog.clear(threadId);
    checkpointStore.clear(threadId);
    sessionStore.clear(threadId);
    bus.emit({ type: "chat.thread.index", threads: await threadStore.list() });
  }

  async function startTurn(input: StartTurnInput): Promise<HarnessTurn> {
    const turnId = input.turnId ?? ids.next("turn");
    const requestedAt = clock.iso();
    turnStore.start({
      threadId: input.threadId,
      turnId,
      requestedAt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      sourceProposedPlan: input.sourceProposedPlan,
    });
    if (input.sessionId) {
      try {
        sessionStore.updateStatus({
          threadId: input.threadId,
          sessionId: input.sessionId,
          status: "running",
          activeTurnId: turnId,
        });
      } catch {
        // session may not be in the store (test fixtures); ignore.
      }
    }
    bus.emit({
      type: "turn.started",
      threadId: input.threadId,
      turnId,
      requestedAt,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.sourceProposedPlan ? { sourceProposedPlan: input.sourceProposedPlan } : {}),
    });
    return {
      threadId: input.threadId,
      turnId,
      state: "running",
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
  }

  function appendActivity(input: AppendActivityInput): ThreadActivity {
    const activity = activityLog.append({
      threadId: input.threadId,
      tone: input.tone,
      kind: input.kind,
      summary: input.summary,
      payload: input.payload,
      turnId: input.turnId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    bus.emit({ type: "activity.appended", threadId: input.threadId, activity });
    return activity;
  }

  function addSession(input: AddSessionInput): Session {
    const session = sessionStore.add({
      threadId: input.threadId,
      ...(input.id ? { id: input.id } : {}),
      providerName: input.provider?.kind ?? "claude-code",
      ...(input.role ? { role: input.role } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    bus.emit({ type: "session.added", threadId: input.threadId, session });
    return session;
  }

  function removeSession(input: {
    threadId: string;
    sessionId: string;
    abortInFlightTurn?: boolean;
  }): Session | null {
    if (input.abortInFlightTurn) {
      const latest = turnStore.latestForSession(input.threadId, input.sessionId);
      if (latest && latest.state === "running") {
        turnStore.transition({
          threadId: input.threadId,
          turnId: latest.turnId,
          state: "interrupted",
        });
        bus.emit({
          type: "turn.aborted",
          threadId: input.threadId,
          turnId: latest.turnId,
          reason: "session-removed",
          sessionId: input.sessionId,
          state: "interrupted",
        });
      }
    }
    const removed = sessionStore.remove(input.threadId, input.sessionId);
    if (removed) {
      bus.emit({
        type: "session.removed",
        threadId: input.threadId,
        sessionId: input.sessionId,
      });
    }
    return removed;
  }

  async function invokeTool(input: InvokeToolInput): Promise<InvokeToolResult> {
    let approvalActivity: ThreadActivity | undefined;
    if (input.needsApproval) {
      approvalActivity = appendActivity({
        threadId: input.threadId,
        turnId: input.turnId,
        tone: "approval",
        kind: "tool.approval.request",
        summary: `Approve ${input.tool}?`,
        payload: { tool: input.tool, input: input.input },
      });
    }
    const tool = tmuxSetup.tools[input.tool];
    const result = (await tool.handler(input.input as never)) as
      | { ok: true; output: unknown }
      | { ok: false; error: string };
    const toolActivity = appendActivity({
      threadId: input.threadId,
      turnId: input.turnId,
      tone: result.ok ? "tool" : "error",
      kind: `tool.${input.tool}`,
      summary: result.ok ? `Ran ${input.tool}` : `Tool ${input.tool} failed`,
      payload: { tool: input.tool, input: input.input, result },
    });
    bus.emit({
      type: "tool.invoked",
      threadId: input.threadId,
      turnId: input.turnId,
      tool: input.tool,
      input: input.input,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
    });
    if (result.ok) {
      return { ok: true, output: result.output, toolActivity, approvalActivity };
    }
    return { ok: false, error: result.error, toolActivity, approvalActivity };
  }

  function upsertPlan(
    threadId: string,
    input: { id?: string; planMarkdown: string },
  ): ProposedPlan {
    const plan: ProposedPlan = {
      id: input.id ?? ids.next("plan"),
      turnId: turnStore.latest(threadId)?.turnId ?? null,
      planMarkdown: input.planMarkdown,
      implementedAt: null,
      implementationThreadId: null,
      createdAt: clock.iso(),
      updatedAt: clock.iso(),
    };
    planStore.upsert(threadId, plan);
    bus.emit({ type: "plan.upserted", threadId, plan });
    appendActivity({
      threadId,
      turnId: plan.turnId,
      tone: "info",
      kind: "plan.upserted",
      summary: `Proposed plan ${plan.id}`,
      payload: plan,
    });
    return plan;
  }

  async function approvePlan(input: {
    threadId: string;
    planId: string;
  }): Promise<{ childTurn: HarnessTurn; plan: ProposedPlan }> {
    const original = planStore.get(input.threadId, input.planId);
    if (!original) throw new Error(`Plan ${input.planId} not found`);
    if (original.implementedAt) {
      throw new Error(`Plan ${input.planId} is already implemented`);
    }
    if (original.rejected) {
      throw new Error(`Plan ${input.planId} is already rejected`);
    }
    const latest = turnStore.latest(input.threadId);
    if (latest && latest.state === "running") {
      throw new Error(`conflict: a turn is already running on thread ${input.threadId}`);
    }
    const childTurn = await startTurn({
      threadId: input.threadId,
      sourceProposedPlan: { threadId: input.threadId, planId: input.planId },
    });
    const stamped = planStore.markImplemented(input.threadId, input.planId, input.threadId);
    // Re-emit plan.upserted with the implementation metadata so serialize()
    // reflects the post-approval state. (Approval also emits its own event.)
    bus.emit({ type: "plan.upserted", threadId: input.threadId, plan: stamped });
    bus.emit({
      type: "plan.approved",
      threadId: input.threadId,
      plan: stamped,
      childTurnId: childTurn.turnId,
    });
    return { childTurn, plan: stamped };
  }

  function rejectPlan(input: { threadId: string; planId: string; reason?: string }): ProposedPlan {
    const original = planStore.get(input.threadId, input.planId);
    if (!original) throw new Error(`Plan ${input.planId} not found`);
    if (original.implementedAt) {
      throw new Error(`Plan ${input.planId} is already implemented`);
    }
    if (original.rejected) {
      throw new Error(`Plan ${input.planId} is already rejected`);
    }
    const stamped = planStore.markRejected(input.threadId, input.planId, {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    bus.emit({ type: "plan.upserted", threadId: input.threadId, plan: stamped });
    bus.emit({ type: "plan.rejected", threadId: input.threadId, plan: stamped });
    appendActivity({
      threadId: input.threadId,
      turnId: stamped.turnId,
      tone: "info",
      kind: "plan.rejected",
      summary: `Rejected plan ${stamped.id}`,
      payload: stamped,
    });
    return stamped;
  }

  let checkpointTurnCount = 0;
  async function snapshotCheckpoint(input: {
    threadId: string;
    turnId: string;
  }): Promise<CheckpointSummary> {
    let snapshot: CheckpointSnapshot;
    try {
      snapshot = await checkpointEngine.snapshot({
        threadId: input.threadId,
        turnId: input.turnId,
        workspaceDir,
      });
    } catch (err) {
      if (err instanceof CheckpointEngineError) {
        const summary: CheckpointSummary = {
          turnId: input.turnId,
          checkpointTurnCount: ++checkpointTurnCount,
          checkpointRef: "",
          status: "error",
          files: [],
          assistantMessageId: null,
          completedAt: clock.iso(),
        };
        checkpointStore.upsert(input.threadId, summary);
        bus.emit({ type: "checkpoint.upserted", threadId: input.threadId, summary });
        return summary;
      }
      throw err;
    }
    const summary: CheckpointSummary = {
      turnId: input.turnId,
      checkpointTurnCount: ++checkpointTurnCount,
      checkpointRef: snapshot.refName,
      status: "ready",
      files: snapshot.files,
      assistantMessageId: null,
      completedAt: clock.iso(),
    };
    checkpointStore.upsert(input.threadId, summary);
    bus.emit({ type: "checkpoint.upserted", threadId: input.threadId, summary });
    return summary;
  }

  async function revertCheckpoint(input: {
    threadId: string;
    turnId: string;
  }): Promise<{ summary: CheckpointSummary; refreshedStatus: CheckpointStatus }> {
    const summary = checkpointStore.get(input.threadId, input.turnId);
    if (!summary) {
      throw new Error(`No checkpoint for thread=${input.threadId} turn=${input.turnId}`);
    }
    await checkpointEngine.revert({
      checkpointRef: summary.checkpointRef,
      workspaceDir,
    });
    const refreshedStatus = await checkpointEngine.status({
      checkpointRef: summary.checkpointRef,
      workspaceDir,
    });
    bus.emit({
      type: "checkpoint.reverted",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointRef: summary.checkpointRef,
    });
    appendActivity({
      threadId: input.threadId,
      turnId: input.turnId,
      tone: "info",
      kind: "checkpoint.reverted",
      summary: `Reverted to ${summary.checkpointRef}`,
      payload: summary,
    });
    return { summary, refreshedStatus };
  }

  async function completeTurn(input: {
    threadId: string;
    turnId: string;
    assistantMessageId?: string;
  }): Promise<HarnessTurn> {
    const completedAt = clock.iso();
    const record = turnStore.transition({
      threadId: input.threadId,
      turnId: input.turnId,
      state: "completed",
      assistantMessageId: input.assistantMessageId ?? null,
      completedAt,
    });
    if (record.sessionId && sessionStore.get(input.threadId, record.sessionId)) {
      sessionStore.updateStatus({
        threadId: input.threadId,
        sessionId: record.sessionId,
        status: "ready",
        activeTurnId: null,
      });
    }
    bus.emit({
      type: "turn.completed",
      threadId: input.threadId,
      turnId: input.turnId,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      assistantMessageId: record.assistantMessageId,
      completedAt,
    });
    return {
      threadId: input.threadId,
      turnId: input.turnId,
      state: record.state,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
  }

  async function abortTurn(input: {
    threadId: string;
    turnId: string;
    reason: string;
  }): Promise<HarnessTurn> {
    const record = turnStore.transition({
      threadId: input.threadId,
      turnId: input.turnId,
      state: "interrupted",
    });
    if (record.sessionId && sessionStore.get(input.threadId, record.sessionId)) {
      sessionStore.updateStatus({
        threadId: input.threadId,
        sessionId: record.sessionId,
        status: "interrupted",
        activeTurnId: null,
      });
    }
    bus.emit({
      type: "turn.aborted",
      threadId: input.threadId,
      turnId: input.turnId,
      reason: input.reason,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      state: record.state,
    });
    appendActivity({
      threadId: input.threadId,
      turnId: input.turnId,
      tone: "error",
      kind: "turn.aborted",
      summary: `Turn aborted: ${input.reason}`,
      payload: { reason: input.reason },
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    });
    return {
      threadId: input.threadId,
      turnId: input.turnId,
      state: record.state,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    };
  }

  async function runScriptedTurn(input: {
    threadId: string;
    prompt: string;
    sessionId?: string;
    sourceProposedPlan?: SourceProposedPlanReference;
  }): Promise<HarnessTurn> {
    const turn = await startTurn({
      threadId: input.threadId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      sourceProposedPlan: input.sourceProposedPlan,
    });
    const script = consumeScript(input.prompt) ?? {
      activities: [
        {
          tone: "info",
          kind: "agent.text",
          summary: `Echo: ${input.prompt.slice(0, 40)}`,
          payload: { text: input.prompt },
        },
      ],
      assistantMessageId: ids.next("msg"),
    };
    providerInvocations.push({ prompt: input.prompt, turnId: turn.turnId });
    for (const activity of script.activities) {
      if (activity.delayMs) clock.advance(activity.delayMs);
      appendActivity({
        threadId: input.threadId,
        turnId: turn.turnId,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
    }
    if (script.proposedPlan) {
      upsertPlan(input.threadId, script.proposedPlan);
    }
    if (script.abortReason) {
      return abortTurn({
        threadId: input.threadId,
        turnId: turn.turnId,
        reason: script.abortReason,
      });
    }
    return completeTurn({
      threadId: input.threadId,
      turnId: turn.turnId,
      assistantMessageId: script.assistantMessageId,
    });
  }

  function serialize(): HarnessSerialized {
    const allThreads: HarnessSerialized["threads"] = [];
    const allTurns: HarnessSerialized["turns"] = [];
    const allActivities: HarnessSerialized["activities"] = [];
    const allPlans: HarnessSerialized["plans"] = [];
    const allCheckpoints: HarnessSerialized["checkpoints"] = [];
    const threadsList = (threadStore as ThreadStore).list();
    void threadsList; // serialize captures domain state below
    // We can't await inside a sync function, so the harness materializes
    // the index synchronously from its in-memory replicas via the bus
    // history. Tests should call await harness.serializeAsync() if they
    // need the persisted version. For the synchronous form we capture
    // what we've observed via emitted events.
    for (const event of bus.events()) {
      if (event.type === "chat.thread.index") {
        for (const entry of event.threads) {
          if (allThreads.find((t) => t.id === entry.id)) continue;
          allThreads.push({
            id: entry.id,
            title: entry.title,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          });
        }
      }
      if (event.type === "turn.started") {
        allTurns.push({
          threadId: event.threadId,
          turnId: event.turnId,
          state: "running",
          requestedAt: event.requestedAt,
          startedAt: event.requestedAt,
          completedAt: null,
          assistantMessageId: null,
        });
      }
      if (event.type === "turn.completed") {
        const turn = allTurns.find(
          (t) => t.threadId === event.threadId && t.turnId === event.turnId,
        );
        if (turn) {
          turn.state = "completed";
          turn.completedAt = event.completedAt;
          turn.assistantMessageId = event.assistantMessageId;
        }
      }
      if (event.type === "turn.aborted") {
        const turn = allTurns.find(
          (t) => t.threadId === event.threadId && t.turnId === event.turnId,
        );
        if (turn) turn.state = event.state;
      }
      if (event.type === "activity.appended") {
        allActivities.push({ threadId: event.threadId, activity: event.activity });
      }
      if (event.type === "plan.upserted") {
        allPlans.push({ threadId: event.threadId, plan: event.plan });
      }
      if (event.type === "checkpoint.upserted") {
        allCheckpoints.push({ threadId: event.threadId, summary: event.summary });
      }
    }
    return {
      schemaVersion: 1,
      threads: allThreads,
      turns: allTurns,
      activities: allActivities,
      plans: allPlans,
      checkpoints: allCheckpoints,
    };
  }

  function hydrateFrom(snapshot: HarnessSerialized): void {
    for (const turn of snapshot.turns) {
      try {
        turnStore.start({
          threadId: turn.threadId,
          turnId: turn.turnId,
          requestedAt: turn.requestedAt,
        });
      } catch {
        // already present
      }
      if (turn.state !== "running") {
        turnStore.transition({
          threadId: turn.threadId,
          turnId: turn.turnId,
          state: turn.state,
          assistantMessageId: turn.assistantMessageId,
          ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
        });
      }
    }
    for (const { threadId, activity } of snapshot.activities) {
      activityLog.append({
        threadId,
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
        turnId: activity.turnId,
        id: activity.id,
        createdAt: activity.createdAt,
      });
    }
    for (const { threadId, plan } of snapshot.plans) {
      planStore.upsert(threadId, plan);
    }
    for (const { threadId, summary } of snapshot.checkpoints) {
      checkpointStore.upsert(threadId, summary);
    }
  }

  async function dispose(): Promise<void> {
    rmSync(persistenceDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }

  return {
    persistenceDir,
    workspaceDir,
    threadStore,
    turnStore,
    sessionStore,
    activityLog,
    checkpointStore,
    checkpointEngine,
    planStore,
    tmux: tmuxSetup.api,
    tools: tmuxSetup.tools as unknown as ChatIntegrationHarness["tools"],
    provider,
    bus,
    clock,
    createThread,
    archiveThread,
    deleteThread,
    startTurn,
    appendActivity,
    addSession,
    removeSession,
    invokeTool,
    upsertPlan,
    approvePlan,
    rejectPlan,
    snapshotCheckpoint,
    revertCheckpoint,
    completeTurn,
    abortTurn,
    runScriptedTurn,
    serialize,
    hydrateFrom,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

function createEventBus(): HarnessEventBus {
  const log: HarnessEvent[] = [];
  const waiters = new Set<{
    type: EventType;
    resolve(event: HarnessEvent): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  return {
    emit(event) {
      log.push(event);
      for (const w of [...waiters]) {
        if (w.type === event.type) {
          clearTimeout(w.timer);
          waiters.delete(w);
          w.resolve(event);
        }
      }
    },
    events: () => log.slice(),
    ofType<T extends EventType>(type: T): ReadonlyArray<Extract<HarnessEvent, { type: T }>> {
      return log.filter((e): e is Extract<HarnessEvent, { type: T }> => e.type === type);
    },
    clear() {
      log.length = 0;
    },
    waitFor(type, timeoutMs = 500) {
      const existing = log.find((e) => e.type === type);
      if (existing) return Promise.resolve(existing as never);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);
        const waiter = { type, resolve: resolve as never, timer };
        waiters.add(waiter);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Default fixtures
// ---------------------------------------------------------------------------

function defaultPanes(): PaneInfo[] {
  return [
    {
      id: "%0",
      index: 0,
      title: "Lead",
      currentCommand: "claude",
      width: 80,
      height: 24,
      active: true,
      role: "lead",
      name: "lead",
      type: null,
    },
    {
      id: "%1",
      index: 1,
      title: "Dev Server",
      currentCommand: "node",
      width: 80,
      height: 24,
      active: false,
      role: "teammate",
      name: "dev",
      type: null,
    },
    {
      id: "%2",
      index: 2,
      title: "Tests",
      currentCommand: "zsh",
      width: 80,
      height: 24,
      active: false,
      role: "teammate",
      name: "tests",
      type: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Convenience helpers exported for tests
// ---------------------------------------------------------------------------

export function activitiesForTurn(
  log: ActivityLog,
  threadId: string,
  turnId: string,
): ThreadActivity[] {
  return log.listByTurn(threadId, turnId);
}

export function tonesForTurn(
  log: ActivityLog,
  threadId: string,
  turnId: string,
): ThreadActivityTone[] {
  return log.listByTurn(threadId, turnId).map((a) => a.tone);
}

export function checkpointFilesByPath(files: CheckpointFile[]): Map<string, CheckpointFile> {
  return new Map(files.map((f) => [f.path, f]));
}

export function uuid(): string {
  return randomUUID();
}
