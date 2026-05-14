/**
 * Terminals registry (G20-P1).
 *
 * JSON-backed persistence for tab-strip metadata — names, scopes, and
 * kind. The actual PTY process lives in `PtyBridgeRegistry`; this
 * store only persists what the UI needs to restore tab labels across
 * reloads. Atomic writes (temp + rename) so a crash mid-write leaves
 * the previous list intact.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Terminal, TerminalKind } from "@tmux-ide/contracts";

const TERMINALS_FILE = ".tmux-ide/terminals.json";
const SAFE_ID = /^[A-Za-z0-9_-]+$/u;

function path(dir: string): string {
  return join(dir, TERMINALS_FILE);
}

function ensureDir(dir: string): void {
  mkdirSync(dirname(path(dir)), { recursive: true });
}

/** Load the full list for a session. Missing file → empty list. */
export function loadTerminals(dir: string): Terminal[] {
  const file = path(dir);
  if (!existsSync(file)) return [];
  try {
    const body = readFileSync(file, "utf-8");
    const parsed = JSON.parse(body) as { terminals?: unknown };
    if (!parsed.terminals || !Array.isArray(parsed.terminals)) return [];
    return parsed.terminals.filter((t): t is Terminal => isTerminal(t)).map((t) => ({ ...t }));
  } catch {
    return [];
  }
}

function isTerminal(value: unknown): value is Terminal {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    SAFE_ID.test(v.id) &&
    typeof v.projectId === "string" &&
    typeof v.scopeId === "string" &&
    typeof v.name === "string" &&
    (v.kind === "shell" || v.kind === "setup" || v.kind === "run" || v.kind === "teardown") &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

function writeAtomic(dir: string, terminals: Terminal[]): void {
  ensureDir(dir);
  const file = path(dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ terminals }, null, 2) + "\n");
  renameSync(tmp, file);
}

export interface CreateInput {
  id: string;
  projectId: string;
  scopeId: string;
  name: string;
  kind: TerminalKind;
  scripted?: boolean;
}

/** Insert OR replace a terminal record by id. Idempotent — calling
 *  `createTerminal` twice with the same deterministic id is a no-op
 *  on the canonical fields and updates `updatedAt`. */
export function upsertTerminal(dir: string, input: CreateInput): Terminal {
  if (!SAFE_ID.test(input.id)) {
    throw new Error(`invalid terminal id "${input.id}"`);
  }
  const existing = loadTerminals(dir);
  const idx = existing.findIndex((t) => t.id === input.id);
  const now = new Date().toISOString();
  const next: Terminal = {
    id: input.id,
    projectId: input.projectId,
    scopeId: input.scopeId,
    name: input.name,
    kind: input.kind,
    createdAt: existing[idx]?.createdAt ?? now,
    updatedAt: now,
    ...(input.scripted ? { scripted: true } : {}),
  };
  if (idx === -1) existing.push(next);
  else existing[idx] = next;
  writeAtomic(dir, existing);
  return next;
}

export function renameTerminal(dir: string, id: string, name: string): Terminal | null {
  const all = loadTerminals(dir);
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  const next: Terminal = {
    ...all[idx]!,
    name: trimmed,
    updatedAt: new Date().toISOString(),
  };
  all[idx] = next;
  writeAtomic(dir, all);
  return next;
}

export function deleteTerminal(dir: string, id: string): boolean {
  const all = loadTerminals(dir);
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeAtomic(dir, next);
  return true;
}

export function findTerminal(dir: string, id: string): Terminal | null {
  const all = loadTerminals(dir);
  return all.find((t) => t.id === id) ?? null;
}
