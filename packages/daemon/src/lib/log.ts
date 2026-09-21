/**
 * Minimal structured logger for tmux-ide daemon processes.
 *
 * Every record is sanitized centrally (`log-sanitize.ts`): credential-shaped
 * keys and substrings are redacted, payloads are bounded per record and for
 * the in-memory ring, and the identity metadata a triage relies on (`ts`,
 * `level`, `component`, `msg`, `pid`, `instanceId`, `version`) can never be
 * overwritten by caller data. Stream write failures (closed pipe, full disk)
 * degrade to ring-only logging with one explicit warning; they never crash
 * the process.
 */

import {
  DEFAULT_LOG_BUDGET,
  DEFAULT_LOG_RING_BYTES,
  sanitizeLogMessage,
  sanitizeLogPayload,
  type LogBudget,
} from "./log-sanitize.ts";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: Level = (process.env.LOG_LEVEL as Level) ?? "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

// ---------------------------------------------------------------------------
// Identity + secrets
//
// The daemon stamps its instance identity once at startup so every record it
// emits (ring, subscribers and wire) carries `pid`, `instanceId` and
// `version`. Registered secret literals are redacted wherever they appear.
// ---------------------------------------------------------------------------

export interface LogIdentity {
  readonly instanceId?: string;
  readonly version?: string;
}

let identity: LogIdentity = {};
const secrets = new Set<string>();

/** Stamp reserved identity metadata onto every subsequent record. */
export function setLogIdentity(next: LogIdentity | null): void {
  identity = next ? { ...next } : {};
}

export function getLogIdentity(): LogIdentity {
  return { ...identity };
}

/** Register a credential literal to redact wherever it appears in a record. */
export function registerLogSecret(secret: string | null | undefined): void {
  if (typeof secret === "string" && secret.length >= 8) secrets.add(secret);
}

/** @internal test seam */
export function _resetLogStateForTests(): void {
  identity = {};
  secrets.clear();
  logBuffer.length = 0;
  ringBytes = 0;
  streamState.stdout = { failed: false, listening: false };
  streamState.stderr = { failed: false, listening: false };
  budget = DEFAULT_LOG_BUDGET;
  ringBudgetBytes = DEFAULT_LOG_RING_BYTES;
}

/** @internal test seam — shrink budgets to make bounds observable. */
export function _setLogBudgetForTests(next: Partial<LogBudget> & { ringBytes?: number }): void {
  const { ringBytes, ...rest } = next;
  budget = { ...DEFAULT_LOG_BUDGET, ...rest };
  if (ringBytes !== undefined) ringBudgetBytes = ringBytes;
}

// ---------------------------------------------------------------------------
// Ring buffer + subscriber bus
//
// Every structured log entry is also captured in an in-memory ring (last
// `LOG_BUFFER_SIZE` entries, at most `ringBudgetBytes` serialized bytes) and
// broadcast to any subscriber. Used by the command-center's
// `/api/logs/:channel` SSE endpoint so the dashboard BottomPanel Output tab
// can stream daemon logs without scraping stderr.
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  level: Level;
  component: string;
  msg: string;
  pid?: number;
  instanceId?: string;
  version?: string;
  data?: Record<string, unknown>;
}

const LOG_BUFFER_SIZE = 1_000;
const logBuffer: LogEntry[] = [];
const entryBytes = new WeakMap<LogEntry, number>();
let ringBytes = 0;
let budget: LogBudget = DEFAULT_LOG_BUDGET;
let ringBudgetBytes = DEFAULT_LOG_RING_BYTES;
type Subscriber = (entry: LogEntry) => void;
const subscribers = new Set<Subscriber>();

/** Snapshot the current ring buffer; useful for SSE backfill. */
export function getLogBuffer(): ReadonlyArray<LogEntry> {
  return logBuffer.slice();
}

/** Ring occupancy for diagnostics: entry count and retained serialized bytes. */
export function getLogBufferStats(): { entries: number; bytes: number; budgetBytes: number } {
  return { entries: logBuffer.length, bytes: ringBytes, budgetBytes: ringBudgetBytes };
}

/**
 * Subscribe to live log entries. Returns an unsubscribe function. The
 * handler runs synchronously inside the writer — keep it cheap; throw
 * inside the handler is caught + logged once so one bad subscriber
 * can't stall the daemon.
 */
export function subscribeLogs(handler: Subscriber): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

// ---------------------------------------------------------------------------
// Stream degradation
// ---------------------------------------------------------------------------

