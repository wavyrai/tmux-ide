/**
 * MonacoModelRegistry — Solid port of emdash's `monaco-model-registry.ts`.
 *
 * A process-singleton that owns every `monaco.editor.ITextModel` in
 * the app, keyed by a typed URI. Three URI schemes correspond to
 * three semantically distinct models per file:
 *
 *   file://...      — buffer; writable; what the editor renders
 *   disk://...      — read-only mirror of the on-disk content
 *   git://.../HEAD  — read-only snapshot at a git ref
 *
 * Lifecycle (mirrors the React+MobX original):
 *   - Ref-counted with a 60s eviction window. Re-registering before
 *     the TTL fires cancels the eviction.
 *   - Reactive `modelStatus` / `dirtyUris` / `bufferVersions` —
 *     re-implemented over Solid `createStore` so consumers read
 *     `store.modelStatus[uri]` and re-run when that URI's value
 *     changes (same granularity as MobX `observable.map.get()`).
 *   - Dedup'd fetches — concurrent registrations for the same key
 *     collapse to one RPC via an in-flight `Map<key, Promise>`.
 *
 * Effect surface: `registerDisk` returns an `Effect.Effect<string,
 * ModelRegistryError>` so callers compose with the rest of the
 * dashboard's Effect chains; everything else stays synchronous (the
 * underlying Monaco API is imperative).
 *
 * Scope for G17-P1: register disk models from the daemon's
 * `/api/project/:name/preview/:file` endpoint, with status flips to
 * `'ready'`. Buffer + git ref registration land in P3 alongside the
 * diff editor.
 */

import { createStore, type SetStoreFunction } from "solid-js/store";
import { Effect, Data } from "effect";
import type * as monaco from "monaco-editor";
import { fetchFilePreview, fetchGitFile, ApiError, type GitRef } from "@/lib/api";
import { buildMonacoModelPath, toDiskUri, toGitUri } from "./model-path";
import { getMonacoFromGlobal } from "./pool";

export type ModelType = "buffer" | "disk" | "git";
export type ModelStatus = "loading" | "ready" | "error";

interface DiskModelEntry {
  type: "disk";
  model: monaco.editor.ITextModel;
  refs: number;
  sessionName: string;
  filePath: string;
  language: string;
}

interface BufferModelEntry {
  type: "buffer";
  model: monaco.editor.ITextModel;
  refs: number;
  sessionName: string;
  filePath: string;
  language: string;
  /** Saved across tab switches. */
  viewState: monaco.editor.ICodeEditorViewState | null;
}

interface GitModelEntry {
  type: "git";
  model: monaco.editor.ITextModel;
  refs: number;
  sessionName: string;
  filePath: string;
  language: string;
  ref: string;
}

type ModelEntry = DiskModelEntry | BufferModelEntry | GitModelEntry;

export class ModelRegistryError extends Data.TaggedError("ModelRegistryError")<{
  readonly uri: string;
  readonly stage: "fetch" | "create-model" | "monaco-load";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Reactive surfaces exposed to Solid consumers. */
interface ReactiveState {
  modelStatus: Record<string, ModelStatus>;
  dirtyUris: Record<string, true>;
  /**
   * Monotonically-increasing buffer content version, per buffer URI.
   * Components reading buffer text subscribe to this signal to
   * re-render on edits without polling.
   */
  bufferVersions: Record<string, number>;
}

const EVICTION_TTL_MS = 60_000;

export class MonacoModelRegistry {
  // Imperative maps — Monaco models are mutable; making them reactive
  // is a category error.
  private modelMap = new Map<string, ModelEntry>();
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingFetches = new Map<string, Promise<string>>();

  // Monaco readiness — resolved by the pool's onInit hook via
  // `notifyMonacoReady`. The pool also stashes Monaco on globalThis;
  // we read it from there to avoid a circular import.
  private monacoReadyPromise: Promise<typeof monaco>;
  private resolveMonacoReady!: (m: typeof monaco) => void;
  private monacoResolved = false;

