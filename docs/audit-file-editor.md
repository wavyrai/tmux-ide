# File / Editor Feature Audit vs emdash

Audit scope: our file/preview/editor surfaces vs:

- `context/emdash/src/main/core/fs/` — filesystem RPC layer (controller + impl)
- `context/emdash/src/renderer/features/tasks/editor/` — file tree, tabs, editor host
- `context/emdash/src/renderer/features/tasks/diff-view/` — diff toolbar, stacked + single-file diff, inline comments, changes panel

Our surfaces:

- `dashboard/src/components/files/FilesSurface.tsx` — explorer rail + tab strip + canonical preview body
- `dashboard/src/components/editor/{CodeEditor,TabStrip,StickyDiffEditor,MergeConflictPanel,...}.tsx`
- `dashboard/src/lib/editor/{buffer-store,fileKind,fs-watch-client,three-way-merge}.ts`
- `dashboard/src/lib/monaco/model-registry.ts` — buffer/disk/git URI registration with view-state preservation
- `dashboard/src/components/diffs/MonacoDiffsView.tsx` — file rail + StickyDiffEditor for working-tree diffs
- `packages/daemon/src/command-center/server.ts` — `/api/project/:name/files`, `/preview/:file`, `/diff`, `/diff/:file`, `/file` (PUT)

This is a doc-only audit — no code migration.

---

## Coverage matrix

