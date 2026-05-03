"use client";

import { useEffect } from "react";
import { API_BASE } from "@/lib/api";
import { useNotifications } from "@/lib/useNotifications";
import { useToasts, type ToastInput } from "@/lib/useToasts";

interface EventPayload {
  session?: string;
  timestamp?: string;
  type?: string;
  taskId?: string;
  agent?: string;
  message?: string;
  milestoneId?: string;
  title?: string;
  reason?: string;
  failedCount?: number;
}

function hashStable(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function eventToast(payload: EventPayload, id: string): ToastInput | null {
  const project = payload.session;
  const scope = project ? { project } : undefined;
  const task = payload.taskId ? `task ${payload.taskId}` : "task";
  const message = payload.message || payload.title;

  switch (payload.type) {
    case "completion":
      return { id, kind: "success", title: "Task completed", body: message ?? task, scope };
    case "error":
      return { id, kind: "error", title: "Task failed", body: message ?? task, scope };
    case "dispatch":
      return {
        id,
        kind: "info",
        title: `Dispatched ${payload.taskId ?? "task"}`,
        body: message,
        scope,
      };
    case "milestone_complete":
      return {
        id,
        kind: "success",
        title: `Milestone complete: ${payload.milestoneId ?? payload.title ?? "milestone"}`,
        body: payload.title,
        scope,
      };
    case "stall":
      return {
        id,
        kind: "warning",
        title: `${payload.agent ?? "Agent"} idle 5m+`,
        body: message,
        scope,
      };
    case "validation_failed":
      return {
        id,
        kind: "error",
        title: `Validation failed: ${payload.milestoneId ?? payload.title ?? "milestone"}`,
        body:
          message ??
          (payload.failedCount != null ? `${payload.failedCount} assertion(s) failed` : undefined),
        scope,
      };
    case "mission_complete":
      return { id, kind: "success", title: "Mission complete", body: payload.title, scope };
    case "retry":
      return {
        id,
        kind: "warning",
        title: `Retrying ${payload.taskId ?? "task"}`,
        body: message,
        scope,
      };
    default:
      return null;
  }
}

export function EventBridge() {
  const { push: pushToast } = useToasts();
  const { push: pushNotification } = useNotifications();

  useEffect(() => {
    if (typeof EventSource === "undefined") return;

    const mountedAt = Date.now();
    const seen = new Set<string>();
    const source = new EventSource(`${API_BASE}/api/events`);

    function handleMessage(event: MessageEvent<string>) {
      let payload: EventPayload;
      try {
        payload = JSON.parse(event.data) as EventPayload;
      } catch {
        return;
      }

      const eventTime = payload.timestamp ? new Date(payload.timestamp).getTime() : mountedAt;
      if (Number.isFinite(eventTime) && eventTime < mountedAt) return;

      const stableId = `event:${hashStable(`${payload.type ?? event.type}:${event.lastEventId || event.data}`)}`;
      if (seen.has(stableId)) return;
      seen.add(stableId);

      const toast = eventToast(payload, stableId);
      if (!toast) return;

      pushToast(toast);
      pushNotification({
        id: stableId,
        kind: toast.kind,
        title: toast.title,
        ...(toast.body ? { body: toast.body } : {}),
        ...(toast.scope ? { scope: toast.scope } : {}),
      });
    }

    source.addEventListener("orchestrator_event", handleMessage as EventListener);
    return () => {
      source.removeEventListener("orchestrator_event", handleMessage as EventListener);
      source.close();
    };
  }, [pushNotification, pushToast]);

  return null;
}
