/**
 * Composer draft persistence — keeps in-flight prompt text + the
 * lightweight attachment list alive across page reloads, plus a
 * cross-tab sync so the same thread open in two tabs stays in
 * agreement.
 *
 * API:
 *   loadDraft(threadId)            → prompt string, or "".
 *   loadDraftAttachments(threadId) → ComposerAttachment[] (file +
 *                                     terminal kinds only — image
 *                                     dataUrls are too heavy for
 *                                     localStorage and are skipped).
 *   saveDraft(threadId, prompt, attachments?) — debounced ~250ms,
 *                                                coalesces keystrokes.
 *   clearDraft(threadId)           — call on successful send.
 *   flushDrafts()                  — synchronous write; auto-fires
 *                                     on `pagehide` / `beforeunload`.
 *   subscribeDraft(threadId, fn)   — fires when another tab mutates
 *                                     the draft for this thread.
 *                                     Returns an unsubscribe fn.
 *
 * Storage shape:
 *   localStorage["tmux-ide:composer:drafts:v1"] = JSON({
 *     [threadId]: {
 *       prompt: string,
 *       attachments?: PersistedAttachment[],
 *       updatedAt: number,
 *     },
 *     ...
 *   })
 *
 * Stale eviction: drafts whose `updatedAt` is older than 30 days
 * are dropped on read so the map doesn't grow without bound across
 * dozens of one-off threads.
 *
 * Notes:
 * - Empty prompts AND empty attachment lists drop the entry so the
 *   map stays compact.
 * - threadId "" or null is treated as a no-op (pre-thread drafts
 *   not yet modeled — see upstream's DraftSessionState for the
 *   future shape).
 * - In SSR / non-browser contexts the store degrades to an
 *   in-memory map, so callers don't need to guard `typeof window`.
 */

import type { ComposerAttachment } from "../types";

const STORAGE_KEY = "tmux-ide:composer:drafts:v1";
const FLUSH_DEBOUNCE_MS = 250;
const STALE_DRAFT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Subset of `ComposerAttachment` safe to round-trip through
 * localStorage. Image attachments are intentionally skipped — their
 * dataUrls can be MBs which would blow past the 5MB quota.
 */
type PersistedAttachment =
  | { kind: "file"; path: string; label: string }
  | { kind: "terminal"; paneId: string; paneTitle: string; sessionName: string };

interface DraftEntry {
  prompt: string;
  attachments?: PersistedAttachment[];
  updatedAt: number;
}

type DraftMap = Record<string, DraftEntry>;

type DraftSubscriber = (entry: DraftEntry | null) => void;

let cached: DraftMap | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let unloadListenerInstalled = false;
let storageListenerInstalled = false;
const subscribers = new Map<string, Set<DraftSubscriber>>();

function hasLocalStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function evictStaleEntries(map: DraftMap): { map: DraftMap; evicted: boolean } {
  const cutoff = Date.now() - STALE_DRAFT_MS;
  let evicted = false;
  for (const id of Object.keys(map)) {
    const entry = map[id];
    if (!entry || typeof entry.updatedAt !== "number") {
      delete map[id];
      evicted = true;
      continue;
    }
    if (entry.updatedAt < cutoff) {
      delete map[id];
      evicted = true;
    }
  }
  return { map, evicted };
}

function readFromStorage(): DraftMap {
  if (cached) return cached;
  installStorageListener();
  if (!hasLocalStorage()) {
    cached = {};
    return cached;
  }
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as DraftMap) : {};
    const { map, evicted } = evictStaleEntries(parsed);
    cached = map;
    if (evicted) scheduleFlush();
  } catch {
    cached = {};
  }
  return cached;
}

function writeToStorageNow(): void {
  if (!dirty) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  dirty = false;
  if (!hasLocalStorage()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached ?? {}));
  } catch {
    // quota errors / private mode — swallow; the in-memory cache still serves
    // this session, and the next save attempt will retry.
  }
}

function scheduleFlush(): void {
  dirty = true;
  installUnloadListener();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeToStorageNow();
  }, FLUSH_DEBOUNCE_MS);
}

function installUnloadListener(): void {
  if (unloadListenerInstalled) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  unloadListenerInstalled = true;
  // Use `pagehide` (more reliable on mobile + bfcache) AND `beforeunload`.
  const onLeave = () => writeToStorageNow();
  window.addEventListener("pagehide", onLeave);
  window.addEventListener("beforeunload", onLeave);
}

