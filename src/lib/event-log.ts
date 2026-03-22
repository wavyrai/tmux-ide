import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StructuredEventSchemaZ } from "../schemas/domain.ts";
import type { z } from "zod";

export type EventType =
  | "dispatch"
  | "stall"
  | "completion"
  | "retry"
  | "reconcile"
  | "error"
  | "task_created"
  | "status_change";

export interface OrchestratorEvent {
  timestamp: string;
  type: EventType;
  taskId?: string;
  agent?: string;
  message: string;
}

export type StructuredEvent = z.infer<typeof StructuredEventSchemaZ>;

/**
 * Generate a human-readable message from a structured event's typed fields.
 */
export function formatEventMessage(event: StructuredEvent): string {
  switch (event.type) {
    case "dispatch": {
      const branch = event.branch ? ` (branch: ${event.branch})` : "";
      return `Dispatched task ${event.taskId} to ${event.agent}${branch}`;
    }
    case "completion": {
      const duration = event.durationMs != null ? ` in ${Math.round(event.durationMs / 1000)}s` : "";
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
  }
}

export function appendEvent(dir: string, event: OrchestratorEvent | StructuredEvent): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }
  const logPath = join(tasksDir, "events.log");

  // If it's a structured event (no message field, or error type with typed payload),
  // validate with schema before writing
  if (!("message" in event) || StructuredEventSchemaZ.safeParse(event).success) {
    appendFileSync(logPath, JSON.stringify(event) + "\n");
    return;
  }

  // Old-format event with free-form message — write as-is
  appendFileSync(logPath, JSON.stringify(event) + "\n");
}

export function readEvents(dir: string): OrchestratorEvent[] {
  const logPath = join(dir, ".tasks", "events.log");
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
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
