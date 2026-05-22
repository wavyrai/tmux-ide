/**
 * SolidDiffsView — the read-only git / PR diff browser body.
 *
 * Replaces MonacoDiffsView under `?view=diffs`. Every mode
 * (Changes working/staged/pr · History · Branch-vs-main) resolves to
 * one combined patch + a file-stat list from the daemon, so the rail
 * and body stay mode-agnostic. The body is a Solid-native virtualized
 * patch renderer with shiki token highlighting that follows the app
 * light/dark theme — no Monaco, no model registry, no theme race.
 *
 * Monaco stays for the editable hunk-accept editor + three-way merge
 * (`?view=changes` / StickyDiffEditor); this surface is read-only.
 */

import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { Effect } from "effect";
import { GitCompare, History } from "lucide-solid";
import { fetchProjectDiff, type DiffFileEntry, type DiffSource } from "@/lib/api";
import {
  fetchCommits,
  fetchCommitDiff,
  fetchRangeDiff,
  relativeDate,
  type CommitEntry,
} from "@/components/diffs/git-history";
import { DiffToolbar, LargeDiffGuard, isLargeDiff } from "@/components/diffs/DiffToolbar";
import { activeShikiTheme, highlightCode, languageForFile } from "@/lib/syntax/shiki";

interface SolidDiffsViewProps {
  projectName: string;
}

type DiffStyle = "unified" | "split";
type DiffMode = "changes" | "history" | "branch";
type DiffLineKind = "context" | "add" | "del" | "hunk" | "meta";

interface DiffLine {
  kind: DiffLineKind;
  /** Raw patch line incl. the leading +/-/space marker. */
  text: string;
  /**
   * Index into the highlight stream for add/del/context lines (the
   * stripped code fed to shiki). -1 for hunk/meta lines.
   */
  codeIndex: number;
}

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
  /** A hunk header spans the full width on its own row. */
  hunk: DiffLine | null;
}

interface NormalizedDiff {
  files: DiffFileEntry[];
  diff: string;
  baseBranch: string | null;
}

const BRANCH_BASE = "main";
const POLL_INTERVAL_MS = 5_000;
const MAX_HIGHLIGHT_BYTES = 400_000;
const MAX_RENDER_LINES = 4000;
const ROW_HEIGHT = 18;

// Low-saturation +/- tints. The previous Monaco surface bled strong
// saturated green/red behind tokens, which fought the syntax colors
// in light mode. Mixing only ~10% of the role color into the bg keeps
// the gutter unmistakable while leaving shiki tokens fully legible.
const LINE_TINT: Record<DiffLineKind, string> = {
  add: "color-mix(in srgb, var(--bg) 90%, var(--green))",
  del: "color-mix(in srgb, var(--bg) 90%, var(--red))",
  hunk: "color-mix(in srgb, var(--bg) 94%, var(--accent))",
  meta: "transparent",
  context: "transparent",
};

const GUTTER_COLOR: Record<DiffLineKind, string> = {
  add: "var(--green)",
  del: "var(--red)",
  hunk: "var(--accent)",
  meta: "var(--dim)",
  context: "var(--dim)",
};

function fileBasename(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? file : file.slice(idx + 1);
}

function fileDirname(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "" : file.slice(0, idx + 1);
}

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/**
 * Split a combined `git diff` into per-file patch segments keyed by
 * the post-image (`b/`) path. The daemon emits the same paths in its
 * file-stat list (one git invocation), so rail selection looks up by
 * `DiffFileEntry.file` directly.
 */
function splitPatchByFile(combined: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!combined.trim()) return out;
  const lines = combined.split("\n");
  let current: string[] | null = null;
  let key: string | null = null;
  const flush = () => {
    if (current && key) out.set(key, current.join("\n"));
    current = null;
    key = null;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
      // `diff --git a/<old> b/<new>` — take the b/ side. Falls back to
      // the +++ line below for paths with spaces.
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      key = m ? m[2]! : null;
      continue;
    }
    if (current) {
      current.push(line);
      if (!key && line.startsWith("+++ b/")) key = line.slice(6).trim();
      else if (!key && line.startsWith("+++ ")) key = line.slice(4).trim();
    }
  }
  flush();
  return out;
}

