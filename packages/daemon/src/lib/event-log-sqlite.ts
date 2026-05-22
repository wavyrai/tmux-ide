import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { StructuredEventSchemaZ } from "../schemas/domain.ts";
import { openDatabase, type SqliteDb } from "./sqlite-adapter.ts";
import { formatEventMessage, type OrchestratorEvent, type StructuredEvent } from "./event-log.ts";

interface Migration {
  id: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        session TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session, ts);
      CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
    `,
  },
];

const dbCache = new Map<string, SqliteDb>();

function dbPathFor(dir: string): string {
  return join(dir, ".tasks", "events.sqlite");
}

function ensureDb(dir: string): SqliteDb {
  const cached = dbCache.get(dir);
  if (cached) return cached;
  mkdirSync(join(dir, ".tasks"), { recursive: true });
  const db = openDatabase(dbPathFor(dir));
  runMigrations(db);
  dbCache.set(dir, db);
  return db;
}

function runMigrations(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const appliedRows = db.prepare("SELECT id FROM _migrations").all<{ id: number }>();
  const applied = new Set(appliedRows.map((r) => r.id));
  const insert = db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)");
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec(migration.sql);
    insert.run(migration.id, new Date().toISOString());
  }
}

export interface EventQuery {
  session?: string;
  kind?: string;
  fromTs?: string;
  toTs?: string;
  limit?: number;
}

export function appendEventSqlite(dir: string, event: OrchestratorEvent | StructuredEvent): void {
  const db = ensureDb(dir);
  const ts = (event as { timestamp?: string }).timestamp ?? new Date().toISOString();
  const kind = (event as { type?: string }).type ?? "unknown";
  db.prepare("INSERT INTO events (ts, kind, payload, session) VALUES (?, ?, ?, ?)").run(
    ts,
    kind,
    JSON.stringify(event),
    basename(dir),
  );
}

function rehydrate(payload: string): OrchestratorEvent | null {
  try {
    const parsed = JSON.parse(payload);

    if ("message" in parsed && typeof parsed.message === "string") {
      return parsed as OrchestratorEvent;
    }

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

    if (parsed.type && parsed.timestamp) {
      return { ...parsed, message: parsed.message ?? "" } as OrchestratorEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function readEventsSqlite(dir: string): OrchestratorEvent[] {
  const db = ensureDb(dir);
  const rows = db
    .prepare("SELECT payload FROM events ORDER BY ts ASC, id ASC")
    .all<{ payload: string }>();
  return rows
    .map((row) => rehydrate(row.payload))
    .filter((event): event is OrchestratorEvent => event !== null);
}

export function queryEventsSqlite(dir: string, query: EventQuery = {}): OrchestratorEvent[] {
  const db = ensureDb(dir);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.session !== undefined) {
    clauses.push("session = ?");
    params.push(query.session);
  }
  if (query.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(query.kind);
  }
  if (query.fromTs !== undefined) {
    clauses.push("ts >= ?");
    params.push(query.fromTs);
  }
  if (query.toTs !== undefined) {
    clauses.push("ts <= ?");
    params.push(query.toTs);
  }
  let sql = "SELECT payload FROM events";
  if (clauses.length > 0) sql += " WHERE " + clauses.join(" AND ");
  sql += " ORDER BY ts ASC, id ASC";
  if (query.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(query.limit);
  }
  const rows = db.prepare(sql).all<{ payload: string }>(...params);
  return rows
    .map((row) => rehydrate(row.payload))
    .filter((event): event is OrchestratorEvent => event !== null);
}

const RETENTION_DAYS_DEFAULT = 30;

export function pruneEventsSqlite(
  dir: string,
  now = Date.now(),
  retentionDays = RETENTION_DAYS_DEFAULT,
): void {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  ensureDb(dir).prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
}

/** Test-only: close all cached DBs and drop the cache. */
export function __resetEventLogSqliteForTests(): void {
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  dbCache.clear();
}
