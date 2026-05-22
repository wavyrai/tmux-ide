/**
 * Thin runtime adapter that returns a sqlite Database constructor compatible
 * with both Bun (`bun:sqlite`) and Node (`better-sqlite3`).
 *
 * The two libraries expose nearly-identical sync APIs for our usage:
 *   db.exec(sql), db.prepare(sql).{run,all,get}(...params), db.close()
 *
 * Production code paths run under Node and will use better-sqlite3.
 * Tests run under bun:test and will transparently use bun:sqlite.
 */
import { createRequire } from "node:module";

type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all<T = unknown>(...params: unknown[]): T[];
  get?<T = unknown>(...params: unknown[]): T | undefined;
};

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const requireFn = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

let DatabaseCtor: (new (path: string) => SqliteDb) | null = null;

function loadDatabaseCtor(): new (path: string) => SqliteDb {
  if (DatabaseCtor) return DatabaseCtor;
  if (isBun) {
    const mod = requireFn("bun:sqlite");
    DatabaseCtor = mod.Database as unknown as new (path: string) => SqliteDb;
  } else {
    const mod = requireFn("better-sqlite3");
    DatabaseCtor = (mod.default ?? mod) as unknown as new (path: string) => SqliteDb;
  }
  return DatabaseCtor;
}

export function openDatabase(path: string): SqliteDb {
  const Ctor = loadDatabaseCtor();
  return new Ctor(path);
}
