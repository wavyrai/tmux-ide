/**
 * FilesSurface — Explorer rail + tab strip + canonical preview body.
 *
 * Renders the project's file tree on the left, a multi-tab editor
 * surface on the right. Clicking a file in the rail:
 *
 *   1. `getFileKind(path)` picks a kind.
 *   2. For text kinds: `openBuffer(...)` seeds the buffer-store
 *      with a loading entry, `fetchFilePreview` resolves the
 *      content, and `markReady` flips the buffer to 'ready' +
 *      registers a writable `file://` Monaco model.
 *   3. For non-Monaco kinds (image / markdown / svg / binary):
 *      registers the `disk://` model so the file renderer
 *      dispatch can read text via the registry.
 *
 * The right side carries:
 *   - `<TabStrip>` showing every open buffer with a dirty `•` +
 *     close `×`. Active tab styling reflects `activeUri`.
 *   - Preview body: `<CodeEditor>` for text (writable, wired to
 *     `markContent`) OR `<FileRenderer>` for the non-text kinds.
 *
 * Cmd+S (Ctrl+S on Linux/Windows) saves the active buffer via
 * the daemon's `PUT /api/project/:name/file` endpoint. The
 * keybind installs while the surface is mounted and tears down
 * on unmount.
 */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { Effect } from "effect";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-solid";
import { Index } from "solid-js";
import type { GitChangeStatus } from "@tmux-ide/contracts";
import { getFileIcon } from "@/lib/editor/file-icon";
import { fetchFilePreview, type ProjectFileNode } from "@/lib/api";
import {
  aggregateDirStatus,
  buildGitStatusMap,
  fetchFolderChildren,
  fetchGitStatusForRail,
  gitStatusTextClass,
} from "@/lib/editor/files-rail";
import { FileRenderer, getFileKind, type ManagedFile, type ManagedFileKind } from "@/lib/editor";
import {
  acceptExternalChange,
  bufferState,
  closeBuffer,
  dismissExternalChange,
  discardRecoverableBuffer,
  listRecoverableBuffers,
  markContent,
  markError,
  markReady,
  openBuffer,
  openBufferAsPreview,
  pinBuffer,
  restoreRecoverableBuffer,
  save,
  saveAll,
  setActiveBuffer,
  type RecoverableSnapshot,
} from "@/lib/editor/buffer-store";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { ShikiViewer } from "@/components/editor/ShikiViewer";
import { MergeConflictPanel } from "@/components/editor/MergeConflictPanel";
import { TabStrip } from "@/components/editor/TabStrip";
import { startFsWatchClient } from "@/lib/editor/fs-watch-client";
import { consumePendingFileOpen, pendingFileOpen } from "@/lib/filesBroker";
import { codeEditorPool } from "@/lib/monaco/code-pool";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { buildMonacoModelPath, toDiskUri } from "@/lib/monaco/model-path";

interface FilesSurfaceProps {
  projectName: string;
  /** Workspace root used to build Monaco model URIs. Defaults to "/". */
  modelRootPath?: string;
}

// Minimal extension → Monaco language id table. Expand as the editor
// surface grows.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  scala: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  graphql: "graphql",
  proto: "protobuf",
};

function languageFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

