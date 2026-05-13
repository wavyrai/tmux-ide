/**
 * Search broker — cross-surface coordination for the search panel
 * (G19-P4 polish).
 *
 * Three concerns colocated in one module:
 *
 *   1. **Pending requests** — a fire-and-forget signal other surfaces
 *      (the Files context menu, future command-palette entries, the
 *      chat "search this file" affordance) publish to when they want
 *      the search panel to open with pre-filled fields. The
 *      SearchView drains the signal on mount + reacts to it while
 *      mounted, so the same code path covers both "panel was closed"
 *      and "panel is already open".
 *
 *   2. **Recent-searches history** — last 10 successful queries per
 *      project, deduped, MRU-first, backed by `localStorage` under
 *      `tmux-ide:search:history:<project>`. Survives browser reloads.
 *
 *   3. **Last-query persistence** — saves `{query, options}` per
 *      project so closing + reopening the search panel restores the
 *      user's last state. Storage key
 *      `tmux-ide:search:last:<project>`.
 *
 * All persistence helpers are SSR-safe: they no-op when `window`
 * isn't present (matters during the Vite SSR pass — happy-dom in
 * tests does have it).
 *
 * The module exposes pure helpers in addition to the
 * signal-mutators so tests can pin the storage format without
 * spinning up a Solid root.
 */

import { createSignal, type Accessor } from "solid-js";
import type { CaseMode, SearchOptions } from "./search";

// ---------------------------------------------------------------------
// Pending search request
// ---------------------------------------------------------------------

export interface PendingSearchRequest {
  /** Optional pre-filled query string. Empty string explicitly
   *  clears the panel's query; `undefined` leaves it as-is. */
  query?: string;
  /** Optional include-glob string (comma-separated, same format the
   *  panel renders). */
  include?: string;
  /** Optional exclude-glob string. */
  exclude?: string;
  /** When true, the panel scrolls focus to the query input on the
   *  next tick. The Files right-click integration sets this so
   *  switching to the search view lands the cursor at the query
   *  field. */
  focusInput?: boolean;
  /** Free-form provenance label — only used for logging right now;
   *  the panel never reads it. */
  source?: string;
}

const [pendingRequest, setPendingRequestSignal] =
  createSignal<PendingSearchRequest | null>(null);

/** Read the current pending request (or null when nothing queued). */
export const pendingSearchRequest: Accessor<PendingSearchRequest | null> =
  pendingRequest;

/** Publish a search request. Replaces any prior unconsumed request. */
export function requestSearch(req: PendingSearchRequest): void {
  setPendingRequestSignal(req);
}

/** Drain the pending request (atomically clears the signal). */
export function consumePendingSearch(): PendingSearchRequest | null {
  const current = pendingRequest();
  if (!current) return null;
  setPendingRequestSignal(null);
  return current;
}

// ---------------------------------------------------------------------
// localStorage keys
// ---------------------------------------------------------------------

const HISTORY_LIMIT = 10;
const HISTORY_PREFIX = "tmux-ide:search:history:";
const LAST_QUERY_PREFIX = "tmux-ide:search:last:";

function historyKey(projectName: string): string {
  return `${HISTORY_PREFIX}${projectName}`;
}

function lastQueryKey(projectName: string): string {
  return `${LAST_QUERY_PREFIX}${projectName}`;
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private-mode Safari throws on access; treat as unavailable.
    return null;
  }
}

// ---------------------------------------------------------------------
// Recent-searches history
// ---------------------------------------------------------------------

/**
 * Load the recent-searches list for a project. Returns at most
 * `HISTORY_LIMIT` entries, MRU-first. Returns an empty array on any
 * storage error or malformed data.
 */
export function loadHistory(projectName: string): string[] {
  const store = safeStorage();
  if (!store) return [];
  const raw = store.getItem(historyKey(projectName));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Record a query as the most-recent entry. Trims to `HISTORY_LIMIT`,
 * dedups (the new entry moves to the front if it already existed).
 * Empty / whitespace-only queries are ignored.
 */
export function recordToHistory(projectName: string, query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return loadHistory(projectName);

  const current = loadHistory(projectName);
  const filtered = current.filter((entry) => entry !== normalized);
  const next = [normalized, ...filtered].slice(0, HISTORY_LIMIT);

  const store = safeStorage();
  if (store) {
    try {
      store.setItem(historyKey(projectName), JSON.stringify(next));
    } catch {
      // Quota exceeded / private mode — silent drop, the in-memory
      // signal still updates so the active session keeps working.
    }
  }
  return next;
}

/** Drop the saved history. Used by a future "Clear history" item. */
export function clearHistory(projectName: string): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(historyKey(projectName));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------
// Last-query persistence
// ---------------------------------------------------------------------

export interface PersistedQuery {
  query: string;
  options: SearchOptions;
}

const CASE_MODES: ReadonlyArray<CaseMode> = ["smart", "sensitive", "insensitive"];

function isCaseMode(value: unknown): value is CaseMode {
  return typeof value === "string" && (CASE_MODES as readonly string[]).includes(value);
}

function isSearchOptions(value: unknown): value is SearchOptions {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isCaseMode(v["case"]) &&
    typeof v["regex"] === "boolean" &&
    typeof v["include"] === "string" &&
    typeof v["exclude"] === "string" &&
    typeof v["context"] === "number" &&
    Number.isFinite(v["context"])
  );
}

/**
 * Read the last persisted `{query, options}` for a project. Returns
 * `null` on missing or malformed data — caller falls back to
 * defaults.
 */
export function loadPersistedQuery(projectName: string): PersistedQuery | null {
  const store = safeStorage();
  if (!store) return null;
  const raw = store.getItem(lastQueryKey(projectName));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["query"] !== "string") return null;
    if (!isSearchOptions(obj["options"])) return null;
    return { query: obj["query"], options: obj["options"] };
  } catch {
    return null;
  }
}

/** Persist the current `{query, options}` for the project. No-ops on
 *  storage failure (private mode, quota exceeded). */
export function persistQuery(projectName: string, payload: PersistedQuery): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(lastQueryKey(projectName), JSON.stringify(payload));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------

/** Reset the pending-request signal — exposed for test isolation. */
export function __resetPendingSearchForTests(): void {
  setPendingRequestSignal(null);
}

/** Build a folder glob from a directory path. Pure — pinned in
 *  tests. The Files context menu calls this so the include glob is
 *  shaped identically wherever a folder is the search scope. */
export function folderIncludeGlob(dirPath: string): string {
  const trimmed = dirPath.replace(/\/+$/, "");
  if (!trimmed) return "**";
  return `${trimmed}/**`;
}
