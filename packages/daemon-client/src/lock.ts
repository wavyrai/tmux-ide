/**
 * Lock-file storage for the daemon's discovery handshake.
 *
 * The CLI / dashboard / electron host all need to know how to reach a
 * running daemon (port + bearer token + parent PID). The daemon writes
 * a lock file at startup and clears it on shutdown; consumers read it
 * to skip a respawn.
 *
 * Atomic write semantics: write to <lock>.tmp first, then rename. The
 * rename is the visibility boundary so a partial write is never
 * observable by readers.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LockData {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

const SCHEMA_KEYS: ReadonlyArray<keyof LockData> = ["pid", "port", "token", "startedAt"];

/**
 * Default lock path: ~/.tmux-ide/daemon.lock. Override via env for tests.
 */
export function defaultLockPath(): string {
  return process.env.TMUX_IDE_DAEMON_LOCK ?? join(homedir(), ".tmux-ide", "daemon.lock");
}

export function writeLock(data: LockData, lockPath: string = defaultLockPath()): void {
  for (const key of SCHEMA_KEYS) {
    if (data[key] === undefined || data[key] === null) {
      throw new Error(`writeLock: missing field "${String(key)}"`);
    }
  }
  if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) {
    throw new Error(`writeLock: invalid pid ${data.pid}`);
  }
  if (typeof data.port !== "number" || !Number.isInteger(data.port) || data.port <= 0) {
    throw new Error(`writeLock: invalid port ${data.port}`);
  }

  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmp = `${lockPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, lockPath);
}

export function readLock(lockPath: string = defaultLockPath()): LockData | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of SCHEMA_KEYS) {
    if (!(key in obj)) return null;
  }
  if (typeof obj.pid !== "number" || !Number.isInteger(obj.pid) || obj.pid <= 0) return null;
  if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port <= 0) return null;
  if (typeof obj.token !== "string" || obj.token.length === 0) return null;
  if (typeof obj.startedAt !== "string" || obj.startedAt.length === 0) return null;
  return {
    pid: obj.pid,
    port: obj.port,
    token: obj.token,
    startedAt: obj.startedAt,
  };
}

/**
 * Clear the lock file. Safe to call when no lock exists.
 */
export function clearLock(lockPath: string = defaultLockPath()): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
