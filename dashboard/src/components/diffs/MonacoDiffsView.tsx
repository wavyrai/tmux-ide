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
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  type JSX,
} from "solid-js";
import { Effect } from "effect";
import { GitCompare, History } from "lucide-solid";
import { fetchProjectDiff, type DiffFileEntry, type DiffSource, type GitRef } from "@/lib/api";
import {
  fetchCommits,
  fetchCommitDiff,
  fetchRangeDiff,
  relativeDate,
  EMPTY_TREE_SHA,
  type CommitEntry,
} from "@/components/diffs/git-history";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { buildMonacoModelPath, toDiskUri, toGitUri } from "@/lib/monaco/model-path";
import {
  StickyDiffEditor,
  type DiffHunk,
  type DiffStyle,
} from "@/components/editor/StickyDiffEditor";
import { DiffToolbar, LargeDiffGuard, isLargeDiff } from "@/components/diffs/DiffToolbar";
import { TabStrip } from "@/components/ui/TabStrip";

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

/**
 * Top-level surface mode. `changes` keeps the original working/staged/pr
 * behavior; `history` browses commits; `branch` shows the full
 * base...HEAD range a PR would contain. All three feed the SAME rail +
 * StickyDiffEditor — only the resolved git refs differ.
 */
type DiffMode = "changes" | "history" | "branch";

/** Normalized shape every mode resolves to so the rail + editor stay
 *  mode-agnostic. Mirrors the working-tree `DiffData` fields the
 *  component already consumed. */
interface NormalizedDiff {
  files: DiffFileEntry[];
  originalRef: GitRef;
  modifiedRef: GitRef;
  baseBranch: string | null;
}

const BRANCH_BASE = "main";

