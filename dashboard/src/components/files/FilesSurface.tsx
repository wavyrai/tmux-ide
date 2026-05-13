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
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-solid";
import {
  fetchFilePreview,
  fetchProjectFiles,
  type ProjectFileNode,
} from "@/lib/api";
import {
  FileRenderer,
  getFileKind,
  type ManagedFile,
  type ManagedFileKind,
} from "@/lib/editor";
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
  restoreRecoverableBuffer,
  save,
  setActiveBuffer,
  type RecoverableSnapshot,
} from "@/lib/editor/buffer-store";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { TabStrip } from "@/components/editor/TabStrip";
import { startFsWatchClient } from "@/lib/editor/fs-watch-client";
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

  const [tree] = createResource(
    () => props.projectName,
    async (sessionName) => Effect.runPromise(fetchProjectFiles(sessionName)),
  );

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
        const uri = bufferState.activeUri;
        if (!uri) return;
        event.preventDefault();
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

  function openFile(path: string) {
    const kind = getFileKind(path);

    if (kind === "text") {
      // Open or focus the editor tab.
      const { existed } = openBuffer({
        sessionName: props.projectName,
        rootPath: rootPath(),
        filePath: path,
        language: languageFor(path),
      });
      if (existed) return;
      // Fetch initial content + hydrate.
      const bufferUri = buildMonacoModelPath(rootPath(), path);
      void Effect.runPromise(fetchFilePreview(props.projectName, path))
        .then((preview) => {
          if (!preview.exists) {
            markError(bufferUri, "File not found");
            return;
          }
          markReady(bufferUri, preview.content);
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
    <div
      data-testid="v2-files-surface"
      class="flex h-full min-h-0 w-full flex-row"
    >
      <aside
        data-testid="v2-files-explorer"
        class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-strong)] text-[12px]"
      >
        <div class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[10px] uppercase tracking-wider text-[var(--dim)]">
          Files
        </div>
        <Show
          when={!tree.loading}
          fallback={
            <div class="px-3 py-2 text-[11px] text-[var(--dim)]">loading…</div>
          }
        >
          <Show
            when={(tree()?.tree ?? []).length > 0}
            fallback={
              <div
                data-testid="v2-files-empty"
                class="px-3 py-2 text-[11px] text-[var(--dim)]"
              >
                No files
              </div>
            }
          >
            <FileTree
              nodes={tree()?.tree ?? []}
              depth={0}
              activePath={railSelectedPath()}
              onPick={openFile}
            />
          </Show>
        </Show>
      </aside>

      <main
        data-testid="v2-files-preview"
        class="flex flex-1 min-w-0 min-h-0 flex-col"
      >
        <Show when={recoverable().length > 0}>
          <RecoveryBanner
            snapshots={recoverable()}
            onRestore={(snap) => {
              restoreRecoverableBuffer(snap);
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
        {props.snapshots.length} unsaved buffer{props.snapshots.length === 1 ? "" : "s"} from your previous session
      </span>
      <span class="flex-1" />
      <For each={props.snapshots}>
        {(snap) => (
          <div class="inline-flex items-center gap-1">
            <span class="truncate font-mono text-[10px] text-[var(--dim)]">
              {snap.filePath}
            </span>
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
}) {
  // Active text buffer wins; otherwise fall through to the non-text
  // preview routing.
  const activeBuffer = createMemo(() =>
    props.activeUri ? bufferState.buffers[props.activeUri] ?? null : null,
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
              <Show when={buf().status === "loading"} fallback={<span>{buf().saveError ?? "failed to load file"}</span>}>
                loading…
              </Show>
            </div>
          }
        >
          <div class="flex h-full min-h-0 w-full min-w-0 flex-col">
            <Show when={buf().externalContent !== null}>
              <ExternalChangeBanner
                filePath={buf().filePath}
                onAccept={() => acceptExternalChange(buf().bufferUri)}
                onDismiss={() => dismissExternalChange(buf().bufferUri)}
              />
            </Show>
            <CodeEditor
              uri={buf().bufferUri}
              readOnly={false}
              onContentChange={(value) => markContent(buf().bufferUri, value)}
            />
          </div>
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
      <span aria-hidden="true" class="text-[var(--yellow,var(--accent))]">⚠</span>
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

interface FileTreeProps {
  nodes: ProjectFileNode[];
  depth: number;
  activePath: string | null;
  onPick: (path: string) => void;
}

function FileTree(props: FileTreeProps) {
  return (
    <ul class="m-0 list-none p-0">
      <For each={props.nodes}>
        {(node) => <FileTreeRow node={node} depth={props.depth} activePath={props.activePath} onPick={props.onPick} />}
      </For>
    </ul>
  );
}

function FileTreeRow(props: {
  node: ProjectFileNode;
  depth: number;
  activePath: string | null;
  onPick: (path: string) => void;
}) {
  const [expanded, setExpanded] = createSignal(props.depth === 0);
  const isActive = () => props.activePath === props.node.path;
  const indent = () => `${0.5 + props.depth * 0.75}rem`;

  return (
    <li>
      <Show
        when={props.node.isDirectory}
        fallback={
          <button
            type="button"
            data-testid="v2-files-row"
            data-file-path={props.node.path}
            data-active={isActive() ? "true" : undefined}
            onClick={() => props.onPick(props.node.path)}
            class={
              "flex h-6 w-full items-center gap-1 px-1 text-left text-[12px] " +
              (isActive()
                ? "bg-[var(--surface-active)] text-[var(--accent)]"
                : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]")
            }
            style={{ "padding-left": indent() }}
          >
            <File class="h-3 w-3 shrink-0 opacity-60" />
            <span class="truncate">{props.node.name}</span>
          </button>
        }
      >
        <button
          type="button"
          data-testid="v2-files-row-dir"
          data-dir-path={props.node.path}
          data-expanded={expanded() ? "true" : undefined}
          onClick={() => setExpanded((v) => !v)}
          class="flex h-6 w-full items-center gap-1 px-1 text-left text-[12px] text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
          style={{ "padding-left": indent() }}
        >
          <Show when={expanded()} fallback={<ChevronRight class="h-3 w-3 shrink-0" />}>
            <ChevronDown class="h-3 w-3 shrink-0" />
          </Show>
          <Show
            when={expanded()}
            fallback={<Folder class="h-3 w-3 shrink-0 opacity-70" />}
          >
            <FolderOpen class="h-3 w-3 shrink-0 opacity-70" />
          </Show>
          <span class="truncate">{props.node.name}</span>
        </button>
        <Show when={expanded() && props.node.children}>
          <FileTree
            nodes={props.node.children ?? []}
            depth={props.depth + 1}
            activePath={props.activePath}
            onPick={props.onPick}
          />
        </Show>
      </Show>
    </li>
  );
}
