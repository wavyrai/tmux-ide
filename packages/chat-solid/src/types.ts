import type { MentionCandidate } from "./lib/mentionSearch";
import type { MarkdownFileLinkMeta } from "./lib/markdownLinks";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

export type ComposerAttachment =
  | { kind: "terminal"; paneId: string; paneTitle: string; sessionName: string }
  | { kind: "file"; path: string; label: string };

export interface ComposerTerminalPane {
  paneId: string;
  paneTitle: string;
  sessionName: string;
  currentCommand?: string;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type AgentProvider =
  | { kind: "claude-code"; binary?: string }
  | { kind: "codex"; binary?: string }
  | { kind: "gemini"; binary?: string }
  | { kind: "custom"; command: string; args: string[]; env?: Record<string, string> };

export type ThreadIndexEntry = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerKind: AgentProvider["kind"];
  projectDir?: string;
  messageCount: number;
  lastStopReason?: StopReason;
};

export type ThreadState = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: AgentProvider;
  projectDir?: string;
  acpSessionId?: string;
  usage?: ChatThreadUsageSummary;
  messages: ThreadMessage[];
};

export type ThreadMessage =
  | { _tag: "UserPrompt"; id: string; createdAt: string; content: ContentBlock[] }
  | { _tag: "AgentUpdate"; id: string; createdAt: string; update: SessionUpdate };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type PlanEntry = {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high";
};

export type AvailableCommand = {
  name: string;
  description?: string;
  input?: unknown;
};

export type ToolCall = {
  toolCallId: string;
  title: string;
  kind?: string | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type PermissionRequest = {
  threadId: string;
  requestId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
  receivedAt: number;
};

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock; messageId?: string | null }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock; messageId?: string | null }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock; messageId?: string | null }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title: string;
      kind?: string;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string | null;
      kind?: string | null;
      status?: ToolCallStatus | null;
      content?: ToolCallContent[] | null;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: AvailableCommand[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: string; [k: string]: unknown };

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

export type ChatPermissionRequestEvent = {
  type: "chat.permission.request";
  threadId: string;
  requestId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
};

export type ChatBusEvent =
  | ChatThreadUpdateEvent
  | ChatThreadStopEvent
  | ChatThreadUsageEvent
  | ChatPermissionRequestEvent;

export type ChatMessage =
  | {
      id: string;
      role: "user";
      createdAt: string;
      content: ContentBlock[];
    }
  | {
      id: string;
      role: "assistant";
      createdAt: string;
      completedAt?: string;
      streaming: boolean;
      text: string;
      thoughtText?: string;
      toolCalls: ToolCallView[];
      stopReason?: StopReason;
    };

export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind?: string;
  status: ToolCallStatus;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type MessagesTimelineRow =
  | { kind: "message"; id: string; createdAt: string; message: ChatMessage }
  | { kind: "plan"; id: string; createdAt: string; entries: PlanEntry[] }
  | { kind: "working"; id: string; createdAt: string };

export interface ChatMountOptions {
  threadId: string;
  sessionName: string | null;
  apiBaseUrl: string;
  wsUrl: string;
  bearerToken: string | null;
  /**
   * Optional candidates surfaced by the @-mention autocomplete in the
   * composer. The host owns sourcing — typically files from
   * /api/project/:name/files, sibling threads, and agent panes. Updates
   * flow in via setOptions() on the mount handle. Omit / pass [] to
   * disable the autocomplete (the `@` token still types through).
   */
  mentionCandidates?: ReadonlyArray<MentionCandidate>;
  /**
   * Invoked when the user clicks a file-link `[text](path)` or
   * `[text](file://path)` rendered inside a chat message. The host
   * routes to its file preview / editor view. When omitted, file
   * links still render as styled chips but clicks fall through to
   * the default browser behavior (which is benign — the href is a
   * bare path that the browser won't navigate to).
   */
  onOpenFile?: (meta: MarkdownFileLinkMeta) => void;
  /**
   * Fired when the header's provider picker (or status-banner switch
   * chip) selects a different provider. The host owns the actual
   * switch — typically `chat.thread.create` with the new provider +
   * a redirect to the new thread, since today the daemon doesn't
   * support hot-swapping a provider on an existing thread.
   */
  onProviderChange?: (next: AgentProvider) => void;
  onClose?: () => void;
}

export type { MarkdownFileLinkMeta } from "./lib/markdownLinks";

export interface ChatHandle {
  unmount(): void;
  setThreadId(threadId: string): void;
  /**
   * Merge a partial update onto the live mount options. Used by React
   * hosts (chat-v2 bridge) to push new mentionCandidates / projectDir
   * / callbacks without remounting the Solid runtime. `threadId`
   * accepted here too for parity with setThreadId.
   */
  setOptions(next: Partial<ChatMountOptions>): void;
}
