# Goal-17 — Code editor port

> **Status:** Audit only. No code changes.
> **Source:** `context/emdash/src/renderer/lib/monaco/` (~1.6k LOC), `context/emdash/src/renderer/lib/editor/` (~0.4k LOC), `context/emdash/src/main/core/editor/` (~0.07k LOC).
> **Motivation:** the editor surface is the biggest remaining hole in the v2 shell. The reference codebase ships a production-quality Monaco integration whose patterns (pool, lease, model registry, typed URIs, invalidation bridges) are exactly what a daemon-backed multi-file editor needs.

---

## §1 — Survey of the reference Monaco architecture

The reference renderer splits its editor surface into three layers, mounted at module load and shared across every editor instance in the app.

### 1.1 — `MonacoPool<TEditor>` (`monaco-pool.ts`, 176 LOC)

A type-parameterised pool of pre-warmed Monaco editor instances. Two concrete pools exist on top: `codeEditorPool` for single-file `IStandaloneCodeEditor` and `diffEditorPool` for `IStandaloneDiffEditor`. Each pool:

- Lives in an off-screen `position:fixed; top:-10000px; visibility:hidden` root so Monaco's `ResizeObserver` keeps measuring correctly (`display:none` would break layout measurement).
- Pre-creates `reserveTarget` idle entries on `init()`. The default is 2 for code, 3 for diff — diffs are heavier so the buffer matters more.
- Exposes `lease() / release(entry)` returning a `PoolEntry<TEditor>` that pairs the editor with its DOM container + per-lease `IDisposable[]`. Release disposes the disposables, calls `cleanupOnRelease`, reparents the container back to the pool root, and replenishes idle slots in the background.
- Exposes the loaded Monaco namespace via `getMonaco()` (and stashes it on `globalThis.__monaco` so module-level singletons — the registry — can reach it without circular imports).

**Why it matters.** Cold-creating a Monaco editor is ~200–400 ms on a warm V8. A leased pool collapses that to a single DOM reparent (~ms). For a tab-switching editor that's the difference between a UI that feels snappy and one that doesn't.

### 1.2 — `MonacoModelRegistry` (`monaco-model-registry.ts`, 811 LOC — the heart)

A single mutable singleton that owns every `monaco.editor.ITextModel` instance in the app, keyed by a typed URI. Three URI schemes correspond to three semantically distinct models per file:

| URI scheme        | Purpose                                  | Writable | Source of truth                                |
| ----------------- | ---------------------------------------- | -------- | ---------------------------------------------- |
| `file://…`        | Buffer — what the editor renders + edits | yes      | Monaco model + crash-recovery autosave         |
| `disk://…`        | Mirror of current on-disk content        | no       | filesystem (RPC fetch + FS-watch invalidation) |
| `git://…/<ref>/…` | Snapshot at a specific git ref           | no       | `git show <ref>:<path>`                        |

All three models share the same URI body (file path + workspace), so a buffer-aware dirty-check is one map lookup + one `getValue() !==`. Diff editors take an `(original, modified)` pair where original is typically a `git://…/HEAD/…` model and modified is the live `file://…` buffer — no copy, no reload.

**Lifecycle highlights:**

- **Ref-counted with a 60s eviction window** — `unregisterModel` decrements; reaching 0 starts a `setTimeout`. Re-registering before the timer cancels it. Closing a tab and reopening 10s later is free.
- **Reactive status map** — `modelStatus: observable.map<uri, "loading"|"ready"|"error">` is what consumers wait on. Renderers gate their render on `'ready'`, so a model that's still fetching from disk renders a skeleton, not a flash of empty content.
- **Dedup'd fetches** — concurrent `registerModel` calls for the same `(project, workspace, file, type, ref?)` collapse to one RPC via an in-flight `Map<key, Promise>`.
- **Crash-recovery autosave** — every `onDidChangeContent` schedules a debounced (2s) `rpc.editorBuffer.saveBuffer` so unsaved edits survive an app crash. On reopen, the main-process service hands the content back via `listBuffers`.
- **Cooperative dirty model** — `dirtyUris` is an `observable.set<string>` populated by comparing `buffer.getValue() !== disk.getValue()`. The disk side stays current because FS-watch events route through `invalidateModel(uri)`, which calls `applyDiskUpdate` — that helper carefully handles the three cases (buffer clean → silently sync, buffer dirty + matches new disk → silently clear dirty, buffer dirty + diverges → add to `pendingConflicts`).
- **Atomic save** — `saveFileToDisk(uri)` writes via RPC, syncs the disk model to match, clears dirty + pending conflict, and asks the main-process buffer service to drop the crash-recovery row.
- **Multi-tab view state** — `attach(editor, newUri, prevUri)` saves `editor.saveViewState()` onto the previous URI's entry before swapping. Cursor position, scroll, folding state, all preserved across tab switches without per-component bookkeeping.