export function FilesSurface(props: FilesSurfaceProps): JSX.Element {
  const rootPath = () => props.modelRootPath ?? "/";
  // Non-Monaco preview surfaces (image / markdown / svg / binary)
  // route through the FileRenderer dispatch. Text kinds drive the
  // tab strip instead.
  const [previewPath, setPreviewPath] = createSignal<string | null>(null);
  const [previewKind, setPreviewKind] = createSignal<ManagedFileKind | null>(null);

  // Lazy folder children — keyed by relative dir path. The empty
  // string is the session root. Entries:
  //   undefined → never requested
  //   []        → loaded, empty
  //   array     → loaded children (one level deep)
  // Loading state is tracked separately via `loadingPaths`.
  const [childrenByPath, setChildrenByPath] = createSignal<Record<string, ProjectFileNode[]>>({});
  const [loadingPaths, setLoadingPaths] = createSignal<Set<string>>(new Set());
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [rootLoading, setRootLoading] = createSignal(true);
  const [rootError, setRootError] = createSignal<string | null>(null);

  // Coalesced git status keyed by relative path. Polled on mount;
  // file-tree colors fall back to no-tint on non-git workspaces.
  const [gitStatus] = createResource(
    () => props.projectName,
    async (sessionName) =>
      buildGitStatusMap(await Effect.runPromise(fetchGitStatusForRail(sessionName))),
  );

  async function loadChildren(dirPath: string): Promise<void> {
    if (childrenByPath()[dirPath] !== undefined) return;
    if (loadingPaths().has(dirPath)) return;
    setLoadingPaths((prev) => new Set(prev).add(dirPath));
    try {
      const children = await fetchFolderChildren(props.projectName, dirPath);
      setChildrenByPath((prev) => ({ ...prev, [dirPath]: children }));
    } catch (err) {
      if (dirPath === "") {
        setRootError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }

  onMount(() => {
    void loadChildren("").finally(() => setRootLoading(false));
    // Warm Monaco up-front. `registerDisk` (used by Markdown/SVG
    // preview paths) blocks on `waitForMonaco`; without this, opening
    // a `.md` before any text buffer leaves the renderer stuck on an
    // empty `getValue()` because the disk model never finishes
    // registering.
    void codeEditorPool.init();
  });

  function toggleDir(path: string) {
    const wasExpanded = expanded().has(path);
    if (!wasExpanded) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      if (childrenByPath()[path] === undefined) {
        void loadChildren(path);
      }
    } else {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }

  interface FlatRow {
    node: ProjectFileNode;
    depth: number;
    expanded: boolean;
    loading: boolean;
  }

  // Flatten the visible tree depth-first. Recurses only into directories
  // that are in the expanded set AND have loaded children — collapsed or
  // not-yet-loaded directories appear as a single row.
  const flatRows = createMemo<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    const expandedSet = expanded();
    const loadingSet = loadingPaths();
    const cache = childrenByPath();
    function walk(parentPath: string, depth: number) {
      const list = cache[parentPath];
      if (!list) return;
      for (const node of list) {
        const isExpanded = node.isDirectory && expandedSet.has(node.path);
        out.push({
          node,
          depth,
          expanded: isExpanded,
          loading: node.isDirectory && loadingSet.has(node.path),
        });
        if (isExpanded) walk(node.path, depth + 1);
      }
    }
    walk("", 0);
    return out;
  });

  // Track disk URIs registered for non-text kinds (markdown / svg
  // need the registry for content reads; image / binary skip it).
  const registeredDiskUris = new Set<string>();

  // Crash-recovery prompt — surface persisted dirty buffers for
  // the active session. Drives the banner; the user picks
  // restore / discard via callbacks.
  const [recoverable, setRecoverable] = createSignal<RecoverableSnapshot[]>([]);

  // Install the Cmd/Ctrl+S + Cmd/Ctrl+W keybinds while the surface
  // is mounted. Cmd+W closes the active tab via the same dirty-
  // confirm path the tab strip's × uses.
  onMount(() => {
    setRecoverable(listRecoverableBuffers(props.projectName));

    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key;
      if (key === "s" || key === "S") {
        event.preventDefault();
        // Cmd/Ctrl+Shift+S = Save All; Cmd/Ctrl+S = Save active.
        if (event.shiftKey) {
          void saveAll();
          return;
        }
        const uri = bufferState.activeUri;
        if (!uri) return;
        void save(uri);
        return;
      }
      if (key === "w" || key === "W") {
        const uri = bufferState.activeUri;
        if (!uri) return;
        event.preventDefault();
        const buf = bufferState.buffers[uri];
        if (!buf) return;
        if (!buf.dirty) {
          closeBuffer(uri);
          return;
        }
        if (
          typeof window !== "undefined" &&
          typeof window.confirm === "function" &&
          window.confirm(`Discard unsaved changes to ${buf.filePath}?`)
        ) {
          closeBuffer(uri, { discardDirty: true });
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  onCleanup(() => {
    for (const uri of registeredDiskUris) modelRegistry.unregisterModel(uri);
    registeredDiskUris.clear();
  });

  // Open the FS-watch WS subscription for this session so external
  // file rewrites flow into the buffer store's
  // `reseedFromExternal` path.
  onMount(() => {
    const stop = startFsWatchClient(props.projectName);
    onCleanup(() => stop());
  });

  // Drain the file-open broker on mount + react to fresh requests
  // while mounted. Powers the context menu's "Open in editor" item
  // and any future deep-link or command-palette flows.
  onMount(() => {
    const pending = consumePendingFileOpen();
    if (pending) openFile(pending.filePath);
  });
  createEffect(() => {
    const req = pendingFileOpen();
    if (!req) return;
    consumePendingFileOpen();
    openFile(req.filePath);
  });

  // Auto-open a non-Monaco preview path when the buffer store has no
  // active buffer (image-only / binary-only navigation).
  createEffect(() => {
    if (bufferState.activeUri && previewPath() !== null) {
      // A text tab is active — drop the non-Monaco preview state
      // so the body switches to the editor.
      setPreviewPath(null);
      setPreviewKind(null);
    }
  });

  function openFile(path: string, opts: { pin?: boolean } = {}) {
    const kind = getFileKind(path);

    if (kind === "text") {
      // Single-click opens as a preview tab (shiki read-only view).
      // Editing the buffer or `pin: true` (double-click) auto-pins
      // it and the surface switches to Monaco.
      const opened = opts.pin
        ? openBuffer({
            sessionName: props.projectName,
            rootPath: rootPath(),
            filePath: path,
            language: languageFor(path),
          })
        : openBufferAsPreview({
            sessionName: props.projectName,
            rootPath: rootPath(),
            filePath: path,
            language: languageFor(path),
          });
      const { existed } = opened;
      if (existed) {
        // Already open — if the caller asked to pin, make sure it
        // sticks even when the buffer was previously a preview.
        if (opts.pin) {
          const bufferUri = buildMonacoModelPath(rootPath(), path);
          const buf = bufferState.buffers[bufferUri];
          if (buf?.isPreview) pinBuffer(bufferUri);
        }
        return;
      }
      // Fetch initial content + hydrate.
      const bufferUri = buildMonacoModelPath(rootPath(), path);
      void Effect.runPromise(fetchFilePreview(props.projectName, path))
        .then(async (preview) => {
          if (!preview.exists) {
            markError(bufferUri, "File not found");
            return;
          }
          await markReady(bufferUri, preview.content);
        })
        .catch((err) => {
          markError(bufferUri, err instanceof Error ? err.message : String(err));
        });
      return;
    }

    // Non-text kinds preview via FileRenderer. `getFileKind` never
    // emits `'too-large'` — that lands later from the FS layer's
    // truncation flag, so the body of this branch is the
    // image / markdown / svg / binary path.
    setActiveBuffer(null);
    setPreviewPath(path);
    setPreviewKind(kind);

    if (kind === "binary" || kind === "image") return;
    const diskUri = toDiskUri(buildMonacoModelPath(rootPath(), path));
    if (modelRegistry.modelStatus(diskUri) === "ready") return;
    void Effect.runPromise(
      modelRegistry.registerDisk({
        sessionName: props.projectName,
        rootPath: rootPath(),
        filePath: path,
        language: languageFor(path),
      }),
    )
      .then(() => registeredDiskUris.add(diskUri))
      .catch(() => {});
  }

  const activeUri = () => bufferState.activeUri;
  const hasPreview = () => activeUri() !== null || previewPath() !== null;
  const railSelectedPath = () => {
    const uri = activeUri();
    if (uri) return bufferState.buffers[uri]?.filePath ?? null;
    return previewPath();
  };

  return (
    <div data-testid="v2-files-surface" class="flex h-full min-h-0 w-full flex-row">
      <aside
        data-testid="v2-files-explorer"
        class="flex w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-strong)] text-[12px]"
      >
        <div class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
          Files
        </div>
        <Show
          when={!rootLoading()}
          fallback={<div class="px-3 py-2 text-[11px] text-[var(--dim)]">loading…</div>}
        >
          <Show
            when={!rootError()}
            fallback={
              <div class="px-3 py-2 text-[11px] text-[var(--red-foreground,var(--red))]">
                {rootError()}
              </div>
            }
          >
            <Show
              when={flatRows().length > 0}
              fallback={
                <div data-testid="v2-files-empty" class="px-3 py-2 text-[11px] text-[var(--dim)]">
                  No files
                </div>
              }
            >
              <FileRail
                rows={flatRows()}
                activePath={railSelectedPath()}
                statusMap={gitStatus() ?? new Map<string, GitChangeStatus>()}
                onPick={(path) => openFile(path)}
                onPinPick={(path) => openFile(path, { pin: true })}
                onToggleDir={toggleDir}
              />
            </Show>
          </Show>
        </Show>
      </aside>

      <main data-testid="v2-files-preview" class="flex flex-1 min-w-0 min-h-0 flex-col">
        <Show when={recoverable().length > 0}>
          <RecoveryBanner
            snapshots={recoverable()}
            onRestore={(snap) => {
              void restoreRecoverableBuffer(snap);
              setRecoverable((prev) => prev.filter((s) => s.bufferUri !== snap.bufferUri));
            }}
            onDiscard={(snap) => {
              discardRecoverableBuffer(snap.bufferUri);
              setRecoverable((prev) => prev.filter((s) => s.bufferUri !== snap.bufferUri));
            }}
            onDismissAll={() => {
              for (const s of recoverable()) {
                discardRecoverableBuffer(s.bufferUri);
              }
              setRecoverable([]);
            }}
          />
        </Show>
        <TabStrip />
        <div class="flex flex-1 min-w-0 min-h-0 flex-col">
          <Show
            when={hasPreview()}
            fallback={
              <div
                data-testid="v2-files-empty-preview"
                class="flex h-full items-center justify-center text-[11px] text-[var(--dim)]"
              >
                Pick a file from the rail to preview it.
              </div>
            }
          >
            <PreviewBody
              activeUri={activeUri()}
              previewPath={previewPath()}
              previewKind={previewKind()}
              rootPath={rootPath()}
              sessionName={props.projectName}
            />
          </Show>
        </div>
      </main>
    </div>
  );
}

function RecoveryBanner(props: {
  snapshots: RecoverableSnapshot[];
  onRestore: (snap: RecoverableSnapshot) => void;
  onDiscard: (snap: RecoverableSnapshot) => void;
  onDismissAll: () => void;
}) {
  return (
    <div
      data-testid="v2-files-recovery-banner"
      class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-active)] px-3 py-2 text-[11px] text-[var(--fg)]"
    >
      <span class="text-[var(--accent)]">●</span>
      <span class="font-mono">
        {props.snapshots.length} unsaved buffer{props.snapshots.length === 1 ? "" : "s"} from your
        previous session
      </span>
      <span class="flex-1" />
      <For each={props.snapshots}>
        {(snap) => (
          <div class="inline-flex items-center gap-1">
            <span class="truncate font-mono text-[10px] text-[var(--dim)]">{snap.filePath}</span>
            <button
              type="button"
              data-testid="v2-files-recovery-restore"
              data-buffer-uri={snap.bufferUri}
              onClick={() => props.onRestore(snap)}
              class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] text-[var(--accent)] hover:bg-[var(--surface-hover)]"
            >
              Restore
            </button>
            <button
              type="button"
              data-testid="v2-files-recovery-discard"
              data-buffer-uri={snap.bufferUri}
              onClick={() => props.onDiscard(snap)}
              class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] text-[var(--dim)] hover:bg-[var(--surface-hover)]"
            >
              Discard
            </button>
          </div>
        )}
      </For>
      <button
        type="button"
        data-testid="v2-files-recovery-dismiss-all"
        onClick={() => props.onDismissAll()}
        class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] text-[var(--dim)] hover:bg-[var(--surface-hover)]"
      >
        Dismiss all
      </button>
    </div>
  );
}

