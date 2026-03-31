import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { StructuredEventSchemaZ } from "../schemas/domain.ts";
import type { z } from "zod";
import { fireWebhooks, type WebhookConfig } from "./webhook.ts";

export type EventType =
  | "dispatch"
  | "stall"
  | "completion"
  | "retry"
  | "reconcile"
  | "error"
  | "task_created"
  | "status_change"
  | "send"
  | "notify"
  | "milestone_validating"
  | "milestone_complete"
  | "validation_dispatch"
  | "remediation"
  | "validation_failed"
  | "planning"
  | "mission_complete"
  | "discovered_issue"
  | "research_dispatch"
  | "research_finding"
  | "agent_heartbeat"
  | "session_start"
  | "session_end";

export interface OrchestratorEvent {
  timestamp: string;
  type: EventType;
  taskId?: string;
  agent?: string;
  message: string;
}

export type StructuredEvent = z.infer<typeof StructuredEventSchemaZ>;

let _webhooks: WebhookConfig[] = [];

/** Configure webhook URLs for event delivery. Call once at startup. */
export function setWebhookConfig(webhooks: WebhookConfig[]): void {
  _webhooks = webhooks;
}

/**
 * Generate a human-readable message from a structured event's typed fields.
 */
export function formatEventMessage(event: StructuredEvent): string {
  switch (event.type) {
    case "dispatch":
      return `Dispatched task ${event.taskId} to ${event.agent}`;
    case "completion": {
      const duration =
        event.durationMs != null ? ` in ${Math.round(event.durationMs / 1000)}s` : "";
      return `Task ${event.taskId} completed by ${event.agent}${duration}`;
    }
    case "stall":
      return `Stall detected: task ${event.taskId} by ${event.agent} (${Math.floor(event.elapsedMs / 60000)}m)`;
    case "retry":
      return `Retry ${event.attempt}/${event.maxRetries} for task ${event.taskId}: ${event.reason}`;
    case "reconcile":
      return `Reconcile task ${event.taskId}: agent "${event.previousAgent}" ${event.action}`;
    case "error": {
      const ctx = [event.taskId && `task ${event.taskId}`, event.agent && `agent ${event.agent}`]
        .filter(Boolean)
        .join(", ");
      const code = event.code ? ` [${event.code}]` : "";
      return ctx ? `Error (${ctx}): ${event.message}${code}` : `Error: ${event.message}${code}`;
    }
    case "task_created":
      return `Task ${event.taskId} created: "${event.title}"`;
    case "status_change":
      return `Task ${event.taskId} status: ${event.from} → ${event.to}`;
    case "send": {
      const preview =
        event.message.length > 50 ? event.message.slice(0, 50) + "..." : event.message;
      return `Sent to ${event.target}: "${preview}"`;
    }
    case "notify": {
      const preview =
        event.message.length > 50 ? event.message.slice(0, 50) + "..." : event.message;
      return `Notified ${event.target}: "${preview}"`;
    }
    case "milestone_validating":
      return event.title && event.milestoneId
        ? `Milestone "${event.title}" (${event.milestoneId}) entered validation`
        : "Milestone entered validation";
    case "milestone_complete":
      return event.title && event.milestoneId
        ? `Milestone "${event.title}" (${event.milestoneId}) completed`
        : "Milestone completed";
    case "validation_dispatch":
      return event.title && event.target
        ? `Dispatched validation for "${event.title}" to ${event.target}`
        : "Dispatched milestone validation";
    case "remediation":
      return event.assertionId
        ? `Created remediation task ${event.taskId} for assertion ${event.assertionId}`
        : `Created remediation task ${event.taskId}`;
    case "validation_failed":
      return event.title && event.failedCount != null
        ? `Milestone "${event.title}" validation failed (${event.failedCount} assertion(s))`
        : "Milestone validation failed";
    case "planning":
      return event.target
        ? `Dispatched mission planning to ${event.target}`
        : "Dispatched mission planning";
    case "mission_complete":
      return event.title ? `Mission "${event.title}" completed` : "Mission completed";
    case "discovered_issue":
      return event.issue
        ? `Created follow-up task ${event.taskId}: ${event.issue}`
        : `Created follow-up task ${event.taskId} for discovered issue`;
    case "research_dispatch":
      return event.target && event.researchType
        ? `Dispatched ${event.researchType} research to ${event.target}`
        : `Dispatched research task ${event.taskId}`;
    case "research_finding":
      return event.summary && event.researchType
        ? `Research finding (${event.researchType}): ${event.summary}`
        : `Recorded research finding from task ${event.taskId}`;
    default:
      return (
        (event as { message?: string }).message ?? `Event: ${(event as { type: string }).type}`
      );
  }
}