The registry has **zero direct event subscriptions**. It's a pure SWR cache — external invalidation bridges (next section) translate FS / git events into `invalidateModel(uri)` calls.

### 1.3 — Invalidation bridges (`invalidation-bridges.ts`, 80 LOC)

Three event streams from the main process feed into the registry:

- **`fsWatchEventChannel`** — file watch events (modify / create / delete / rename). `findDiskUris({workspaceId, filePath})` returns the affected URIs; each is invalidated. `.git/*` paths are filtered.
- **`gitWorkspaceChangedChannel`** — index vs HEAD changed. Invalidates all `git://…/HEAD/…` or `git://…/STAGED/…` URIs for the workspace.
- **`gitRefChangedChannel`** — a specific branch/tag moved. Invalidates exact-ref matches; falls back to "any branch" when the change kind is unspecified.

All three return unsubscribe functions; the wirer composes one teardown.

### 1.4 — Per-pool surfaces (`monaco-code-pool.ts`, `monaco-diff-pool.ts`)

Both are thin: 23 and 94 LOC. They construct the underlying `MonacoPool<TEditor>` with the per-editor `createEditor` factory + cleanup. Diff adds an `applyContent(entry, originalUri, modifiedUri, language)` helper that resolves both URIs through the registry and calls `editor.setModel({ original, modified })`. The model registry owns lifecycle for `file://` / `disk://` / `git://`; the pool itself only disposes `inmemory://` scratch models it temporarily created.

### 1.5 — `StickyDiffEditor` (`sticky-diff-editor.tsx`, 142 LOC)

A counter-pattern to the lease/release model: the diff editor used in PR-style sticky views creates its Monaco diff editor **once** and swaps content via a MobX `autorun`. The autorun waits for both URI's `modelStatus` to be `'ready'`, then calls `editor.setModel({original, modified})` in place. The editor lives for the lifetime of the component. Used when the diff is the whole component, not a tile.

### 1.6 — Per-filetype renderers (`lib/editor/`)

`fileKind.ts` is a pure extension-keyed switch that returns one of `text | markdown | svg | image | binary | too-large` (the last set after I/O when the FS layer reports `truncated`). The dispatch is taken once at the tab-open site; each kind has a dedicated renderer:

| Kind        | Renderer                    | What it renders                                                           |
| ----------- | --------------------------- | ------------------------------------------------------------------------- |
| `text`      | Monaco code editor (leased) | code with syntax highlighting + autosave                                  |
| `markdown`  | `MarkdownEditorRenderer`    | preview (default) + toggle to Monaco source                               |
| `svg`       | `SvgRenderer`               | inline `<img>` from `URL.createObjectURL(blob)` + toggle to Monaco source |
| `image`     | `ImageRenderer`             | `<img src={dataUrl}>` (data-URL fetched once)                             |
| `too-large` | `TooLargeRenderer`          | static "file too large" placeholder                                       |
| `binary`    | `BinaryRenderer`            | static "binary file" placeholder                                          |

The markdown + SVG renderers explicitly read `modelRegistry.getValue(bufferUri)` so editing in source mode and flipping back to preview shows your unsaved changes immediately — no re-fetch.

