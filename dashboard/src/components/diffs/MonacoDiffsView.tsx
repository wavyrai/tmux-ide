/**
 * MonacoDiffsView — file rail + StickyDiffEditor body for the
 * project's working-tree diff.
 *
 * Listens for changes via `fetchProjectDiff`, renders a left rail of
 * changed files (same shape the v2-solid-widgets DiffsViewer uses).
 * Clicking a file opens a `<StickyDiffEditor>` with:
 *
 *   originalUri = git://<root>/<file>/HEAD         (read-only)
 *   modifiedUri = disk://<root>/<file>             (working tree)
 *
 * Hunk-by-hunk Accept / Reject buttons fire through the host's
 * callbacks; the per-hunk write-through is stubbed until G17-P5
 * (the host logs the hunk + path for now; the diff stays read-only
 * on disk).
 *
 * This surface coexists with the v2-solid-widgets DiffsViewer +
 * pane 2's DiffsView commit/PR surface — it lives behind
 * `?view=changes` while DiffsView holds `?view=diffs`.
 */

import {
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  type JSX,
} from "solid-js";
import { Effect } from "effect";
import { GitCompare } from "lucide-solid";
import { fetchProjectDiff, type DiffFileEntry } from "@/lib/api";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { buildMonacoModelPath, toDiskUri, toGitUri } from "@/lib/monaco/model-path";
import {
  StickyDiffEditor,
  type DiffHunk,
  type DiffStyle,
} from "@/components/editor/StickyDiffEditor";

interface MonacoDiffsViewProps {
  projectName: string;
  /** Workspace root used to build Monaco model URIs. Defaults to "/". */
  modelRootPath?: string;
  /**
   * Hunk Accept/Reject callbacks. When omitted the editor still
   * renders the hunk list but the Accept/Reject affordances stay
   * hidden — matches the `StickyDiffEditor`'s opt-in contract.
   */
  onAcceptHunk?: (file: string, hunk: DiffHunk) => void;
  onRejectHunk?: (file: string, hunk: DiffHunk) => void;
}

function languageFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "mdx":
      return "markdown";
    case "css":
      return "css";
    case "html":
      return "html";
    case "yml":
    case "yaml":
      return "yaml";
    case "go":
      return "go";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "sh":
    case "bash":
      return "shell";
    default:
      return "plaintext";
  }
}

function fileBasename(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? file : file.slice(idx + 1);
}

function fileDirname(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "" : file.slice(0, idx + 1);
}

const POLL_INTERVAL_MS = 5_000;