type StreamName = "stdout" | "stderr";
interface StreamState {
  failed: boolean;
  listening: boolean;
}
const streamState: Record<StreamName, StreamState> = {
  stdout: { failed: false, listening: false },
  stderr: { failed: false, listening: false },
};

/** Which process streams the logger has given up on (diagnostics only). */
export function getLogStreamFailures(): readonly StreamName[] {
  return (Object.keys(streamState) as StreamName[]).filter((name) => streamState[name].failed);
}

function markStreamFailed(name: StreamName, error: unknown): void {
  if (streamState[name].failed) return;
  streamState[name].failed = true;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const warning = `[log.ts] ${name} write failed (${detail}); further records are retained in memory only\n`;
  const other: StreamName = name === "stdout" ? "stderr" : "stdout";
  if (!streamState[other].failed) {
    try {
      process[other].write(warning);
    } catch {
      streamState[other].failed = true;
    }
  }
}

function writeToStream(name: StreamName, line: string): void {
  const state = streamState[name];
  if (state.failed) return;
  const stream = process[name];
  if (!state.listening) {
    state.listening = true;
    // A closed pipe (EPIPE) or full disk (ENOSPC) surfaces asynchronously as
    // an 'error' event; without a listener Node raises it as an uncaught
    // exception and the daemon dies mid-triage.
    stream.on("error", (error: unknown) => markStreamFailed(name, error));
  }
  try {
    stream.write(line);
  } catch (error) {
    markStreamFailed(name, error);
  }
}

function writeStructuredLog(
  level: Level,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const payload = sanitizeLogPayload(data, { secrets, budget });
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component: sanitizeLogMessage(String(component), secrets, budget).slice(0, 128),
    msg: sanitizeLogMessage(message, secrets, budget),
    pid: process.pid,
    ...(identity.instanceId ? { instanceId: identity.instanceId } : {}),
    ...(identity.version ? { version: identity.version } : {}),
    ...(payload.data ? { data: payload.data } : {}),
  };
  const size = payload.bytes + Buffer.byteLength(entry.msg, "utf8") + 96;
  entryBytes.set(entry, size);
  // Push to ring + drop oldest while over either budget.
  logBuffer.push(entry);
  ringBytes += size;
  while (
    logBuffer.length > 0 &&
    (logBuffer.length > LOG_BUFFER_SIZE || ringBytes > ringBudgetBytes)
  ) {
    const evicted = logBuffer.shift()!;
    ringBytes -= entryBytes.get(evicted) ?? 0;
    if (logBuffer.length === 0) ringBytes = 0;
  }
  // Fan out to subscribers; isolate failures.
  for (const sub of subscribers) {
    try {
      sub(entry);
    } catch (err) {
      // Avoid recursion via the logger; write directly to stderr.
      writeToStream(
        "stderr",
        `[log.ts] subscriber threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  // Stream form for humans tailing the process. The data field is
  // serialized inline (matches the previous wire shape); reserved metadata
  // is written last so a caller payload can never shadow it.
  const wire: Record<string, unknown> = {
    ...(entry.data ?? {}),
    ts: entry.ts,
    level: entry.level,
    component: entry.component,
    msg: entry.msg,
    pid: entry.pid,
    ...(entry.instanceId ? { instanceId: entry.instanceId } : {}),
    ...(entry.version ? { version: entry.version } : {}),
  };
  if (payload.renamedKeys.length > 0) wire.reservedKeysRenamed = payload.renamedKeys;
  writeToStream(level === "error" ? "stderr" : "stdout", JSON.stringify(wire) + "\n");
}

export const logger = {
  debug: (component: string, msg: string, data?: Record<string, unknown>) =>
    writeStructuredLog("debug", component, msg, data),
  info: (component: string, msg: string, data?: Record<string, unknown>) =>
    writeStructuredLog("info", component, msg, data),
  warn: (component: string, msg: string, data?: Record<string, unknown>) =>
    writeStructuredLog("warn", component, msg, data),
  error: (component: string, msg: string, data?: Record<string, unknown>) =>
    writeStructuredLog("error", component, msg, data),
};

/**
 * Thin logger shim compatible with VibeTunnel's module logger API (`createLogger`-style methods).
 * Wraps `console.*` (distinct from structured JSON `logger` above).
 */
export type LogMethod = (...args: unknown[]) => void;

export const log = {
  /** Alias for `info` / console.log (VibeTunnel `createLogger` compatibility). */
  log: (...args: unknown[]) => {
    console.log(...args);
  },
  info: (...args: unknown[]) => {
    console.log(...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args);
  },
  debug: (...args: unknown[]) => {
    console.debug(...args);
  },
} satisfies {
  log: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  debug: LogMethod;
};
