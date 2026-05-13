/**
 * FilesSurface — Solid Explorer rail + canonical preview body.
 *
 * Renders the project's file tree from `/api/project/:name/files`
 * on the left, the file renderer dispatch on the right. Clicking a
 * file triggers:
 *
 *   1. `getFileKind(path)` (G17-P2 pure helper) — picks a kind.
 *   2. For text kinds: `modelRegistry.registerDisk({...})` so the
 *      registry fetches the file content via `/preview/:file` and
 *      flips `modelStatus[diskUri]` to `'ready'`.
 *   3. `<FileRenderer file={...}>` — dispatches to one of the five
 *      stateless renderers (Binary / Image / Markdown / Svg /
 *      TooLarge) or, for text, the leased `<CodeEditor>` mounted
 *      against the freshly-registered disk URI.
 *
 * Read-only for G17-P4. Multi-tab + dirty state + save lands in
 * G17-P5.
 */

import {
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { Effect } from "effect";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-solid";
import {
  fetchProjectFiles,
  type ProjectFileNode,
} from "@/lib/api";
import {
  FileRenderer,
  getFileKind,
  type ManagedFile,
  type ManagedFileKind,
} from "@/lib/editor";
import { CodeEditor } from "@/components/editor/CodeEditor";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { buildMonacoModelPath, toDiskUri } from "@/lib/monaco/model-path";

interface FilesSurfaceProps {
  projectName: string;
  /** Workspace root used to build Monaco model URIs. Defaults to "/". */
  modelRootPath?: string;
}

// Minimal extension → Monaco language id table. Read-only for now;
// expand as the editor surface grows.
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
  const [activePath, setActivePath] = createSignal<string | null>(null);
  const [activeKind, setActiveKind] = createSignal<ManagedFileKind | null>(null);

  const [tree] = createResource(
    () => props.projectName,
    async (sessionName) => Effect.runPromise(fetchProjectFiles(sessionName)),
  );

  // Track every URI we've ever registered so we can unregister on
  // unmount + on path swap. The registry's 60s eviction handles the
  // common case (rapid switch back to a recently-closed file is
  // free); we just need to drop refs on cleanup.
  const registeredUris = new Set<string>();

  onCleanup(() => {
    for (const uri of registeredUris) modelRegistry.unregisterModel(uri);
    registeredUris.clear();
  });

  function openFile(path: string) {
    const kind = getFileKind(path);
    setActivePath(path);
    setActiveKind(kind);

    // Only text / markdown / svg need the model registered — image
    // renders from `file.content`, binary just renders a placeholder.
    // `getFileKind` never emits `'too-large'` — that lands later via
    // the FS-layer's truncation flag.
    if (kind === "binary" || kind === "image") return;

    const bufferUri = buildMonacoModelPath(rootPath(), path);
    const diskUri = toDiskUri(bufferUri);
    if (modelRegistry.modelStatus(diskUri) === "ready") return;

    void Effect.runPromise(
      modelRegistry.registerDisk({
        sessionName: props.projectName,
        rootPath: rootPath(),
        filePath: path,
        language: languageFor(path),
      }),
    )
      .then(() => {
        registeredUris.add(diskUri);
      })
      .catch(() => {
        // Registry already flipped status to 'error' for this URI;
        // the renderer dispatch falls through to the binary
        // placeholder via the dispatch's fallback Match clause.
      });
  }

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
              activePath={activePath()}
              onPick={openFile}
            />
          </Show>
        </Show>
      </aside>

      <main
        data-testid="v2-files-preview"
        class="flex flex-1 min-w-0 min-h-0 flex-col"
      >
        <Show
          when={activePath() !== null}
          fallback={
            <div
              data-testid="v2-files-empty-preview"
              class="flex h-full items-center justify-center text-[11px] text-[var(--dim)]"
            >
              Pick a file from the rail to preview it.
            </div>
          }
        >
          {(_) => <PreviewBody
            path={activePath()!}
            kind={activeKind()!}
            rootPath={rootPath()}
          />}
        </Show>
      </main>
    </div>
  );
}

function PreviewBody(props: { path: string; kind: ManagedFileKind; rootPath: string }) {
  const file = createMemo<ManagedFile>(() => ({
    path: props.path,
    kind: props.kind,
    content: "",
    isLoading: false,
    tabId: props.path,
  }));

  const bufferUri = createMemo(() =>
    buildMonacoModelPath(props.rootPath, props.path),
  );

  // Text dispatches to a leased Monaco editor; the FileRenderer's
  // built-in text slot is still the G17-P2 placeholder, so we
  // bypass it for text and call CodeEditor directly.
  return (
    <Show
      when={props.kind === "text"}
      fallback={
        <FileRenderer
          file={file()}
          modelRootPath={props.rootPath}
          onEditSource={undefined}
        />
      }
    >
      <CodeEditor uri={toDiskUri(bufferUri())} />
    </Show>
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