/** Parse a single file's patch into kinded lines + a code-stream index. */
function parseFilePatch(patch: string): { lines: DiffLine[]; code: string[] } {
  const lines: DiffLine[] = [];
  const code: string[] = [];
  if (!patch) return { lines, code };
  for (const raw of patch.split("\n")) {
    const kind = classifyLine(raw);
    let codeIndex = -1;
    if (kind === "add" || kind === "del" || kind === "context") {
      codeIndex = code.length;
      code.push(raw.length > 0 ? raw.slice(1) : "");
    }
    lines.push({ kind, text: raw, codeIndex });
  }
  return { lines, code };
}

/**
 * Extract the inner HTML of each `<span class="line">` from shiki's
 * `codeToHtml` output. shiki joins lines with a literal `\n` and emits
 * exactly one top-level line span per source line, so splitting the
 * `<code>` body on `\n` is safe (tokens never contain newlines).
 */
function shikiLineHtml(html: string): string[] {
  const open = html.search(/<code[^>]*>/);
  const close = html.lastIndexOf("</code>");
  if (open === -1 || close === -1) return [];
  const codeOpenEnd = html.indexOf(">", open) + 1;
  const inner = html.slice(codeOpenEnd, close);
  return inner
    .split("\n")
    .map((l) => l.replace(/^<span class="line"[^>]*>/, "").replace(/<\/span>$/, ""));
}

function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flushPairs = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null, hunk: null });
    }
    dels = [];
    adds = [];
  };
  for (const ln of lines) {
    if (ln.kind === "del") {
      dels.push(ln);
      continue;
    }
    if (ln.kind === "add") {
      adds.push(ln);
      continue;
    }
    flushPairs();
    // Hunk + meta headers span the full width on their own row so the
    // split columns read like two clean files.
    if (ln.kind === "hunk" || ln.kind === "meta") {
      rows.push({ left: null, right: null, hunk: ln });
    } else {
      rows.push({ left: ln, right: ln, hunk: null });
    }
  }
  flushPairs();
  return rows;
}