  // Reactive surfaces. `solid-js/store` proxies hand each URI access
  // its own reactivity — reading `state.modelStatus[uri]` from a
  // Solid component or `createEffect` re-runs only when that URI's
  // status changes, not when any URI changes.
  private state: ReactiveState;
  private setState: SetStoreFunction<ReactiveState>;

  constructor() {
    const [state, setState] = createStore<ReactiveState>({
      modelStatus: {},
      dirtyUris: {},
      bufferVersions: {},
    });
    this.state = state;
    this.setState = setState;
    this.monacoReadyPromise = new Promise<typeof monaco>((resolve) => {
      this.resolveMonacoReady = resolve;
    });
  }

  // -------------------------------------------------------------------
  // Reactive accessors
  // -------------------------------------------------------------------

  /** Reactive status for a URI. Reads track changes per URI. */
  modelStatus(uri: string): ModelStatus {
    return this.state.modelStatus[uri] ?? "loading";
  }

  /** Reactive dirty flag for a buffer URI. */
  isDirty(bufferUri: string): boolean {
    return this.state.dirtyUris[bufferUri] === true;
  }

  /** Reactive content version for a buffer URI. */
  bufferVersion(bufferUri: string): number {
    return this.state.bufferVersions[bufferUri] ?? 0;
  }

  /**
   * Raw store snapshot — handed to tests + advanced consumers. Reads
   * are NOT reactive when accessed this way; use `modelStatus(uri)`
   * for reactivity.
   */
  getStateSnapshot(): Readonly<ReactiveState> {
    return this.state;
  }

  // -------------------------------------------------------------------
  // Monaco readiness
  // -------------------------------------------------------------------

  /**
   * Called by the pool's `onInit` after Monaco finishes loading. Safe
   * to call multiple times; only the first call has any effect.
   */
  notifyMonacoReady(m: typeof monaco): void {
    if (this.monacoResolved) return;
    this.monacoResolved = true;
    this.resolveMonacoReady(m);
  }

  private async waitForMonaco(): Promise<typeof monaco> {
    if (this.monacoResolved) return this.monacoReadyPromise;
    // If the pool has already initialised and the global pointer is
    // set, resolve eagerly so the registry can boot in isolation
    // (tests; widgets that don't go through the code pool).
    const global = getMonacoFromGlobal();
    if (global) {
      this.notifyMonacoReady(global);
      return global;
    }
    return this.monacoReadyPromise;
  }

  // -------------------------------------------------------------------
  // Public registration API
  // -------------------------------------------------------------------

