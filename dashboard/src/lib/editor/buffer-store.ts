/**
 * Buffer store — Solid signal-backed state for the multi-tab
 * editor surface.
 *
 * Tracks every open file: current content, last-saved content,
 * dirty bit, status, and the open order (drives the tab strip's
 * left-to-right ordering). The store is module-singleton so the
 * tab strip, the editor host, and the Cmd+S keybind all read the
 * same source.
 *
 * Responsibility split:
 *   - This store owns content + dirty state + the open-order array.
 *   - `modelRegistry` (G17-P1) owns the Monaco `ITextModel`
 *     lifetime, view-state preservation across `attach()` swaps,
 *     and the 60s eviction TTL.
 *   - `CodeEditor` (G17-P4) attaches the registry's model to a
 *     leased editor; on edit it calls back into this store.
 *
 * Save flow:
 *   user types → Monaco onChange → bufferStore.markContent(uri,
 *   content) → setDirty(true) → tab strip's `•` lights up. User
 *   hits Cmd+S → bufferStore.save(uri) → PUT /api/project/:name
 *   /file → on success, baseContent ← content, dirty ← false.
 */

import { createStore, type SetStoreFunction } from "solid-js/store";
import { batch } from "solid-js";
import { Effect } from "effect";
import { saveFile } from "@/lib/api";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { codeEditorPool } from "@/lib/monaco/code-pool";
import { getMonacoFromGlobal } from "@/lib/monaco/pool";
import { buildMonacoModelPath } from "@/lib/monaco/model-path";

// G17-P6 — autosave + crash recovery + external-change reseed.
//
// Autosave debounce: each `markContent` resets a per-buffer timer.
// When the timer fires, `save(uri)` runs. The debounce window is
// short enough to feel "saves on stop typing" without thrashing
// the daemon's writeFileSync.
//
// Crash-recovery store: every dirty markContent writes a snapshot
// to localStorage so an unexpected reload doesn't lose work. Saved
// + closed buffers drop their snapshot. On host mount, the host
// reads `listRecoverableBuffers()` and decides whether to prompt
// the user.
//
// External-change reseed: `reseedFromExternal(uri, content)` is
// fired by the FS-watch WS subscriber when the underlying disk
// content changes out from under the editor. Clean buffers
// silently re-sync (baseContent + content + Monaco model all
// match disk). Dirty buffers route to `conflict` state — the host
// surfaces a banner; in-buffer content stays untouched.
const AUTOSAVE_DEBOUNCE_MS = 1_500;
const RECOVERY_STORAGE_KEY = "tmux-ide.editor.recovery.v1";
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

export type BufferStatus = "loading" | "ready" | "error";

export interface OpenBuffer {
  bufferUri: string;
  filePath: string;
  sessionName: string;
  rootPath: string;
  language: string;
  status: BufferStatus;
  /** Current in-editor content. */
  content: string;
  /** Last-saved content; `dirty` derives from `content !== baseContent`. */
  baseContent: string;
  dirty: boolean;
  openedAt: number;
  lastSavedAt: number | null;
  saveError: string | null;
  saving: boolean;
  /**
   * Set when the daemon's FS-watch reports the file was rewritten
   * externally while this buffer was dirty. The host surfaces a
   * banner asking the user whether to keep their edits or reload
   * from disk; until they resolve it, `baseContent` is the on-disk
   * content and `content` is the user's edits.
   */
  externalContent: string | null;
  /**
   * Preview tab marker. When true, the tab strip renders the name in
   * italic and the next `openBufferAsPreview` call replaces this tab
   * in place rather than appending a new one. Cleared by
   * `pinBuffer`, by editing the buffer (dirty preview tabs auto-pin),
   * or by a regular `openBuffer` call for the same URI.
   */
  isPreview: boolean;
}

/** Snapshot persisted to localStorage for crash recovery. */
export interface RecoverableSnapshot {
  bufferUri: string;
  filePath: string;
  sessionName: string;
  rootPath: string;
  language: string;
  content: string;
  baseContent: string;
  savedAt: number;
}