function PreviewBody(props: {
  activeUri: string | null;
  previewPath: string | null;
  previewKind: ManagedFileKind | null;
  rootPath: string;
  sessionName: string;
}) {
  // Active text buffer wins; otherwise fall through to the non-text
  // preview routing.
  const activeBuffer = createMemo(() =>
    props.activeUri ? (bufferState.buffers[props.activeUri] ?? null) : null,
  );

  const previewFile = createMemo<ManagedFile | null>(() => {
    if (!props.previewPath || !props.previewKind) return null;
    return {
      path: props.previewPath,
      kind: props.previewKind,
      content: "",
      isLoading: false,
      tabId: props.previewPath,
    };
  });

  return (
    <Show
      when={activeBuffer()}
      fallback={
        <Show when={previewFile()}>
          {(f) => (
            <FileRenderer
              file={f()}
              modelRootPath={props.rootPath}
              sessionName={props.sessionName}
              onEditSource={undefined}
            />
          )}
        </Show>
      }
    >
      {(buf) => (
        <Show
          when={buf().status === "ready"}
          fallback={
            <div
              data-testid="v2-files-buffer-loading"
              data-buffer-status={buf().status}
              class="flex h-full items-center justify-center text-[11px] text-[var(--dim)]"
            >
              <Show
                when={buf().status === "loading"}
                fallback={<span>{buf().saveError ?? "failed to load file"}</span>}
              >
                loading…
              </Show>
            </div>
          }
        >
          <Show
            when={buf().externalContent !== null && buf().dirty}
            fallback={
              <div
                class="flex h-full min-h-0 w-full min-w-0 flex-col"
                onDblClick={() => {
                  // Double-click anywhere in the preview body pins
                  // the tab — matches the tab-strip double-click
                  // behaviour from EDITOR-2.
                  if (buf().isPreview) pinBuffer(buf().bufferUri);
                }}
              >
                <Show when={buf().externalContent !== null}>
                  {/* Clean buffer that picked up an external write
                      somehow — fall back to the simple banner. The
                      G17-P6 silent re-sync path covers most cases;
                      this branch only fires if `dirty` flips off
                      between reseed and render. */}
                  <ExternalChangeBanner
                    filePath={buf().filePath}
                    onAccept={() => acceptExternalChange(buf().bufferUri)}
                    onDismiss={() => dismissExternalChange(buf().bufferUri)}
                  />
                </Show>
                <Show
                  when={buf().isPreview}
                  fallback={
                    <CodeEditor
                      uri={buf().bufferUri}
                      readOnly={false}
                      onContentChange={(value) => markContent(buf().bufferUri, value)}
                    />
                  }
                >
                  <ShikiViewer filePath={buf().filePath} content={buf().content} />
                </Show>
              </div>
            }
          >
            <MergeConflictPanel buffer={buf()} />
          </Show>
        </Show>
      )}
    </Show>
  );
}

