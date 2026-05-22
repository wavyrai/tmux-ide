import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import * as sqliteBackendImpl from "./event-log-sqlite.ts";
import { StructuredEventSchemaZ } from "../schemas/domain.ts";
import type { z } from "zod";
import { fireWebhooks, type WebhookConfig } from "./webhook.ts";

export type EventType =
  | "dispatch"
  | "stall"
  | "completion"
  | "retry"
  | "reconcile"
  | "task.dispatched"
  | "task.claimed"
  | "task.completed"
  | "task.failed"
  | "task.retried"
  | "agent.stalled"
  | "agent.recovered"
  | "orchestrator.reconciled"
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
  | "session_end"
  | "webhook.test";

export interface OrchestratorEvent {
  timestamp: string;
  type: EventType;
  taskId?: string;
  agent?: string;
  message: string;
  [key: string]: unknown;
}

export type StructuredEvent = z.infer<typeof StructuredEventSchemaZ>;

let _webhooks: WebhookConfig[] = [];
export const eventLogEmitter = new EventEmitter();
// Each project-stream SSE connection adds one listener. The dashboard
// can easily mount 10+ concurrent streams across tabs. Disable Node's
// default 10-listener warning — listeners are removed on stream close
// in command-center/server.ts, so this is bounded by active clients.
eventLogEmitter.setMaxListeners(0);

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

const EVENT_LOG_FILE = "_events.jsonl";
const LEGACY_EVENT_LOG_FILE = "events.log";
const MAX_LOG_SIZE = 10 * 1024 * 1024;
const RETENTION_DAYS = 30;
let _rotating = false;

function eventLogMaxBytes(): number {
  const parsed = Number.parseInt(process.env.TMUX_IDE_EVENT_LOG_MAX_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_LOG_SIZE;
}

function dateKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function currentLogPath(dir: string): string {
  return join(dir, ".tasks", EVENT_LOG_FILE);
}

function rotatedLogPath(tasksDir: string, date: string): string {
  return join(tasksDir, `_events-${date}.jsonl.gz`);
}

function rotateEventLogIfNeeded(dir: string): void {
  if (_rotating) return;
  const tasksDir = join(dir, ".tasks");
  const logPath = currentLogPath(dir);
  if (!existsSync(logPath)) return;

  try {
    const stat = statSync(logPath);
    const tooLarge = stat.size >= eventLogMaxBytes();
    const staleDay = dateKey(stat.mtimeMs) !== dateKey();
    if (!tooLarge && !staleDay) return;

    _rotating = true;
    const rotateDate = dateKey(stat.mtimeMs);
    const rotatedPath = rotatedLogPath(tasksDir, rotateDate);
    const content = readFileSync(logPath);
    const existing = existsSync(rotatedPath)
      ? gunzipSync(readFileSync(rotatedPath))
      : Buffer.alloc(0);
    const separator =
      existing.byteLength > 0 && !existing.toString("utf-8").endsWith("\n") ? "\n" : "";
    writeFileSync(
      rotatedPath,
      gzipSync(Buffer.concat([existing, Buffer.from(separator), content])),
    );
    unlinkSync(logPath);
  } catch {
    // rotation is best-effort; continue writing to current file
  } finally {
    _rotating = false;
  }
}

export function pruneEventLogs(dir: string, now = Date.now()): void {
  if (useSqliteEventLog()) {
    sqliteBackend().pruneEventsSqlite(dir, now, RETENTION_DAYS);
    return;
  }
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) return;
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const file of readdirSync(tasksDir)) {
    const match = file.match(/^_events-(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/);
    if (!match) continue;
    const timestamp = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (Number.isFinite(timestamp) && timestamp < cutoff) {
      rmSync(join(tasksDir, file), { force: true });
    }
  }
}

/**
 * Returns true when the SQLite event-log backend is selected via env flag.
 * Default is the file-based JSONL backend.
 */
