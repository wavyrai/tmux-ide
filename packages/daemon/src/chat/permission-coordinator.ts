/**
 * Permission coordinator — owns the in-flight permission requests across
 * all live threads. Extracted from thread-manager.ts to keep its own
 * timers and Map<requestId, PendingPermissionRequest> off the manager.
 */

import { randomUUID } from "node:crypto";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "../acp/index.ts";
import type { ChatEvent } from "./types.ts";
import {
  InvalidPermissionOptionError,
  PermissionRequestNotFoundError,
  autoRejectResponse,
  cancelledPermissionResponse,
  normalizePermissionToolCall,
} from "./permission-helpers.ts";

export interface PermissionCoordinatorOptions {
  busEmit: (event: ChatEvent) => void;
  permissionTimeoutMs: number;
  /** Called before broadcasting the request so callers can drain pipes. */
  beforeEmit?: (threadId: string) => Promise<void> | void;
}

interface PendingPermissionRequest {
  threadId: string;
  options: ReadonlyArray<PermissionOption>;
  resolve: (response: RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PermissionCoordinator {
  request(threadId: string, req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  respond(threadId: string, requestId: string, optionId: string): void;
  cancelForThread(threadId: string): void;
  cancelAll(): void;
  isKnown(threadId: string, requestId: string): boolean;
}

export function makePermissionCoordinator(
  opts: PermissionCoordinatorOptions,
): PermissionCoordinator {
  const pending = new Map<string, PendingPermissionRequest>();

  function remove(requestId: string): PendingPermissionRequest | null {
    const entry = pending.get(requestId);
    if (!entry) return null;
    if (entry.timer) clearTimeout(entry.timer);
    pending.delete(requestId);
    return entry;
  }

  return {
    async request(threadId, req) {
      await opts.beforeEmit?.(threadId);
      const requestId = randomUUID();
      return new Promise<RequestPermissionResponse>((resolve) => {
        const timer = setTimeout(() => {
          remove(requestId)?.resolve(autoRejectResponse(req.options));
        }, opts.permissionTimeoutMs);
        timer.unref?.();
        pending.set(requestId, { threadId, options: req.options, resolve, timer });
        opts.busEmit({
          type: "chat.permission.request",
          threadId,
          requestId,
          toolCall: normalizePermissionToolCall(req.toolCall),
          options: req.options,
        });
      });
    },
    respond(threadId, requestId, optionId) {
      const entry = pending.get(requestId);
      if (!entry || entry.threadId !== threadId) {
        throw new PermissionRequestNotFoundError(threadId, requestId);
      }
      if (!entry.options.some((option) => option.optionId === optionId)) {
        throw new InvalidPermissionOptionError(requestId, optionId);
      }
      remove(requestId)?.resolve({ outcome: { outcome: "selected", optionId } });
    },
    cancelForThread(threadId) {
      for (const [requestId, entry] of pending) {
        if (entry.threadId !== threadId) continue;
        remove(requestId)?.resolve(cancelledPermissionResponse());
      }
    },
    cancelAll() {
      for (const requestId of pending.keys()) {
        remove(requestId)?.resolve(cancelledPermissionResponse());
      }
    },
    isKnown(threadId, requestId) {
      const entry = pending.get(requestId);
      return !!entry && entry.threadId === threadId;
    },
  };
}