function ExternalChangeBanner(props: {
  filePath: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="v2-files-external-change-banner"
      class="flex shrink-0 items-center gap-2 border-b border-[var(--yellow,var(--accent))] bg-[var(--surface)] px-3 py-2 text-[11px] text-[var(--fg)]"
    >
      <span aria-hidden="true" class="text-[var(--yellow,var(--accent))]">
        ⚠
      </span>
      <span>
        <span class="font-mono">{props.filePath}</span> changed on disk.
      </span>
      <span class="flex-1" />
      <button
        type="button"
        data-testid="v2-files-external-change-accept"
        onClick={() => props.onAccept()}
        class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] text-[var(--accent)] hover:bg-[var(--surface-hover)]"
      >
        Reload from disk
      </button>
      <button
        type="button"
        data-testid="v2-files-external-change-dismiss"
        onClick={() => props.onDismiss()}
        class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-[10px] text-[var(--dim)] hover:bg-[var(--surface-hover)]"
      >
        Keep my edits
      </button>
    </div>
  );
}

interface FlatRailRow {
  node: ProjectFileNode;
  depth: number;
  expanded: boolean;
  loading: boolean;
}

interface FileRailProps {
  rows: FlatRailRow[];
  activePath: string | null;
  statusMap: Map<string, GitChangeStatus>;
  onPick: (path: string) => void;
  onPinPick: (path: string) => void;
  onToggleDir: (path: string) => void;
}