const MAX_LOG_SIZE = 1048576; // 1MB
let _rotating = false;

export function appendEvent(dir: string, event: OrchestratorEvent | StructuredEvent): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }
  const logPath = join(tasksDir, "events.log");

  // Rotate if file exceeds 1MB (atomic: copy to temp, rename temp to .1, remove old)
  // Guard with _rotating flag to prevent concurrent rotation from interleaved calls
  if (!_rotating && existsSync(logPath)) {
    try {
      const size = statSync(logPath).size;
      if (size > MAX_LOG_SIZE) {
        _rotating = true;
        const rotatedPath = logPath + ".1";
        const tmpRotated = rotatedPath + ".tmp";
        copyFileSync(logPath, tmpRotated);
        renameSync(tmpRotated, rotatedPath);
        unlinkSync(logPath);
      }
    } catch {
      // stat/copy/rename failure — continue writing to current file
    } finally {
      _rotating = false;
    }
  }

  const line = JSON.stringify(event) + "\n";

  // If it's a structured event (no message field, or error type with typed payload),
  // validate with schema before writing
  if (!("message" in event) || StructuredEventSchemaZ.safeParse(event).success) {
    appendFileSync(logPath, line);
    if (_webhooks.length > 0) fireWebhooks(_webhooks, event);
    return;
  }

  // Old-format event with free-form message — write as-is
  appendFileSync(logPath, line);
  if (_webhooks.length > 0) fireWebhooks(_webhooks, event);
}

export function readEvents(dir: string): OrchestratorEvent[] {
  const logPath = join(dir, ".tasks", "events.log");
  const rotatedPath = logPath + ".1";

  // Collect lines from rotated file first (older events), then current
  let lines: string[] = [];
  if (existsSync(rotatedPath)) {
    const raw = readFileSync(rotatedPath, "utf-8").trim();
    if (raw) lines = raw.split("\n");
  }
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, "utf-8").trim();
    if (raw) lines = lines.concat(raw.split("\n"));
  }
  if (lines.length === 0) return [];

  return lines
    .map((line) => {
      try {
        const parsed = JSON.parse(line);

        // Old format: has a message field → return as-is
        if ("message" in parsed && typeof parsed.message === "string") {
          return parsed as OrchestratorEvent;
        }

        // New structured format: try to parse and generate message
        const result = StructuredEventSchemaZ.safeParse(parsed);
        if (result.success) {
          const structured = result.data;
          return {
            timestamp: structured.timestamp,
            type: structured.type,
            taskId: "taskId" in structured ? structured.taskId : undefined,
            agent: "agent" in structured ? structured.agent : undefined,
            message: formatEventMessage(structured),
          } as OrchestratorEvent;
        }

        // Fallback: treat as old format if it has at minimum type and timestamp
        if (parsed.type && parsed.timestamp) {
          return { ...parsed, message: parsed.message ?? "" } as OrchestratorEvent;
        }

        return null;
      } catch {
        return null;
      }
    })
    .filter((e): e is OrchestratorEvent => e !== null);
}