| Area                                   | We have                                                                                 | emdash counterpart                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File tree — virtualization             | No (recursive DOM via `<FileTree>` in `FilesSurface.tsx:528`)                           | Yes (`@tanstack/react-virtual` in `editor-file-tree.tsx:1`)                                                                                                                   |
| File tree — lazy children              | No (one eager walk via `/api/project/:name/files`, depth ≤ 5, ≤ 5000 nodes, no expand)  | Yes (`FilesStore.loadDir` in `stores/files-store.ts:128`; expanded paths trigger per-folder fetch)                                                                            |
| File tree — pagination / huge folders  | No (server caps at 5000 nodes total; oversized dirs silently truncated)                 | Per-directory `ListOptions` with `maxEntries` + `truncated` (`types.ts:42`); `fs.listFiles` paginatable                                                                       |
| File tree — FS-watch live updates      | Partial — our `fs-watch-client.ts` reseeds open buffers but does not mutate the tree    | Yes (`FilesStore._applyWatchEventsInternal` in `files-store.ts:253` — create/delete/modify/rename)                                                                            |
| File tree — git-status row colors      | No                                                                                      | Yes (`editor-file-tree.tsx:24` reads `workspace.git.fileChanges` → added/modified/deleted/renamed colors)                                                                     |
| File tree — keyboard nav               | None (rows are `<button>`, no roving tabindex, no arrow nav)                            | `tabIndex`, `Enter`/`Space` handlers, `role="treeitem"`, `aria-expanded` (`editor-file-tree.tsx:46`)                                                                          |
| File tree — drag-drop / rename / ctx   | None (`ExplorerContextMenu.tsx` exists in `search/` but is not wired into FilesSurface) | Not in scope of the inspected files, but `controller.ts` exposes the RPC primitives                                                                                           |
| Preview — chunked / large-file fallback| No (`/preview/:file` returns 413 at 1 MB; client never sees a truncation flag)          | `fs.read(path, maxBytes=200 KB)` returns `{content, truncated}` (`types.ts:155`, `local-fs.ts:331`); renderer routes truncated text → `TooLargeRenderer`                      |
| Preview — image / svg / markdown       | Yes (`ImageRenderer`, `SvgRenderer`, `MarkdownRenderer` under `components/editor/`)     | Yes (`image-renderer`, `svg-renderer`, `markdown-renderer` via `editor-main-panel.tsx:118`)                                                                                   |
| Preview — image data URL pipeline      | Inline `<img src="/api/.../preview/...">`; relies on text endpoint                      | Dedicated `rpc.fs.readImage` returning base64 dataUrl (`controller.ts:109`, `local-fs.ts:696`); store stores `dataUrl` per-tab                                                |
| Preview — markdown source/render toggle| Static (clicking `.md` → rendered; no in-editor toggle once a buffer is open)           | Floating `Eye/Pencil` `ToggleGroup` overlay (`editor-main-panel.tsx:86`) flips renderer between `markdown` and `markdown-source`                                              |
| Preview — binary upstream of Monaco    | Extension-only check (`fileKind.ts:71` BINARY_EXTS)                                     | Same extension check, plus `truncated` flag from FS layer triggers `too-large` routing                                                                                        |
| Monaco — viewState save/restore        | Yes (`model-registry.ts:577` saves on swap, `:584` restores)                            | Yes (same pattern, `modelRegistry.attach(editor, newUri, prevUri)`)                                                                                                           |
| Monaco — split / multi-pane editors    | No                                                                                      | Not implemented in emdash either (single editor host)                                                                                                                         |
| Monaco — dirty indicator               | Yes (tab dot, gutter via `setDirty`)                                                    | Yes (`isDirty` per tab)                                                                                                                                                       |
| Monaco — autosave UX                   | Yes (1.5 s debounce, `buffer-store.ts:316`)                                             | Not autosaved — emdash leaves dirty until `Cmd+S`. Their `editorBuffer.clearBuffer` persists draft in main process; we persist in `localStorage`.                             |
| Monaco — save-on-blur                  | No                                                                                      | No                                                                                                                                                                            |
| Monaco — Save All                      | No (only `Cmd+S` for active)                                                            | Yes (`addMonacoKeyboardShortcuts(..., { onSave, onSaveAll })` + `saveAllFiles` in `editor-view-store.ts:244`)                                                                 |
| Monaco — conflict resolution           | Inline `MergeConflictPanel` (`three-way-merge.ts`, full 3-way per-hunk picker)          | Modal dialog with two buttons (`conflict-dialog.tsx`, `editor-view-store.ts:258` Keep mine / Accept incoming). We are richer; their flow is simpler.                          |
| Monaco — crash recovery                | Yes (`localStorage` snapshot per dirty buffer, `buffer-store.ts:508`)                   | Yes (main-process `rpc.editorBuffer.listBuffers` + `clearBuffer`; restored on remount in `editor-view-store.ts:293`)                                                          |
| Tab strip — drag-to-reorder            | No                                                                                      | Yes (`ReorderList` axis="x" in `file-tabs.tsx:62`; `editorView.reorderTabs(from, to)`)                                                                                        |
| Tab strip — scrollable overflow        | `overflow-x-auto` only, no scroll-into-view-on-activate                                 | Same overflow-x-auto, but with `useTabShortcuts` + active-tab-aware nav                                                                                                       |
| Tab strip — preview tab (single-click) | No — every click pins                                                                   | Yes (`openFilePreview` single-click puts an italic non-pinned tab that mutates in place on next nav; `openFile` / double-click pins) — `editor-view-store.ts:144`             |
| Tab strip — pinned / unpinned          | No                                                                                      | Yes (`tab.isPreview` boolean; `pinTab(tabId)` flips it)                                                                                                                       |
| Tab strip — keyboard shortcuts         | Only `Cmd+W` (close, in `FilesSurface.tsx:163`)                                         | `useTabShortcuts(editorView)` — `setNextTabActive` / `setPreviousTabActive` / `setTabActiveIndex` / `closeActiveTab` (`editor-view-store.ts:94`)                              |
| Tab strip — recently-closed history    | No                                                                                      | No (not in scope)                                                                                                                                                             |
| Tab strip — tab spinner                | Inline `loading…` text                                                                  | `useDelayedBoolean(modelStatus === 'loading', 200)` → animated `Loader2` (`file-tabs.tsx:97`)                                                                                 |
| Tab strip — file icons                 | Lucide generic `File` only                                                              | Per-extension `<FileIcon filename=...>` (`editor-file-tree.tsx:8`, also in tabs/tree)                                                                                         |
| Diff — inline vs side-by-side toggle   | Yes (`StickyDiffEditor.tsx:125` syncs `renderSideBySide`)                               | Yes (`DiffToolbar` toggle group, `file-diff-view.tsx:182` reads `diffView.diffStyle`)                                                                                         |
| Diff — hunk list / focus jump          | Yes (`HunkList` in `StickyDiffEditor.tsx:189`)                                          | None as an external list — emdash relies on Monaco's built-in F7/Shift+F7 hunk navigation                                                                                     |
| Diff — per-hunk accept / reject        | Callbacks defined; UI wired (`StickyDiffEditor.tsx:174`); no host action wires them yet | Not directly — emdash uses staged/unstage workflow at the changes-panel level                                                                                                 |
| Diff — large-diff guard                | No                                                                                      | Yes (`stacked-diff-view.tsx:18` `LARGE_DIFF_LINE_THRESHOLD = 1500` → "Load anyway" UI)                                                                                        |
| Diff — stacked / multi-file scroll     | No (`MonacoDiffsView` is rail + single editor)                                          | Yes (`stacked-diff-view.tsx` — all changed files in one scroll surface, scroll position drives `activeFile`)                                                                  |
| Diff — diff toolbar (path + source)    | No (only summary bar + style toggle)                                                    | Yes (`diff-toolbar.tsx` — filename, directory, `FileIcon`, `Changed/Staged/PR/Git` badge)                                                                                     |
| Diff — multi-source groups             | Working tree only (HEAD ↔ disk)                                                         | `'staged' | 'disk' | 'git' | 'pr'` with `originalRef` / `modifiedRef` per active file (`file-diff-view.tsx:65`); separate model URIs (`toGitUri(uri, STAGED_REF)`, etc.)       |
| Diff — inline draft comments           | No                                                                                      | Yes (`monaco-comment-manager.ts` injects React widgets as Monaco view zones, glyph margin gutter, `use-diff-editor-comments.ts`)                                              |
| Diff — three-way merge                 | Yes (`three-way-merge.ts` 287 lines, full per-hunk picker)                              | No (simple 2-button modal)                                                                                                                                                    |
| Diff — binary placeholder              | Buried (`fileKind.ts:86 isBinaryForDiff`, not actually wired in `MonacoDiffsView`)      | Yes — `isBinaryForDiff` short-circuit in `file-diff-view.tsx:24` shows "Binary file — no diff available"                                                                      |
| State — view snapshot persistence      | No (tabs + active reset every project switch)                                           | Yes (`EditorViewSnapshot`: tabs, activeTabId, expandedPaths — `editor-view-store.ts:62`; survives project remount)                                                            |
| FS layer — local vs SSH                | Local only via `node:fs`                                                                | Pluggable: `FileSystemProvider` (`types.ts:158`) with `local-fs.ts` + `ssh-fs.ts` impls; controller routes per workspace                                                      |
| FS layer — read budget                 | Per-request 1 MB hard reject; no chunked reads                                          | `read(path, maxBytes=200KB)` chunked read with fd + `truncated: true` for oversized (`local-fs.ts:331`)                                                                       |
| FS layer — ignore filter               | `createIgnoreFilter(session.dir)` server-side                                           | `local-fs.ts:441` reads `.gitignore` + tracks `truncated` per traversal                                                                                                       |