export interface BufferStoreState {
  buffers: Record<string, OpenBuffer>;
  /** Open order — drives the tab strip left-to-right. */
  order: string[];
  /** Active buffer URI; null when no buffer is selected. */
  activeUri: string | null;
}

const [state, setState] = createStore<BufferStoreState>({
  buffers: {},
  order: [],
  activeUri: null,
});

export const bufferState = state;

export function getActiveBuffer(): OpenBuffer | null {
  const uri = state.activeUri;
  return uri ? (state.buffers[uri] ?? null) : null;
}

export function setActiveBuffer(uri: string | null): void {
  setState("activeUri", uri);
}

/**
 * Open (or focus) a buffer for `filePath`. If the buffer is already
 * open, just flips `activeUri`. Otherwise inserts a `loading` entry
 * and lets the caller hydrate via `markReady` once content arrives.
 */
export function openBuffer(input: {
  sessionName: string;
  rootPath: string;
  filePath: string;
  language: string;
}): { bufferUri: string; existed: boolean } {
  const bufferUri = buildMonacoModelPath(input.rootPath, input.filePath);
  const existing = state.buffers[bufferUri];
  if (existing) {
    batch(() => {
      // Opening explicitly (vs `openBufferAsPreview`) pins the tab.
      if (existing.isPreview) {
        setState("buffers", bufferUri, "isPreview", false);
      }
      setState("activeUri", bufferUri);
    });
    return { bufferUri, existed: true };
  }

  batch(() => {
    setState("buffers", bufferUri, {
      bufferUri,
      filePath: input.filePath,
      sessionName: input.sessionName,
      rootPath: input.rootPath,
      language: input.language,
      status: "loading",
      content: "",
      baseContent: "",
      dirty: false,
      openedAt: Date.now(),
      lastSavedAt: null,
      saveError: null,
      saving: false,
      externalContent: null,
      isPreview: false,
    });
    setState("order", (order) => [...order, bufferUri]);
    setState("activeUri", bufferUri);
  });
  return { bufferUri, existed: false };
}

/**
 * Open `filePath` as a preview tab. Single-click-from-tree semantics:
 *
 *   - If the buffer is already open, just flip `activeUri` (no
 *     pin/unpin change — re-clicking your current preview stays
 *     a preview; re-clicking a pinned tab stays pinned).
 *   - If a clean preview tab exists, replace it in place (the old
 *     buffer + Monaco model are dropped, the new buffer takes its
 *     slot in `order`). Avoids the "tab graveyard" from rapid
 *     browsing.
 *   - If the existing preview is dirty, pin it (keep the user's
 *     edits) and append a fresh preview tab.
 *   - Otherwise append a new preview tab at the end.
 */
export function openBufferAsPreview(input: {
  sessionName: string;
  rootPath: string;
  filePath: string;
  language: string;
}): { bufferUri: string; existed: boolean } {
  const bufferUri = buildMonacoModelPath(input.rootPath, input.filePath);
  const existing = state.buffers[bufferUri];
  if (existing) {
    setState("activeUri", bufferUri);
    return { bufferUri, existed: true };
  }

  // Look for an in-place replacement target — a clean preview tab.
  const previewUri = state.order.find((u) => {
    const b = state.buffers[u];
    return b?.isPreview === true && !b.dirty;
  });

  if (previewUri) {
    const previewIdx = state.order.indexOf(previewUri);
    // Close the old preview buffer (clean by construction). Its
    // Monaco model is unregistered via the registry's TTL.
    closeBuffer(previewUri, { discardDirty: false });
    batch(() => {
      setState("buffers", bufferUri, {
        bufferUri,
        filePath: input.filePath,
        sessionName: input.sessionName,
        rootPath: input.rootPath,
        language: input.language,
        status: "loading",
        content: "",
        baseContent: "",
        dirty: false,
        openedAt: Date.now(),
        lastSavedAt: null,
        saveError: null,
        saving: false,
        externalContent: null,
        isPreview: true,
      });
      // Insert at the old preview's slot so the strip doesn't jump.
      setState("order", (order) => {
        const next = [...order];
        const insertAt = Math.min(previewIdx, next.length);
        next.splice(insertAt, 0, bufferUri);
        return next;
      });
      setState("activeUri", bufferUri);
    });
    return { bufferUri, existed: false };
  }

  batch(() => {
    setState("buffers", bufferUri, {
      bufferUri,
      filePath: input.filePath,
      sessionName: input.sessionName,
      rootPath: input.rootPath,
      language: input.language,
      status: "loading",
      content: "",
      baseContent: "",
      dirty: false,
      openedAt: Date.now(),
      lastSavedAt: null,
      saveError: null,
      saving: false,
      externalContent: null,
      isPreview: true,
    });
    setState("order", (order) => [...order, bufferUri]);
    setState("activeUri", bufferUri);
  });
  return { bufferUri, existed: false };
}