export function SolidDiffsView(props: SolidDiffsViewProps): JSX.Element {
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [diffStyle, setDiffStyle] = createSignal<DiffStyle>("unified");
  const [source, setSource] = createSignal<DiffSource>("working");
  const [mode, setMode] = createSignal<DiffMode>("changes");
  const [selectedCommit, setSelectedCommit] = createSignal<string | null>(null);
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
        return { files: r.files, diff: r.diff, baseBranch: r.base };
      }
      if (key.mode === "history") {
        if (!key.commit) return { files: [], diff: "", baseBranch: null };
        const r = await Effect.runPromise(fetchCommitDiff(key.sessionName, key.commit));
        return { files: r.files, diff: r.diff, baseBranch: null };
      }
      const d = await Effect.runPromise(fetchProjectDiff(key.sessionName, key.source));
      return { files: d.files ?? [], diff: d.diff ?? "", baseBranch: d.baseBranch ?? null };
    },
  );

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

  // Only the live working/staged/pr changes view needs polling; commit
  // and branch views are immutable snapshots.
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

  // When source/mode/commit changes, drop per-file "Load anyway"
  // overrides — large-file thresholds are evaluated per diff.
  createEffect(() => {
    void source();
    void mode();
    void selectedCommit();
    setForcedLargeLoads(new Set<string>());
  });

  const files = createMemo<DiffFileEntry[]>(() => data()?.files ?? []);
  const totalAdditions = createMemo(() => files().reduce((s, f) => s + f.additions, 0));
  const totalDeletions = createMemo(() => files().reduce((s, f) => s + f.deletions, 0));

  const segments = createMemo(() => splitPatchByFile(data()?.diff ?? ""));

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

  const selectedPatch = createMemo(() => {
    const file = selectedFile();
    if (!file || selectedIsLarge()) return "";
    return segments().get(file) ?? "";
  });

  const parsed = createMemo(() => parseFilePatch(selectedPatch()));

  // shiki-highlighted inner HTML for each code-stream line. Recomputed
  // on patch change AND on theme change (activeShikiTheme reads the
  // settings signal) so tokens always match the active light/dark
  // theme — never a stale-theme flash. Plain text renders until this
  // resolves; that fallback is itself theme-correct (var(--fg)).
  const [highlighted, setHighlighted] = createSignal<string[] | null>(null);
  createEffect(
    on([selectedFile, selectedPatch, () => activeShikiTheme()], async () => {
      setHighlighted(null);
      const file = selectedFile();
      const code = parsed().code;
      if (!file || code.length === 0) return;
      const lang = languageForFile(file);
      const joined = code.join("\n");
      if (!lang || joined.length > MAX_HIGHLIGHT_BYTES) return; // plain fallback
      try {
        const out = await highlightCode(joined, lang);
        const htmlLines = shikiLineHtml(out);
        // Tolerant: index-map rather than require an exact count.
        // shiki can emit a trailing empty line span; a strict
        // equality check there would silently drop ALL highlighting.
        // Per-line lookup falls back to plain only for genuinely
        // missing indices.
        if (htmlLines.length > 0) setHighlighted(htmlLines);
      } catch {
        setHighlighted(null);
      }
    }),
  );

  const lineHtml = (ln: DiffLine): string | null => {
    if (ln.codeIndex < 0) return null;
    const h = highlighted();
    return h ? (h[ln.codeIndex] ?? null) : null;
  };

  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | null>(null);
  const [showAll, setShowAll] = createSignal(false);

  // Reset truncation + scroll position whenever the file or layout
  // changes so a long file followed by a short one doesn't keep the
  // "showing first N" banner around incorrectly.
  createEffect(
    on([selectedFile, diffStyle], () => {
      setShowAll(false);
      scrollEl()?.scrollTo({ top: 0 });
    }),
  );

  // Direct <For> rendering — @tanstack/solid-virtual is intentionally
  // NOT used here. Its getVirtualItems() perpetually returns [] when
  // the scroll element resolves after the virtualizer's onMount (the
  // element is read once in `_didMount`, not reactively), so the body
  // rendered a correctly-sized spacer with zero rows. Same bug
  // FilesSurface + MessagesTimeline hit and dropped it for. Per-file
  // patches are already bounded by the large-diff guard;
  // MAX_RENDER_LINES is a belt-and-braces cap for pathological hunks.
  const allLines = createMemo(() => parsed().lines);
  const lineTruncated = createMemo(() => allLines().length > MAX_RENDER_LINES && !showAll());
  const visibleLines = createMemo(() =>
    lineTruncated() ? allLines().slice(0, MAX_RENDER_LINES) : allLines(),
  );
  const allSplitRows = createMemo<SplitRow[]>(() =>
    diffStyle() === "split" ? buildSplitRows(parsed().lines) : [],
  );
  const splitTruncated = createMemo(() => allSplitRows().length > MAX_RENDER_LINES && !showAll());
  const visibleSplitRows = createMemo(() =>
    splitTruncated() ? allSplitRows().slice(0, MAX_RENDER_LINES) : allSplitRows(),
  );
  const truncatedNow = createMemo(() =>
    diffStyle() === "split" ? splitTruncated() : lineTruncated(),
  );
  const totalCount = createMemo(() =>
    diffStyle() === "split" ? allSplitRows().length : allLines().length,
  );

  function renderCell(ln: DiffLine | null): JSX.Element {
    if (!ln) {
      return (
        <div style={{ "background-color": "color-mix(in srgb, var(--bg) 97%, var(--dim))" }} />
      );
    }
    // For split, the deletion column shows del+context, additions
    // column shows add+context; suppress the opposite marker so each
    // side reads like a file.
    const sign = ln.kind === "add" ? "+" : ln.kind === "del" ? "-" : ln.kind === "hunk" ? "" : " ";
    // Accessor, not a captured value: highlighting resolves async
    // AFTER the <For> cell is created, and <For> never re-runs the
    // cell for the same item. Reading lineHtml() inside JSX keeps the
    // span subscribed so tokens swap in once shiki finishes.
    const html = () => lineHtml(ln);
    return (
      <div
        data-diff-line-kind={ln.kind}
        style={{
          display: "flex",
          height: `${ROW_HEIGHT}px`,
          "line-height": `${ROW_HEIGHT}px`,
          "white-space": "pre",
          "background-color": LINE_TINT[ln.kind],
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-base)",
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: "16px",
            "flex-shrink": "0",
            "text-align": "center",
            color: GUTTER_COLOR[ln.kind],
            "user-select": "none",
            opacity: ln.kind === "context" ? "0.4" : "0.9",
          }}
        >
          {sign}
        </span>
        <Show
          when={ln.kind === "hunk" || ln.kind === "meta"}
          fallback={
            <Show
              when={html() != null}
              fallback={
                <span style={{ "padding-right": "12px", color: "var(--fg)" }}>
                  {(ln.text.length > 0 ? ln.text.slice(1) : "") || " "}
                </span>
              }
            >
              <span
                style={{ "padding-right": "12px" }}
                // eslint-disable-next-line solid/no-innerhtml
                innerHTML={html()!}
              />
            </Show>
          }
        >
          <span
            style={{
              "padding-right": "12px",
              color: ln.kind === "hunk" ? "var(--accent)" : "var(--dim)",
            }}
          >
            {ln.text || " "}
          </span>
        </Show>
      </div>
    );
  }

  return (
    <div
      data-testid="v2-solid-diffs-view"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-base">
        <GitCompare class="h-3 w-3 text-[var(--accent)]" aria-hidden="true" />
        <span data-testid="v2-solid-diffs-summary" class="text-[var(--dim)]">
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
          <span data-testid="v2-solid-diffs-commit-label" class="font-mono text-[var(--accent)]">
            {selectedCommit()?.slice(0, 7)}
          </span>
        </Show>
        <span class="flex-1" />
        <Show
          when={
            mode() === "branch"
              ? (data()?.baseBranch ?? BRANCH_BASE)
              : mode() === "changes" && source() === "pr" && data()?.baseBranch
                ? data()?.baseBranch
                : null
          }
        >
          {(base) => (
            <span
              data-testid="v2-solid-diffs-pr-base"
              class="text-xs text-[var(--dim)]"
              title="Diff base branch"
            >
              vs {base()}
            </span>
          )}
        </Show>
        <div
          role="group"
          aria-label="diff mode"
          class="inline-flex overflow-hidden rounded border border-[var(--border)]"
        >
          <For
            each={
              [
                ["changes", "Changes"],
                ["history", "History"],
                ["branch", `Branch vs ${BRANCH_BASE}`],
              ] as [DiffMode, string][]
            }
          >
            {([m, lbl]) => (
              <button
                type="button"
                data-testid={`v2-solid-diffs-mode-${m}`}
                onClick={() => switchMode(m)}
                aria-pressed={mode() === m}
                class={
                  "h-5 px-2 text-sm font-mono " +
                  (mode() === m
                    ? "bg-[var(--surface-active)] text-[var(--fg)]"
                    : "bg-transparent text-[var(--dim)] hover:text-[var(--fg)]")
                }
              >
                {lbl}
              </button>
            )}
          </For>
        </div>
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
                  data-testid={`v2-solid-diffs-source-${s}`}
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
                data-testid={`v2-solid-diffs-style-${style}`}
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
            data-testid="v2-solid-diffs-commit-list"
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
                    data-testid="v2-solid-diffs-commits-empty"
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
                        data-testid="v2-solid-diffs-commit"
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
          data-testid="v2-solid-diffs-file-list"
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
                  data-testid="v2-solid-diffs-empty"
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
                              data-testid="v2-solid-diffs-browse-history"
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
                      data-testid="v2-solid-diffs-file"
                      data-diff-file-path={f.file}
                      onClick={() => setSelectedFile(f.file)}
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

        <section data-testid="v2-solid-diffs-body" class="flex flex-1 min-w-0 min-h-0 flex-col">
          <Show when={selectedEntry()}>
            {(entry) => (
              <DiffToolbar
                file={entry().file}
                additions={entry().additions}
                deletions={entry().deletions}
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
            )}
          </Show>
          {/* The scroll container mounts unconditionally so the
              virtualizer observes a stable element from first paint.
              Nesting the ref behind a <Show> leaves getVirtualItems()
              stuck at 0 even though getTotalSize() resolves — same
              constraint CommitDialog's picker follows. Empty / large /
              loaded states swap inside it. */}
          <div
            ref={setScrollEl}
            data-testid="v2-solid-diffs-scroll"
            data-diff-style={diffStyle()}
            class="relative flex-1 min-h-0 min-w-0 overflow-auto"
          >
            <Show
              when={selectedEntry()}
              fallback={
                <div
                  data-testid="v2-solid-diffs-empty-preview"
                  class="flex h-full items-center justify-center text-sm text-[var(--dim)]"
                >
                  Pick a file to diff.
                </div>
              }
            >
              {(entry) => (
                <Show
                  when={!selectedIsLarge()}
                  fallback={
                    <LargeDiffGuard
                      file={entry().file}
                      additions={entry().additions}
                      deletions={entry().deletions}
                      onLoadAnyway={() => forceLoadFile(entry().file)}
                    />
                  }
                >
                  <>
                    <Show when={truncatedNow()}>
                      <div
                        data-testid="v2-solid-diffs-truncated"
                        style={{
                          display: "flex",
                          "align-items": "center",
                          "justify-content": "space-between",
                          padding: "4px 12px",
                          "background-color": "var(--surface)",
                          "border-bottom": "1px solid var(--border)",
                          "font-size": "var(--text-sm)",
                          position: "sticky",
                          top: "0",
                          "z-index": "1",
                        }}
                      >
                        <span style={{ color: "var(--yellow, var(--accent))" }}>
                          showing first {MAX_RENDER_LINES} of {totalCount()} lines
                        </span>
                        <button
                          type="button"
                          data-testid="v2-solid-diffs-show-all"
                          onClick={() => setShowAll(true)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--accent)",
                            cursor: "pointer",
                            "font-family": "inherit",
                            "font-size": "inherit",
                            "text-decoration": "underline",
                          }}
                        >
                          show all
                        </button>
                      </div>
                    </Show>
                    <Show
                      when={diffStyle() === "split"}
                      fallback={<For each={visibleLines()}>{(ln) => renderCell(ln)}</For>}
                    >
                      <For each={visibleSplitRows()}>
                        {(row) => (
                          <Show when={!row.hunk} fallback={renderCell(row.hunk)}>
                            <div
                              style={{
                                display: "grid",
                                "grid-template-columns": "1fr 1fr",
                              }}
                            >
                              <div
                                style={{
                                  "border-right": "1px solid var(--border)",
                                  overflow: "hidden",
                                }}
                              >
                                {renderCell(row.left)}
                              </div>
                              <div style={{ overflow: "hidden" }}>{renderCell(row.right)}</div>
                            </div>
                          </Show>
                        )}
                      </For>
                    </Show>
                  </>
                </Show>
              )}
            </Show>
          </div>
        </section>
      </div>
    </div>
  );
}