---

## Top 10 most-broken or missing features

Rank-ordered by user-visible impact and the leverage of fixing it. Each item names the emdash file that informs the right shape.

### 1. File tree is not virtualized and not lazily loaded

**State:** broken — degrades fast on any non-trivial repo.

`FilesSurface.tsx:290` renders the whole tree as recursive DOM. The server caps at 5000 nodes / depth 5 in `server.ts:1397`, so we get silent truncation on repos with more files and unbounded DOM growth up to that limit. Every click that toggles a folder still has the entire subtree mounted. There is also no incremental load — the server walks the full tree once per page load.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/editor/editor-file-tree.tsx` — `@tanstack/react-virtual` over `visibleRows` (flattened view of expanded nodes).
- `context/emdash/src/renderer/features/tasks/editor/stores/files-store.ts` — `loadDir(dirPath)` per-expand; `_applyEntries` keeps `nodes` + `childIndex` Maps.
- `context/emdash/src/main/core/fs/controller.ts:23` `listFiles` taking `ListOptions { recursive: false, includeHidden, maxEntries }`.

### 2. FS-watch events don't update the tree

**State:** broken — file creates / deletes / renames done in the terminal panes (the entire point of tmux-ide) don't reflect in the rail until full refresh.

`fs-watch-client.ts` exists and routes events into `reseedFromExternal` for open buffers only. The tree resource is `createResource`-fetched once at mount.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/editor/stores/files-store.ts:253` `_applyWatchEventsInternal` — switch on `create | delete | modify | rename`, mutate `_nodes` / `_childIndex`, debounce a `_bumpTree()` rerender.
- `context/emdash/src/main/core/fs/types.ts:7` `FileWatcher.update(paths)` — incremental subscription that grows as folders expand.

