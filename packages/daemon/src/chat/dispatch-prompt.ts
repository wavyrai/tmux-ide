/**
 * Prompt dispatch — fire-and-forget glue that runs an ACP/Codex prompt,
 * flushes the per-thread pipe, and broadcasts the `chat.thread.stop`
 * event with the resolved stop reason. Extracted so thread-manager.ts
 * doesn't need to inline two near-identical try/catch blocks.
 */

import type { ContentBlock, StopReason } from "../acp/index.ts";
import type { AcpClient } from "../acp/index.ts";
import type { CodexClient, ReasoningEffort, SendUserMessageResponse } from "../codex/index.ts";
import type { ChatEvent } from "./types.ts";
import type { ThreadStore } from "./thread-store.ts";
import { codexInputFromContent, stopReasonFromResponse } from "./codex-helpers.ts";
import type { MessagePipe } from "./message-pipe.ts";

/** Recognized reasoning-effort levels (codex). Includes `xhigh` per
 *  t3's CodexProvider.ts:96-137. Unrecognized values pass through
 *  unchanged — codex will reject anything it doesn't know. */
const KNOWN_REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
function asReasoningEffort(value: string): ReasoningEffort | null {
  return (KNOWN_REASONING_EFFORTS as string[]).includes(value) ? (value as ReasoningEffort) : null;
}

export type Logger = (event: {
  level: "info" | "warn" | "error";
  msg: string;
  data?: unknown;
}) => void;

export interface CodexActivePrompt {
  promptId: string;
  turnId: string | null;
  resolve: (stopReason: StopReason) => void;
}

export interface DispatchCodexInput {
  threadId: string;
  codexThreadId: string;
  pipe: MessagePipe;
  client: CodexClient;
  busEmit: (event: ChatEvent) => void;
  store: Pick<ThreadStore, "recordStopReason">;
  logger: Logger;
  /** Mutated to track the running prompt — cleared on completion / error. */
  bindActivePrompt(active: CodexActivePrompt | null): void;
  /** Read the current active prompt so we can ignore stale errors. */
  readActivePrompt(): CodexActivePrompt | null;
  promptId: string;
  content: ContentBlock[];
  /**
   * Per-turn model. Forwarded as `model` on Codex's `sendUserMessage`
   * — Codex applies the model to this turn without re-creating the
   * conversation.
   */
  model?: string;
  /**
   * Per-turn reasoning effort (Codex `effort`). When omitted, Codex
   * applies the model's `defaultReasoningEffort`. Mirrors t3's
   * `CodexAdapter.ts:1509-1530` wire — the daemon forwards only when
   * the value is present and known.
   */
  reasoningEffort?: string;
  /**
   * Per-turn fast-mode opt-in. Forwarded as `serviceTier: "fast"`
   * (Codex's "additionalSpeedTier") when true. Skipped otherwise so
   * Codex uses the standard tier.
   */
  fastMode?: boolean;
}

export async function dispatchCodexPrompt(input: DispatchCodexInput): Promise<void> {
  const completed = new Promise<StopReason>((resolve) => {
    input.bindActivePrompt({ promptId: input.promptId, turnId: null, resolve });
  });
  try {
    const effortLevel = input.reasoningEffort ? asReasoningEffort(input.reasoningEffort) : null;
    const response: SendUserMessageResponse = await input.client.sendUserMessage({
      threadId: input.codexThreadId,
      input: codexInputFromContent(input.content),
      ...(input.model ? { model: input.model } : {}),
      ...(effortLevel ? { effort: effortLevel } : {}),
      ...(input.fastMode ? { serviceTier: "fast" } : {}),
    });
    const active = input.readActivePrompt();
    if (active?.promptId === input.promptId) {
      input.bindActivePrompt({ ...active, turnId: response.turn.id });
    }
    const stopReason = await completed;
    await input.pipe.forceFlush();
    input.busEmit({
      type: "chat.thread.stop",
      threadId: input.threadId,
      promptId: input.promptId,
      stopReason,
    });
    input.pipe.finishTimeline(input.promptId, stopReason);
    await input.store.recordStopReason(input.threadId, stopReason);
  } catch (err) {
    if (input.readActivePrompt()?.promptId === input.promptId) input.bindActivePrompt(null);
    input.logger({
      level: "warn",
      msg: "Codex prompt failed",
      data: { threadId: input.threadId, error: (err as Error).message ?? String(err) },
    });
    await input.pipe.forceFlush();
    input.busEmit({
      type: "chat.thread.stop",
      threadId: input.threadId,
      promptId: input.promptId,
      stopReason: "refusal",
    });
    input.pipe.finishTimeline(input.promptId, "refusal");
    await input.store.recordStopReason(input.threadId, "refusal").catch(() => undefined);
  }
}

export interface DispatchAcpInput {
  threadId: string;
  sessionId: string;
  pipe: MessagePipe;
  client: AcpClient;
  busEmit: (event: ChatEvent) => void;
  store: Pick<ThreadStore, "recordStopReason">;
  logger: Logger;
  promptId: string;
  content: ContentBlock[];
  /**
   * Per-turn model. Surfaced on `PromptRequest._meta.model` — claude-code-acp
   * ignores `_meta` keys it doesn't recognize, so this is a safe channel for
   * surfacing the selection to the agent (and for the e2e harness to assert
   * the daemon applied it).
   */
  model?: string;
  /** Per-turn reasoning effort (currently a no-op on the ACP side —
   *  surfaced on `_meta` so future claude-code-acp builds can pick it
   *  up without a contract change). */
  reasoningEffort?: string;
  /** Per-turn fast-mode opt-in (no-op on ACP today; same rationale as
   *  reasoningEffort). */
  fastMode?: boolean;
}

export async function dispatchAcpPrompt(input: DispatchAcpInput): Promise<void> {
  try {
    const meta: Record<string, unknown> = {};
    if (input.model) meta.model = input.model;
    if (input.reasoningEffort) meta.reasoningEffort = input.reasoningEffort;
    if (input.fastMode) meta.fastMode = true;
    const response = await input.client.prompt({
      sessionId: input.sessionId,
      prompt: input.content,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
    const stopReason = stopReasonFromResponse(response);
    await input.pipe.forceFlush();
    input.busEmit({
      type: "chat.thread.stop",
      threadId: input.threadId,
      promptId: input.promptId,
      stopReason,
    });
    input.pipe.finishTimeline(input.promptId, stopReason);
    await input.store.recordStopReason(input.threadId, stopReason);
  } catch (err) {
    input.logger({
      level: "warn",
      msg: "ACP prompt failed",
      data: { threadId: input.threadId, error: (err as Error).message ?? String(err) },
    });
    await input.pipe.forceFlush();
    input.busEmit({
      type: "chat.thread.stop",
      threadId: input.threadId,
      promptId: input.promptId,
      stopReason: "refusal",
    });
    input.pipe.finishTimeline(input.promptId, "refusal");
    await input.store.recordStopReason(input.threadId, "refusal").catch(() => undefined);
  }
}