  /**
   * Effect-flavoured disk-model registration. Returns the buffer URI
   * string (same body as `file://` / `disk://` / `git://` for the
   * same file). On success, `modelStatus[diskUri]` flips to `'ready'`.
   *
   * Idempotent over the disk URI — concurrent calls coalesce on the
   * in-flight fetch + share the same final model.
   */
  registerDisk(input: {
    sessionName: string;
    rootPath: string;
    filePath: string;
    language: string;
  }): Effect.Effect<string, ModelRegistryError> {
    return Effect.tryPromise({
      try: () =>
        this.registerDiskAsync(input.sessionName, input.rootPath, input.filePath, input.language),
      catch: (cause) =>
        cause instanceof ModelRegistryError
          ? cause
          : new ModelRegistryError({
              uri: buildMonacoModelPath(input.rootPath, input.filePath),
              stage: "create-model",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
    });
  }

  private async registerDiskAsync(
    sessionName: string,
    rootPath: string,
    filePath: string,
    language: string,
  ): Promise<string> {
    const bufferUri = buildMonacoModelPath(rootPath, filePath);
    const diskUri = toDiskUri(bufferUri);

    // Already-registered fast path. Increment ref count + cancel any
    // pending eviction.
    const existing = this.modelMap.get(diskUri);
    if (existing?.type === "disk") {
      existing.refs += 1;
      const timer = this.evictionTimers.get(diskUri);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.evictionTimers.delete(diskUri);
      }
      return bufferUri;
    }

    this.setState("modelStatus", diskUri, "loading");

    // Fetch content + wait for Monaco in parallel; neither blocks the
    // other.
    let content: string;
    let m: typeof monaco;
    try {
      const fetchKey = `${sessionName}:${filePath}:disk`;
      [content, m] = await Promise.all([
        this.dedupFetch(fetchKey, () =>
          Effect.runPromise(fetchFilePreview(sessionName, filePath)).then((preview) => {
            if (!preview.exists) {
              throw new ModelRegistryError({
                uri: diskUri,
                stage: "fetch",
                message: `File not found: ${filePath}`,
              });
            }
            return preview.content;
          }),
        ),
        this.waitForMonaco(),
      ]);
    } catch (err) {
      this.setState("modelStatus", diskUri, "error");
      if (err instanceof ModelRegistryError) throw err;
      if (err instanceof ApiError) {
        throw new ModelRegistryError({
          uri: diskUri,
          stage: "fetch",
          message: err.message,
          cause: err,
        });
      }
      throw err;
    }

    const monacoUri = m.Uri.parse(diskUri);
    let model = m.editor.getModel(monacoUri);
    if (!model) model = m.editor.createModel(content, language, monacoUri);
    const entry: DiskModelEntry = {
      type: "disk",
      model,
      refs: 1,
      sessionName,
      filePath,
      language,
    };
    this.modelMap.set(diskUri, entry);
    this.setState("modelStatus", diskUri, "ready");
    return bufferUri;
  }

  /**
   * Register (or increment refcount on) a `git://...` model — the
   * read-only snapshot of `filePath` at `ref`. Same lifecycle as
   * `registerDisk`: ref-counted, in-flight-dedup'd, status-tracked.
   *
   * Returns the git URI string (not the buffer URI) — diff editors
   * pin the original side to this URI directly.
   */
  registerGit(input: {
    sessionName: string;
    rootPath: string;
    filePath: string;
    language: string;
    ref?: GitRef;
  }): Effect.Effect<string, ModelRegistryError> {
    const ref = input.ref ?? "HEAD";
    return Effect.tryPromise({
      try: () =>
        this.registerGitAsync(
          input.sessionName,
          input.rootPath,
          input.filePath,
          input.language,
          ref,
        ),
      catch: (cause) => {
        const bufferUri = buildMonacoModelPath(input.rootPath, input.filePath);
        return cause instanceof ModelRegistryError
          ? cause
          : new ModelRegistryError({
              uri: toGitUri(bufferUri, String(ref)),
              stage: "create-model",
              message: cause instanceof Error ? cause.message : String(cause),
              cause,
            });
      },
    });
  }

  private async registerGitAsync(
    sessionName: string,
    rootPath: string,
    filePath: string,
    language: string,
    ref: GitRef,
  ): Promise<string> {
    const bufferUri = buildMonacoModelPath(rootPath, filePath);
    const gitUri = toGitUri(bufferUri, String(ref));

    // Fast path: already registered at this exact ref.
    const existing = this.modelMap.get(gitUri);
    if (existing?.type === "git" && existing.ref === ref) {
      existing.refs += 1;
      const timer = this.evictionTimers.get(gitUri);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.evictionTimers.delete(gitUri);
      }
      return gitUri;
    }

    this.setState("modelStatus", gitUri, "loading");

    let content: string;
    let m: typeof monaco;
    try {
      const fetchKey = `${sessionName}:${filePath}:git:${ref}`;
      [content, m] = await Promise.all([
        this.dedupFetch(fetchKey, () =>
          Effect.runPromise(fetchGitFile(sessionName, filePath, ref)).then((result) => {
            // Missing-at-ref is NOT an error — the side just renders
            // empty (added since / never tracked / deleted). Return
            // empty content so the diff editor still mounts.
            return result.exists ? result.content : "";
          }),
        ),
        this.waitForMonaco(),
      ]);
    } catch (err) {
      this.setState("modelStatus", gitUri, "error");
      if (err instanceof ModelRegistryError) throw err;
      if (err instanceof ApiError) {
        throw new ModelRegistryError({
          uri: gitUri,
          stage: "fetch",
          message: err.message,
          cause: err,
        });
      }
      throw err;
    }

    const monacoUri = m.Uri.parse(gitUri);
    let model = m.editor.getModel(monacoUri);
    if (!model) model = m.editor.createModel(content, language, monacoUri);
    const entry: GitModelEntry = {
      type: "git",
      model,
      refs: 1,
      sessionName,
      filePath,
      language,
      ref: String(ref),
    };
    this.modelMap.set(gitUri, entry);
    this.setState("modelStatus", gitUri, "ready");
    return gitUri;
  }