### 1.7 — Main-process editor coordination (`main/core/editor/`)

Two tiny files. `EditorBufferService` is a SQLite-backed table of `(projectId, workspaceId, filePath) → content` with a 7-day TTL, exposed via three RPCs (`saveBuffer`, `clearBuffer`, `listBuffers`). That's the entire backend support — file reads + writes are existing FS RPCs; git reads use existing git RPCs; FS watch + git ref change events are existing pub-sub channels.

### 1.8 — Misc

- `monacoModelPath.ts` — pure helper that builds the `file://…` URI for a `(rootPath, filePath)` pair. Percent-encodes each path segment.
- `use-model.ts` + `use-monaco-lease.ts` — 30/39 LOC React hooks that wrap the registry's observable into renderer-friendly form. The lease hook returns a `MobX observable.box` so MobX `autorun`s can react to the lease arriving alongside other observable inputs.
- `monaco-themes.ts` — paints CSS-custom-property colours to a 1×1 canvas to convert any colour space (hex / hsl / p3) to Monaco-compatible hex; reads `--monaco-bg`, `--monaco-fg`, `--monaco-line-highlight`, the diff insert/remove backgrounds, etc., and emits a `monaco.editor.defineTheme` call for `custom-dark` and `custom-light`.
- `editorConfig.ts` + `monaco-config.ts` — `DIFF_EDITOR_BASE_OPTIONS` (40 lines of carefully tuned Monaco options) and TS / JS language defaults (no semantic validation — Monaco doesn't have the full project type environment).
- `activeCodeEditor.ts` — focus-tracked singleton so global undo/redo keybinds route to whichever Monaco instance currently has focus.

---

## §2 — Solid + Effect equivalents

Monaco itself is vendor-neutral DOM-mounted JS — **keep it**. The wrapper layers around it are React + MobX-shaped and want fresh idioms.

### 2.1 — The pool stays imperative

`MonacoPool<TEditor>` is already a plain class. Solid doesn't change anything here — the pool is process-singleton, not per-component reactive state. **Port verbatim** to `dashboard/src/lib/monaco/monaco-pool.ts` with one small change: replace MobX `observable.box`-based lease tracking (used by `use-monaco-lease.ts`) with a Solid signal. Same shape, different host reactive runtime.

### 2.2 — The registry becomes Solid stores + an Effect.Service

The model registry has three reactive surfaces consumers care about:

1. `modelStatus: Map<uri, 'loading'|'ready'|'error'>` — drives render gating.
2. `dirtyUris: Set<uri>` — drives the "•" indicator on tabs.
3. `bufferVersions: Map<uri, version>` — drives reactive readers of buffer content (markdown / svg preview).

Solid expression:

- Replace `observable.map<uri, ModelStatus>` with a `createStore` whose first level is the URI string. Reading `store.modelStatus[uri]` from a Solid component re-runs the effect when that URI's status changes — same granularity as MobX `observable.map.get()`. Set via `setStore('modelStatus', uri, 'ready')`.
- `dirtyUris` and `bufferVersions` become two more `createStore` instances. Reactive without listing the URI in any dep array.
- The non-reactive `modelMap`, `evictionTimers`, `bufferContentDisposables`, `bufferAutosaveTimers`, `pendingFetches` are plain `Map<>` / `Set<>` instances — Monaco models are imperative; trying to make them reactive is a category error.

Wrap the whole thing in an `Effect.Service` (mirroring how the dashboard `fetchSessions` service is shaped — `src/lib/api.ts`). Public methods return `Effect.Effect<…, DomainError>`; the internal map mutations + Monaco calls stay synchronous inside the effect bodies. This buys typed error channels for the RPC fetches (`registerDisk` / `registerGit`) without inventing a parallel error type system on top of MobX.

```ts
// Sketch
export interface MonacoModelRegistry {
  readonly registerModel: (
    input: RegisterModelInput,
  ) => Effect.Effect<string, ModelRegistryError, FsRpc | GitRpc>;
  readonly unregisterModel: (uri: string) => Effect.Effect<void>;
  readonly invalidateModel: (
    uri: string,
  ) => Effect.Effect<void, ModelRegistryError, FsRpc | GitRpc>;
  readonly attach: (
    editor: monaco.editor.IStandaloneCodeEditor,
    newUri: string,
    prevUri?: string,
  ) => void;
  readonly saveFileToDisk: (uri: string) => Effect.Effect<string | null, ModelRegistryError, FsRpc>;
  // …
  // Reactive surfaces (raw Solid stores — no Effect wrapping; reading is the side effect):
  readonly modelStatus: Store<Record<string, ModelStatus>>;
  readonly dirtyUris: Store<Record<string, true>>;
  readonly bufferVersions: Store<Record<string, number>>;
}
```

### 2.3 — `useMonacoLease` collapses into a Solid `createResource` + `onCleanup`

```ts
export function useMonacoLease<T>(pool: MonacoPool<T>) {
  const [entry, setEntry] = createSignal<PoolEntry<T> | null>(null);
  let leased: PoolEntry<T> | null = null;
  void pool.lease().then((e) => {
    leased = e;
    setEntry(e);
  });
  onCleanup(() => {
    if (leased) pool.release(leased);
  });
  return entry;
}
```

Reads the signal in a component re-runs the effect when the lease arrives. Drop-in for the existing React hook.

### 2.4 — Invalidation bridges become Effect daemon resources

The reference codebase consumes IPC events via a `mobx-react` channel abstraction. In our world the daemon broadcasts via WebSocket `/ws/events`. Wire each bridge as an `Effect.Layer` that subscribes on layer activation and cleans up on dispose:

- `Layer.scoped` opens the WS subscription.
- The subscriber translates frames (`fs.watch.event`, `git.workspace.changed`, `git.ref.changed`) into `registry.invalidateModel(uri)` calls.

The translation logic is identical (`diskUrisForFsWatchEvent` is pure — copy it verbatim).

### 2.5 — Themes + config — keep, port mechanically

Monaco theme defs are just JS objects; the CSS-var-to-canvas-hex trick still works in the browser. `editorConfig.ts` is config, not code; copy. `monaco-config.ts` (TS language defaults) — copy, but consider feeding it real `tsconfig.json` paths from the daemon's project detection (existing `tmux-ide detect` already has the data).

### 2.6 — `StickyDiffEditor` keeps its create-once + autorun pattern

Solid's `createEffect` is the autorun. The component:

```tsx
export function StickyDiffEditor(props: StickyDiffEditorProps) {
  let mountRef: HTMLDivElement | undefined;
  const [editor, setEditor] = createSignal<monaco.editor.IStandaloneDiffEditor | null>(null);

  onMount(() => {
    const m = getMonacoOrThrow();
    const next = m.editor.createDiffEditor(mountRef!, { ...DIFF_EDITOR_BASE_OPTIONS });
    setEditor(next);
    onCleanup(() => next.dispose());
  });

  createEffect(() => {
    const e = editor();
    if (!e) return;
    const origStatus = registry.modelStatus[props.originalUri];
    const modStatus = registry.modelStatus[props.modifiedUri];
    if (origStatus !== "ready" || modStatus !== "ready") return;
    const origModel = registry.getModelByUri(props.originalUri);
    const modModel = registry.getModelByUri(props.modifiedUri);
    if (!origModel || !modModel) return;
    e.setModel({ original: origModel, modified: modModel });
  });

  return <div ref={mountRef} class="h-full" />;
}
```

Identical mental model; the props are still URI strings, the gating is still `'ready'`.

---

## §3 — Per-filetype renderer dispatch

The dispatch table maps 1:1. The renderers themselves are tiny (10–70 LOC each):

| Reference file           | Solid port (target)                                  | Notes                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileKind.ts`            | `dashboard/src/lib/editor/fileKind.ts`               | Pure — copy unchanged.                                                                                                                                                                                                      |
| `binary-renderer.tsx`    | `dashboard/src/components/editor/BinaryRenderer.tsx` | Trivial JSX rewrite. Replace `lucide-react` with `lucide-solid` (already in dashboard deps via the widgets package, confirm at port time).                                                                                  |
| `image-renderer.tsx`     | `…/ImageRenderer.tsx`                                | Same. `<img src={file.content}>` — content is a data URL provided by the daemon (new endpoint, see §4).                                                                                                                     |
| `markdown-renderer.tsx`  | `…/MarkdownRenderer.tsx`                             | Reuses the dashboard's existing markdown renderer (chat-solid's `lib/markdown.ts` or whatever the post-cutover surface has). Reactive read of `registry.bufferVersions[uri]` triggers re-render when the source pane edits. |
| `svg-renderer.tsx`       | `…/SvgRenderer.tsx`                                  | `URL.createObjectURL(new Blob([content], {type:'image/svg+xml'}))` + `onCleanup(() => URL.revokeObjectURL(url))`.                                                                                                           |
| `too-large-renderer.tsx` | `…/TooLargeRenderer.tsx`                             | Trivial.                                                                                                                                                                                                                    |

The dispatch site (post-G16 lives in `dashboard/src/routes/v2/project/[name]/<some-editor-component>`) looks like:

```tsx
<Switch>
  <Match when={file().kind === "image"}>
    <ImageRenderer file={file()} />
  </Match>
  <Match when={file().kind === "svg"}>
    <SvgRenderer filePath={file().path} />
  </Match>
  <Match when={file().kind === "markdown"}>
    <MarkdownRenderer filePath={file().path} />
  </Match>
  <Match when={file().kind === "text"}>
    <CodeEditor uri={bufferUri()} />
  </Match>
  <Match when={file().kind === "binary"}>
    <BinaryRenderer file={file()} />
  </Match>
  <Match when={file().kind === "too-large"}>
    <TooLargeRenderer file={file()} />
  </Match>
</Switch>
```

---

## §4 — Daemon-side support

Today's daemon already exposes most of what the editor needs. The gaps:

### What exists (`packages/daemon/src/command-center/server.ts`)

- `GET /api/project/:name/files` — file tree.
- `GET /api/project/:name/preview/:file{.+}` — read file content (sandboxed under `session.dir`, 1 MB cap).
- `GET /api/project/:name/diff` + `…/diff/:file{.+}` — per-file unified diff.

### What we need to add

| Endpoint                                                    | Why                                                                                                                                                                                                                                                                             | Shape                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **`PUT /api/project/:name/file/:file{.+}`**                 | Write back the buffer (`saveFileToDisk`). Sandboxed identically to `/preview/`.                                                                                                                                                                                                 | Body: `{ content: string }`. Returns `{ saved: true, mtimeMs }`.                                                               |
| **`GET /api/project/:name/git/file?ref=<ref>&path=<file>`** | Original side of diff editors + git:// model fetches. Shells out to `git show <ref>:<path>` inside `session.dir`.                                                                                                                                                               | Returns `{ exists, content, ref }`.                                                                                            |
| **`POST /api/v2/action/editor.buffer.save`**                | Crash-recovery autosave. Mirrors the reference codebase's `EditorBufferService` 1:1 — stores under `.tmux-ide/editor-buffers/<projectId>/<workspaceId>/<sha1(filePath)>.txt` (no SQLite needed; the daemon's persistence is filesystem-first). 7-day TTL pruned on daemon boot. | Action input: `{ session, filePath, content }`.                                                                                |
| **`POST /api/v2/action/editor.buffer.clear`**               | Called after a successful disk save.                                                                                                                                                                                                                                            | `{ session, filePath }`.                                                                                                       |
| **`POST /api/v2/action/editor.buffer.list`**                | On project open, list any unsaved buffers and offer to restore.                                                                                                                                                                                                                 | `{ session }` → `[{ filePath, content, updatedAt }]`.                                                                          |
| **WS frame `fs.watch.event`**                               | Drives `disk://` model invalidation. The daemon already has `@parcel/watcher`; emit the events on the existing `/ws/events` channel.                                                                                                                                            | `{ type: "fs.watch.event", session, path, kind: "modify"\|"create"\|"delete"\|"rename", oldPath?, entryType: "file"\|"dir" }`. |
| **WS frame `git.workspace.changed`**                        | Invalidates `git://HEAD/…` / `git://STAGED/…` URIs when the index or HEAD pointer moves. The daemon already polls git status for the changes view; piggyback.                                                                                                                   | `{ type: "git.workspace.changed", session, kind: "index"\|"head" }`.                                                           |
| **WS frame `git.ref.changed`**                              | Optional polish — only matters once we surface branch-comparison diffs in chat. Defer until G17-P4.                                                                                                                                                                             | n/a for the MVP.                                                                                                               |

**Effort estimate, daemon-side:** ~4 hours for the file write + git file-at-ref endpoints + buffer service + FS-watch broadcast, plus tests. No new infrastructure (the WS bus + sandboxing + file routes all exist).

---

## §5 — Migration phases

Phased to land value early. P1 is the platform; P4 is what users feel.

### G17-P1 — Port `lib/monaco/*` to `dashboard/src/lib/monaco/*` (~2 days)

Files (target paths, post-G16-P4 rename):

- `dashboard/src/lib/monaco/{pool,code-pool,diff-pool,themes,config,model-path,active-editor,editor-config,invalidation-bridges}.ts`
- `dashboard/src/lib/monaco/model-registry.ts` — the big one. Bring across with the Solid-store rewiring (§2.2).
- `dashboard/src/lib/monaco/use-lease.ts` + `use-model.ts` — Solid signals (§2.3).

Acceptance: the registry boots, can register a `disk://` model from a daemon RPC, and `modelStatus[uri]` flips to `'ready'`. No editor mounted yet.

**Effort:** ~16 hours of focused porting. The 811-line registry is the bulk.

### G17-P2 — Per-filetype renderers (~0.5 day)

Files: §3 table. All small, all stateless except markdown (which reads `bufferVersions`).

**Effort:** ~3 hours.

### G17-P3 — `StickyDiffEditor` + daemon git-file endpoint (~1 day)

- Add `GET /api/project/:name/git/file` on the daemon.
- Port `StickyDiffEditor` to Solid (§2.6).
- Wire it into the existing `/v2/project/[name]?view=changes` route: replace the current ad-hoc diff renderer with `<StickyDiffEditor originalUri="git://…/HEAD/…" modifiedUri="disk://…">`.

Acceptance: changed-files view shows real Monaco diffs with syntax highlighting + smart unchanged-region collapsing.

**Effort:** ~6 hours.

### G17-P4 — Wire into the Files view as the canonical preview (~1.5 days)

- Replace `dashboard/src/routes/v2/project/[name]?view=files` preview with the renderer-dispatch from §3.
- Daemon: add the buffer-save action + `PUT` file write + `fs.watch.event` WS broadcast.
- Tab strip: borrow the reference codebase's single-file "preview tab" pattern (single-click opens a preview tab in italic; double-click or first edit promotes to a stable tab). Optional polish; can ship P4 without it.

Acceptance: click a file → opens in Monaco / image / markdown / etc. Edit → autosave; Cmd-S → disk write; modify the file in a terminal → editor updates without losing cursor position.

**Effort:** ~12 hours.

### G17-P5 — Multi-file tabs + dirty state + save (~1 day)

The infrastructure from P1 already supports it (model registry refcounts + view state preservation). P5 is mostly UI:

- Tab bar at the top of the editor pane.
- Dirty dot (`registry.dirtyUris[uri]`).
- Cmd-W close, Cmd-Shift-T reopen.
- "Unsaved changes" guard on tab close.
- Crash-recovery restore prompt on project open (uses `editor.buffer.list`).

**Effort:** ~8 hours.

**Total:** ~7 person-days for a Monaco-quality editor end-to-end. The registry port (P1) is the long pole; P2 / P3 are small and could land in a single afternoon together if a pair wants to.

---

## §6 — Open questions

1. **Monaco vs CodeMirror.** Recommendation: **stay with Monaco.** Reasons: (a) the patterns we're porting are Monaco-specific — switching means re-architecting the registry; (b) Monaco's diff editor with unchanged-region collapsing is a genuine product differentiator we don't want to reinvent; (c) bundle size penalty (~3 MB ungzipped via `@monaco-editor/react` loader) is one-time, lazy-loaded, and arguably worth it for the LSP-style language services. The only argument for CodeMirror would be aggressive bundle-size targeting, which isn't a stated priority. **Reconfirm with the user before P1.**
2. **TypeScript language services scope.** Reference disables `noSemanticValidation` because Monaco doesn't have the project's type environment. For tmux-ide, a worker that proxies to a real `tsc --watch` would be a lot of work for marginal gain (LSP UX without the LSP infra). Stay with syntax-only validation.
3. **Crash-recovery storage format.** Filesystem under `.tmux-ide/editor-buffers/<projectId>/<workspaceId>/<sha1(filePath)>.txt` is simpler than SQLite and consistent with how the daemon already persists tasks. Confirm the directory pattern at P4 design time.
4. **Where does the editor mount in the v2 shell?** Today's `/v2/project/[name]?view=files` has a preview pane; P4 replaces that. But does the editor get its own dedicated `?view=editor` once multi-tab lands, or does it stay as the right-pane of `?view=files`? Recommendation: leave editor mounted inside `?view=files` until P5 lands tab strip + dirty state, then promote to its own view.
5. **Vim mode?** Out of scope. The reference codebase doesn't ship Vim bindings either. If we want them later, `monaco-vim` is a 5-line drop-in addon.
6. **LSP integration.** Out of scope for G17 entirely. The daemon would need to spawn / proxy real language servers per project; that's a separate goal (G18 candidate).

---

## §7 — Effort estimates

| Phase      | Scope                                                                     | Effort                     |
| ---------- | ------------------------------------------------------------------------- | -------------------------- |
| **G17-P1** | Port lib/monaco/\* (pool + registry + bridges + themes) to Solid + Effect | ~16 h                      |
| **G17-P2** | Per-filetype renderers (6 small files)                                    | ~3 h                       |
| **G17-P3** | StickyDiffEditor + daemon `git/file` endpoint                             | ~6 h                       |
| **G17-P4** | Wire into Files view + buffer-save / write / watch endpoints              | ~12 h                      |
| **G17-P5** | Multi-file tabs + dirty state + crash recovery UI                         | ~8 h                       |
| **Total**  |                                                                           | **~45 h** (~6 person-days) |

These estimates assume the porter has the reference codebase open as a side-by-side. Compress to ~4 person-days if Monaco + Effect are familiar; expand to ~10 if both are new to the porter.

---

## TL;DR

**Recommended editor library:** **Monaco — stay**. The reference codebase's pool + typed-URI registry + invalidation-bridge pattern is what makes the integration production-quality; that pattern doesn't survive a CodeMirror pivot without being rewritten end-to-end.

**Top three hardest things to port:**

1. **`MonacoModelRegistry`** (811 LOC) — three URI schemes, ref-counted with eviction window, dedup'd RPCs, dirty-tracking that handles the four (clean / synced / silently-clear / conflict) outcomes of a disk update, autosave + crash recovery, multi-tab view-state. The single biggest piece; budget two solid days.
2. **`StickyDiffEditor`** (142 LOC) — the create-once-then-autorun pattern is subtle. Getting Solid's `createEffect` to wait on both `modelStatus` reads and the editor signal without firing partial updates needs care; resist the urge to "just useEffect it".
3. **FS-watch + git-ref-change invalidation plumbing.** Conceptually small but spans daemon (broadcast) + bridge (subscribe + translate) + registry (apply). Without it, `disk://` models go stale and the dirty-tracking lies.

Daemon-side, the gap is small: one `PUT` file route, one `GET` git-at-ref route, one buffer service (mirror the reference's 57-line `EditorBufferService`), one new WS frame type for FS events. ~4 hours of daemon work for the whole goal.