export function MonacoDiffsView(props: MonacoDiffsViewProps): JSX.Element {
  const rootPath = () => props.modelRootPath ?? "/";
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [diffStyle, setDiffStyle] = createSignal<DiffStyle>("split");
  const [source, setSource] = createSignal<DiffSource>("working");
  const [mode, setMode] = createSignal<DiffMode>("changes");
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null);
  // Files for which the user has explicitly clicked "Load anyway",
  // overriding the LARGE_DIFF_LINE_THRESHOLD guard.
  const [forcedLargeLoads, setForcedLargeLoads] = createSignal<Set<string>>(new Set());

  const [data, { refetch }] = createResource(
    () => ({
      sessionName: props.projectName,
      source: source(),
      mode: mode(),
      commit: selectedCommit(),
    }),
    async (key): Promise<NormalizedDiff> => {
      if (key.mode === "branch") {
        const r = await Effect.runPromise(fetchRangeDiff(key.sessionName, BRANCH_BASE));
        return {
          files: r.files,
          originalRef: r.baseSha ?? BRANCH_BASE,
          modifiedRef: "HEAD",
          baseBranch: r.base,
        };
      }
      if (key.mode === "history") {
        if (!key.commit) {
          return { files: [], originalRef: "HEAD", modifiedRef: "WORKING", baseBranch: null };
        }
        const r = await Effect.runPromise(fetchCommitDiff(key.sessionName, key.commit));
        return {
          files: r.files,
          originalRef: r.parent ?? EMPTY_TREE_SHA,
          modifiedRef: r.sha,
          baseBranch: null,
        };
      }
      const d = await Effect.runPromise(fetchProjectDiff(key.sessionName, key.source));
      return {
        files: d.files ?? [],
        originalRef: d.originalRef ?? "HEAD",
        modifiedRef: d.modifiedRef ?? "WORKING",
        baseBranch: d.baseBranch ?? null,
      };
    },
  );

  // Commit list — only loaded in history mode (and refreshed when the
  // surface is mounted there). `?base=main` tags ahead-of-base commits.
  const [commitsRes] = createResource(
    () => (mode() === "history" ? props.projectName : null),
    async (sessionName) =>
      Effect.runPromise(fetchCommits(sessionName, BRANCH_BASE, 200)).catch(() => ({
        commits: [] as CommitEntry[],
        base: null,
        baseSha: null,
        headSha: "",
        aheadCount: 0,
      })),
  );
  const commitList = createMemo<CommitEntry[]>(() => commitsRes()?.commits ?? []);

  // Re-poll the summary every 5s; same cadence the widget version uses.
  // Commit + branch views are immutable snapshots, so only the live
  // working/staged/pr changes view needs the poll.
  const interval = setInterval(() => {
    if (mode() === "changes") void refetch();
  }, POLL_INTERVAL_MS);
  onCleanup(() => clearInterval(interval));

  function switchMode(next: DiffMode) {
    setMode(next);
    setSelectedFile(null);
    if (next !== "history") setSelectedCommit(null);
  }

  function pickCommit(sha: string) {
    setSelectedCommit(sha);
    setSelectedFile(null);
  }

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

  // Refs the daemon resolved for the current diff source. The
  // dashboard echoes these into the model URIs so the StickyDiffEditor
  // sees the right git:// / disk:// pair per source.
  const originalRef = createMemo<GitRef>(() => data()?.originalRef ?? "HEAD");
  const modifiedRef = createMemo<GitRef>(() => data()?.modifiedRef ?? "WORKING");

  function uriForRef(file: string, ref: GitRef): { uri: string; isWorking: boolean } {
    const bufferUri = buildMonacoModelPath(rootPath(), file);
    if (ref === "WORKING") return { uri: toDiskUri(bufferUri), isWorking: true };
    return { uri: toGitUri(bufferUri, String(ref)), isWorking: false };
  }

  function registerForFile(file: string) {
    const language = languageFor(file);
    const left = uriForRef(file, originalRef());
    const right = uriForRef(file, modifiedRef());
    for (const [target, ref] of [[left, originalRef()] as const, [right, modifiedRef()] as const]) {
      if (modelRegistry.modelStatus(target.uri) === "ready") continue;
      if (target.isWorking) {
        void Effect.runPromise(
          modelRegistry.registerDisk({
            sessionName: props.projectName,
            rootPath: rootPath(),
            filePath: file,
            language,
          }),
        )
          .then(() => registeredUris.add(target.uri))
          .catch(() => {});
      } else {
        void Effect.runPromise(
          modelRegistry.registerGit({
            sessionName: props.projectName,
            rootPath: rootPath(),
            filePath: file,
            language,
            ref,
          }),
        )
          .then(() => registeredUris.add(target.uri))
          .catch(() => {});
      }
    }
  }

  function pickFile(file: string) {
    setSelectedFile(file);
    registerForFile(file);
  }

  const selectedUris = createMemo(() => {
    const file = selectedFile();
    if (!file) return null;
    const left = uriForRef(file, originalRef());
    const right = uriForRef(file, modifiedRef());
    return {
      file,
      originalUri: left.uri,
      modifiedUri: right.uri,
    };
  });

  const selectedEntry = createMemo<DiffFileEntry | null>(() => {
    const file = selectedFile();
    if (!file) return null;
    return files().find((f) => f.file === file) ?? null;
  });

  const selectedIsLarge = createMemo(() => {
    const entry = selectedEntry();
    if (!entry) return false;
    if (forcedLargeLoads().has(entry.file)) return false;
    return isLargeDiff(entry.additions, entry.deletions);
  });

  function forceLoadFile(file: string) {
    setForcedLargeLoads((prev) => {
      const next = new Set(prev);
      next.add(file);
      return next;
    });
  }

  // Re-register the selected file's models when the diff source
  // changes — the URIs now point at different refs and StickyDiffEditor
  // reads them straight from `selectedUris()`.
  createEffect(() => {
    void originalRef();
    void modifiedRef();
    const file = selectedFile();
    if (file) registerForFile(file);
  });

  // When the source/mode/commit changes, drop the per-file "Load
  // anyway" overrides — large-file thresholds are evaluated per diff.
  createEffect(() => {
    void source();
    void mode();
    void selectedCommit();
    setForcedLargeLoads(new Set<string>());
  });

  return (
    <div
      data-testid="v2-monaco-diffs-view"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-base">
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
        <Show when={mode() === "history" && selectedCommit()}>
          <span class="text-[var(--dim)] opacity-30">│</span>
          <span data-testid="v2-monaco-diffs-commit-label" class="font-mono text-[var(--accent)]">
            {selectedCommit()?.slice(0, 7)}
          </span>
        </Show>
        <span class="flex-1" />
        <Show
          when={
            (mode() === "branch" && (data()?.baseBranch ?? BRANCH_BASE)) ||
            (mode() === "changes" && data()?.baseBranch && source() === "pr"
              ? data()?.baseBranch
              : null)
          }
        >
          {(base) => (
            <span
              data-testid="v2-monaco-diffs-pr-base"
              class="text-xs text-[var(--dim)]"
              title="Diff base branch"
            >
              vs {base()}
            </span>
          )}
        </Show>
        <TabStrip<DiffMode>
          variant="pill"
          ariaLabel="diff mode"
          testid="v2-monaco-diffs-mode"
          items={[
            { id: "changes", label: "changes" },
            { id: "history", label: "history" },
            { id: "branch", label: `branch vs ${BRANCH_BASE}` },
          ]}
          activeId={mode()}
          onSelect={(next) => switchMode(next)}
        />
        <Show when={mode() === "changes"}>
          <div
            role="group"
            aria-label="diff source"
            class="inline-flex overflow-hidden rounded border border-[var(--border)]"
          >
            <For each={["working", "staged", "pr"] as DiffSource[]}>
              {(s) => (
                <button
                  type="button"
                  data-testid={`v2-monaco-diffs-source-${s}`}
                  onClick={() => {
                    setSource(s);
                    setSelectedFile(null);
                  }}
                  aria-pressed={source() === s}
                  title={
                    s === "working"
                      ? "Working tree (HEAD ↔ disk)"
                      : s === "staged"
                        ? "Staged (HEAD ↔ index)"
                        : "Pull request (base ↔ HEAD)"
                  }
                  class={
                    "h-5 px-2 text-sm font-mono " +
                    (source() === s
                      ? "bg-[var(--surface-active)] text-[var(--fg)]"
                      : "bg-transparent text-[var(--dim)] hover:text-[var(--fg)]")
                  }
                >
                  {s}
                </button>
              )}
            </For>
          </div>
        </Show>
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
                  "h-5 px-2 text-sm font-mono " +
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
        <Show when={mode() === "history"}>
          <aside
            data-testid="v2-monaco-diffs-commit-list"
            class="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-weak)]"
          >
            <Show
              when={!commitsRes.loading}
              fallback={<div class="px-3 py-2 text-sm text-[var(--dim)]">loading commits…</div>}
            >
              <Show
                when={commitList().length > 0}
                fallback={
                  <div
                    data-testid="v2-monaco-diffs-commits-empty"
                    class="px-3 py-2 text-sm text-[var(--dim)]"
                  >
                    No commits
                  </div>
                }
              >
                <For each={commitList()}>
                  {(commit) => {
                    const isActive = () => selectedCommit() === commit.sha;
                    return (
                      <button
                        type="button"
                        data-testid="v2-monaco-diffs-commit"
                        data-commit-sha={commit.sha}
                        data-ahead={commit.ahead ? "true" : "false"}
                        onClick={() => pickCommit(commit.sha)}
                        aria-pressed={isActive()}
                        class={
                          "flex flex-col gap-0.5 border-b border-[var(--border)] px-2 py-1.5 text-left text-base " +
                          (isActive()
                            ? "bg-[var(--surface-active)]"
                            : "hover:bg-[var(--surface-hover)]")
                        }
                      >
                        <span class="flex items-center gap-1.5">
                          <Show when={commit.ahead}>
                            <span
                              class="shrink-0 rounded-sm bg-[var(--accent)] px-1 text-[9px] uppercase text-[var(--bg)]"
                              title={`Ahead of ${BRANCH_BASE} — included in a PR`}
                            >
                              ahead
                            </span>
                          </Show>
                          <span
                            class={
                              "min-w-0 flex-1 truncate " +
                              (isActive() ? "text-[var(--accent)]" : "text-[var(--fg)]")
                            }
                          >
                            {commit.subject}
                          </span>
                        </span>
                        <span class="flex items-center gap-1.5 text-xs text-[var(--dim)]">
                          <span class="font-mono">{commit.shortSha}</span>
                          <span class="opacity-40">·</span>
                          <span class="min-w-0 truncate">{commit.author}</span>
                          <span class="opacity-40">·</span>
                          <span class="shrink-0">{relativeDate(commit.date)}</span>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </aside>
        </Show>
        <aside
          data-testid="v2-monaco-diffs-file-list"
          class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)] bg-[var(--bg-weak)]"
        >
          <Show
            when={!data.loading}
            fallback={<div class="px-3 py-2 text-sm text-[var(--dim)]">loading…</div>}
          >
            <Show
              when={files().length > 0}
              fallback={
                <div
                  data-testid="v2-monaco-diffs-empty"
                  class="flex flex-col gap-2 px-3 py-2 text-sm text-[var(--dim)]"
                >
                  <Show
                    when={mode() === "history"}
                    fallback={
                      <Show
                        when={mode() === "branch"}
                        fallback={
                          <>
                            <span>No working-tree changes</span>
                            <button
                              type="button"
                              data-testid="v2-monaco-diffs-browse-history"
                              onClick={() => switchMode("history")}
                              class="inline-flex items-center gap-1 self-start rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-sm text-[var(--fg)] hover:bg-[var(--surface-hover)]"
                            >
                              <History class="h-3 w-3" aria-hidden="true" />
                              Browse commit history
                            </button>
                          </>
                        }
                      >
                        <span>No diff vs {data()?.baseBranch ?? BRANCH_BASE}</span>
                      </Show>
                    }
                  >
                    <span>{selectedCommit() ? "No file changes" : "Select a commit"}</span>
                  </Show>
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
                        "flex h-6 w-full items-center px-2 text-left text-base " +
                        (isActive()
                          ? "bg-[var(--surface-active)]"
                          : "hover:bg-[var(--surface-hover)]")
                      }
                    >
                      <span class="flex-1 min-w-0 truncate">
                        <Show when={fileDirname(f.file)}>
                          <span class="text-[var(--dim)]">{fileDirname(f.file)}</span>
                        </Show>
                        <span class={isActive() ? "text-[var(--accent)]" : "text-[var(--fg)]"}>
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

        <section data-testid="v2-monaco-diffs-body" class="flex flex-1 min-w-0 min-h-0 flex-col">
          <Show
            when={selectedUris()}
            fallback={
              <div
                data-testid="v2-monaco-diffs-empty-preview"
                class="flex h-full items-center justify-center text-sm text-[var(--dim)]"
              >
                Pick a file to diff.
              </div>
            }
          >
            {(uris) => (
              <>
                <DiffToolbar
                  file={uris().file}
                  additions={selectedEntry()?.additions ?? 0}
                  deletions={selectedEntry()?.deletions ?? 0}
                  badge={
                    mode() === "history"
                      ? "Commit"
                      : mode() === "branch"
                        ? "Branch"
                        : source() === "staged"
                          ? "Staged"
                          : source() === "pr"
                            ? "PR"
                            : "Changed"
                  }
                />
                <Show
                  when={!selectedIsLarge()}
                  fallback={
                    <LargeDiffGuard
                      file={uris().file}
                      additions={selectedEntry()?.additions ?? 0}
                      deletions={selectedEntry()?.deletions ?? 0}
                      onLoadAnyway={() => forceLoadFile(uris().file)}
                    />
                  }
                >
                  <StickyDiffEditor
                    originalUri={uris().originalUri}
                    modifiedUri={uris().modifiedUri}
                    diffStyle={diffStyle()}
                    onAcceptHunk={
                      props.onAcceptHunk ? (h) => props.onAcceptHunk!(uris().file, h) : undefined
                    }
                    onRejectHunk={
                      props.onRejectHunk ? (h) => props.onRejectHunk!(uris().file, h) : undefined
                    }
                  />
                </Show>
              </>
            )}
          </Show>
        </section>
      </div>
    </div>
  );
}
