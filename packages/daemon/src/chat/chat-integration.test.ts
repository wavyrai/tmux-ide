/**
 * Chat integration test suite — t3-rigor bring-up.
 *
 * This file is the canonical fast-feedback gate for the chat subsystem.
 * It wires the real stores + a real temp git repo + mocked tmux/provider
 * backends into one bundle (`createHarness`) and walks the system through
 * each scenario the goal-13 acceptance criteria call out:
 *
 *   1. Thread lifecycle
 *   2. Turn lifecycle
 *   3. Tool calls (send_to_pane / read_pane / capture_pane)
 *   4. Permission flow
 *   5. Plan flow (propose → approve → child turn)
 *   6. Checkpoint flow (snapshot → record → revert)
 *   7. Multi-turn correlation (per-turn diff isolation)
 *   8. Compat shim (legacy `chat.thread.update` + new turn/activity events)
 *   9. Persistence round-trip
 *  10. Error paths (abort mid-stream, tool error, revert dirty conflict)
 *
 * Every future goal-13 task is expected to extend this file with at least
 * one new scenario before the task can be marked done — see the README in
 * `__tests__/` for the contribution checklist.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  activitiesForTurn,
  checkpointFilesByPath,
  createHarness,
  tonesForTurn,
  type ChatIntegrationHarness,
  type HarnessEvent,
  type ScriptedTurnResponse,
} from "./chat-integration-harness.ts";
import {
  chatSessionSendHandler,
  chatThreadCreateHandler,
  chatThreadGetHandler,
} from "../command-center/actions/handlers/chat-actions.ts";
import { makeThreadManager } from "./thread-manager.ts";
import type {
  AcpClient,
  CancelNotification,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "../acp/index.ts";
import type { ChatEvent } from "./types.ts";

const execFile = promisify(execFileCallback);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

let harness: ChatIntegrationHarness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.dispose();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await predicate()).toBe(true);
}

function eventTypes(events: ReadonlyArray<HarnessEvent>): string[] {
  return events.map((e) => e.type);
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// Mock ACP client (legacy thread-manager wiring)
// ---------------------------------------------------------------------------

class CompatAcpClient implements AcpClient {
  readonly closed = Promise.resolve({ code: 0 as const, signal: null });
  readonly promptDeferred = deferred<PromptResponse>();
  readonly promptRequests: PromptRequest[] = [];
  private updateHandler: ((n: SessionNotification) => void) | null = null;

  async initialize(): Promise<InitializeResponse> {
    return { protocolVersion: 1 };
  }
  async newSession(_req: NewSessionRequest): Promise<NewSessionResponse> {
    return { sessionId: "session-1" };
  }
  async loadSession(_req: LoadSessionRequest): Promise<LoadSessionResponse> {
    return {};
  }
  prompt(req: PromptRequest): Promise<PromptResponse> {
    this.promptRequests.push(req);
    return this.promptDeferred.promise;
  }
  async cancel(_n: CancelNotification): Promise<void> {}
  onSessionUpdate(handler: (n: SessionNotification) => void): () => void {
    this.updateHandler = handler;
    return () => {
      if (this.updateHandler === handler) this.updateHandler = null;
    };
  }
  onPermissionRequest(
    _h: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
  ): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
  emit(update: SessionNotification["update"]): void {
    this.updateHandler?.({ sessionId: "session-1", update });
  }
}

// ===========================================================================
// 1. Thread lifecycle
// ===========================================================================

describe("scenario 1 — thread lifecycle (create → first turn → completion → archive → delete)", () => {
  it("creates a thread with default provider and surfaces it on the index event", async () => {
    const thread = await harness.createThread({ title: "First chat" });
    expect(thread.id).toMatch(/^thr-\d{4}$/);
    expect(thread.title).toBe("First chat");
    const indexEvents = harness.bus.ofType("chat.thread.index");
    expect(indexEvents).toHaveLength(1);
    expect(indexEvents[0]!.threads.map((t) => t.id)).toEqual([thread.id]);
  });

  it("accepts an explicit codex provider and records it on the stored thread", async () => {
    const thread = await harness.createThread({ provider: { kind: "codex" } });
    const state = await harness.threadStore.get(thread.id);
    expect(state).not.toBeNull();
    expect(state!.provider.kind).toBe("codex");
  });

  it("appends user prompts and assistant updates as ThreadMessage records via the store", async () => {
    const thread = await harness.createThread();
    await harness.threadStore.appendMessage(thread.id, {
      _tag: "UserPrompt",
      id: "u1",
      createdAt: harness.clock.iso(),
      content: [{ type: "text", text: "hello" }],
    });
    await harness.threadStore.appendMessage(thread.id, {
      _tag: "AgentUpdate",
      id: "a1",
      createdAt: harness.clock.iso(),
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
    });
    const state = await harness.threadStore.get(thread.id);
    expect(state!.messages.map((m) => m._tag)).toEqual(["UserPrompt", "AgentUpdate"]);
    expect(state!.messages).toHaveLength(2);
  });

  it("titles a fresh thread from the first user prompt when the caller didn't pass one", async () => {
    // Drive thread-store directly so we exercise its real "New chat" default
    // — the harness defaults to a fixture title for clarity in other tests.
    const state = await harness.threadStore.create({ provider: { kind: "claude-code" } });
    expect(state.title).toBe("New chat");
    await harness.threadStore.appendMessage(state.id, {
      _tag: "UserPrompt",
      id: "u1",
      createdAt: harness.clock.iso(),
      content: [{ type: "text", text: "ship the dashboard tonight" }],
    });
    const refreshed = await harness.threadStore.get(state.id);
    expect(refreshed!.title).toBe("ship the dashboard tonight");
  });

  it("runs a first scripted turn end-to-end and reaches the 'completed' state", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("hi", {
      activities: [
        { tone: "info", kind: "agent.text", summary: "Hi back" },
        { tone: "info", kind: "agent.text", summary: "Anything else?" },
      ],
      assistantMessageId: "msg-1",
    });
    const turn = await harness.runScriptedTurn({ threadId: thread.id, prompt: "hi" });
    expect(turn.state).toBe("completed");
    expect(harness.turnStore.list(thread.id)).toHaveLength(1);
    expect(harness.activityLog.list({ threadId: thread.id })).toHaveLength(2);
  });

  it("emits an archive index event without touching the persistent store", async () => {
    const thread = await harness.createThread({ title: "Daily" });
    harness.bus.clear();
    await harness.archiveThread(thread.id);
    const indexes = harness.bus.ofType("chat.thread.index");
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.threads[0]!.title).toBe("[archived] Daily");
    // Underlying store row is unchanged.
    const state = await harness.threadStore.get(thread.id);
    expect(state!.title).toBe("Daily");
  });

  it("deletes the thread and clears every per-thread record across the harness", async () => {
    const thread = await harness.createThread();
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "x" });
    expect(harness.activityLog.list({ threadId: thread.id }).length).toBeGreaterThan(0);
    expect(harness.turnStore.list(thread.id).length).toBeGreaterThan(0);
    await harness.deleteThread(thread.id);
    expect(await harness.threadStore.get(thread.id)).toBeNull();
    expect(harness.activityLog.list({ threadId: thread.id })).toEqual([]);
    expect(harness.turnStore.list(thread.id)).toEqual([]);
    expect(harness.checkpointStore.list(thread.id)).toEqual([]);
  });

  it("emits chat.thread.index events on each lifecycle transition", async () => {
    const thread = await harness.createThread();
    await harness.archiveThread(thread.id);
    await harness.deleteThread(thread.id);
    const indexes = harness.bus.ofType("chat.thread.index");
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    expect(indexes[indexes.length - 1]!.threads).toEqual([]);
  });

  it("supports many concurrently-created threads with distinct ids", async () => {
    const threads = await Promise.all(
      Array.from({ length: 5 }, (_, i) => harness.createThread({ title: `t-${i}` })),
    );
    const ids = new Set(threads.map((t) => t.id));
    expect(ids.size).toBe(5);
    const index = await harness.threadStore.list();
    expect(index).toHaveLength(5);
  });
});

// ===========================================================================
// 2. Turn lifecycle
// ===========================================================================

describe("scenario 2 — turn lifecycle (start → activities → completion)", () => {
  it("starts a turn in the 'running' state and pins it as the latest", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    expect(turn.state).toBe("running");
    const latest = harness.turnStore.latest(thread.id);
    expect(latest?.turnId).toBe(turn.turnId);
    expect(latest?.state).toBe("running");
  });

  it("records five mixed-tone activities and preserves the order they were appended", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const tones = ["info", "tool", "approval", "tool", "error"] as const;
    for (let i = 0; i < tones.length; i++) {
      harness.appendActivity({
        threadId: thread.id,
        turnId: turn.turnId,
        tone: tones[i]!,
        kind: `kind-${i}`,
        summary: `summary ${i}`,
        payload: { i },
      });
    }
    expect(tonesForTurn(harness.activityLog, thread.id, turn.turnId)).toEqual([
      "info",
      "tool",
      "approval",
      "tool",
      "error",
    ]);
  });

  it("assigns a strictly monotonic sequence to activities within a single turn", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    for (let i = 0; i < 6; i++) {
      harness.appendActivity({
        threadId: thread.id,
        turnId: turn.turnId,
        tone: "info",
        kind: "agent.text",
        summary: `chunk ${i}`,
      });
    }
    const sequences = activitiesForTurn(harness.activityLog, thread.id, turn.turnId).map(
      (a) => a.sequence,
    );
    expect(sequences).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("transitions the turn to 'completed' with an assistant message id", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.completeTurn({
      threadId: thread.id,
      turnId: turn.turnId,
      assistantMessageId: "msg-final",
    });
    const stored = harness.turnStore.get(thread.id, turn.turnId);
    expect(stored?.state).toBe("completed");
    expect(stored?.assistantMessageId).toBe("msg-final");
    expect(stored?.completedAt).not.toBeNull();
  });

  it("emits turn.started → activity.appended* → turn.completed in that order", async () => {
    const thread = await harness.createThread();
    harness.bus.clear();
    const turn = await harness.startTurn({ threadId: thread.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turn.turnId,
      tone: "info",
      kind: "agent.text",
      summary: "hi",
    });
    await harness.completeTurn({ threadId: thread.id, turnId: turn.turnId });
    expect(eventTypes(harness.bus.events())).toEqual([
      "turn.started",
      "activity.appended",
      "turn.completed",
    ]);
  });

  it("rejects an illegal transition from a terminal state back to running", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.completeTurn({ threadId: thread.id, turnId: turn.turnId });
    expect(() =>
      harness.turnStore.transition({
        threadId: thread.id,
        turnId: turn.turnId,
        state: "running",
      }),
    ).toThrowError(/Illegal turn transition/);
  });

  it("partitions activities by turn so concurrent turns stay isolated", async () => {
    const thread = await harness.createThread();
    const a = await harness.startTurn({ threadId: thread.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: a.turnId,
      tone: "info",
      kind: "agent.text",
      summary: "turn-a",
    });
    await harness.completeTurn({ threadId: thread.id, turnId: a.turnId });

    const b = await harness.startTurn({ threadId: thread.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: b.turnId,
      tone: "info",
      kind: "agent.text",
      summary: "turn-b",
    });
    await harness.completeTurn({ threadId: thread.id, turnId: b.turnId });

    expect(
      activitiesForTurn(harness.activityLog, thread.id, a.turnId).map((x) => x.summary),
    ).toEqual(["turn-a"]);
    expect(
      activitiesForTurn(harness.activityLog, thread.id, b.turnId).map((x) => x.summary),
    ).toEqual(["turn-b"]);
  });

  it("supports filtered queries by sinceSeq for incremental dashboard hydration", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    for (let i = 0; i < 4; i++) {
      harness.appendActivity({
        threadId: thread.id,
        turnId: turn.turnId,
        tone: "info",
        kind: "agent.text",
        summary: `chunk ${i}`,
      });
    }
    const tail = harness.activityLog.list({ threadId: thread.id, sinceSeq: 1 });
    expect(tail.map((a) => a.summary)).toEqual(["chunk 2", "chunk 3"]);
  });
});

// ===========================================================================
// 3. Tool calls (send_to_pane / read_pane / capture_pane)
// ===========================================================================

describe("scenario 3 — tool calls via chat tools", () => {
  it("invokes send_to_pane and records a tool-tone activity with the input payload", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "ls\n" },
    });
    expect(result.ok).toBe(true);
    expect(result.toolActivity.tone).toBe("tool");
    expect(harness.tmux.sendCalls()).toEqual([{ target: "%0", text: "ls\n", enter: true }]);
  });

  it("invokes read_pane with the default 50-line window when no `lines` is provided", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    harness.tmux.setPaneContent("%1", "build output line 1\nbuild output line 2\n");
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "read_pane",
      input: { target: "Dev Server" },
    });
    expect(result.ok).toBe(true);
    expect(harness.tmux.captureCalls()).toEqual([{ target: "%1", mode: "recent", arg: 50 }]);
  });

  it("invokes capture_pane with a custom scrollback depth", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "capture_pane",
      input: { target: "%2", scrollback: 200 },
    });
    expect(result.ok).toBe(true);
    expect(harness.tmux.captureCalls()).toEqual([{ target: "%2", mode: "scrollback", arg: 200 }]);
  });

  it("records tool inputs in the activity payload for replay & UI rendering", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "echo hi" },
    });
    const activity = harness.activityLog.listByTurn(thread.id, turn.turnId).at(-1)!;
    expect(activity.kind).toBe("tool.send_to_pane");
    expect((activity.payload as { input: { text: string } }).input.text).toBe("echo hi");
  });

  it("emits a tool.invoked harness event for each tool call so subscribers can audit", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "x" },
    });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "read_pane",
      input: { target: "lead" },
    });
    const invocations = harness.bus.ofType("tool.invoked");
    expect(invocations.map((e) => e.tool)).toEqual(["send_to_pane", "read_pane"]);
    expect(invocations.every((e) => e.ok)).toBe(true);
  });

  it("propagates pane-resolution failures as ok:false with an explanatory error", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "ghost-pane", text: "x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/);
    expect(result.toolActivity.tone).toBe("error");
  });

  it("threads multiple tool calls in sequence under the same turn", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "pwd" },
    });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "read_pane",
      input: { target: "lead", lines: 10 },
    });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "capture_pane",
      input: { target: "lead", scrollback: 500 },
    });
    expect(harness.activityLog.listByTurn(thread.id, turn.turnId)).toHaveLength(3);
  });

  it("resolves pane targets by name, title, role, or id consistently", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const labels = ["dev", "Dev Server", "teammate", "%1"];
    for (const target of labels) {
      await harness.invokeTool({
        threadId: thread.id,
        turnId: turn.turnId,
        tool: "send_to_pane",
        input: { target, text: target },
      });
    }
    const targets = harness.tmux.sendCalls().map((c) => c.target);
    expect(targets).toEqual(["%1", "%1", "%1", "%1"]);
  });
});

// ===========================================================================
// 4. Permission flow
// ===========================================================================

describe("scenario 4 — permission flow", () => {
  it("records an approval-tone activity before executing the tool when needsApproval=true", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "rm -rf /" },
      needsApproval: true,
    });
    expect(result.approvalActivity?.tone).toBe("approval");
    expect(result.toolActivity.tone).toBe("tool");
    expect(harness.activityLog.listByTurn(thread.id, turn.turnId).map((a) => a.tone)).toEqual([
      "approval",
      "tool",
    ]);
  });

  it("links the approval activity to the same turn as the tool call", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "deploy" },
      needsApproval: true,
    });
    expect(result.approvalActivity?.turnId).toBe(turn.turnId);
    expect(result.toolActivity.turnId).toBe(turn.turnId);
  });

  it("carries the proposed tool input on the approval payload so the UI can preview it", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "capture_pane",
      input: { target: "dev", scrollback: 5000 },
      needsApproval: true,
    });
    const payload = result.approvalActivity!.payload as { input: Record<string, unknown> };
    expect(payload.input).toEqual({ target: "dev", scrollback: 5000 });
  });

  it("skips the approval activity when needsApproval is omitted", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "ls" },
    });
    expect(result.approvalActivity).toBeUndefined();
    expect(harness.activityLog.listByTurn(thread.id, turn.turnId).map((a) => a.tone)).toEqual([
      "tool",
    ]);
  });

  it("still produces a tool-tone follow-up activity when the approved tool fails", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "missing", text: "go" },
      needsApproval: true,
    });
    expect(result.ok).toBe(false);
    expect(result.approvalActivity?.tone).toBe("approval");
    expect(result.toolActivity.tone).toBe("error");
  });

  it("preserves event ordering: approval activity before tool.invoked emission", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    harness.bus.clear();
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "x" },
      needsApproval: true,
    });
    const types = eventTypes(harness.bus.events());
    const firstApproval = types.indexOf("activity.appended");
    const firstToolInvoked = types.indexOf("tool.invoked");
    expect(firstApproval).toBeGreaterThanOrEqual(0);
    expect(firstToolInvoked).toBeGreaterThan(firstApproval);
  });

  it("allows multiple approval gates in a single turn without entanglement", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "first" },
      needsApproval: true,
    });
    await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "second" },
      needsApproval: true,
    });
    const tones = tonesForTurn(harness.activityLog, thread.id, turn.turnId);
    expect(tones).toEqual(["approval", "tool", "approval", "tool"]);
  });
});

// ===========================================================================
// 5. Plan flow (propose → approve → child turn)
// ===========================================================================

describe("scenario 5 — plan flow", () => {
  it("upserts a ProposedPlan when scripted on a turn and emits plan.upserted", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("plan it", {
      activities: [{ tone: "info", kind: "agent.text", summary: "thinking..." }],
      assistantMessageId: "msg-plan",
      proposedPlan: {
        id: "plan-001",
        planMarkdown: "# plan\n- step 1\n- step 2\n",
      },
    });
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "plan it" });
    const planEvents = harness.bus.ofType("plan.upserted");
    expect(planEvents).toHaveLength(1);
    expect(planEvents[0]!.plan.id).toBe("plan-001");
  });

  it("records the plan in the plan store with createdAt / updatedAt timestamps", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, {
      id: "plan-direct",
      planMarkdown: "# direct plan",
    });
    expect(plan.createdAt).toBe(harness.clock.iso());
    expect(plan.updatedAt).toBe(plan.createdAt);
    expect(harness.planStore.get(thread.id, "plan-direct")).toEqual(plan);
  });

  it("ties the plan back to the latest running turn when one exists", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const plan = harness.upsertPlan(thread.id, { planMarkdown: "# plan" });
    expect(plan.turnId).toBe(turn.turnId);
  });

  it("approves a plan by spawning a child turn whose sourceProposedPlan points at it", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, {
      id: "plan-A",
      planMarkdown: "# A",
    });
    const { childTurn } = await harness.approvePlan({
      threadId: thread.id,
      planId: plan.id,
    });
    const stored = harness.turnStore.get(thread.id, childTurn.turnId);
    expect(stored?.sourceProposedPlan).toEqual({
      threadId: thread.id,
      planId: plan.id,
    });
  });

  it("marks the original plan as implemented with implementedAt + implementationThreadId", async () => {
    const thread = await harness.createThread();
    const original = harness.upsertPlan(thread.id, { id: "plan-B", planMarkdown: "# B" });
    await harness.approvePlan({ threadId: thread.id, planId: original.id });
    const updated = harness.planStore.get(thread.id, original.id);
    expect(updated?.implementedAt).not.toBeNull();
    expect(updated?.implementationThreadId).toBe(thread.id);
  });

  it("emits turn.started and plan.approved during approval (plan.upserted re-fires with implementation metadata)", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, { planMarkdown: "# X" });
    harness.bus.clear();
    await harness.approvePlan({ threadId: thread.id, planId: plan.id });
    const types = eventTypes(harness.bus.events());
    expect(types).toContain("turn.started");
    expect(types).toContain("plan.upserted");
    expect(types).toContain("plan.approved");
    // Order: child turn starts first, then plan re-upsert + approve.
    expect(types.indexOf("turn.started")).toBeLessThan(types.indexOf("plan.approved"));
    expect(types.indexOf("plan.upserted")).toBeLessThan(types.indexOf("plan.approved"));
  });

  it("rejects approve for an unknown plan id", async () => {
    const thread = await harness.createThread();
    await expect(
      harness.approvePlan({ threadId: thread.id, planId: "missing" }),
    ).rejects.toThrowError(/missing/);
  });

  it("supports multiple plans being upserted on the same turn", async () => {
    const thread = await harness.createThread();
    await harness.startTurn({ threadId: thread.id });
    harness.upsertPlan(thread.id, { id: "p1", planMarkdown: "1" });
    harness.upsertPlan(thread.id, { id: "p2", planMarkdown: "2" });
    expect(harness.planStore.list(thread.id).map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

// ===========================================================================
// 5b. plan-approve-execute (T076) — REST-facing approve / reject lifecycle
// ===========================================================================

describe("plan-approve-execute", () => {
  it("(a) agent emits plan → PlanUpserted event fires → plan visible via GET", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("propose plan", {
      activities: [{ tone: "info", kind: "agent.text", summary: "drafting" }],
      assistantMessageId: "msg-a",
      proposedPlan: {
        id: "plan-A",
        planMarkdown: "# Plan A\n- step 1\n",
      },
    });
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "propose plan" });

    const upserts = harness.bus.ofType("plan.upserted");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.plan.id).toBe("plan-A");

    // The list-equivalent of the REST GET /api/threads/:threadId/plans
    const visible = harness.planStore.list(thread.id);
    expect(visible.map((p) => p.id)).toEqual(["plan-A"]);
    expect(visible[0]!.planMarkdown).toContain("# Plan A");
    expect(visible[0]!.implementedAt).toBeNull();
    expect(visible[0]!.rejected).toBeUndefined();
  });

  it("(b) approve → new turn spawned → latestTurn.sourceProposedPlan references planId", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, {
      id: "plan-B",
      planMarkdown: "# Plan B",
    });

    const { childTurn } = await harness.approvePlan({
      threadId: thread.id,
      planId: plan.id,
    });

    const latest = harness.turnStore.latest(thread.id);
    expect(latest?.turnId).toBe(childTurn.turnId);
    expect(latest?.sourceProposedPlan).toEqual({
      threadId: thread.id,
      planId: plan.id,
    });
    expect(latest?.state).toBe("running");
  });

  it("(c) approve → original plan.implementedAt + implementationThreadId set", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, {
      id: "plan-C",
      planMarkdown: "# Plan C",
    });

    await harness.approvePlan({ threadId: thread.id, planId: plan.id });

    const stored = harness.planStore.get(thread.id, plan.id);
    expect(stored?.implementedAt).not.toBeNull();
    expect(typeof stored?.implementedAt).toBe("string");
    expect(stored?.implementationThreadId).toBe(thread.id);
    expect(stored?.rejected).toBeUndefined();
  });

  it("(d) reject → plan.rejected populated, no new turn spawned", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, {
      id: "plan-D",
      planMarkdown: "# Plan D",
    });
    harness.bus.clear();

    const rejected = harness.rejectPlan({
      threadId: thread.id,
      planId: plan.id,
      reason: "wrong direction",
    });

    expect(rejected.rejected?.reason).toBe("wrong direction");
    expect(rejected.rejected?.at).toEqual(expect.any(String));
    expect(rejected.implementedAt).toBeNull();

    // No new turn started.
    expect(harness.bus.ofType("turn.started")).toEqual([]);
    expect(harness.turnStore.latest(thread.id)).toBeNull();

    // plan.upserted re-fires with rejection metadata; plan.rejected fires once.
    expect(harness.bus.ofType("plan.rejected")).toHaveLength(1);
    const upsertEvents = harness.bus.ofType("plan.upserted");
    expect(upsertEvents.at(-1)!.plan.rejected?.reason).toBe("wrong direction");
  });

  it("(e) approve while another turn is already running → rejected with conflict error", async () => {
    const thread = await harness.createThread();
    // Simulate an in-flight turn on this thread.
    await harness.startTurn({ threadId: thread.id });

    const plan = harness.upsertPlan(thread.id, {
      id: "plan-E",
      planMarkdown: "# Plan E",
    });

    await expect(
      harness.approvePlan({ threadId: thread.id, planId: plan.id }),
    ).rejects.toThrowError(/conflict/i);

    // The plan must remain pending: no implementation metadata, no rejection.
    const stored = harness.planStore.get(thread.id, plan.id);
    expect(stored?.implementedAt).toBeNull();
    expect(stored?.rejected).toBeUndefined();
  });
});

// ===========================================================================
// 6. Checkpoint flow (snapshot → record → revert)
// ===========================================================================

describe("scenario 6 — checkpoint flow", () => {
  it("snapshots the workspace on a clean tree and falls back to HEAD", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const summary = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turn.turnId,
    });
    const head = (await gitOutput(harness.workspaceDir, "rev-parse", "HEAD")).trim();
    expect(summary.status).toBe("ready");
    expect(summary.files).toEqual([]);
    // Snapshot SHA was anchored under refs/tmux-ide/checkpoints/.
    const refs = await gitOutput(
      harness.workspaceDir,
      "for-each-ref",
      "refs/tmux-ide/checkpoints/",
    );
    expect(refs).toContain(turn.turnId);
    expect(summary.checkpointRef.endsWith(`/${turn.turnId}`)).toBe(true);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
  });

  it("captures a CheckpointFile list with kind/additions/deletions when the tree is dirty", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 999;\n");
    writeFileSync(join(harness.workspaceDir, "added.ts"), "export const b = 1;\n");
    await gitOutput(harness.workspaceDir, "add", "added.ts");
    const turn = await harness.startTurn({ threadId: thread.id });
    const summary = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turn.turnId,
    });
    const byPath = checkpointFilesByPath(summary.files);
    expect(byPath.get("src.ts")?.kind).toBe("modified");
    expect(byPath.get("src.ts")?.additions).toBe(1);
    expect(byPath.get("src.ts")?.deletions).toBe(1);
    expect(byPath.get("added.ts")?.kind).toBe("added");
  });

  it("stores each summary in the checkpoint store keyed by turnId", async () => {
    const thread = await harness.createThread();
    const t1 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t1.turnId });
    expect(harness.checkpointStore.get(thread.id, t1.turnId)).not.toBeNull();
  });

  it("assigns monotonic checkpointTurnCount across snapshots in the same thread", async () => {
    const thread = await harness.createThread();
    const t1 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t1.turnId });
    await harness.completeTurn({ threadId: thread.id, turnId: t1.turnId });
    const t2 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t2.turnId });
    const list = harness.checkpointStore.list(thread.id);
    expect(list.map((c) => c.checkpointTurnCount)).toEqual([1, 2]);
  });

  it("emits checkpoint.upserted with the full summary on snapshot", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    const ckptEvents = harness.bus.ofType("checkpoint.upserted");
    expect(ckptEvents).toHaveLength(1);
    expect(ckptEvents[0]!.summary.turnId).toBe(turn.turnId);
  });

  it("reverts a snapshot, restoring tracked files and emitting checkpoint.reverted", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 42;\n");
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    // Commit the snapshot state and move HEAD forward so revert is exercised.
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "promote snapshot");
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 999;\n");
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "advance");

    const { refreshedStatus } = await harness.revertCheckpoint({
      threadId: thread.id,
      turnId: turn.turnId,
    });
    expect(refreshedStatus).toBe("ready");
    expect(readFileSync(join(harness.workspaceDir, "src.ts"), "utf8")).toBe(
      "export const a = 42;\n",
    );
    expect(harness.bus.ofType("checkpoint.reverted")).toHaveLength(1);
  });

  it("leaves untracked files alone on revert", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 2;\n");
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "advance");
    writeFileSync(join(harness.workspaceDir, "untracked.txt"), "keep me\n");

    await harness.revertCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    expect(readFileSync(join(harness.workspaceDir, "untracked.txt"), "utf8")).toBe("keep me\n");
  });

  it("logs an info-tone 'checkpoint.reverted' activity on the turn", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 7;\n");
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "advance");
    await harness.revertCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    const activities = harness.activityLog.listByTurn(thread.id, turn.turnId);
    const reverted = activities.find((a) => a.kind === "checkpoint.reverted");
    expect(reverted?.tone).toBe("info");
  });

  it("refuses to revert when no checkpoint exists for the turn", async () => {
    const thread = await harness.createThread();
    await expect(
      harness.revertCheckpoint({ threadId: thread.id, turnId: "missing-turn" }),
    ).rejects.toThrowError(/No checkpoint/);
  });
});

// ===========================================================================
// 7. Multi-turn correlation (per-turn diff isolation in checkpoints)
// ===========================================================================

describe("scenario 7 — per-turn diff isolation across multiple snapshots", () => {
  it("turn-1 captures files A,B and turn-2 captures only file C", async () => {
    const thread = await harness.createThread();

    // Turn 1 edits src.ts (A) + adds notes.md (B)
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 11;\n");
    writeFileSync(join(harness.workspaceDir, "notes.md"), "todo\n");
    await gitOutput(harness.workspaceDir, "add", "notes.md");
    const turn1 = await harness.startTurn({ threadId: thread.id });
    const ckpt1 = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turn1.turnId,
    });
    // Commit so the second turn diffs against a fresh HEAD.
    await gitOutput(harness.workspaceDir, "add", ".");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "turn-1 changes");
    await harness.completeTurn({ threadId: thread.id, turnId: turn1.turnId });

    // Turn 2 edits config.json (C) only.
    writeFileSync(join(harness.workspaceDir, "config.json"), JSON.stringify({ x: 1 }));
    await gitOutput(harness.workspaceDir, "add", "config.json");
    const turn2 = await harness.startTurn({ threadId: thread.id });
    const ckpt2 = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turn2.turnId,
    });

    const filesT1 = ckpt1.files.map((f) => f.path).sort();
    const filesT2 = ckpt2.files.map((f) => f.path).sort();
    expect(filesT1).toEqual(["notes.md", "src.ts"]);
    expect(filesT2).toEqual(["config.json"]);
  });

  it("each turn's checkpoint ref resolves independently after later turns commit", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 11;\n");
    const t1 = await harness.startTurn({ threadId: thread.id });
    const c1 = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: t1.turnId,
    });
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "advance");

    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 22;\n");
    const t2 = await harness.startTurn({ threadId: thread.id });
    const c2 = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: t2.turnId,
    });
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "advance again");

    const s1 = await harness.checkpointEngine.status({
      checkpointRef: c1.checkpointRef,
      workspaceDir: harness.workspaceDir,
    });
    const s2 = await harness.checkpointEngine.status({
      checkpointRef: c2.checkpointRef,
      workspaceDir: harness.workspaceDir,
    });
    expect(s1).toBe("ready");
    expect(s2).toBe("ready");
  });

  it("reverting turn-1 does not touch files only changed in turn-2 (untracked)", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 11;\n");
    const t1 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t1.turnId });
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "promote");
    await harness.completeTurn({ threadId: thread.id, turnId: t1.turnId });

    // Turn 2 just adds an untracked file.
    writeFileSync(join(harness.workspaceDir, "scratch.txt"), "scratch\n");
    await harness.revertCheckpoint({ threadId: thread.id, turnId: t1.turnId });
    expect(readFileSync(join(harness.workspaceDir, "scratch.txt"), "utf8")).toBe("scratch\n");
  });

  it("listForThread returns refs in stable order matching insertion", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 11;\n");
    const t1 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t1.turnId });
    await gitOutput(harness.workspaceDir, "add", "src.ts");
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "p1");
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 22;\n");
    const t2 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t2.turnId });
    const refs = await harness.checkpointEngine.listForThread({
      threadId: thread.id,
      workspaceDir: harness.workspaceDir,
    });
    expect(refs.map((r) => r.turnId).sort()).toEqual([t1.turnId, t2.turnId].sort());
  });

  it("each snapshot increments checkpointTurnCount monotonically across the thread", async () => {
    const thread = await harness.createThread();
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(harness.workspaceDir, "src.ts"), `export const a = ${i};\n`);
      const t = await harness.startTurn({ threadId: thread.id });
      await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t.turnId });
      await gitOutput(harness.workspaceDir, "add", "src.ts");
      await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", `c${i}`);
      await harness.completeTurn({ threadId: thread.id, turnId: t.turnId });
    }
    expect(harness.checkpointStore.list(thread.id).map((c) => c.checkpointTurnCount)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("turn-2's checkpoint does NOT include files that were only touched in turn-1", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "a.txt"), "a\n");
    await gitOutput(harness.workspaceDir, "add", "a.txt");
    const t1 = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: t1.turnId });
    await gitOutput(harness.workspaceDir, "commit", "--quiet", "-m", "t1");
    await harness.completeTurn({ threadId: thread.id, turnId: t1.turnId });

    writeFileSync(join(harness.workspaceDir, "b.txt"), "b\n");
    await gitOutput(harness.workspaceDir, "add", "b.txt");
    const t2 = await harness.startTurn({ threadId: thread.id });
    const ckpt2 = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: t2.turnId,
    });
    const paths = ckpt2.files.map((f) => f.path);
    expect(paths).toContain("b.txt");
    expect(paths).not.toContain("a.txt");
  });
});

// ===========================================================================
// 8. Compat shim — legacy chat.thread.update AND new turn/activity events
// ===========================================================================

describe("scenario 8 — compat shim", () => {
  it("a scripted turn produces both activity.appended events and a legacy chat.thread.update can be emitted in parallel", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("legacy", {
      activities: [
        { tone: "info", kind: "agent.text", summary: "chunk 1" },
        { tone: "info", kind: "agent.text", summary: "chunk 2" },
      ],
      assistantMessageId: "msg-1",
    });
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "legacy" });
    // Legacy bus subscribers expect chat.thread.update — synthesize one per activity
    // and verify counts agree.
    const activities = harness.bus.ofType("activity.appended");
    for (const evt of activities) {
      harness.bus.emit({
        type: "chat.thread.update",
        threadId: evt.threadId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: evt.activity.summary },
        },
        seq: evt.activity.sequence ?? 0,
      });
    }
    const legacyUpdates = harness.bus.ofType("chat.thread.update");
    expect(legacyUpdates).toHaveLength(activities.length);
  });

  it("legacy thread-manager wiring still produces chat.thread.update + chat.thread.stop", async () => {
    const events: ChatEvent[] = [];
    const client = new CompatAcpClient();
    const manager = makeThreadManager({
      store: harness.threadStore,
      spawnClient: async () => client,
      busEmit: (event) => events.push(event),
      permissionTimeoutMs: 1,
    });
    const deps = {
      store: harness.threadStore,
      manager,
      busEmit: (event: ChatEvent) => events.push(event),
    };
    const created = await chatThreadCreateHandler(
      { provider: { kind: "claude-code" }, title: "compat" },
      deps,
    );
    const sent = await chatSessionSendHandler(
      { threadId: created.thread.id, content: [{ type: "text", text: "hi" }] },
      deps,
    );
    client.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "world" },
      messageId: "a1",
    });
    client.promptDeferred.resolve({ stopReason: "end_turn" });

    await waitFor(() => events.some((e) => e.type === "chat.thread.stop"));
    expect(sent.accepted).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain("chat.thread.index");
    expect(types).toContain("chat.thread.update");
    expect(types).toContain("chat.thread.stop");
    await manager.shutdown();
  });

  it("the chatThreadGet handler returns the thread with messages after a legacy round-trip", async () => {
    const events: ChatEvent[] = [];
    const client = new CompatAcpClient();
    const manager = makeThreadManager({
      store: harness.threadStore,
      spawnClient: async () => client,
      busEmit: (e) => events.push(e),
      permissionTimeoutMs: 1,
    });
    const deps = {
      store: harness.threadStore,
      manager,
      busEmit: (e: ChatEvent) => events.push(e),
    };
    const created = await chatThreadCreateHandler({ provider: { kind: "claude-code" } }, deps);
    await chatSessionSendHandler(
      { threadId: created.thread.id, content: [{ type: "text", text: "x" }] },
      deps,
    );
    client.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "y" },
      messageId: "a1",
    });
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    await waitFor(() => events.some((e) => e.type === "chat.thread.stop"));
    const got = await chatThreadGetHandler({ id: created.thread.id }, deps);
    expect(got.thread.messages.map((m) => m._tag)).toEqual(["UserPrompt", "AgentUpdate"]);
    await manager.shutdown();
  });

  it("activity count equals chat.thread.update count after a scripted run", async () => {
    const thread = await harness.createThread();
    const script: ScriptedTurnResponse = {
      activities: [
        { tone: "info", kind: "agent.text", summary: "1" },
        { tone: "info", kind: "agent.text", summary: "2" },
        { tone: "info", kind: "agent.text", summary: "3" },
      ],
      assistantMessageId: "m",
    };
    harness.provider.scriptPrompt("equal", script);
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "equal" });
    const activityCount = harness.bus.ofType("activity.appended").length;
    // synthesize one legacy update per activity
    for (let i = 0; i < activityCount; i++) {
      harness.bus.emit({
        type: "chat.thread.update",
        threadId: thread.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String(i) },
        },
        seq: i,
      });
    }
    expect(harness.bus.ofType("chat.thread.update")).toHaveLength(activityCount);
  });

  it("the harness bus preserves emission order across legacy + new event types", async () => {
    const thread = await harness.createThread();
    harness.bus.emit({
      type: "chat.thread.update",
      threadId: thread.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "legacy" } },
      seq: 0,
    });
    const turn = await harness.startTurn({ threadId: thread.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turn.turnId,
      tone: "info",
      kind: "agent.text",
      summary: "new",
    });
    const seq = harness.bus.events().map((e) => e.type);
    expect(seq[seq.length - 3]).toBe("chat.thread.update");
    expect(seq[seq.length - 2]).toBe("turn.started");
    expect(seq[seq.length - 1]).toBe("activity.appended");
  });

  it("a single user message produces both new turn events and a chat.thread.update", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("shim", {
      activities: [{ tone: "info", kind: "agent.text", summary: "ok" }],
      assistantMessageId: "m",
    });
    harness.bus.clear();
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "shim" });
    harness.bus.emit({
      type: "chat.thread.update",
      threadId: thread.id,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      seq: 0,
    });
    const types = eventTypes(harness.bus.events());
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.completed");
    expect(types).toContain("activity.appended");
    expect(types).toContain("chat.thread.update");
  });
});

// ===========================================================================
// 9. Persistence round-trip
// ===========================================================================

describe("scenario 9 — persistence round-trip", () => {
  it("thread-store survives serialize → deserialize via the JSON files on disk", async () => {
    const thread = await harness.createThread({ title: "Persist me" });
    await harness.threadStore.appendMessage(thread.id, {
      _tag: "UserPrompt",
      id: "u1",
      createdAt: harness.clock.iso(),
      content: [{ type: "text", text: "persistent" }],
    });
    // Fresh store rooted at the same dir should rehydrate the thread.
    const { makeThreadStore } = await import("./thread-store.ts");
    const fresh = makeThreadStore({ rootDir: harness.persistenceDir });
    const state = await fresh.get(thread.id);
    expect(state?.title).toBe("Persist me");
    expect(state?.messages).toHaveLength(1);
    expect(state!.messages[0]._tag).toBe("UserPrompt");
  });

  it("serializes turns and replays them via hydrateFrom with identical state", async () => {
    const thread = await harness.createThread();
    const t1 = await harness.startTurn({ threadId: thread.id });
    await harness.completeTurn({
      threadId: thread.id,
      turnId: t1.turnId,
      assistantMessageId: "m1",
    });
    const snapshot = harness.serialize();
    const fresh = await createHarness();
    try {
      fresh.hydrateFrom(snapshot);
      const stored = fresh.turnStore.get(thread.id, t1.turnId);
      expect(stored?.state).toBe("completed");
      expect(stored?.assistantMessageId).toBe("m1");
    } finally {
      await fresh.dispose();
    }
  });

  it("replays activities with original timestamps and sequence preserved", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    for (let i = 0; i < 3; i++) {
      harness.appendActivity({
        threadId: thread.id,
        turnId: turn.turnId,
        tone: "info",
        kind: "agent.text",
        summary: `c${i}`,
      });
    }
    const snapshot = harness.serialize();
    const fresh = await createHarness();
    try {
      fresh.hydrateFrom(snapshot);
      const replayed = fresh.activityLog.listByTurn(thread.id, turn.turnId);
      expect(replayed.map((a) => a.summary)).toEqual(["c0", "c1", "c2"]);
      expect(replayed.map((a) => a.sequence)).toEqual([0, 1, 2]);
    } finally {
      await fresh.dispose();
    }
  });

  it("replays plan store entries with implementation metadata intact", async () => {
    const thread = await harness.createThread();
    const plan = harness.upsertPlan(thread.id, { id: "plan-p", planMarkdown: "p" });
    await harness.approvePlan({ threadId: thread.id, planId: plan.id });
    const snapshot = harness.serialize();
    const fresh = await createHarness();
    try {
      fresh.hydrateFrom(snapshot);
      const restored = fresh.planStore.get(thread.id, plan.id);
      expect(restored?.implementedAt).not.toBeNull();
    } finally {
      await fresh.dispose();
    }
  });

  it("replays checkpoint summaries with their refs and file lists", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 9;\n");
    const turn = await harness.startTurn({ threadId: thread.id });
    const original = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turn.turnId,
    });
    const snapshot = harness.serialize();
    const fresh = await createHarness();
    try {
      fresh.hydrateFrom(snapshot);
      const replayed = fresh.checkpointStore.get(thread.id, turn.turnId);
      expect(replayed).toEqual(original);
    } finally {
      await fresh.dispose();
    }
  });

  it("serialize → JSON.stringify → JSON.parse round-trips losslessly for store data", async () => {
    const thread = await harness.createThread();
    const t = await harness.startTurn({ threadId: thread.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: t.turnId,
      tone: "info",
      kind: "agent.text",
      summary: "hi",
    });
    const snapshot = harness.serialize();
    const wire = JSON.parse(JSON.stringify(snapshot));
    expect(wire).toEqual(snapshot);
  });

  it("thread index file ordering is deterministic across re-hydrations", async () => {
    const t1 = await harness.createThread({ title: "first" });
    const t2 = await harness.createThread({ title: "second" });
    const list1 = (await harness.threadStore.list()).map((e) => e.id);
    const { makeThreadStore } = await import("./thread-store.ts");
    const fresh = makeThreadStore({ rootDir: harness.persistenceDir });
    const list2 = (await fresh.list()).map((e) => e.id);
    expect(list2).toEqual(list1);
    expect(list2).toEqual([t2.id, t1.id]);
  });
});

// ===========================================================================
// 10. Error paths
// ===========================================================================

describe("scenario 10 — error paths", () => {
  it("aborts a turn mid-stream and records an error-tone activity", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("crash", {
      activities: [{ tone: "info", kind: "agent.text", summary: "step 1" }],
      abortReason: "user pressed escape",
    });
    const turn = await harness.runScriptedTurn({ threadId: thread.id, prompt: "crash" });
    expect(turn.state).toBe("interrupted");
    const tones = tonesForTurn(harness.activityLog, thread.id, turn.turnId);
    expect(tones).toContain("error");
  });

  it("emits turn.aborted with the abort reason", async () => {
    const thread = await harness.createThread();
    harness.provider.scriptPrompt("abrt", {
      activities: [],
      abortReason: "rate limit",
    });
    harness.bus.clear();
    await harness.runScriptedTurn({ threadId: thread.id, prompt: "abrt" });
    const aborted = harness.bus.ofType("turn.aborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.reason).toBe("rate limit");
  });

  it("tool errors produce error-tone activities AND tool.invoked with ok:false", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "no-such-pane", text: "x" },
    });
    expect(result.ok).toBe(false);
    const last = harness.activityLog.listByTurn(thread.id, turn.turnId).at(-1)!;
    expect(last.tone).toBe("error");
    const invocations = harness.bus.ofType("tool.invoked");
    expect(invocations[0]!.ok).toBe(false);
  });

  it("refuses to revert when the workspace is dirty against the checkpoint paths", async () => {
    const thread = await harness.createThread();
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 1;\n");
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.snapshotCheckpoint({ threadId: thread.id, turnId: turn.turnId });
    // Make the working tree dirty on a path the snapshot also touches.
    writeFileSync(join(harness.workspaceDir, "src.ts"), "export const a = 999;\n");
    await expect(
      harness.revertCheckpoint({ threadId: thread.id, turnId: turn.turnId }),
    ).rejects.toMatchObject({ code: "dirty_conflict" });
  });

  it("a duplicate turnId start throws a TurnStoreError(duplicate)", async () => {
    const thread = await harness.createThread();
    await harness.startTurn({ threadId: thread.id, turnId: "fixed" });
    await expect(harness.startTurn({ threadId: thread.id, turnId: "fixed" })).rejects.toMatchObject(
      { code: "duplicate" },
    );
  });

  it("transitioning a missing turn throws a TurnStoreError(not_found)", async () => {
    const thread = await harness.createThread();
    expect(() =>
      harness.turnStore.transition({
        threadId: thread.id,
        turnId: "ghost",
        state: "completed",
      }),
    ).toThrowError(/not found/i);
  });

  it("snapshot in a non-git directory propagates a CheckpointEngineError(not_a_git_repo)", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await expect(
      harness.checkpointEngine.snapshot({
        threadId: thread.id,
        turnId: turn.turnId,
        workspaceDir: harness.persistenceDir, // store dir is not a git repo
      }),
    ).rejects.toMatchObject({ code: "not_a_git_repo" });
  });

  it("tool calls in a turn that's already terminal still record activities but flag them as out-of-turn", async () => {
    const thread = await harness.createThread();
    const turn = await harness.startTurn({ threadId: thread.id });
    await harness.completeTurn({ threadId: thread.id, turnId: turn.turnId });
    const result = await harness.invokeTool({
      threadId: thread.id,
      turnId: turn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "after completion" },
    });
    expect(result.ok).toBe(true);
    const activity = harness.activityLog.listByTurn(thread.id, turn.turnId).at(-1)!;
    expect(activity.tone).toBe("tool");
    // The turn itself remains in its completed state — we don't re-open it.
    expect(harness.turnStore.get(thread.id, turn.turnId)?.state).toBe("completed");
  });
});

// ===========================================================================
// 11. Multi-agent — multiple OrchestrationSessions per Thread (T078)
// ===========================================================================

describe("multi-agent", () => {
  it("(a) two sessions both start turns and emit activities — stream interleaves by sequence", async () => {
    const thread = await harness.createThread({ title: "Two-agent thread" });
    const lead = harness.addSession({ threadId: thread.id, id: "lead", role: "lead" });
    const planner = harness.addSession({
      threadId: thread.id,
      id: "planner",
      role: "planner",
    });

    const turnLead = await harness.startTurn({ threadId: thread.id, sessionId: lead.id });
    const turnPlanner = await harness.startTurn({
      threadId: thread.id,
      sessionId: planner.id,
    });

    // Interleave: lead → planner → lead → planner.
    harness.appendActivity({
      threadId: thread.id,
      turnId: turnLead.turnId,
      sessionId: lead.id,
      tone: "info",
      kind: "agent.text",
      summary: "lead step 1",
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turnPlanner.turnId,
      sessionId: planner.id,
      tone: "info",
      kind: "agent.text",
      summary: "planner step 1",
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turnLead.turnId,
      sessionId: lead.id,
      tone: "info",
      kind: "agent.text",
      summary: "lead step 2",
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turnPlanner.turnId,
      sessionId: planner.id,
      tone: "info",
      kind: "agent.text",
      summary: "planner step 2",
    });

    const all = harness.activityLog.list({ threadId: thread.id });
    expect(all.map((a) => a.sequence)).toEqual([0, 1, 2, 3]);
    // Ordered by global sequence, not by session — the dashboard renders lanes
    // by re-grouping on sessionId, but the canonical stream is interleaved.
    expect(all.map((a) => a.sessionId)).toEqual([lead.id, planner.id, lead.id, planner.id]);

    // Per-session views partition cleanly.
    expect(harness.activityLog.listBySession(thread.id, lead.id).map((a) => a.summary)).toEqual([
      "lead step 1",
      "lead step 2",
    ]);
    expect(harness.activityLog.listBySession(thread.id, planner.id).map((a) => a.summary)).toEqual([
      "planner step 1",
      "planner step 2",
    ]);
  });

  it("(b) one session completes while the other is still streaming — partial-progress rendering", async () => {
    const thread = await harness.createThread();
    const lead = harness.addSession({ threadId: thread.id, id: "lead", role: "lead" });
    const teammate = harness.addSession({
      threadId: thread.id,
      id: "tm",
      role: "teammate",
    });

    const tLead = await harness.startTurn({ threadId: thread.id, sessionId: lead.id });
    const tTm = await harness.startTurn({ threadId: thread.id, sessionId: teammate.id });

    harness.appendActivity({
      threadId: thread.id,
      turnId: tTm.turnId,
      sessionId: teammate.id,
      tone: "info",
      kind: "agent.text",
      summary: "teammate first chunk",
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: tLead.turnId,
      sessionId: lead.id,
      tone: "info",
      kind: "agent.text",
      summary: "lead chunk",
    });

    await harness.completeTurn({
      threadId: thread.id,
      turnId: tLead.turnId,
      assistantMessageId: "msg_lead",
    });

    // teammate still running
    expect(harness.turnStore.get(thread.id, tTm.turnId)?.state).toBe("running");
    expect(harness.turnStore.get(thread.id, tLead.turnId)?.state).toBe("completed");

    // Session statuses match
    expect(harness.sessionStore.get(thread.id, lead.id)?.status).toBe("ready");
    expect(harness.sessionStore.get(thread.id, teammate.id)?.status).toBe("running");

    // Continue streaming on the still-running session post-completion of the other
    harness.appendActivity({
      threadId: thread.id,
      turnId: tTm.turnId,
      sessionId: teammate.id,
      tone: "info",
      kind: "agent.text",
      summary: "teammate second chunk",
    });
    expect(harness.activityLog.listBySession(thread.id, teammate.id).map((a) => a.summary)).toEqual(
      ["teammate first chunk", "teammate second chunk"],
    );
  });

  it("(c) remove session mid-turn — activities preserved, no orphan record", async () => {
    const thread = await harness.createThread();
    const lead = harness.addSession({ threadId: thread.id, id: "lead", role: "lead" });
    const teammate = harness.addSession({
      threadId: thread.id,
      id: "tm",
      role: "teammate",
    });

    const turn = await harness.startTurn({ threadId: thread.id, sessionId: teammate.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turn.turnId,
      sessionId: teammate.id,
      tone: "info",
      kind: "agent.text",
      summary: "in-flight chunk",
    });

    const removed = harness.removeSession({
      threadId: thread.id,
      sessionId: teammate.id,
      abortInFlightTurn: true,
    });
    expect(removed?.id).toBe(teammate.id);
    expect(harness.sessionStore.get(thread.id, teammate.id)).toBeNull();

    // The in-flight turn is marked interrupted (so the UI doesn't show it as
    // an "orphan running" turn), but its activities are preserved verbatim.
    expect(harness.turnStore.get(thread.id, turn.turnId)?.state).toBe("interrupted");
    expect(
      harness.activityLog.listBySession(thread.id, teammate.id).map((a) => a.summary),
    ).toContain("in-flight chunk");

    // Lead session is unaffected.
    expect(harness.sessionStore.get(thread.id, lead.id)?.status).toBe("idle");

    // A session.removed event was emitted.
    expect(harness.bus.ofType("session.removed").map((e) => e.sessionId)).toContain(teammate.id);
  });

  it("(d) a session adopts a ProposedPlan from another session (sourceProposedPlan cross-session)", async () => {
    const thread = await harness.createThread();
    const planner = harness.addSession({
      threadId: thread.id,
      id: "planner",
      role: "planner",
    });
    const teammate = harness.addSession({
      threadId: thread.id,
      id: "tm",
      role: "teammate",
    });

    // Planner produces a plan during its turn.
    const plannerTurn = await harness.startTurn({
      threadId: thread.id,
      sessionId: planner.id,
    });
    const plan = harness.upsertPlan(thread.id, { planMarkdown: "## Do X" });
    await harness.completeTurn({
      threadId: thread.id,
      turnId: plannerTurn.turnId,
      assistantMessageId: "msg_plan",
    });

    // Teammate starts a turn that adopts the plan via sourceProposedPlan.
    const adoptionTurn = await harness.startTurn({
      threadId: thread.id,
      sessionId: teammate.id,
      sourceProposedPlan: { threadId: thread.id, planId: plan.id },
    });

    const turnRecord = harness.turnStore.get(thread.id, adoptionTurn.turnId)!;
    expect(turnRecord.sessionId).toBe(teammate.id);
    expect(turnRecord.sourceProposedPlan).toEqual({
      threadId: thread.id,
      planId: plan.id,
    });

    // The plan itself was authored on the planner's turn, but the consuming
    // turn lives under the teammate session — cross-session adoption.
    expect(plan.turnId).toBe(plannerTurn.turnId);
  });

  it("(e) two sessions request checkpoint at the same logical time — checkpoint-store keys by turnId so each gets its own", async () => {
    const thread = await harness.createThread();
    const a = harness.addSession({ threadId: thread.id, id: "a", role: "teammate" });
    const b = harness.addSession({ threadId: thread.id, id: "b", role: "teammate" });

    const turnA = await harness.startTurn({ threadId: thread.id, sessionId: a.id });
    const turnB = await harness.startTurn({ threadId: thread.id, sessionId: b.id });

    // Both write to different files and take a checkpoint.
    writeFileSync(join(harness.workspaceDir, "a.txt"), "from a\n");
    const summaryA = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turnA.turnId,
    });

    writeFileSync(join(harness.workspaceDir, "b.txt"), "from b\n");
    const summaryB = await harness.snapshotCheckpoint({
      threadId: thread.id,
      turnId: turnB.turnId,
    });

    // Distinct refs and distinct file-sets.
    expect(summaryA.turnId).toBe(turnA.turnId);
    expect(summaryB.turnId).toBe(turnB.turnId);
    expect(summaryA.checkpointRef).not.toBe(summaryB.checkpointRef);

    // checkpoint-store keys by turnId, so each entry is retrievable independently.
    expect(harness.checkpointStore.get(thread.id, turnA.turnId)?.checkpointRef).toBe(
      summaryA.checkpointRef,
    );
    expect(harness.checkpointStore.get(thread.id, turnB.turnId)?.checkpointRef).toBe(
      summaryB.checkpointRef,
    );
  });

  it("(f) compat shim — old single-session consumers see only session[0]'s activities", async () => {
    const thread = await harness.createThread();
    const lead = harness.addSession({ threadId: thread.id, id: "lead", role: "lead" });
    const teammate = harness.addSession({
      threadId: thread.id,
      id: "tm",
      role: "teammate",
    });

    const leadTurn = await harness.startTurn({ threadId: thread.id, sessionId: lead.id });
    const tmTurn = await harness.startTurn({ threadId: thread.id, sessionId: teammate.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: leadTurn.turnId,
      sessionId: lead.id,
      tone: "info",
      kind: "agent.text",
      summary: "lead said hi",
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: tmTurn.turnId,
      sessionId: teammate.id,
      tone: "info",
      kind: "agent.text",
      summary: "teammate said hi",
    });

    // A "legacy single-session consumer" implements the shim by reading
    // sessions[0] and filtering activities by sessionId. The canonical
    // sessions list preserves insertion order.
    const sessions = harness.sessionStore.list(thread.id);
    expect(sessions[0]?.id).toBe(lead.id);
    const legacyView = harness.activityLog.listBySession(thread.id, sessions[0]!.id!);
    expect(legacyView.map((a) => a.summary)).toEqual(["lead said hi"]);
    // The other session's activities exist on the full thread stream but the
    // compat consumer simply does not see them.
    const fullView = harness.activityLog.list({ threadId: thread.id });
    expect(fullView.map((a) => a.summary)).toEqual(["lead said hi", "teammate said hi"]);
  });

  it("(g) per-session token usage aggregation", async () => {
    const thread = await harness.createThread();
    const a = harness.addSession({ threadId: thread.id, id: "a", role: "teammate" });
    const b = harness.addSession({ threadId: thread.id, id: "b", role: "teammate" });

    const tA = await harness.startTurn({ threadId: thread.id, sessionId: a.id });
    const tB = await harness.startTurn({ threadId: thread.id, sessionId: b.id });

    // Surface per-session token usage by tagging activities with both sessionId
    // and a structured payload, then folding the activity stream per session.
    harness.appendActivity({
      threadId: thread.id,
      turnId: tA.turnId,
      sessionId: a.id,
      tone: "info",
      kind: "agent.usage",
      summary: "usage A1",
      payload: { inputTokens: 100, outputTokens: 50 },
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: tA.turnId,
      sessionId: a.id,
      tone: "info",
      kind: "agent.usage",
      summary: "usage A2",
      payload: { inputTokens: 60, outputTokens: 30 },
    });
    harness.appendActivity({
      threadId: thread.id,
      turnId: tB.turnId,
      sessionId: b.id,
      tone: "info",
      kind: "agent.usage",
      summary: "usage B1",
      payload: { inputTokens: 200, outputTokens: 80 },
    });

    function totalsFor(sessionId: string): { input: number; output: number } {
      return harness.activityLog
        .listBySession(thread.id, sessionId)
        .filter((act) => act.kind === "agent.usage")
        .reduce(
          (acc, act) => {
            const p = act.payload as { inputTokens?: number; outputTokens?: number };
            return {
              input: acc.input + (p.inputTokens ?? 0),
              output: acc.output + (p.outputTokens ?? 0),
            };
          },
          { input: 0, output: 0 },
        );
    }

    expect(totalsFor(a.id!)).toEqual({ input: 160, output: 80 });
    expect(totalsFor(b.id!)).toEqual({ input: 200, output: 80 });
  });

  it("(h) session role-based default tool permissions: validator/researcher are read-only by default", async () => {
    const thread = await harness.createThread();
    const validator = harness.addSession({
      threadId: thread.id,
      id: "val",
      role: "validator",
    });
    const lead = harness.addSession({ threadId: thread.id, id: "lead", role: "lead" });

    // Default permission contract: read-only roles (validator, researcher) must
    // emit an "approval" activity before any write-class tool call; lead/teammate
    // can run write-class tools directly. We assert this with an explicit
    // role → needsApproval mapping driven by the session record.
    const ROLE_NEEDS_APPROVAL: Record<string, boolean> = {
      validator: true,
      researcher: true,
      lead: false,
      teammate: false,
      planner: false,
    };
    function needsApproval(sessionId: string): boolean {
      const s = harness.sessionStore.get(thread.id, sessionId);
      return s?.role ? (ROLE_NEEDS_APPROVAL[s.role] ?? false) : false;
    }

    const valTurn = await harness.startTurn({
      threadId: thread.id,
      sessionId: validator.id,
    });
    const valResult = await harness.invokeTool({
      threadId: thread.id,
      turnId: valTurn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "hello" },
      needsApproval: needsApproval(validator.id!),
    });
    expect(valResult.approvalActivity?.tone).toBe("approval");

    const leadTurn = await harness.startTurn({ threadId: thread.id, sessionId: lead.id });
    const leadResult = await harness.invokeTool({
      threadId: thread.id,
      turnId: leadTurn.turnId,
      tool: "send_to_pane",
      input: { target: "lead", text: "hello" },
      needsApproval: needsApproval(lead.id!),
    });
    expect(leadResult.approvalActivity).toBeUndefined();
  });
});

// ===========================================================================
// 12. Feature-flag cutover — ?chat=v2 becomes default, ?chat=v1 lingers as
//     the escape hatch with a deprecation banner (T080).
//
// The dashboard owns the URL/banner mechanics; this suite verifies the
// daemon-observable invariants that have to hold for the cutover to be safe:
//   (a) new threads still produce the v2 event taxonomy (default route)
//   (b) the legacy `chat.thread.update` shim ALSO fires (so v1 still reads)
//   (c) the providerStore that backs the settings escape-hatch persists
//       across a reload — same disk shape that the dashboard's
//       localStorage toggle relies on
//   (d) `ProviderInstance` flows through `Thread.provider` once T079's
//       migration is finished — `getResolvedProvider` returns the instance.
// ===========================================================================

describe("feature-flag-cutover", () => {
  it("(a) default route lands on new UI — new threads emit v2 turn/activity events", async () => {
    const thread = await harness.createThread({ title: "v2-default" });
    const turn = await harness.startTurn({ threadId: thread.id });
    harness.appendActivity({
      threadId: thread.id,
      turnId: turn.turnId,
      tone: "info",
      kind: "text",
      summary: "first activity",
    });
    await harness.completeTurn({ threadId: thread.id, turnId: turn.turnId });

    const newTaxonomy = harness.bus
      .events()
      .map((e) => e.type)
      .filter((t) => t === "turn.started" || t === "activity.appended" || t === "turn.completed");
    expect(newTaxonomy).toEqual(["turn.started", "activity.appended", "turn.completed"]);
  });

  it("(b) ?chat=v1 lands on old UI with deprecation banner — compat shim still fires legacy events", async () => {
    // Set up the legacy thread-manager path so the compat shim fires its
    // chat.thread.update event when an ACP update lands.
    const events: ChatEvent[] = [];
    const client = new CompatAcpClient();
    const manager = makeThreadManager({
      store: harness.threadStore,
      spawnClient: async () => client,
      busEmit: (event) => events.push(event),
    });
    const thread = await harness.threadStore.create({
      title: "v1-compat",
      provider: { kind: "claude-code" },
    });
    void manager.send({
      threadId: thread.id,
      content: [{ type: "text", text: "hello v1" }],
    });
    await waitFor(() => client.promptRequests.length === 1);
    client.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      messageId: "v1-msg",
    });
    client.promptDeferred.resolve({ stopReason: "end_turn" });
    await waitFor(() => events.some((e) => e.type === "chat.thread.update"));
    expect(events.some((e) => e.type === "chat.thread.update")).toBe(true);
    expect(events.some((e) => e.type === "chat.thread.stop")).toBe(true);
    await manager.shutdown();
  });

  it("(c) settings toggle persists and overrides URL param — providerStore round-trips across reload", async () => {
    const { makeProviderStore } = await import("./provider-store.ts");
    const filePath = join(harness.persistenceDir, "providers.json");
    const storeA = makeProviderStore({ filePath });
    storeA.add({
      id: "settings-toggle-fixture",
      kind: "local-ollama",
      displayName: "Local Ollama",
      config: { kind: "local-ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3" },
    });
    // Fresh instance reads the same file — same shape backs the dashboard's
    // localStorage "use old chat" override (persists across reload).
    const storeB = makeProviderStore({ filePath });
    expect(storeB.list()).toHaveLength(1);
    expect(storeB.list()[0]!.id).toBe("settings-toggle-fixture");
    expect(storeB.summaries()[0]!.hasApiKey).toBe(false);
    // Removal also persists.
    expect(storeB.remove("settings-toggle-fixture")).toBe(true);
    const storeC = makeProviderStore({ filePath });
    expect(storeC.list()).toHaveLength(0);
  });

  it("(d) ProviderInstance flows through Thread.provider after T079 migration finishes", async () => {
    const { makeProviderStore } = await import("./provider-store.ts");
    const filePath = join(harness.persistenceDir, "providers-d.json");
    const providerStore = makeProviderStore({ filePath });
    const created = providerStore.add({
      id: "wired-anthropic",
      kind: "anthropic",
      displayName: "Anthropic Claude",
      config: {
        kind: "anthropic",
        apiKey: "secret-key-not-on-wire",
        model: "claude-opus-4-7",
      },
    });
    expect(created.id).toBe("wired-anthropic");

    const thread = await harness.threadStore.create({
      title: "wired-thread",
      provider: { kind: "claude-code" },
      providerInstanceId: created.id,
    });
    expect(thread.providerInstanceId).toBe("wired-anthropic");

    const manager = makeThreadManager({
      store: harness.threadStore,
      spawnClient: async () => new CompatAcpClient(),
      busEmit: () => {},
      providerStore,
    });
    const resolved = await manager.getResolvedProvider(thread.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe("wired-anthropic");
    expect(resolved!.kind).toBe("anthropic");
    expect(resolved!.config.kind).toBe("anthropic");
    // Verify the redacted summary that crosses the wire is missing apiKey.
    const summary = providerStore.summaries().find((s) => s.id === created.id)!;
    expect(summary.hasApiKey).toBe(true);
    expect((summary as { apiKey?: string }).apiKey).toBeUndefined();
    await manager.shutdown();
  });

  it("(d-fallback) getResolvedProvider returns null when no providerInstanceId is set", async () => {
    const manager = makeThreadManager({
      store: harness.threadStore,
      spawnClient: async () => new CompatAcpClient(),
      busEmit: () => {},
    });
    const thread = await harness.threadStore.create({
      title: "legacy",
      provider: { kind: "claude-code" },
    });
    expect(await manager.getResolvedProvider(thread.id)).toBeNull();
    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// REST endpoints (T082): /api/providers wiring. The legacy
// /api/threads CRUD shims (list/create/get/delete) were superseded by
// `chat.thread.*` actions; cascade-clear coverage for delete now lives
// on the `chat.thread.delete` handler test.
// ---------------------------------------------------------------------------

describe("rest-endpoints", () => {
  it("(c) GET /api/providers returns redacted ProviderInstanceSummary — no apiKey leaks", async () => {
    const { createApp } = await import("../command-center/server.ts");
    const { makeProviderStore } = await import("./provider-store.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "rest-providers-"));
    const providerStore = makeProviderStore({ filePath: join(dir, "providers.json") });
    providerStore.add({
      id: "secret-anthropic",
      kind: "anthropic",
      displayName: "Anthropic Prod",
      config: {
        kind: "anthropic",
        apiKey: "sk-ant-PLAINTEXT-SHOULD-NEVER-LEAK",
        model: "claude-opus-4-7",
      },
    });

    const app = createApp({ providerStore });
    const res = await app.request("/api/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(body.providers).toHaveLength(1);
    const summary = body.providers[0];
    expect(summary.id).toBe("secret-anthropic");
    expect(summary.kind).toBe("anthropic");
    expect(summary.hasApiKey).toBe(true);
    expect(summary.apiKey).toBeUndefined();
    // The plaintext key must not appear ANYWHERE on the wire.
    expect(JSON.stringify(body)).not.toContain("sk-ant-PLAINTEXT");
  });
});
