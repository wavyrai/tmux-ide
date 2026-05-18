/**
 * Prompt dispatch — fire-and-forget glue that runs an ACP/Codex prompt,
 * flushes the per-thread pipe, and broadcasts the `chat.thread.stop`
 * event with the resolved stop reason. Extracted so thread-manager.ts
 * doesn't need to inline two near-identical try/catch blocks.
 */

import type { ContentBlock, StopReason } from "../acp/index.ts";
import type { AcpClient } from "../acp/index.ts";
import type { CodexClient, SendUserMessageResponse } from "../codex/index.ts";
import type { ChatEvent } from "./types.ts";
import type { ThreadStore } from "./thread-store.ts";
import { codexInputFromContent, stopReasonFromResponse } from "./codex-helpers.ts";
import type { MessagePipe } from "./message-pipe.ts";

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
}

export async function dispatchCodexPrompt(input: DispatchCodexInput): Promise<void> {
  const completed = new Promise<StopReason>((resolve) => {
    input.bindActivePrompt({ promptId: input.promptId, turnId: null, resolve });
  });
  try {
    const response: SendUserMessageResponse = await input.client.sendUserMessage({
      threadId: input.codexThreadId,
      input: codexInputFromContent(input.content),
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
}

export async function dispatchAcpPrompt(input: DispatchAcpInput): Promise<void> {
  try {
    const response = await input.client.prompt({
      sessionId: input.sessionId,
      prompt: input.content,
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
