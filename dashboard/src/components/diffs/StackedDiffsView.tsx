/**
 * StackedDiffsView — every changed file in one scroll surface, one
 * `<StickyDiffEditor>` per file. Scroll position drives the active
 * file in the left rail; clicking a rail entry scrolls the matching
 * section into view.
 *
 * Coexists with `MonacoDiffsView` (rail + single editor). Both share
 * the same `DiffToolbar` + `LargeDiffGuard` helpers so the per-file
 * header + threshold UI stay consistent.
 */

import {
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  onCleanup,
  onMount,
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
import { DiffToolbar, LargeDiffGuard, isLargeDiff } from "@/components/diffs/DiffToolbar";

interface StackedDiffsViewProps {
  projectName: string;
  modelRootPath?: string;
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

function basename(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? file : file.slice(idx + 1);
}

function dirname(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "" : file.slice(0, idx + 1);
}

const POLL_INTERVAL_MS = 5_000;

export function StackedDiffsView(props: StackedDiffsViewProps): JSX.Element {
  const rootPath = () => props.modelRootPath ?? "/";
  const [diffStyle, setDiffStyle] = createSignal<DiffStyle>("split");
  const [activeFile, setActiveFile] = createSignal<string | null>(null);
  const [forcedLargeLoads, setForcedLargeLoads] = createSignal<Set<string>>(new Set());
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | null>(null);

  const [data, { refetch }] = createResource(
    () => props.projectName,
    async (sessionName) => Effect.runPromise(fetchProjectDiff(sessionName)),
  );

  const interval = setInterval(() => void refetch(), POLL_INTERVAL_MS);
  onCleanup(() => clearInterval(interval));

  const files = createMemo<DiffFileEntry[]>(() => data()?.files ?? []);
  const totalAdditions = createMemo(() => files().reduce((s, f) => s + f.additions, 0));
  const totalDeletions = createMemo(() => files().reduce((s, f) => s + f.deletions, 0));

  // Eagerly register git:// + disk:// models for every changed file
  // that isn't gated by the large-diff threshold. The registry's 60s
  // TTL handles cleanup on unmount.
  const registeredUris = new Set<string>();
  onCleanup(() => {
    for (const uri of registeredUris) modelRegistry.unregisterModel(uri);
    registeredUris.clear();
  });

  function ensureRegistered(file: string) {
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
      )
        .then(() => registeredUris.add(diskUri))
        .catch(() => {});
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
      )
        .then(() => registeredUris.add(gitUri))
        .catch(() => {});
    }
  }

  function isFileLarge(entry: DiffFileEntry): boolean {
    if (forcedLargeLoads().has(entry.file)) return false;
    return isLargeDiff(entry.additions, entry.deletions);
  }

  function forceLoadFile(file: string) {
    setForcedLargeLoads((prev) => {
      const next = new Set(prev);
      next.add(file);
      return next;
    });
  }

  // Scroll-driven active file: an IntersectionObserver scoped to the
  // scroll container picks the entry with the largest intersection
  // ratio whenever the user scrolls. The default `activeFile`
  // initializes to the first file once data arrives.
  let observer: IntersectionObserver | null = null;
  const sectionRefs = new Map<string, HTMLElement>();
  function registerSection(file: string, el: HTMLElement | undefined) {
    if (!el) {
      sectionRefs.delete(file);
      return;
    }
    sectionRefs.set(file, el);
    if (observer) observer.observe(el);
  }

  onMount(() => {
    const root = scrollEl();
    if (!root) return;
    observer = new IntersectionObserver(
      (entries) => {
        // Pick the visible entry with the largest intersection ratio.
        let best: { file: string; ratio: number } | null = null;
        for (const e of entries) {
          const file = (e.target as HTMLElement).dataset.diffSection;
          if (!file) continue;
          if (!best || e.intersectionRatio > best.ratio) {
            best = { file, ratio: e.intersectionRatio };
          }
        }
        if (best && best.ratio > 0) setActiveFile(best.file);
      },
      { root, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of sectionRefs.values()) observer.observe(el);
  });
  onCleanup(() => {
    observer?.disconnect();
    observer = null;
  });

  function scrollToFile(file: string) {
    const el = sectionRefs.get(file);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveFile(file);
  }

  return (
    <div
      data-testid="v2-stacked-diffs-view"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-base">
        <GitCompare class="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
        <span data-testid="v2-stacked-diffs-summary" class="text-[var(--dim)]">
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
                data-testid={`v2-stacked-diffs-style-${style}`}
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
        <aside
          data-testid="v2-stacked-diffs-rail"
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
                  data-testid="v2-stacked-diffs-empty"
                  class="px-3 py-2 text-sm text-[var(--dim)]"
                >
                  No uncommitted changes
                </div>
              }
            >
              <For each={files()}>
                {(f) => {
                  const isActive = () => activeFile() === f.file;
                  return (
                    <button
                      type="button"
                      data-testid="v2-stacked-diffs-rail-file"
                      data-diff-file-path={f.file}
                      onClick={() => scrollToFile(f.file)}
                      aria-pressed={isActive()}
                      class={
                        "flex h-6 w-full items-center px-2 text-left text-base " +
                        (isActive()
                          ? "bg-[var(--surface-active)]"
                          : "hover:bg-[var(--surface-hover)]")
                      }
                    >
                      <span class="flex-1 min-w-0 truncate">
                        <Show when={dirname(f.file)}>
                          <span class="text-[var(--dim)]">{dirname(f.file)}</span>
                        </Show>
                        <span class={isActive() ? "text-[var(--accent)]" : "text-[var(--fg)]"}>
                          {basename(f.file)}
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
          ref={setScrollEl}
          data-testid="v2-stacked-diffs-scroll"
          class="flex flex-1 min-w-0 min-h-0 flex-col overflow-y-auto"
        >
          <Show
            when={files().length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-sm text-[var(--dim)]">
                No uncommitted changes
              </div>
            }
          >
            <For each={files()}>
              {(f) => {
                const bufferUri = buildMonacoModelPath(rootPath(), f.file);
                const originalUri = toGitUri(bufferUri, "HEAD");
                const modifiedUri = toDiskUri(bufferUri);
                const large = () => isFileLarge(f);
                // Kick off the model registration only when we're
                // actually mounting the editor (i.e. not blocked by
                // the large-diff guard).
                const ensureLoaded = () => {
                  if (!large()) ensureRegistered(f.file);
                };
                return (
                  <div
                    ref={(el) => registerSection(f.file, el)}
                    data-diff-section={f.file}
                    data-testid="v2-stacked-diffs-section"
                    class="flex flex-col border-b border-[var(--border)]"
                  >
                    <DiffToolbar
                      file={f.file}
                      additions={f.additions}
                      deletions={f.deletions}
                      badge="Changed"
                    />
                    <Show
                      when={!large()}
                      fallback={
                        <LargeDiffGuard
                          file={f.file}
                          additions={f.additions}
                          deletions={f.deletions}
                          onLoadAnyway={() => {
                            forceLoadFile(f.file);
                            ensureRegistered(f.file);
                          }}
                        />
                      }
                    >
                      {(() => {
                        ensureLoaded();
                        return (
                          <div class="min-h-[240px]">
                            <StickyDiffEditor
                              originalUri={originalUri}
                              modifiedUri={modifiedUri}
                              diffStyle={diffStyle()}
                              onAcceptHunk={
                                props.onAcceptHunk
                                  ? (h) => props.onAcceptHunk!(f.file, h)
                                  : undefined
                              }
                              onRejectHunk={
                                props.onRejectHunk
                                  ? (h) => props.onRejectHunk!(f.file, h)
                                  : undefined
                              }
                            />
                          </div>
                        );
                      })()}
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </section>
      </div>
    </div>
  );
}
