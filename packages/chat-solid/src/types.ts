import type { Accessor } from "solid-js";
import type { ComposerBannerItem } from "./components/ComposerBannerStack";
import type { PendingUserInput } from "./components/ComposerPendingUserInputPanel";
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
  | { kind: "file"; path: string; label: string }
  | {
      /**
       * Staged image attachment (e.g. pasted-from-clipboard or
       * picked from the OS picker). Carries a data URL so the
       * carousel can render a 56px thumbnail without a fetch; the
       * sender re-encodes it to a ContentBlock on send. Optional
       * `sizeBytes` drives the badge shown in the carousel card
       * footer.
       */
      kind: "image";
      dataUrl: string;
      label: string;
      mimeType?: string;
      sizeBytes?: number;
      width?: number;
      height?: number;
    };

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

/**
 * Wire shape of a daemon-side `ProposedPlan` snapshot. Mirrors the
 * contract in `@tmux-ide/contracts` so chat-solid doesn't import from
 * the contracts package directly (keeps the package self-contained).
 *
 * A plan is "pending" when both `implementedAt` is null *and*
 * `rejected` is absent — the daemon's plan-orchestrator emits a fresh
 * `chat.plan.upserted` event on every state transition so this view
 * stays current.
 */
export interface ProposedPlanSummary {
  id: string;
  turnId: string | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: string | null;
  rejected?: { at: string; reason?: string };
  createdAt: string;
  updatedAt: string;
}

export type ChatPlanUpsertedEvent = {
  type: "chat.plan.upserted";
  threadId: string;
  plan: ProposedPlanSummary;
};

export type ChatBusEvent =
  | ChatThreadUpdateEvent
  | ChatThreadStopEvent
  | ChatThreadUsageEvent
  | ChatPermissionRequestEvent
  | ChatPlanUpsertedEvent;

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

/**
 * One row in the chat transcript. Hosts compute this list and push
 * it to `MessagesTimeline`; the renderer is a pure function of the
 * row variants. Additive optional fields (e.g. work-group entries,
 * completion-divider gate, revert-turn count) keep older callers
 * source-compatible — leave them undefined and the renderer falls
 * back to its plain behavior.
 */
export type MessagesTimelineRow =
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      /**
       * When true, render the "Completed turn" divider directly above
       * this row. Wired by the host (typically tagged onto the first
       * assistant message that closed a turn) so the divider falls
       * between the turn's tool work and its prose conclusion.
       */
      showCompletionDivider?: boolean;
      /**
       * Optional ISO timestamp that scopes the completion divider's
       * duration label to this turn ("Completed in 3.2s"). When
       * unset, the divider falls back to the bare label.
       */
      completionTurnStartedAt?: string;
      /**
       * Number of completed turns that would be rolled back if the
       * user clicked "Revert from here" on this user message. Drives
       * the revert button's visibility + label ("Revert 3 turns").
       * Only meaningful on user messages.
       */
      revertTurnCount?: number;
    }
  | { kind: "plan"; id: string; createdAt: string; entries: PlanEntry[] }
  | { kind: "working"; id: string; createdAt: string }
  | {
      /**
       * Adjacent host-supplied work-log entries collapsed into a
       * single row. The renderer collapses them behind a "Worked on N
       * step(s)" chip with an expand affordance; expanded, each entry
       * lays out as a single-line bullet. Avoids a wall of one-shot
       * rows for repeated read/write/tool steps inside a single
       * assistant turn.
       */
      kind: "work";
      id: string;
      createdAt: string;
      entries: ReadonlyArray<WorkLogEntry>;
    };

/**
 * Single work-log entry rendered inside a `work` row. The shape is
 * intentionally tiny — hosts that don't track sub-kinds can pass
 * `{ id, label }` and get a clean bullet list; hosts that do can
 * pass `kind` and the renderer picks an icon glyph.
 */
export interface WorkLogEntry {
  id: string;
  label: string;
  kind?: "tool" | "file-read" | "file-write" | "terminal" | "thinking";
  status?: "completed" | "in_progress" | "failed";
  createdAt?: string;
}

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
  /**
   * Fired when the header's Delete button is clicked. The host owns
   * the actual delete dispatch (DELETE /api/threads/:id +
   * thread-list reconciliation) plus any destructive-action confirm
   * prompt. Receives the active thread id so the host doesn't have
   * to track it separately. Omit to hide the Delete affordance —
   * chat-solid's header only renders the button when this is
   * provided. The rail-side per-thread delete (ThreadListRail) is
   * an independent surface and stays wired regardless.
   */
  onDelete?: (threadId: string) => void;
  /**
   * Host-supplied banners that surface in the `ComposerBannerStack`
   * alongside the chat surface's own banners (plan follow-up, future
   * approval verdicts, etc). Use this for project-scoped warnings the
   * daemon doesn't model — e.g. "merge freeze in effect",
   * "GROWTHBOOK flag pending review". Returns an empty / missing list
   * to suppress the host contribution without remounting.
   *
   * Stack ordering: chat-surface banners first, host banners appended.
   * Only the first item in the merged list renders with full chrome;
   * the rest collapse to a "+N more" cap.
   */
  bannerItems?: Accessor<ReadonlyArray<ComposerBannerItem>>;
  /**
   * Host-sourced "pick one of these" prompts. Mirrors the
   * `bannerItems` / `mentionCandidates` pattern: the daemon has no
   * chat-bus event for user-input requests today, so the host derives
   * these (e.g. from an orchestration activity stream) and feeds them
   * in. When present, the composer mounts `ComposerPendingUserInputPanel`
   * with 1-9 shortcuts; answering the last question submits the picks
   * as a normal user turn. Empty / omitted hides the panel.
   */
  pendingUserInputs?: Accessor<ReadonlyArray<PendingUserInput>>;
  /**
   * Optional async post-pass over rendered message HTML. chat-solid
   * renders markdown synchronously (marked + DOMPurify, plain
   * `<pre><code class="language-x">` fences); when the host injects
   * this, the timeline upgrades each rendered body to the host's
   * syntax-highlighted HTML once it resolves. The host owns the
   * highlighter (the dashboard passes its shiki pipeline) so
   * chat-solid stays dependency-light and never imports app code.
   */
  highlightCodeFences?: (html: string) => Promise<string>;
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