/** Pin a preview tab so it survives the next `openBufferAsPreview`. */
export function pinBuffer(bufferUri: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf || !buf.isPreview) return;
  setState("buffers", bufferUri, "isPreview", false);
}

/**
 * Reorder the open-buffer list. `fromIndex` is removed and
 * reinserted at `toIndex`. Out-of-range or no-op moves are
 * silently ignored.
 */
export function reorderBuffers(fromIndex: number, toIndex: number): void {
  const order = state.order;
  if (fromIndex < 0 || fromIndex >= order.length) return;
  if (toIndex < 0 || toIndex >= order.length) return;
  if (fromIndex === toIndex) return;
  const next = [...order];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return;
  next.splice(toIndex, 0, moved);
  setState("order", next);
}

/**
 * Hydrate a buffer with its fetched initial content + register a
 * writable Monaco model behind the buffer URI. Flips status to
 * `'ready'`. Awaits Monaco init so the registry call can't race
 * the first editor lease.
 */
export async function markReady(bufferUri: string, initialContent: string): Promise<void> {
  const buf = state.buffers[bufferUri];
  if (!buf) return;
  try {
    // Warm the editor pool only when Monaco isn't already on the
    // global. Once warm (or stubbed — tests set globalThis.__monaco),
    // `registerBuffer` is the sole hard dependency and runs
    // synchronously, so we skip the redundant pool round-trip. This
    // keeps `markReady` synchronous in that path, which both matches
    // the buffer-store test contract and avoids re-initing the pool
    // per opened buffer in production.
    if (!getMonacoFromGlobal()) {
      await codeEditorPool.init();
    }
    modelRegistry.registerBuffer({
      sessionName: buf.sessionName,
      rootPath: buf.rootPath,
      filePath: buf.filePath,
      language: buf.language,
      initialContent,
    });
  } catch (err) {
    setState("buffers", bufferUri, {
      ...buf,
      status: "error",
      saveError: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  batch(() => {
    setState("buffers", bufferUri, {
      ...buf,
      status: "ready",
      content: initialContent,
      baseContent: initialContent,
      dirty: false,
    });
  });
}

/** Mark a buffer as failed to load (the host's fetch path errored). */
export function markError(bufferUri: string, message: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf) return;
  setState("buffers", bufferUri, {
    ...buf,
    status: "error",
    saveError: message,
  });
}

/**
 * Apply an in-editor content change. Updates `content`, recomputes
 * `dirty`, bumps the Monaco buffer-version signal (so other readers
 * of `useBufferVersion(uri)` re-run), lights the registry's dirty
 * bit, persists a crash-recovery snapshot, and schedules a
 * debounced autosave.
 */
export function markContent(bufferUri: string, nextContent: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf || buf.status !== "ready") return;
  if (buf.content === nextContent) return;
  const dirty = nextContent !== buf.baseContent;
  // A preview tab that's been edited becomes a real pinned tab —
  // we don't want a dirty buffer to vanish on the next single-click.
  const isPreview = dirty ? false : buf.isPreview;
  batch(() => {
    setState("buffers", bufferUri, {
      ...buf,
      content: nextContent,
      dirty,
      isPreview,
    });
    modelRegistry.setDirty(bufferUri, dirty);
    modelRegistry.bumpBufferVersion(bufferUri);
  });

  if (dirty) {
    persistRecoverySnapshot(bufferUri);
    scheduleAutosave(bufferUri);
  } else {
    // Content returned to baseContent — drop the recovery snapshot
    // and cancel any pending autosave.
    clearRecoverySnapshot(bufferUri);
    cancelAutosave(bufferUri);
  }
}

/**
 * Persist a buffer's content to disk via the daemon. On success,
 * `baseContent ← content`, `dirty ← false`, `lastSavedAt` updates;
 * the crash-recovery snapshot for the URI is cleared. On failure,
 * `saveError` is set; dirty remains true; recovery snapshot stays
 * so the user doesn't lose work.
 */
export async function save(bufferUri: string): Promise<void> {
  const buf = state.buffers[bufferUri];
  if (!buf || buf.status !== "ready" || buf.saving) return;
  if (!buf.dirty) return; // nothing to write
  // A successful save settles the disk content; cancel any pending
  // autosave so it doesn't fire on top of the explicit save.
  cancelAutosave(bufferUri);
  setState("buffers", bufferUri, { ...buf, saving: true, saveError: null });
  try {
    await Effect.runPromise(saveFile(buf.sessionName, buf.filePath, buf.content));
    const after = state.buffers[bufferUri];
    if (!after) return;
    batch(() => {
      setState("buffers", bufferUri, {
        ...after,
        baseContent: after.content,
        dirty: false,
        saving: false,
        saveError: null,
        lastSavedAt: Date.now(),
      });
      modelRegistry.setDirty(bufferUri, false);
    });
    clearRecoverySnapshot(bufferUri);
  } catch (err) {
    const after = state.buffers[bufferUri];
    if (!after) return;
    setState("buffers", bufferUri, {
      ...after,
      saving: false,
      saveError: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Save every dirty, ready buffer in parallel. Iterates a snapshot of
 * `order` so a close/open mid-save doesn't perturb the loop. Errors
 * on individual buffers surface via each buffer's `saveError` field —
 * the returned promise resolves once every save has settled.
 */
export async function saveAll(): Promise<void> {
  const targets = state.order
    .map((uri) => state.buffers[uri])
    .filter((b): b is OpenBuffer => !!b && b.status === "ready" && b.dirty && !b.saving)
    .map((b) => b.bufferUri);
  if (targets.length === 0) return;
  await Promise.all(targets.map((uri) => save(uri)));
}

/**
 * Close a buffer. If `discardDirty` is false (default), the call is
 * a no-op when the buffer is dirty — the host can prompt the user
 * before passing `discardDirty: true`. Drops the buffer's
 * registration via the model registry's 60s TTL, cancels its
 * pending autosave, and clears its crash-recovery snapshot.
 */
export function closeBuffer(bufferUri: string, opts: { discardDirty?: boolean } = {}): boolean {
  const buf = state.buffers[bufferUri];
  if (!buf) return false;
  if (buf.dirty && !opts.discardDirty) return false;
  const nextOrder = state.order.filter((u) => u !== bufferUri);
  const nextActive =
    state.activeUri === bufferUri ? (nextOrder[nextOrder.length - 1] ?? null) : state.activeUri;
  batch(() => {
    setState("buffers", bufferUri, undefined as unknown as OpenBuffer);
    setState("order", nextOrder);
    setState("activeUri", nextActive);
    modelRegistry.setDirty(bufferUri, false);
  });
  modelRegistry.unregisterModel(bufferUri);
  cancelAutosave(bufferUri);
  clearRecoverySnapshot(bufferUri);
  return true;
}

// ---------------------------------------------------------------------
// Autosave debounce
// ---------------------------------------------------------------------

function scheduleAutosave(bufferUri: string): void {
  cancelAutosave(bufferUri);
  const timer = setTimeout(() => {
    autosaveTimers.delete(bufferUri);
    void save(bufferUri);
  }, AUTOSAVE_DEBOUNCE_MS);
  autosaveTimers.set(bufferUri, timer);
}

function cancelAutosave(bufferUri: string): void {
  const timer = autosaveTimers.get(bufferUri);
  if (timer !== undefined) {
    clearTimeout(timer);
    autosaveTimers.delete(bufferUri);
  }
}

/** Test-only: configurable autosave window. */
export function _getAutosaveWindowMsForTests(): number {
  return AUTOSAVE_DEBOUNCE_MS;
}

/** Test-only: snapshot the active autosave timers. */
export function _hasPendingAutosaveForTests(bufferUri: string): boolean {
  return autosaveTimers.has(bufferUri);
}

// ---------------------------------------------------------------------
// External-change reseed (FS-watch invalidation)
// ---------------------------------------------------------------------

/**
 * Apply a daemon-side FS-watch event to an open buffer. If the
 * buffer is clean, the new content seeds both `baseContent` and
 * `content` and the Monaco model is replaced — the user sees the
 * fresh file with no prompt. If the buffer is dirty, the new
 * content is parked in `externalContent` so the host can surface
 * a "file changed on disk — keep / discard?" banner.
 *
 * No-op when:
 *   - The buffer URI isn't open.
 *   - The buffer's status isn't `'ready'`.
 *   - The new content equals the current baseContent (idempotent;
 *     re-emitting the same write doesn't toggle the conflict
 *     banner).
 */
export function reseedFromExternal(bufferUri: string, nextContent: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf || buf.status !== "ready") return;
  if (nextContent === buf.baseContent) {
    // The disk write matches what we already have — drop any
    // outstanding `externalContent` banner.
    if (buf.externalContent !== null) {
      setState("buffers", bufferUri, { ...buf, externalContent: null });
    }
    return;
  }
  if (buf.dirty) {
    setState("buffers", bufferUri, { ...buf, externalContent: nextContent });
    return;
  }
  // Clean buffer — silently re-sync.
  const model = modelRegistry.getModelByUri(bufferUri);
  try {
    model?.setValue(nextContent);
  } catch {
    /* model may have been disposed mid-flight */
  }
  batch(() => {
    setState("buffers", bufferUri, {
      ...buf,
      content: nextContent,
      baseContent: nextContent,
      externalContent: null,
    });
    modelRegistry.bumpBufferVersion(bufferUri);
  });
}

/**
 * The user chose to discard their in-buffer edits and reload from
 * the externally-changed content. Clears `externalContent`,
 * cancels pending autosave + recovery snapshot. The buffer becomes
 * clean again with `externalContent` as the new baseContent.
 */
export function acceptExternalChange(bufferUri: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf || buf.externalContent === null) return;
  const fresh = buf.externalContent;
  const model = modelRegistry.getModelByUri(bufferUri);
  try {
    model?.setValue(fresh);
  } catch {
    /* ignore */
  }
  batch(() => {
    setState("buffers", bufferUri, {
      ...buf,
      content: fresh,
      baseContent: fresh,
      dirty: false,
      externalContent: null,
    });
    modelRegistry.setDirty(bufferUri, false);
    modelRegistry.bumpBufferVersion(bufferUri);
  });
  cancelAutosave(bufferUri);
  clearRecoverySnapshot(bufferUri);
}

/**
 * The user chose to keep their edits despite the external change.
 * Drops `externalContent` (the banner disappears) without touching
 * the dirty content. Note: the next successful save will overwrite
 * the disk-side change.
 */
export function dismissExternalChange(bufferUri: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf || buf.externalContent === null) return;
  setState("buffers", bufferUri, { ...buf, externalContent: null });
}

/**
 * Three-way merge resolution. The user has reviewed base /
 * external / local and produced a merged result via the
 * `<MergeConflictPanel>`; apply it as the buffer's new live
 * content and clear `externalContent`. Recovery snapshot +
 * autosave + Monaco model + version + dirty flag all update.
 *
 * Dirty remains true (the merged result still hasn't been written
 * to disk); the user's next save commits it. baseContent stays at
 * the previous on-disk snapshot — the explicit save flow is what
 * promotes the merged content to disk.
 */
export function resolveConflict(bufferUri: string, mergedContent: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf) return;
  // The panel is only visible when externalContent is set; tests
  // and edge-cases can pass arbitrary content though, so the
  // resolution path doesn't strictly require externalContent.
  const dirty = mergedContent !== buf.baseContent;
  const model = modelRegistry.getModelByUri(bufferUri);
  try {
    model?.setValue(mergedContent);
  } catch {
    /* model may have been disposed mid-flight */
  }
  batch(() => {
    setState("buffers", bufferUri, {
      ...buf,
      content: mergedContent,
      dirty,
      externalContent: null,
    });
    modelRegistry.setDirty(bufferUri, dirty);
    modelRegistry.bumpBufferVersion(bufferUri);
  });
  if (dirty) {
    persistRecoverySnapshot(bufferUri);
    scheduleAutosave(bufferUri);
  } else {
    cancelAutosave(bufferUri);
    clearRecoverySnapshot(bufferUri);
  }
}

// ---------------------------------------------------------------------
// Crash-recovery persistence
// ---------------------------------------------------------------------

function readRecoveryMap(): Record<string, RecoverableSnapshot> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(RECOVERY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, RecoverableSnapshot>;
  } catch {
    return {};
  }
}

