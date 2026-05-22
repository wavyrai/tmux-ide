/**
 * Pure permission helpers extracted from thread-manager.ts. The stateful
 * permission lifecycle (pending map, timers, etc.) stays in the manager;
 * these are just shape translators + error classes.
 */

import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCall,
  ToolCallUpdate,
} from "../acp/index.ts";

export class PermissionRequestNotFoundError extends Error {
  readonly threadId: string;
  readonly requestId: string;

  constructor(threadId: string, requestId: string) {
    super(`Permission request ${requestId} not found for thread ${threadId}`);
    this.name = "PermissionRequestNotFoundError";
    this.threadId = threadId;
    this.requestId = requestId;
  }
}

export class InvalidPermissionOptionError extends Error {
  readonly requestId: string;
  readonly optionId: string;

  constructor(requestId: string, optionId: string) {
    super(`Permission option ${optionId} is not valid for request ${requestId}`);
    this.name = "InvalidPermissionOptionError";
    this.requestId = requestId;
    this.optionId = optionId;
  }
}

export function normalizePermissionToolCall(update: ToolCallUpdate): ToolCall {
  return {
    toolCallId: update.toolCallId,
    title: update.title ?? "Permission request",
    ...(update.kind ? { kind: update.kind } : {}),
    ...(update.status ? { status: update.status } : {}),
    ...(update.content ? { content: update.content } : {}),
    ...(update.locations ? { locations: update.locations } : {}),
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
    ...(update._meta !== undefined ? { _meta: update._meta } : {}),
  };
}

export function autoRejectResponse(
  options: ReadonlyArray<PermissionOption>,
): RequestPermissionResponse {
  const option =
    options.find((candidate) => candidate.optionId === "reject_once") ??
    options.find((candidate) => candidate.kind.startsWith("reject_")) ??
    options[0];
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}