### 3. Tab strip has no preview tab and no drag-to-reorder

**State:** missing — every click pins a tab; rapid browsing leaves dozens of tabs you have to close one-by-one.

`TabStrip.tsx` + `buffer-store.openBuffer` always inserts into `order` and stays. Order is fixed insertion order.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/editor/stores/editor-view-store.ts:144` `openFilePreview` mutates the existing preview tab in place (same `tabId`, no flash); single-click → preview, double-click / `pinTab` → keep.
- `context/emdash/src/renderer/features/tasks/editor/file-tabs.tsx:62` `ReorderList axis="x"` — drag-to-reorder via `editorView.reorderTabs(from, to)`.

### 4. No tab keyboard shortcuts (next/prev/by-index/close-active)

**State:** missing.

Only `Cmd+W` lives in `FilesSurface.tsx:163`. No `Ctrl+Tab`, no `Cmd+1..9`, no `Cmd+Alt+Left/Right`.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/editor/stores/editor-view-store.ts:94` `setNextTabActive` / `setPreviousTabActive` / `setTabActiveIndex(index)` / `closeActiveTab`.
- Wire via a `useTabShortcuts(editorView)` equivalent (a Solid `onMount` keydown listener returning matching ops).

### 5. Preview endpoint has no chunked / truncated read — 1 MB is a hard 413

**State:** broken — common files (lockfiles, generated SQL dumps, minified bundles, large markdown specs) just fail to open.

`server.ts:1853` rejects with `413 "File too large"` and the client falls back to a generic error. `TooLargeRenderer.tsx` exists but is never reached: the daemon never emits a truncated payload.

**Right shape:**

- `context/emdash/src/main/core/fs/types.ts:73` `ReadResult { content, truncated }`.
- `context/emdash/src/main/core/fs/impl/local-fs.ts:331` `read(path, maxBytes=200KB)` — `fs.open` + `fd.read(buffer, 0, maxBytes, 0)` for oversize; return `truncated: true`.
- `context/emdash/src/renderer/features/tasks/editor/editor-main-panel.tsx:125` routes `renderer.kind === 'too-large'` → `<TooLargeRenderer>`.

### 6. No stacked diff view + no diff toolbar

**State:** missing — `MonacoDiffsView` shows a rail + single editor. There is no all-changed-files scroll surface, and the only header is the summary bar with the inline/split toggle. No filename, no directory, no source badge ("Staged" / "Changed" / "PR" / "Git").

**Right shape:**

- `context/emdash/src/renderer/features/tasks/diff-view/main-panel/stacked-diff-view.tsx` — `<StackedDiffPanel>` with `visibleSlots`, IntersectionObserver-equivalent scroll-driven `setActiveFile`, per-file `<StickyDiffEditor>` mounted in a collapsible `<Activity>` block.
- `context/emdash/src/renderer/features/tasks/diff-view/main-panel/diff-toolbar.tsx` — file icon + filename + directory + source `<Badge>`.
- Large-diff guard: `LARGE_DIFF_LINE_THRESHOLD = 1500` → "Load anyway" prompt before mounting the diff editor.

### 7. Diff is HEAD-only — no staged / PR / arbitrary-ref groups

