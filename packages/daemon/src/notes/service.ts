/**
 * Notes service — pure file I/O over `.tmux-ide/notes.md` inside a
 * project directory. No Hono / HTTP knowledge. Handlers in
 * `./handlers.ts` translate request payloads to these calls.
 *
 * Atomic writes via temp + rename so a concurrent reader never sees
 * a half-written buffer.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const NOTES_REL_PATH = ".tmux-ide/notes.md";

export interface NoteRecord {
  /** Markdown body. Empty string when no note has been written yet. */
  content: string;
  /** ISO-8601 mtime, or null if the file does not exist. */
  updatedAt: string | null;
}

function notePath(sessionDir: string): string {
  return join(sessionDir, NOTES_REL_PATH);
}

export function readNote(sessionDir: string): NoteRecord {
  const path = notePath(sessionDir);
  if (!existsSync(path)) return { content: "", updatedAt: null };
  try {
    const content = readFileSync(path, "utf8");
    const stat = statSync(path);
    return { content, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { content: "", updatedAt: null };
  }
}

export function writeNote(sessionDir: string, content: string): NoteRecord {
  const path = notePath(sessionDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  const stat = statSync(path);
  return { content, updatedAt: stat.mtime.toISOString() };
}