function writeRecoveryMap(map: Record<string, RecoverableSnapshot>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / disabled — recovery is best-effort */
  }
}

function persistRecoverySnapshot(bufferUri: string): void {
  const buf = state.buffers[bufferUri];
  if (!buf) return;
  if (!buf.dirty || buf.status !== "ready") {
    clearRecoverySnapshot(bufferUri);
    return;
  }
  const map = readRecoveryMap();
  map[bufferUri] = {
    bufferUri,
    filePath: buf.filePath,
    sessionName: buf.sessionName,
    rootPath: buf.rootPath,
    language: buf.language,
    content: buf.content,
    baseContent: buf.baseContent,
    savedAt: Date.now(),
  };
  writeRecoveryMap(map);
}

function clearRecoverySnapshot(bufferUri: string): void {
  if (typeof window === "undefined") return;
  const map = readRecoveryMap();
  if (!(bufferUri in map)) return;
  delete map[bufferUri];
  writeRecoveryMap(map);
}

/**
 * Return every persisted recovery snapshot — optionally narrowed
 * to one session. Hosts use this on project mount to decide
 * whether to prompt for restore.
 */
export function listRecoverableBuffers(sessionName?: string): RecoverableSnapshot[] {
  const map = readRecoveryMap();
  const all = Object.values(map);
  if (!sessionName) return all;
  return all.filter((s) => s.sessionName === sessionName);
}

