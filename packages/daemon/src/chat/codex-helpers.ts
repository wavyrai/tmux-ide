/**
 * Codex-specific translation helpers — extracted from thread-manager.ts.
 *
 * These are the pure functions that translate between our ACP-facing
 * surface and the Codex provider's wire format. The stateful event
 * handler (handleCodexAgentEvent) stays in thread-manager.ts because it
 * needs access to the live thread's mutable state.
 */

import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
  ToolCall,
} from "../acp/index.ts";
import type {
  ApplyPatchApprovalRequest,
  ApplyPatchApprovalResponse,
  CodexAgentEvent,
  UserInput,
} from "../codex/index.ts";
import { CLIENT_METHODS as CODEX_CLIENT_METHODS } from "../codex/methods.ts";

export function stopReasonFromResponse(value: unknown): StopReason {
  const response = value as { stopReason?: unknown; stop_reason?: unknown };
  const reason = response.stopReason ?? response.stop_reason;
  if (
    reason === "end_turn" ||
    reason === "max_tokens" ||
    reason === "max_turn_requests" ||
    reason === "refusal" ||
    reason === "cancelled"
  ) {
    return reason;
  }
  return "end_turn";
}

export function codexInputFromContent(content: ReadonlyArray<ContentBlock>): UserInput[] {
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image" && block.uri) return { type: "image", url: block.uri };
    if (block.type === "resource_link") {
      return { type: "mention", name: block.name, path: block.uri };
    }
    return { type: "text", text: JSON.stringify(block) };
  });
}

export function codexMeta(value: Record<string, unknown>): Record<string, unknown> {
  return { provider: "codex", ...value };
}

export function codexApplyPatchToPermission(
  threadId: string,
  req: ApplyPatchApprovalRequest,
): RequestPermissionRequest {
  const paths = Object.keys(req.fileChanges);
  const title =
    req.reason ?? (paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`);
  return {
    sessionId: threadId,
    _meta: codexMeta({ codexRequest: req }),
    toolCall: {
      toolCallId: req.callId,
      title,
      kind: "edit",
      status: "pending",
      rawInput: req,
      _meta: codexMeta({ conversationId: req.conversationId }),
      content: paths.map((path) => {
        const change = req.fileChanges[path];
        if (!change) {
          return {
            type: "content",
            content: { type: "text", text: `Unknown change for ${path}` },
          };
        }
        if (change.type === "add") {
          return { type: "diff", path, oldText: "", newText: change.content };
        }
        if (change.type === "delete") {
          return { type: "diff", path, oldText: change.content, newText: "" };
        }
        return {
          type: "diff",
          path: change.move_path ?? path,
          oldText: "",
          newText: change.unified_diff,
        };
      }),
    },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for session", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
  };
}

export function codexApplyPatchResponseFromPermission(
  response: RequestPermissionResponse,
): ApplyPatchApprovalResponse {
  if (response.outcome.outcome === "cancelled") return { decision: "abort" };
  if (response.outcome.optionId === "allow_once") return { decision: "approved" };
  if (response.outcome.optionId === "allow_always") return { decision: "approved_for_session" };
  return { decision: "denied" };
}

export function codexErrorMessage(params: Record<string, unknown>): string {
  if (typeof params.message === "string") return params.message;
  const error = params.error;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Codex returned an error.";
}

export function classifyCodexToolKind(item: Record<string, unknown>): ToolCall["kind"] {
  const raw = String(item.type ?? item.name ?? item.toolName ?? item.tool ?? "").toLowerCase();
  if (raw.includes("patch") || raw.includes("file") || raw.includes("edit")) return "edit";
  if (raw.includes("shell") || raw.includes("exec") || raw.includes("command")) return "execute";
  if (raw.includes("read")) return "read";
  if (raw.includes("search")) return "search";
  return "other";
}

export function codexToolTitle(item: Record<string, unknown>): string {
  for (const key of ["title", "name", "toolName", "tool", "type"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "Codex tool call";
}

export function translateCodexItemCompleted(
  event: Extract<CodexAgentEvent, { method: typeof CODEX_CLIENT_METHODS.item_completed }>,
): SessionUpdate {
  const item = event.params.item;
  const toolCallId =
    typeof item.id === "string"
      ? item.id
      : typeof item.callId === "string"
        ? item.callId
        : typeof item.toolCallId === "string"
          ? item.toolCallId
          : `${event.params.turnId}:item`;
  const output =
    typeof item.output === "string"
      ? item.output
      : typeof item.result === "string"
        ? item.result
        : null;
  return {
    sessionUpdate: "tool_call",
    toolCallId,
    title: codexToolTitle(item),
    kind: classifyCodexToolKind(item),
    status: item.status === "failed" ? "failed" : "completed",
    rawInput: item,
    _meta: codexMeta({ threadId: event.params.threadId, turnId: event.params.turnId, item }),
    ...(output ? { content: [{ type: "content", content: { type: "text", text: output } }] } : {}),
  };
}

export function isCodexFinalAgentMessageItem(item: Record<string, unknown>): boolean {
  if (item.type !== "agentMessage") return false;
  const phase = typeof item.phase === "string" ? item.phase : null;
  const status = typeof item.status === "string" ? item.status : null;
  return (
    phase === "final" || phase === "final_answer" || phase === "completed" || status === "completed"
  );
}
