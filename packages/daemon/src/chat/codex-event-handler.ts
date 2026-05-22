/**
 * Codex agent-event handler — translates the raw Codex client events
 * into SessionUpdate emits + turn lifecycle calls. Extracted from
 * thread-manager.ts so the manager doesn't need a 100-line switch on
 * provider-specific method names.
 */

import type { SessionUpdate } from "../acp/index.ts";
import type { CodexAgentEvent } from "../codex/index.ts";
import { CLIENT_METHODS as CODEX_CLIENT_METHODS } from "../codex/methods.ts";
import {
  codexErrorMessage,
  codexMeta,
  isCodexFinalAgentMessageItem,
  translateCodexItemCompleted,
} from "./codex-helpers.ts";
import { extractUsagePatch, type UsagePatch } from "./usage-extraction.ts";

export interface CodexEventDeps {
  /** The thread's session id as it appears on outgoing SessionUpdates. */
  sessionId: string;
  /** Emit a SessionUpdate through the thread's message pipe. */
  emitUpdate(update: SessionUpdate): void;
  /** Record token usage extracted from the event payload. */
  recordUsage(patch: UsagePatch | null): void;
  /** Resolve the active prompt with a stop reason (optionally turn-scoped). */
  resolveActivePrompt(stopReason: "end_turn" | "refusal", turnId?: string): void;
}

export function handleCodexAgentEvent(event: CodexAgentEvent, deps: CodexEventDeps): void {
  if (event.method === CODEX_CLIENT_METHODS.turn_started) return;

  if (event.method === CODEX_CLIENT_METHODS.turn_completed) {
    deps.recordUsage(extractUsagePatch(event.params.turn));
    deps.resolveActivePrompt("end_turn", event.params.turn.id);
    return;
  }

  if (event.method === CODEX_CLIENT_METHODS.error) {
    deps.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: codexErrorMessage(event.params) },
      _meta: codexMeta({ error: event.params }),
    });
    deps.resolveActivePrompt("refusal");
    return;
  }

  if (event.method === CODEX_CLIENT_METHODS.item_agent_message_delta) {
    deps.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: event.params.delta },
      messageId: event.params.itemId,
      _meta: codexMeta({ threadId: event.params.threadId, turnId: event.params.turnId }),
    });
    return;
  }

  if (
    event.method === CODEX_CLIENT_METHODS.item_reasoning_summary_text_delta ||
    event.method === CODEX_CLIENT_METHODS.item_reasoning_text_delta
  ) {
    deps.emitUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: event.params.delta },
      messageId: event.params.itemId,
      _meta: codexMeta({ threadId: event.params.threadId, turnId: event.params.turnId }),
    });
    return;
  }

  if (event.method === CODEX_CLIENT_METHODS.item_reasoning_summary_part_added) {
    deps.emitUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "" },
      messageId: event.params.itemId,
      _meta: codexMeta({
        threadId: event.params.threadId,
        turnId: event.params.turnId,
        summaryIndex: event.params.summaryIndex,
      }),
    });
    return;
  }

  if (event.method === CODEX_CLIENT_METHODS.item_completed) {
    const itemType = (event.params.item as { type?: string }).type;
    if (itemType === "userMessage" || itemType === "agentReasoning") return;
    if (itemType === "agentMessage") {
      if (isCodexFinalAgentMessageItem(event.params.item)) {
        deps.resolveActivePrompt("end_turn", event.params.turnId);
      }
      return;
    }
    deps.emitUpdate(translateCodexItemCompleted(event));
  }
}
