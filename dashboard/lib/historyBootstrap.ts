/**
 * t3-aligned transcript bootstrap for LLM-input building.
 *
 * Faithful port of `context/t3code/apps/web/src/historyBootstrap.ts`. Takes
 * prior chat messages + a new user prompt + a character budget, and returns
 * a single string ready to send to a model:
 *
 *   {preamble}\n\n
 *   {transcript header}\n
 *   {[N earlier message(s) omitted ...]}  // only when budget forces truncation
 *
 *   USER:\n{text}\n
 *   ASSISTANT:\n{text}\n
 *   ... newest included messages, oldest-first
 *
 *   {latest-prompt header}\n
 *   {new prompt}
 *
 * Truncation strategy: include the entire transcript when it fits; otherwise
 * drop oldest messages first until the budget is met. If even a single
 * message + prompt overflows, fall back to prompt-only.
 *
 * Use cases in chat-v2:
 *   - Cross-session bootstrapping (T078 — a fresh agent joins a thread
 *     mid-conversation and needs the prior turns as context).
 *   - Thread forks: copy a transcript into a new thread + add a new prompt.
 *   - Agent process restarts: rebuild context after the daemon drops the
 *     ACP session.
 *
 * The shape used here (`ChatMessage`) is intentionally minimal so the
 * utility stays portable. A chat-v2 adapter that maps our `ActivityView` /
 * `TurnSummary` records into this shape lives at the bottom of the file.
 */

import type { ActivityView } from "@/components/chat-v2/useChatStore";

// ---------------------------------------------------------------------------
// Core: t3's buildBootstrapInput
// ---------------------------------------------------------------------------

export type ChatMessageRole = "user" | "assistant";

export interface ChatMessageAttachment {
  type: "image" | string;
  name: string;
}

export interface ChatMessage {
  id?: string;
  role: ChatMessageRole;
  text?: string;
  attachments?: ChatMessageAttachment[];
  createdAt?: string;
}

export interface BootstrapInputResult {
  text: string;
  includedCount: number;
  omittedCount: number;
  truncated: boolean;
}

const BOOTSTRAP_PREAMBLE =
  "Continue this conversation using the transcript context below. The final section is the latest user request to answer now.";
const TRANSCRIPT_HEADER = "Transcript context:";
const LATEST_PROMPT_HEADER = "Latest user request (answer this now):";
const OMITTED_SUMMARY = (count: number) =>
  `[${count} earlier message(s) omitted to stay within input limits.]`;

function messageRoleLabel(message: ChatMessage): "USER" | "ASSISTANT" {
  return message.role === "assistant" ? "ASSISTANT" : "USER";
}

function attachmentSummary(message: ChatMessage): string | null {
  const imageAttachments = message.attachments?.filter((a) => a.type === "image");
  const count = imageAttachments?.length ?? 0;
  if (count === 0) return null;
  const names = imageAttachments?.slice(0, 3).map((a) => a.name) ?? [];
  const namesSummary = names.join(", ");
  const extra = count - names.length;
  const extraSummary = extra > 0 ? ` (+${extra} more)` : "";
  return `[Attached image${count === 1 ? "" : "s"}: ${namesSummary}${extraSummary}]`;
}

function buildMessageBlock(message: ChatMessage): string {
  const text = message.text;
  const attachments = attachmentSummary(message);
  const label = messageRoleLabel(message);
  if (text && attachments) return `${label}:\n${text}\n${attachments}`;
  if (text) return `${label}:\n${text}`;
  if (attachments) return `${label}:\n${attachments}`;
  return `${label}:\n(empty message)`;
}

function finalizeWithPrompt(
  transcriptBody: string,
  latestPrompt: string,
  maxChars: number,
): string | null {
  const text = `${BOOTSTRAP_PREAMBLE}\n\n${TRANSCRIPT_HEADER}\n${transcriptBody}\n\n${LATEST_PROMPT_HEADER}\n${latestPrompt}`;
  return text.length <= maxChars ? text : null;
}