export function useSqliteEventLog(): boolean {
  return process.env.TMUX_IDE_EVENT_LOG === "sqlite";
}

function sqliteBackend(): typeof sqliteBackendImpl {
  return sqliteBackendImpl;
}

export function appendEvent(dir: string, event: OrchestratorEvent | StructuredEvent): void {
  if (useSqliteEventLog()) {
    // Lazy require avoids loading the sqlite adapter (and its native binding)
    // unless the SQLite backend is actually selected.
    const { appendEventSqlite } = sqliteBackend();
    appendEventSqlite(dir, event);
    eventLogEmitter.emit("event", { dir, event });
    if (_webhooks.length > 0) fireWebhooks(_webhooks, event);
    return;
  }

  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) {
    mkdirSync(tasksDir, { recursive: true });
  }
  rotateEventLogIfNeeded(dir);
  pruneEventLogs(dir);
  const logPath = currentLogPath(dir);

  const line = JSON.stringify(event) + "\n";
  const writeEvent = () => {
    appendFileSync(logPath, line);
    eventLogEmitter.emit("event", { dir, event });
    if (_webhooks.length > 0) fireWebhooks(_webhooks, event);
  };

  // If it's a structured event (no message field, or error type with typed payload),
  // validate with schema before writing
  if (!("message" in event) || StructuredEventSchemaZ.safeParse(event).success) {
    writeEvent();
    return;
  }

  // Old-format event with free-form message — write as-is
  writeEvent();
}

export interface EventQuery {
  session?: string;
  kind?: string;
  fromTs?: string;
  toTs?: string;
  limit?: number;
}

/**
 * Query events with optional filters. Works against either backend:
 * SQLite uses indexed SQL; file backend reads all events and filters in JS.
 * The session field is derived from `basename(dir)` for the file backend.
 */
export function queryEvents(dir: string, query: EventQuery = {}): OrchestratorEvent[] {
  if (useSqliteEventLog()) {
    return sqliteBackend().queryEventsSqlite(dir, query);
  }
  const session = dir.split("/").pop() ?? "";
  if (query.session !== undefined && query.session !== session) return [];

  let events = readEvents(dir);
  if (query.kind !== undefined) events = events.filter((e) => e.type === query.kind);
  if (query.fromTs !== undefined) events = events.filter((e) => e.timestamp >= query.fromTs!);
  if (query.toTs !== undefined) events = events.filter((e) => e.timestamp <= query.toTs!);
  if (query.limit !== undefined) events = events.slice(0, query.limit);
  return events;
}

export function readEvents(dir: string): OrchestratorEvent[] {
  if (useSqliteEventLog()) {
    return sqliteBackend().readEventsSqlite(dir);
  }

  const tasksDir = join(dir, ".tasks");
  const logPath = currentLogPath(dir);
  const legacyPath = join(tasksDir, LEGACY_EVENT_LOG_FILE);
  const legacyRotatedPath = legacyPath + ".1";

  let lines: string[] = [];
  if (existsSync(tasksDir)) {
    const rotations = readdirSync(tasksDir)
      .filter((file) => /^_events-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(file))
      .sort()
      .slice(-1);
    for (const file of rotations) {
      const raw = gunzipSync(readFileSync(join(tasksDir, file)))
        .toString("utf-8")
        .trim();
      if (raw) lines = lines.concat(raw.split("\n"));
    }
  }
  if (existsSync(logPath)) {
    const raw = readFileSync(logPath, "utf-8").trim();
    if (raw) lines = lines.concat(raw.split("\n"));
  }
  if (existsSync(legacyRotatedPath)) {
    const raw = readFileSync(legacyRotatedPath, "utf-8").trim();
    if (raw) lines = lines.concat(raw.split("\n"));
  }
  if (existsSync(legacyPath)) {
    const raw = readFileSync(legacyPath, "utf-8").trim();
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
