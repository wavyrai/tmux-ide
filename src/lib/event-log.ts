import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "dispatch"
  | "stall"
  | "completion"
  | "retry"
  | "reconcile"
  | "error";

export interface OrchestratorEvent {
  timestamp: string;
  type: EventType;
  taskId?: string;
  agent?: string;
  message: string;
}

export function appendEvent(dir: string, event: OrchestratorEvent): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }
  const logPath = join(tasksDir, "events.log");
  appendFileSync(logPath, JSON.stringify(event) + "\n");
}

export function readEvents(dir: string): OrchestratorEvent[] {
  const logPath = join(dir, ".tasks", "events.log");
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as OrchestratorEvent);
}