export function buildBootstrapInput(
  previousMessages: ChatMessage[],
  latestPrompt: string,
  maxChars: number,
): BootstrapInputResult {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 1;
  const promptOnly =
    latestPrompt.length <= budget ? latestPrompt : latestPrompt.slice(0, budget);

  if (previousMessages.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: 0,
      truncated: promptOnly.length !== latestPrompt.length,
    };
  }

  const newestFirstBlocks: string[] = [];
  for (let i = previousMessages.length - 1; i >= 0; i -= 1) {
    const message = previousMessages[i];
    if (!message) continue;
    newestFirstBlocks.push(buildMessageBlock(message));
  }

  if (newestFirstBlocks.length === 0) {
    return {
      text: promptOnly,
      includedCount: 0,
      omittedCount: previousMessages.length,
      truncated: true,
    };
  }

  // Greedily include from newest-to-oldest while we still fit the budget.
  let includedNewestFirst: string[] = [];
  for (const block of newestFirstBlocks) {
    const nextNewestFirst = [...includedNewestFirst, block];
    const nextChronological = [...nextNewestFirst].reverse();
    const omittedCount = newestFirstBlocks.length - nextChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? `${OMITTED_SUMMARY(omittedCount)}\n\n${nextChronological.join("\n\n")}`
        : nextChronological.join("\n\n");
    if (!finalizeWithPrompt(transcriptBody, latestPrompt, budget)) break;
    includedNewestFirst = nextNewestFirst;
  }

  // Walk back from oldest-included if the final composition still overflows
  // (covers the edge where adding the omitted-summary line pushes us over).
  let includedChronological = [...includedNewestFirst].reverse();
  while (true) {
    const omittedCount = newestFirstBlocks.length - includedChronological.length;
    const transcriptBody =
      omittedCount > 0
        ? includedChronological.length > 0
          ? `${OMITTED_SUMMARY(omittedCount)}\n\n${includedChronological.join("\n\n")}`
          : OMITTED_SUMMARY(omittedCount)
        : includedChronological.join("\n\n");
    const finalized = finalizeWithPrompt(transcriptBody, latestPrompt, budget);
    if (finalized) {
      return {
        text: finalized,
        includedCount: includedChronological.length,
        omittedCount,
        truncated: omittedCount > 0 || latestPrompt.length !== promptOnly.length,
      };
    }
    if (includedChronological.length === 0) {
      return {
        text: promptOnly,
        includedCount: 0,
        omittedCount: previousMessages.length,
        truncated: true,
      };
    }
    includedChronological = includedChronological.slice(1);
  }
}

// ---------------------------------------------------------------------------
// chat-v2 adapter
//
// Our chat shape is `ActivityView` (granular: tool calls, text chunks,
// approvals, errors) grouped by `turnId`. To build a transcript for an
// LLM, we collapse each turn into one user-block (the request) + one
// assistant-block (the joined response). Activities without text are
// summarized as `[tool: <name>]` so the transcript stays readable.
//
// `requestText` per turn isn't carried on TurnSummary directly today —
// callers that have access to the user-message text should pass it in via
// the `userMessageByTurnId` map. When omitted, the user-block falls back
// to a placeholder so the transcript still shows the turn boundary.
// ---------------------------------------------------------------------------

export interface ActivitiesToMessagesOptions {
  /** Map of turnId → original user prompt text. */
  userMessageByTurnId?: Record<string, string>;
  /** Defaults to "(user prompt)". */
  missingUserPlaceholder?: string;
}

export function activitiesToChatMessages(
  activities: ReadonlyArray<ActivityView>,
  options: ActivitiesToMessagesOptions = {},
): ChatMessage[] {
  const missing = options.missingUserPlaceholder ?? "(user prompt)";
  const byTurn = new Map<string, ActivityView[]>();
  const turnOrder: string[] = [];
  const ambient: ActivityView[] = [];

  for (const activity of activities) {
    if (activity.turnId === null) {
      ambient.push(activity);
      continue;
    }
    let bucket = byTurn.get(activity.turnId);
    if (!bucket) {
      bucket = [];
      byTurn.set(activity.turnId, bucket);
      turnOrder.push(activity.turnId);
    }
    bucket.push(activity);
  }

  // Sort each turn's activities by `sequence` (when present) for a stable
  // chronological order within the turn.
  for (const bucket of byTurn.values()) {
    bucket.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }

  const messages: ChatMessage[] = [];

  // Ambient activities (no turn) come first as informational context.
  for (const activity of ambient) {
    const summary = stringifyActivity(activity);
    if (summary) {
      messages.push({
        id: activity.id,
        role: "assistant",
        text: summary,
        createdAt: activity.createdAt,
      });
    }
  }

  for (const turnId of turnOrder) {
    const bucket = byTurn.get(turnId) ?? [];
    const userText = options.userMessageByTurnId?.[turnId] ?? missing;
    messages.push({
      id: `user:${turnId}`,
      role: "user",
      text: userText,
      createdAt: bucket[0]?.createdAt,
    });
    const assistantText = bucket.map(stringifyActivity).filter(Boolean).join("\n");
    if (assistantText) {
      messages.push({
        id: `assistant:${turnId}`,
        role: "assistant",
        text: assistantText,
        createdAt: bucket[bucket.length - 1]?.createdAt,
      });
    }
  }

  return messages;
}

function stringifyActivity(activity: ActivityView): string {
  // Free-form activities carry their text in `summary`; tool calls get a
  // compact `[tool: kind]` marker so the LLM can see *that* a tool ran
  // without ballooning the transcript with raw JSON payloads.
  if (activity.tone === "tool") {
    return `[tool: ${activity.kind}] ${activity.summary}`.trim();
  }
  if (activity.tone === "error") {
    return `[error] ${activity.summary}`.trim();
  }
  if (activity.tone === "approval") {
    return `[approval] ${activity.summary}`.trim();
  }
  return activity.summary;
}