export function MonacoDiffsView(props: MonacoDiffsViewProps): JSX.Element {
  const rootPath = () => props.modelRootPath ?? "/";
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [diffStyle, setDiffStyle] = createSignal<DiffStyle>("split");

  const [data, { refetch }] = createResource(
    () => props.projectName,
    async (sessionName) => Effect.runPromise(fetchProjectDiff(sessionName)),
  );

  // Re-poll the summary every 5s; same cadence the widget version uses.
  const interval = setInterval(() => void refetch(), POLL_INTERVAL_MS);
  onCleanup(() => clearInterval(interval));

  const files = createMemo<DiffFileEntry[]>(() => data()?.files ?? []);
  const totalAdditions = createMemo(() => files().reduce((s, f) => s + f.additions, 0));
  const totalDeletions = createMemo(() => files().reduce((s, f) => s + f.deletions, 0));

  // Track URIs we've registered so we can drop refs on unmount + on
  // file swap. The 60s registry TTL makes rapid switches free.
  const registeredUris = new Set<string>();
  onCleanup(() => {
    for (const uri of registeredUris) modelRegistry.unregisterModel(uri);
    registeredUris.clear();
  });

  function pickFile(file: string) {
    setSelectedFile(file);
    const language = languageFor(file);
    const bufferUri = buildMonacoModelPath(rootPath(), file);
    const diskUri = toDiskUri(bufferUri);
    const gitUri = toGitUri(bufferUri, "HEAD");

    if (modelRegistry.modelStatus(diskUri) !== "ready") {
      void Effect.runPromise(
        modelRegistry.registerDisk({
          sessionName: props.projectName,
          rootPath: rootPath(),
          filePath: file,
          language,
        }),
      ).then(() => registeredUris.add(diskUri)).catch(() => {});
    }

    if (modelRegistry.modelStatus(gitUri) !== "ready") {
      void Effect.runPromise(
        modelRegistry.registerGit({
          sessionName: props.projectName,
          rootPath: rootPath(),
          filePath: file,
          language,
          ref: "HEAD",
        }),
      ).then(() => registeredUris.add(gitUri)).catch(() => {});
    }
  }

  const selectedUris = createMemo(() => {
    const file = selectedFile();
    if (!file) return null;
    const bufferUri = buildMonacoModelPath(rootPath(), file);
    return {
      file,
      originalUri: toGitUri(bufferUri, "HEAD"),
      modifiedUri: toDiskUri(bufferUri),
    };
  });

  return (
    <div
      data-testid="v2-monaco-diffs-view"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-[12px]">
        <GitCompare class="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
        <span data-testid="v2-monaco-diffs-summary" class="text-[var(--dim)]">
          {files().length} file{files().length !== 1 ? "s" : ""} changed
        </span>
        <Show when={files().length > 0}>
          <span class="text-[var(--dim)] opacity-30">│</span>
          <span class="text-[var(--green)]">+{totalAdditions()}</span>
          <span class="text-[var(--dim)] opacity-30">/</span>
          <span class="text-[var(--red)]">−{totalDeletions()}</span>
        </Show>
        <span class="flex-1" />
        <div
          role="group"
          aria-label="diff view mode"
          class="inline-flex overflow-hidden rounded border border-[var(--border)]"
        >
          <For each={["unified", "split"] as DiffStyle[]}>
            {(style) => (
              <button
                type="button"
                data-testid={`v2-monaco-diffs-style-${style}`}
                onClick={() => setDiffStyle(style)}
                aria-pressed={diffStyle() === style}
                class={
                  "h-5 px-2 text-[11px] font-mono " +
                  (diffStyle() === style
                    ? "bg-[var(--surface-active)] text-[var(--fg)]"
                    : "bg-transparent text-[var(--dim)] hover:text-[var(--fg)]")
                }
              >
                {style}
              </button>
            )}
          </For>
        </div>
      </header>

      <div class="flex flex-1 min-h-0">
        <aside
          data-testid="v2-monaco-diffs-file-list"
          class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-weak)]"
        >
          <Show
            when={!data.loading}
            fallback={
              <div class="px-3 py-2 text-[11px] text-[var(--dim)]">loading…</div>
            }
          >
            <Show
              when={files().length > 0}
              fallback={
                <div
                  data-testid="v2-monaco-diffs-empty"
                  class="px-3 py-2 text-[11px] text-[var(--dim)]"
                >
                  No uncommitted changes
                </div>
              }
            >
              <For each={files()}>
                {(f) => {
                  const isActive = () => selectedFile() === f.file;
                  return (
                    <button
                      type="button"
                      data-testid="v2-monaco-diffs-file"
                      data-diff-file-path={f.file}
                      onClick={() => pickFile(f.file)}
                      aria-pressed={isActive()}
                      class={
                        "flex h-6 w-full items-center px-2 text-left text-[12px] " +
                        (isActive()
                          ? "bg-[var(--surface-active)]"
                          : "hover:bg-[var(--surface-hover)]")
                      }
                    >
                      <span class="flex-1 min-w-0 truncate">
                        <Show when={fileDirname(f.file)}>
                          <span class="text-[var(--dim)]">{fileDirname(f.file)}</span>
                        </Show>
                        <span
                          class={
                            isActive() ? "text-[var(--accent)]" : "text-[var(--fg)]"
                          }
                        >
                          {fileBasename(f.file)}
                        </span>
                      </span>
                      <span class="ml-2 flex shrink-0 gap-1">
                        <Show when={f.additions > 0}>
                          <span class="text-[var(--green)]">+{f.additions}</span>
                        </Show>
                        <Show when={f.deletions > 0}>
                          <span class="text-[var(--red)]">−{f.deletions}</span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </Show>
        </aside>

        <section
          data-testid="v2-monaco-diffs-body"
          class="flex flex-1 min-w-0 min-h-0 flex-col"
        >
          <Show
            when={selectedUris()}
            fallback={
              <div
                data-testid="v2-monaco-diffs-empty-preview"
                class="flex h-full items-center justify-center text-[11px] text-[var(--dim)]"
              >
                Pick a file to diff.
              </div>
            }
          >
            {(uris) => (
              <StickyDiffEditor
                originalUri={uris().originalUri}
                modifiedUri={uris().modifiedUri}
                diffStyle={diffStyle()}
                onAcceptHunk={
                  props.onAcceptHunk
                    ? (h) => props.onAcceptHunk!(uris().file, h)
                    : undefined
                }
                onRejectHunk={
                  props.onRejectHunk
                    ? (h) => props.onRejectHunk!(uris().file, h)
                    : undefined
                }
              />
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}
