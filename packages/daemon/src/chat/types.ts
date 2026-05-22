import type {
  AgentProvider,
  ContentBlock,
  SessionUpdate,
  StopReason,
  ToolCall,
} from "../acp/index.ts";
import type {
  ChatThreadEvent,
  ChatTimelineUpsertEvent,
  ChatTimelineResetEvent,
} from "@tmux-ide/contracts";

export type { AgentProvider, ContentBlock, SessionUpdate, StopReason, ToolCall };
export type { ChatThreadEvent, ChatTimelineUpsertEvent, ChatTimelineResetEvent };

export interface ThreadIndexEntry {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerKind: AgentProvider["kind"];
  projectDir?: string;
  messageCount: number;
  lastStopReason?: StopReason;
}

export interface ThreadState {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: AgentProvider;
  /**
   * Optional reference to a `ProviderInstance` persisted in
   * `~/.tmux-ide/providers.json` (T080). When set, the thread is logically
   * backed by that instance — `provider` remains as the legacy ACP spawn
   * shape until the registry-driven dispatch path replaces it. The wire
   * representation flows through `Thread.session.providerInstanceId`.
   */
  providerInstanceId?: string;
  projectDir?: string;
  acpSessionId?: string;
  usage?: ChatThreadUsageSummary;
  messages: ThreadMessage[];
}

export type ThreadMessage =
  | { _tag: "UserPrompt"; id: string; createdAt: string; content: ContentBlock[] }
  | { _tag: "AgentUpdate"; id: string; createdAt: string; update: SessionUpdate };

export type ChatThreadUpdateEvent = {
  type: "chat.thread.update";
  threadId: string;
  update: SessionUpdate;
  seq: number;
};

export type ChatThreadStopEvent = {
  type: "chat.thread.stop";
  threadId: string;
  promptId: string;
  stopReason: StopReason;
};

export interface ChatThreadUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export type ChatThreadUsageEvent = {
  type: "chat.thread.usage";
  threadId: string;
  usage: ChatThreadUsageSummary;
};

export type ChatThreadIndexEvent = {
  type: "chat.thread.index";
  threads: ThreadIndexEntry[];
};

export type ChatPermissionRequestEvent = {
  type: "chat.permission.request";
  threadId: string;
  requestId: string;
  toolCall: ToolCall;
  options: ReadonlyArray<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
};

/**
 * Daemon-side chat event union. Includes the legacy `chat.thread.*`
 * shapes (kept for compat through T080) AND the t3-style
 * `chat.<aggregate>.<verb>` events from @tmux-ide/contracts. Stores emit
 * the new shapes; the thread-manager keeps emitting the legacy ones in
 * parallel so existing dashboard consumers keep working unchanged.
 */
export type ChatEvent =
  | ChatThreadUpdateEvent
  | ChatThreadStopEvent
  | ChatThreadUsageEvent
  | ChatThreadIndexEvent
  | ChatPermissionRequestEvent
  | ChatTimelineUpsertEvent
  | ChatTimelineResetEvent
  | ChatThreadEvent;