function installStorageListener(): void {
  if (storageListenerInstalled) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  storageListenerInstalled = true;
  // Cross-tab sync: when another tab writes the draft store, we
  // invalidate the in-memory cache so the next read picks up the
  // new value, and we fan out to any subscribers watching a thread
  // that actually changed.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const previous = cached ?? {};
    cached = null;
    const next = readFromStorage();
    // Diff: notify subscribers whose thread's entry actually moved.
    const ids = new Set<string>([...Object.keys(previous), ...Object.keys(next)]);
    for (const id of ids) {
      const watchers = subscribers.get(id);
      if (!watchers || watchers.size === 0) continue;
      const before = previous[id] ?? null;
      const after = next[id] ?? null;
      // Fire only when user-observable content changed (prompt or
      // attachments). updatedAt-only churn is ignored so a sibling
      // tab's debounced flush doesn't wake every subscriber whose
      // thread didn't actually move.
      if (
        before?.prompt === after?.prompt &&
        attachmentsEqual(before?.attachments, after?.attachments)
      ) {
        continue;
      }
      for (const fn of watchers) fn(after);
    }
  });
}

function attachmentsEqual(
  a: PersistedAttachment[] | undefined,
  b: PersistedAttachment[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.kind !== right.kind) return false;
    if (left.kind === "file" && right.kind === "file") {
      if (left.path !== right.path || left.label !== right.label) return false;
    } else if (left.kind === "terminal" && right.kind === "terminal") {
      if (
        left.paneId !== right.paneId ||
        left.paneTitle !== right.paneTitle ||
        left.sessionName !== right.sessionName
      ) {
        return false;
      }
    }
  }
  return true;
}

function toPersisted(
  attachments: ReadonlyArray<ComposerAttachment> | undefined,
): PersistedAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const out: PersistedAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "file") {
      out.push({ kind: "file", path: attachment.path, label: attachment.label });
    } else if (attachment.kind === "terminal") {
      out.push({
        kind: "terminal",
        paneId: attachment.paneId,
        paneTitle: attachment.paneTitle,
        sessionName: attachment.sessionName,
      });
    }
    // Image attachments are intentionally skipped — data URLs are
    // too heavy for localStorage. The host re-pastes them when the
    // user reopens the page.
  }
  return out.length > 0 ? out : undefined;
}

export function loadDraft(threadId: string | null | undefined): string {
  if (!threadId) return "";
  return readFromStorage()[threadId]?.prompt ?? "";
}

export function loadDraftAttachments(
  threadId: string | null | undefined,
): ReadonlyArray<ComposerAttachment> {
  if (!threadId) return [];
  const entry = readFromStorage()[threadId];
  if (!entry?.attachments) return [];
  // Round-trip through ComposerAttachment so callers get the canonical
  // discriminated-union shape.
  return entry.attachments.map(
    (attachment): ComposerAttachment =>
      attachment.kind === "file"
        ? { kind: "file", path: attachment.path, label: attachment.label }
        : {
            kind: "terminal",
            paneId: attachment.paneId,
            paneTitle: attachment.paneTitle,
            sessionName: attachment.sessionName,
          },
  );
}

export function saveDraft(
  threadId: string | null | undefined,
  prompt: string,
  attachments?: ReadonlyArray<ComposerAttachment>,
): void {
  if (!threadId) return;
  const store = readFromStorage();
  const persisted = toPersisted(attachments);
  if (!prompt && !persisted) {
    if (!(threadId in store)) return;
    delete store[threadId];
  } else {
    store[threadId] = {
      prompt,
      ...(persisted ? { attachments: persisted } : {}),
      updatedAt: Date.now(),
    };
  }
  scheduleFlush();
}

export function clearDraft(threadId: string | null | undefined): void {
  if (!threadId) return;
  const store = readFromStorage();
  if (!(threadId in store)) return;
  delete store[threadId];
  scheduleFlush();
}

export function flushDrafts(): void {
  writeToStorageNow();
}

/**
 * Subscribe to cross-tab mutations of the supplied thread's draft.
 * The callback fires whenever a sibling tab writes a new entry (or
 * clears it) so the composer can adopt the latest value mid-typing
 * without trampling local edits. Returns an unsubscribe fn.
 */
export function subscribeDraft(
  threadId: string | null | undefined,
  fn: DraftSubscriber,
): () => void {
  if (!threadId) return () => undefined;
  installStorageListener();
  let watchers = subscribers.get(threadId);
  if (!watchers) {
    watchers = new Set();
    subscribers.set(threadId, watchers);
  }
  watchers.add(fn);
  return () => {
    watchers!.delete(fn);
    if (watchers!.size === 0) subscribers.delete(threadId);
  };
}

/** Test-only: clear in-memory + persisted state so suites don't leak. */
export function __resetComposerDraftStoreForTests(): void {
  cached = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  subscribers.clear();
  if (hasLocalStorage()) {
    try {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export const __STALE_DRAFT_MS_FOR_TESTS = STALE_DRAFT_MS;

export const __STORAGE_KEY_FOR_TESTS = STORAGE_KEY;
export const __FLUSH_DEBOUNCE_MS_FOR_TESTS = FLUSH_DEBOUNCE_MS;