  /**
   * Register (or increment refcount on) a writable `file://` buffer
   * model seeded with the supplied content. Unlike `registerDisk`,
   * this is purely synchronous — the host already has the content
   * (typically from a freshly-resolved `fetchFilePreview` call) and
   * just wants Monaco to wrap it in an editable model.
   *
   * The buffer-store uses this to mount an editable `file://`
   * model behind each open tab; edits flow back to the buffer
   * store via the editor's `onDidChangeModelContent`.
   *
   * Returns the buffer URI string.
   */
  registerBuffer(input: {
    sessionName: string;
    rootPath: string;
    filePath: string;
    language: string;
    initialContent: string;
  }): string {
    const bufferUri = buildMonacoModelPath(input.rootPath, input.filePath);

    const existing = this.modelMap.get(bufferUri);
    if (existing?.type === "buffer") {
      existing.refs += 1;
      const timer = this.evictionTimers.get(bufferUri);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.evictionTimers.delete(bufferUri);
      }
      return bufferUri;
    }

    const m = getMonacoFromGlobal();
    if (!m) {
      throw new ModelRegistryError({
        uri: bufferUri,
        stage: "monaco-load",
        message: "registerBuffer requires Monaco to be loaded (call codeEditorPool.init() first)",
      });
    }

    const monacoUri = m.Uri.parse(bufferUri);
    let model = m.editor.getModel(monacoUri);
    if (!model) {
      model = m.editor.createModel(input.initialContent, input.language, monacoUri);
    } else {
      // Existing Monaco model with the same URI but not yet tracked
      // by the registry — reset its value to the freshly fetched
      // content so the editor isn't showing stale data.
      try {
        model.setValue(input.initialContent);
      } catch {
        /* ignore */
      }
    }

    const entry: BufferModelEntry = {
      type: "buffer",
      model,
      refs: 1,
      sessionName: input.sessionName,
      filePath: input.filePath,
      language: input.language,
      viewState: null,
    };
    this.modelMap.set(bufferUri, entry);
    this.setState("modelStatus", bufferUri, "ready");
    this.setState("bufferVersions", bufferUri, 1);
    return bufferUri;
  }

  /**
   * Bump the version counter for a buffer URI. Consumers that read
   * the buffer's text via memo can subscribe to the version to
   * re-run on edit. Returns the new version.
   */
  bumpBufferVersion(bufferUri: string): number {
    const next = (this.state.bufferVersions[bufferUri] ?? 0) + 1;
    this.setState("bufferVersions", bufferUri, next);
    return next;
  }

  /**
   * Set the dirty bit for a buffer URI. Drives the tab strip's
   * dirty indicator (`•`).
   */
  setDirty(bufferUri: string, dirty: boolean): void {
    if (dirty) {
      this.setState("dirtyUris", bufferUri, true);
    } else {
      this.setState("dirtyUris", bufferUri, undefined as unknown as true);
    }
  }

