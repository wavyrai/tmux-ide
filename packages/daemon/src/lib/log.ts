/** Minimal structured logger for tmux-ide daemon processes. */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let minLevel: Level = (process.env.LOG_LEVEL as Level) ?? "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

// ---------------------------------------------------------------------------
// Ring buffer + subscriber bus
//
// Every structured log entry is also captured in an in-memory ring (last
// `LOG_BUFFER_SIZE` entries) and broadcast to any subscriber. Used by the
// command-center's `/api/logs/:channel` SSE endpoint so the dashboard
// BottomPanel Output tab can stream daemon logs without scraping stderr.
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  level: Level;
  component: string;
  msg: string;
  data?: Record<string, unknown>;
}

const LOG_BUFFER_SIZE = 1_000;
const logBuffer: LogEntry[] = [];
type Subscriber = (entry: LogEntry) => void;
const subscribers = new Set<Subscriber>();

/** Snapshot the current ring buffer; useful for SSE backfill. */
export function getLogBuffer(): ReadonlyArray<LogEntry> {
  return logBuffer.slice();
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

function writeStructuredLog(
  level: Level,
  component: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg: message,
    ...(data ? { data } : {}),
  };
  // Push to ring + drop oldest when over budget.
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  // Fan out to subscribers; isolate failures.
  for (const sub of subscribers) {
    try {
      sub(entry);
    } catch (err) {
      // Avoid recursion via the logger; write directly to stderr.
      process.stderr.write(
        `[log.ts] subscriber threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  // Stream form for humans tailing the process. The data field is
  // serialized inline (matches the previous wire shape).
  const wire: Record<string, unknown> = {
    ts: entry.ts,
    level: entry.level,
    component: entry.component,
    msg: entry.msg,
  };
  if (data) Object.assign(wire, data);
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(wire) + "\n");
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