function FileRail(props: FileRailProps) {
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | null>(null);
  // Roving tabindex — only the focused row carries tabIndex=0; the
  // others get -1.
  const [focusedIndex, setFocusedIndex] = createSignal(0);

  // Previously this used `@tanstack/solid-virtual`. Same bug as
  // MessagesTimeline (fix b15d122): `getVirtualItems()` perpetually
  // returns `[]` so the rail rendered a correctly-sized spacer with
  // zero rows. `<Index>` keeps the same nodes mounted across array
  // replacements and is plenty fast for the lazy-loaded per-folder
  // listing (typical visible rows < 500).

  // Keep focusedIndex in range when the row list shrinks (collapse).
  createEffect(() => {
    const len = props.rows.length;
    if (len === 0) return;
    if (focusedIndex() >= len) setFocusedIndex(len - 1);
  });

  function moveFocus(nextIndex: number, opts: { focus?: boolean } = { focus: true }) {
    const len = props.rows.length;
    if (len === 0) return;
    const clamped = Math.max(0, Math.min(len - 1, nextIndex));
    setFocusedIndex(clamped);
    if (opts.focus !== false) {
      queueMicrotask(() => {
        const el = scrollEl()?.querySelector<HTMLElement>(
          `[data-row-index="${clamped}"] [data-rail-row]`,
        );
        el?.focus();
        el?.scrollIntoView({ block: "nearest" });
      });
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    const rows = props.rows;
    if (rows.length === 0) return;
    const idx = focusedIndex();
    const row = rows[idx];
    if (!row) return;
    const key = event.key;
    if (key === "ArrowDown" || key === "j") {
      event.preventDefault();
      moveFocus(idx + 1);
    } else if (key === "ArrowUp" || key === "k") {
      event.preventDefault();
      moveFocus(idx - 1);
    } else if (key === "ArrowRight" || key === "l") {
      event.preventDefault();
      if (row.node.isDirectory && !row.expanded) {
        props.onToggleDir(row.node.path);
      } else if (row.node.isDirectory && row.expanded) {
        // Move to first child (next row at greater depth).
        const next = rows[idx + 1];
        if (next && next.depth > row.depth) moveFocus(idx + 1);
      }
    } else if (key === "ArrowLeft" || key === "h") {
      event.preventDefault();
      if (row.node.isDirectory && row.expanded) {
        props.onToggleDir(row.node.path);
      } else {
        // Walk backwards to the row at depth - 1.
        const targetDepth = row.depth - 1;
        if (targetDepth < 0) return;
        for (let i = idx - 1; i >= 0; i--) {
          if (rows[i]!.depth === targetDepth) {
            moveFocus(i);
            break;
          }
        }
      }
    } else if (key === "Enter") {
      event.preventDefault();
      if (row.node.isDirectory) props.onToggleDir(row.node.path);
      else props.onPick(row.node.path);
    } else if (key === " ") {
      // Space toggles directories; for files, falls through to pick
      // (matches what most file explorers do).
      event.preventDefault();
      if (row.node.isDirectory) props.onToggleDir(row.node.path);
      else props.onPick(row.node.path);
    } else if (key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (key === "End") {
      event.preventDefault();
      moveFocus(rows.length - 1);
    }
  }

  return (
    <div
      ref={setScrollEl}
      data-testid="v2-files-rail-scroll"
      role="tree"
      aria-label="File explorer"
      onKeyDown={handleKeyDown}
      class="relative min-h-0 flex-1 overflow-y-auto"
    >
      <div data-testid="v2-files-rail-spacer">
        <Index each={props.rows}>
          {(row, index) => {
            const isFocused = () => index === focusedIndex();
            return (
              <div data-row-index={index}>
                <FileRailRow
                  row={row()}
                  index={index}
                  focused={isFocused()}
                  activePath={props.activePath}
                  statusMap={props.statusMap}
                  onPick={props.onPick}
                  onPinPick={props.onPinPick}
                  onToggleDir={props.onToggleDir}
                  onFocusRow={(i) => setFocusedIndex(i)}
                />
              </div>
            );
          }}
        </Index>
      </div>
    </div>
  );
}

function FileRailRow(props: {
  row: FlatRailRow;
  index: number;
  focused: boolean;
  activePath: string | null;
  statusMap: Map<string, GitChangeStatus>;
  onPick: (path: string) => void;
  onPinPick: (path: string) => void;
  onToggleDir: (path: string) => void;
  onFocusRow: (index: number) => void;
}) {
  const node = () => props.row.node;
  const isActive = () => props.activePath === node().path;
  const indent = () => `${0.5 + props.row.depth * 0.75}rem`;
  const status = () => {
    if (node().isDirectory) return aggregateDirStatus(node().path, props.statusMap);
    return props.statusMap.get(node().path);
  };
  const statusClass = () => gitStatusTextClass(status());
  const ariaLevel = () => props.row.depth + 1;
  const tabIndex = () => (props.focused ? 0 : -1);

  return (
    <Show
      when={node().isDirectory}
      fallback={
        <button
          type="button"
          data-testid="v2-files-row"
          data-rail-row
          data-file-path={node().path}
          data-active={isActive() ? "true" : undefined}
          data-git-status={status() ?? undefined}
          data-focused={props.focused ? "true" : undefined}
          role="treeitem"
          aria-level={ariaLevel()}
          aria-selected={isActive()}
          tabIndex={tabIndex()}
          onClick={() => {
            props.onFocusRow(props.index);
            props.onPick(node().path);
          }}
          onDblClick={() => {
            // Double-click pins the tab and switches the body from
            // ShikiViewer to the writable Monaco editor.
            props.onFocusRow(props.index);
            props.onPinPick(node().path);
          }}
          onFocus={() => props.onFocusRow(props.index)}
          class={
            "flex h-6 w-full items-center gap-1 px-1 text-left text-[12px] outline-none " +
            (isActive()
              ? "bg-[var(--surface-active)] text-[var(--accent)]"
              : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]") +
            (props.focused ? " ring-1 ring-inset ring-[var(--accent)]" : "")
          }
          style={{ "padding-left": indent() }}
        >
          {(() => {
            const Icon = getFileIcon(node().name);
            return <Icon class="h-3 w-3 shrink-0 opacity-60" />;
          })()}
          <span class={"truncate " + (statusClass() ?? "")}>{node().name}</span>
        </button>
      }
    >
      <button
        type="button"
        data-testid="v2-files-row-dir"
        data-rail-row
        data-dir-path={node().path}
        data-expanded={props.row.expanded ? "true" : undefined}
        data-git-status={status() ?? undefined}
        data-focused={props.focused ? "true" : undefined}
        role="treeitem"
        aria-level={ariaLevel()}
        aria-expanded={props.row.expanded}
        tabIndex={tabIndex()}
        onClick={() => {
          props.onFocusRow(props.index);
          props.onToggleDir(node().path);
        }}
        onFocus={() => props.onFocusRow(props.index)}
        class={
          "flex h-6 w-full items-center gap-1 px-1 text-left text-[12px] outline-none text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]" +
          (props.focused ? " ring-1 ring-inset ring-[var(--accent)]" : "")
        }
        style={{ "padding-left": indent() }}
      >
        <Show when={props.row.expanded} fallback={<ChevronRight class="h-3 w-3 shrink-0" />}>
          <ChevronDown class="h-3 w-3 shrink-0" />
        </Show>
        <Show when={props.row.expanded} fallback={<Folder class="h-3 w-3 shrink-0 opacity-70" />}>
          <FolderOpen class="h-3 w-3 shrink-0 opacity-70" />
        </Show>
        <span class={"truncate " + (statusClass() ?? "")}>{node().name}</span>
        <Show when={props.row.loading}>
          <span class="ml-1 text-[10px] text-[var(--dim)]">…</span>
        </Show>
      </button>
    </Show>
  );
}