**State:** missing — our `MonacoDiffsView.pickFile` hardcodes `git://<root>/<file>/HEAD` ↔ `disk://<root>/<file>`. The model-registry has `registerGit` taking a `ref`, so the substrate is there; the wiring is not.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/diff-view/main-panel/file-diff-view.tsx:65` builds `originalUri` / `modifiedUri` from the `activeFile.group` switch (`'disk' | 'staged' | 'git' | 'pr'`) with `originalRef` / `modifiedRef`.
- `context/emdash/src/renderer/features/tasks/diff-view/changes-panel/` exposes the staged-vs-unstaged-vs-PR groupings as the data model.
- Constants: `HEAD_REF`, `STAGED_REF` (`@shared/git`).

### 8. No inline draft comments on diffs

**State:** missing — this is one of the highest-leverage features in emdash for review workflows; we don't have anything equivalent.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/diff-view/comments/monaco-comment-manager.ts` — class that owns:
  - Gutter glyph margin decorations.
  - Hover + pinned line decorations.
  - View zones rendered via `createRoot` (React) for both `<CommentInput>` and stacked `<CommentWidget>`s.
- `context/emdash/src/renderer/features/tasks/diff-view/comments/use-diff-editor-comments.ts` — hook that constructs / disposes the manager per diff editor instance.
- `context/emdash/src/renderer/features/tasks/diff-view/stores/draft-comments-store.ts` — store keyed by `filePath` with `addComment / updateComment / deleteComment`.

### 9. No git-status row colors on the tree, and no per-extension file icons

**State:** missing — both the tree (`FilesSurface.tsx:574`) and tab strip (`TabStrip.tsx:97`) show a generic Lucide `<File>` and `<File>` only, with no status coloring.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/editor/editor-file-tree.tsx:24` derives `fileStatus` from `taskState.workspace.git.fileChanges` and conditional Tailwind classes for added / modified / deleted / renamed.
- `context/emdash/src/renderer/lib/editor/file-icon.tsx` (referenced in `editor-file-tree.tsx:8`, `file-tabs.tsx:5`) — per-extension icon component. Used identically in the diff toolbar (`diff-toolbar.tsx:6`).

### 10. Editor view state isn't persisted across sessions / project switches

**State:** missing — every project remount loses open tabs, active tab, and tree expand state. Crash recovery saves dirty content but not which files were open or which folders were expanded.

**Right shape:**

- `context/emdash/src/renderer/features/tasks/editor/stores/editor-view-store.ts:62` `snapshot` getter + `restoreSnapshot(EditorViewSnapshot)` — `{ tabs: [{tabId, path, isPreview}], activeTabId, expandedPaths: string[] }`.
- `Snapshottable<EditorViewSnapshot>` interface — persistence is driven from a workspace-scoped snapshot store, not localStorage; reloads through `void editorView.restore()` on mount (`editor-provider.tsx:171`).

---

## Tier-2 — noted, not in the top 10

These are real gaps but lower priority than the items above.

- **Save All** keybind + `saveAllFiles` (`editor-view-store.ts:244`).
- **Markdown / SVG source-vs-render toggle** floating overlay (`editor-main-panel.tsx:86`).
- **Tab loading spinner** with 200 ms debounce to avoid flash (`file-tabs.tsx:97`).
- **Image read pipeline** via dedicated `readImage → dataUrl` (`controller.ts:109`) instead of inlining `<img src=/api/...>` — the dedicated path doesn't tax the text preview cap and gives us proper MIME handling.
- **Keyboard navigation on the file tree** (`role="treeitem"`, arrow keys, `Enter` / `Space`).
- **Editor focus restore** when the surface remounts and the user expects focus in the editor (`editor-provider.tsx:206` `focusedRegion === 'main'` pattern).
- **Single registry for buffer/disk/git models** with `buffer` URI for save flow alongside `disk` URI for read-only — emdash registers all three in `_registerModels` (`editor-view-store.ts:333`). Our `modelRegistry` supports the same schemes (`registerBuffer`, `registerDisk`, `registerGit`) but `FilesSurface.openFile` only goes through the buffer flow; non-Monaco paths separately register `disk://`. Fine as-is, but the unified registration is cleaner.
- **Filesystem abstraction (local vs SSH)** — `FileSystemProvider` (`types.ts:158`) with `local-fs` / `ssh-fs` impls. Not relevant unless we add remote workspaces, but it's the right shape for that future.

---

## Out of scope here

- Monaco-config polish (font, line height, ruler, minimap toggle) — separate audit.
- LSP integration — we already have `wireLspToEditor` + hover/rename/lightbulb; emdash's Monaco config doesn't cover this.
- Search / replace surfaces — these live in `dashboard/src/components/search/`; not part of the file-editor surface.