/**
 * Restore a recovery snapshot — opens the buffer, hydrates it from
 * the saved baseContent (so the disk-derived view is correct) and
 * applies the dirty content on top (so the editor shows the user's
 * unsaved edits). Caller is responsible for prompting before
 * calling.
 */
export async function restoreRecoverableBuffer(snap: RecoverableSnapshot): Promise<void> {
  openBuffer({
    sessionName: snap.sessionName,
    rootPath: snap.rootPath,
    filePath: snap.filePath,
    language: snap.language,
  });
  await markReady(snap.bufferUri, snap.baseContent);
  if (snap.content !== snap.baseContent) {
    // Reapply the dirty edits on top of baseContent. markContent
    // re-persists the snapshot, which is fine — it's a no-op write
    // of the same data.
    markContent(snap.bufferUri, snap.content);
  }
}

/**
 * Drop a recovery snapshot without opening it (user declined to
 * restore).
 */
export function discardRecoverableBuffer(bufferUri: string): void {
  clearRecoverySnapshot(bufferUri);
}

/** Test-only reset. */
export function __resetBufferStoreForTests(set?: SetStoreFunction<BufferStoreState>): void {
  void set; // unused — kept for signature parity with other test helpers
  for (const t of autosaveTimers.values()) clearTimeout(t);
  autosaveTimers.clear();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(RECOVERY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
  setState({ buffers: {}, order: [], activeUri: null });
}