  /**
   * Decrement the ref count on a URI. When refs reach 0, schedule a
   * 60s eviction timer; re-registering within that window cancels it.
   *
   * Resolves the buffer / disk / git scheme variants of the same
   * file body so callers can pass any of them.
   */
  unregisterModel(uri: string): void {
    // Direct hit first (exact URI was passed in); otherwise expand to
    // the buffer + disk-URI pair (git URIs are scheme-specific and
    // never collapse into the buffer URI, so they only resolve
    // directly).
    const candidates = [uri, toDiskUri(uri)];
    for (const key of candidates) {
      const entry = this.modelMap.get(key);
      if (!entry) continue;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      // Schedule eviction. Any in-flight timer for this URI is
      // refreshed.
      const existing = this.evictionTimers.get(key);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => this.evictNow(key), EVICTION_TTL_MS);
      this.evictionTimers.set(key, timer);
      return;
    }
  }

  /**
   * Force-evict a URI without waiting for the TTL. Disposes the
   * Monaco model + clears reactive state. Tests rely on this.
   */
  evictNow(uri: string): void {
    const entry = this.modelMap.get(uri);
    if (!entry) return;
    try {
      entry.model.dispose();
    } catch {
      /* already disposed */
    }
    this.modelMap.delete(uri);
    this.evictionTimers.delete(uri);
    this.setState("modelStatus", uri, undefined as unknown as ModelStatus);
    this.setState("dirtyUris", uri, undefined as unknown as true);
    this.setState("bufferVersions", uri, undefined as unknown as number);
  }

  /**
   * Mark a URI for refetch. Drops the cached model + reactive entry;
   * the next `registerDisk` for the same key fetches fresh content.
   */
  invalidateModel(uri: string): void {
    this.evictNow(uri);
  }

  /** Resolve a URI to its underlying Monaco model. */
  getModelByUri(uri: string): monaco.editor.ITextModel | undefined {
    return this.modelMap.get(uri)?.model;
  }

  /**
   * Read the current text content for a registered URI. Returns null
   * if the URI isn't registered.
   */
  getValue(uri: string): string | null {
    const entry = this.modelMap.get(uri);
    return entry ? entry.model.getValue() : null;
  }

  /**
   * Attach an editor to a URI, restoring view state from a previous
   * attachment if one was recorded. Mirrors the React/MobX version's
   * `attach(editor, newUri, prevUri)` shape so multi-tab cursor /
   * scroll / folding state survives tab switches.
   */
  attach(editor: monaco.editor.IStandaloneCodeEditor, newUri: string, prevUri?: string): void {
    // Save outgoing view state.
    if (prevUri) {
      const prevEntry = this.modelMap.get(prevUri);
      if (prevEntry && prevEntry.type === "buffer") {
        prevEntry.viewState = editor.saveViewState();
      }
    }
    const nextEntry = this.modelMap.get(newUri);
    if (!nextEntry) return;
    editor.setModel(nextEntry.model);
    if (nextEntry.type === "buffer" && nextEntry.viewState) {
      editor.restoreViewState(nextEntry.viewState);
    }
  }

  /** Build the canonical buffer URI for a given root + file path. */
  uriFor(rootPath: string, filePath: string): string {
    return buildMonacoModelPath(rootPath, filePath);
  }

  /**
   * Build a git URI for a buffer URI + ref. Exposed for the diff
   * editor wire-up in G17-P3.
   */
  gitUriFor(bufferUri: string, ref: string): string {
    return toGitUri(bufferUri, ref);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private dedupFetch(key: string, fn: () => Promise<string>): Promise<string> {
    const existing = this.pendingFetches.get(key);
    if (existing) return existing;
    const p = fn().finally(() => this.pendingFetches.delete(key));
    this.pendingFetches.set(key, p);
    return p;
  }

  // -------------------------------------------------------------------
  // Test helpers
  // -------------------------------------------------------------------

  _resetForTests(): void {
    for (const entry of this.modelMap.values()) {
      try {
        entry.model.dispose();
      } catch {
        /* ignore */
      }
    }
    this.modelMap.clear();
    for (const timer of this.evictionTimers.values()) clearTimeout(timer);
    this.evictionTimers.clear();
    this.pendingFetches.clear();
    this.setState("modelStatus", {} as Record<string, ModelStatus>);
    this.setState("dirtyUris", {} as Record<string, true>);
    this.setState("bufferVersions", {} as Record<string, number>);
  }
}

/** Process-singleton; pool's `onInit` hands Monaco off via `notifyMonacoReady`. */
export const modelRegistry = new MonacoModelRegistry();
