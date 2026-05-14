/**
 * SearchView — Cmd+Shift+F repo search panel (G19-P2).
 *
 * Layout matches the audit's §3 mockup:
 *
 *   ┌─ Search ────────────────────────────────┐
 *   │ Query input                             │
 *   │ Replace input (collapsible)             │
 *   │ [Aa] [.*] toggles + include/exclude     │
 *   │ N results in M files (Xms)              │
 *   │ ▾ src/foo.ts        (5 matches)         │
 *   │   12  // TODO: refactor                 │
 *   │   ...                                   │
 *   └─────────────────────────────────────────┘
 *
 * State + streaming lives in `@/lib/search` — this file is pure
 * render + event wiring. Click on a match row navigates to
 * `?view=files&path=<path>&line=<line>` so the Files surface
 * (G17-P4/5 — owned by another silo) can open the file at the
 * cursor; the parent route handles the navigation.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useNavigate } from "@solidjs/router";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Pencil,
  Regex,
  Search as SearchIcon,
  X,
} from "lucide-solid";
import {
  iterateMatches,
  makeSearchService,
  segmentLine,
  stepMatch,
  type FileMatch,
  type FlatMatch,
  type MatchRow,
  type ReplaceResult,
  type SearchService,
} from "@/lib/search";
import { openFileAt } from "@/lib/editorOpen";
import { bufferState } from "@/lib/editor/buffer-store";
import {
  consumePendingSearch,
  loadHistory,
  loadPersistedQuery,
  pendingSearchRequest,
  persistQuery,
  recordToHistory,
} from "@/lib/searchBroker";

const SEARCH_DEBOUNCE_MS = 250;

interface SearchViewProps {
  projectName: string;
  /**
   * Workspace root used to build the Monaco buffer URI when a match
   * is clicked. Defaults to "/" — matches `FilesSurface`'s default
   * so the URIs collide on the same file.
   */
  modelRootPath?: string;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sh: "shell",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  sql: "sql",
};

function languageFor(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

const CONTEXT_WINDOW = 3;

type ResultEntry =
  | { kind: "file-header"; key: string; path: string; file: FileMatch }
  | { kind: "context"; key: string; path: string; line: number; text: string }
  | {
      kind: "match";
      key: string;
      path: string;
      match: MatchRow;
      matchId: string;
      column: number;
      length: number;
    };

/**
 * Flatten the file-grouped result set into a single linear list of
 * rows the virtualizer can slice over. Collapsed file groups
 * contribute their header only; expanded groups contribute the
 * header followed by interleaved context/match/context blocks.
 */
function flattenResults(
  fileOrder: readonly string[],
  byFile: Record<string, FileMatch>,
): ResultEntry[] {
  const out: ResultEntry[] = [];
  for (const path of fileOrder) {
    const file = byFile[path];
    if (!file) continue;
    out.push({ kind: "file-header", key: `H:${path}`, path, file });
    if (!file.expanded) continue;
    for (const match of file.matches) {
      const ctx = file.contextByLine;
      for (let l = match.line - CONTEXT_WINDOW; l < match.line; l += 1) {
        const text = ctx[l];
        if (text !== undefined) {
          out.push({ kind: "context", key: `C:${path}:${l}`, path, line: l, text });
        }
      }
      const first = match.submatches[0];
      const column = first?.start ?? 0;
      const length = first ? first.end - first.start : 0;
      const matchId = `${path}:${match.line}:${column}`;
      out.push({
        kind: "match",
        key: `M:${matchId}`,
        path,
        match,
        matchId,
        column,
        length,
      });
      for (let l = match.line + 1; l <= match.line + CONTEXT_WINDOW; l += 1) {
        const text = ctx[l];
        if (text !== undefined) {
          out.push({ kind: "context", key: `C:${path}:${l}`, path, line: l, text });
        }
      }
    }
  }
  return out;
}

function estimateEntrySize(kind: ResultEntry["kind"]): number {
  // Compact monospace rows are ~22px; the file-header strip has a
  // little more vertical padding. The virtualizer remeasures with
  // the real size as each row scrolls into view.
  if (kind === "file-header") return 26;
  return 22;
}

export function SearchView(props: SearchViewProps): JSX.Element {
  let service!: SearchService;
  let queryInputRef: HTMLInputElement | undefined;
  const [replaceOpen, setReplaceOpen] = createSignal(false);
  const [confirmAcrossFiles, setConfirmAcrossFiles] = createSignal(false);
  const [pendingReplace, setPendingReplace] = createSignal<ReplaceResult | null>(null);
  const [replaceError, setReplaceError] = createSignal<string | null>(null);
  // Active match id for F3 / Shift+F3 navigation. The clicked row +
  // the row F3 lands on share the same selection visual.
  const [activeMatchId, setActiveMatchId] = createSignal<string | null>(null);
  // Scroll container ref for the virtualized results list.
  const [resultsEl, setResultsEl] = createSignal<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  service = makeSearchService(props.projectName);
  const rootPath = (): string => props.modelRootPath ?? "/";

  // Recent-searches history — last 10 queries, MRU-first. Hydrated
  // from localStorage on mount; updated after every successful run.
  const [history, setHistory] = createSignal<string[]>([]);
  const [historyOpen, setHistoryOpen] = createSignal(false);

  // Current-file scope — when on, the panel restricts include to the
  // buffer-store's active file. Toggle off restores the prior glob.
  const [currentFileMode, setCurrentFileMode] = createSignal(false);
  const [savedInclude, setSavedInclude] = createSignal<string | null>(null);

  function activeBufferPath(): string | null {
    const uri = bufferState.activeUri;
    if (!uri) return null;
    return bufferState.buffers[uri]?.filePath ?? null;
  }

  function toggleCurrentFileMode(): void {
    if (!currentFileMode()) {
      const path = activeBufferPath();
      if (!path) return; // no active file → no-op (button is also disabled)
      setSavedInclude(service.options().include);
      service.setOptions({ include: path });
      setCurrentFileMode(true);
    } else {
      service.setOptions({ include: savedInclude() ?? "" });
      setSavedInclude(null);
      setCurrentFileMode(false);
    }
  }

  let debounceHandle: ReturnType<typeof setTimeout> | null = null;
  function scheduleRun(): void {
    if (debounceHandle) clearTimeout(debounceHandle);
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      void service.run();
    }, SEARCH_DEBOUNCE_MS);
  }

  function drainPendingRequest(): void {
    const req = consumePendingSearch();
    if (!req) return;
    if (req.query !== undefined) service.setQuery(req.query);
    const optsPatch: { include?: string; exclude?: string } = {};
    if (req.include !== undefined) optsPatch.include = req.include;
    if (req.exclude !== undefined) optsPatch.exclude = req.exclude;
    if (Object.keys(optsPatch).length > 0) service.setOptions(optsPatch);
    if (req.focusInput) queueMicrotask(() => queryInputRef?.focus());
    if (service.query().trim().length > 0) void service.run();
  }

  onMount(() => {
    // Hydrate persisted query + options for this project.
    const persisted = loadPersistedQuery(props.projectName);
    if (persisted) {
      service.setQuery(persisted.query);
      service.setOptions(persisted.options);
    }
    setHistory(loadHistory(props.projectName));

    // Drain any pending cross-surface request (e.g. Files right-click).
    drainPendingRequest();

    queryInputRef?.focus();
    if (service.query().trim().length > 0) {
      // Cold-start the search if we restored a non-empty query.
      void service.run();
    }
    window.addEventListener("keydown", onGlobalKey, true);
  });

  onCleanup(() => {
    if (debounceHandle) clearTimeout(debounceHandle);
    service.cancel();
    window.removeEventListener("keydown", onGlobalKey, true);
    // Persist the latest state so re-opening restores it.
    persistQuery(props.projectName, {
      query: service.query(),
      options: service.options(),
    });
  });

  // React to broker requests landing while the panel is already mounted.
  createEffect(() => {
    if (pendingSearchRequest()) drainPendingRequest();
  });

  // Push successful runs onto the recent-searches list.
  createEffect(() => {
    if (service.state.status !== "done") return;
    const q = service.query().trim();
    if (!q) return;
    setHistory(recordToHistory(props.projectName, q));
  });

  // F3 / Shift+F3 — step through matches across files (panel-wide,
  // VS Code-style "Go to next match"). Wrap-around at both ends.
  function onGlobalKey(event: KeyboardEvent): void {
    if (event.key !== "F3") return;
    const flat = iterateMatches(service.state);
    if (flat.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const next = stepMatch(flat, activeMatchId(), event.shiftKey ? "prev" : "next");
    if (next) jumpToMatch(next);
  }

  const totals = createMemo(() => {
    const summary = service.state.summary;
    const fileCount = service.state.fileOrder.length;
    return { matches: summary?.matches ?? 0, fileCount, elapsedMs: summary?.elapsedMs ?? 0 };
  });

  // Flat list of result rows fed to the virtualizer. Recomputes when
  // any file's `expanded` or matches array shifts; the virtualizer
  // diffs and remeasures only the rows it actually renders.
  const entries = createMemo<ResultEntry[]>(() =>
    flattenResults(service.state.fileOrder, service.state.byFile),
  );

  const virtualizer = createVirtualizer({
    get count() {
      return entries().length;
    },
    getScrollElement: () => resultsEl(),
    estimateSize: (index) => estimateEntrySize(entries()[index]?.kind ?? "match"),
    overscan: 8,
    getItemKey: (index) => entries()[index]?.key ?? index,
  });

  // F3 / activation: keep the active match scrolled into view by
  // letting the virtualizer drive the scroll (it can target rows
  // that aren't currently in the DOM).
  createEffect(() => {
    const id = activeMatchId();
    if (!id) return;
    const list = entries();
    const idx = list.findIndex((entry) => entry.kind === "match" && entry.matchId === id);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  });

  function onQueryInput(event: Event): void {
    const value = (event.currentTarget as HTMLInputElement).value;
    service.setQuery(value);
    if (value.trim().length === 0) {
      service.cancel();
      service.run().catch(() => undefined);
      return;
    }
    scheduleRun();
  }

  /**
   * Click handler for a single match row. Three coordinated steps:
   *   1. Activate the match id so F3 keeps stepping from here.
   *   2. Drive `openFileAt` — opens (or focuses) the buffer + queues
   *      a pending-reveal request the editor consumes on attach
   *      (G19-P3 / pane 1 G17-P6).
   *   3. Switch the view to `files` via URL nav so the editor pane
   *      becomes the visible surface.
   */
  function openMatch(path: string, line: number, column = 0, length = 0): void {
    setActiveMatchId(`${path}:${line}:${column}`);
    openFileAt({
      sessionName: props.projectName,
      rootPath: rootPath(),
      filePath: path,
      language: languageFor(path),
      line,
      column,
      length,
    });
    const search = new URLSearchParams();
    search.set("view", "files");
    search.set("path", path);
    search.set("line", String(line));
    navigate(`/v2/project/${encodeURIComponent(props.projectName)}?${search.toString()}`);
  }

  /**
   * F3 step target. Selects the row visually + opens the file at
   * line via `openMatch`. Pulls cursor + selection range straight
   * from the FlatMatch so the same column/length the editor reveals
   * matches the panel's highlighted submatch.
   */
  function jumpToMatch(target: FlatMatch): void {
    setActiveMatchId(target.id);
    openMatch(target.path, target.line, target.column, target.length);
  }

  /** Click handler for a context line — just open the file there. */
  function openContextLine(path: string, line: number): void {
    openMatch(path, line, 0, 0);
  }

  function buildReplaceFilesPayload(targetPaths: string[]) {
    return targetPaths
      .map((path) => {
        const file = service.state.byFile[path];
        if (!file) return null;
        return {
          path,
          expectedMtimeMs: file.snapshotMs,
          replacements: file.matches.flatMap((m) =>
            m.submatches.map((sm) => ({
              line: m.line,
              column: sm.start,
              length: sm.end - sm.start,
            })),
          ),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  async function replacePaths(paths: string[]): Promise<void> {
    setReplaceError(null);
    setPendingReplace(null);
    try {
      const result = await service.replace({
        files: buildReplaceFilesPayload(paths),
        replacement: service.replaceWith(),
      });
      setPendingReplace(result);
    } catch (err) {
      setReplaceError(err instanceof Error ? err.message : String(err));
    }
  }

  function replaceAllConfirmed(): void {
    const paths = [...service.state.fileOrder];
    setConfirmAcrossFiles(false);
    void replacePaths(paths);
  }

  function totalMatchesAcrossFiles(): number {
    return service.state.fileOrder.reduce((sum, path) => {
      const f = service.state.byFile[path];
      if (!f) return sum;
      return sum + f.matches.reduce((s, m) => s + m.submatches.length, 0);
    }, 0);
  }

  return (
    <div
      data-testid="search-view"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2 text-[11px] uppercase tracking-wide text-[var(--dim)]">
        <span class="font-medium text-[var(--fg)]">Search</span>
        <span>Cmd+Shift+F</span>
      </header>

      <div class="flex flex-col gap-2 border-b border-[var(--border)] bg-[var(--bg-weak)] px-3 py-2">
        <div class="relative">
          <SearchIcon
            class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--dim)]"
            size={14}
          />
          <input
            ref={queryInputRef}
            data-testid="search-query"
            value={service.query()}
            onInput={onQueryInput}
            onFocus={() => {
              if (service.query().trim().length === 0 && history().length > 0) {
                setHistoryOpen(true);
              }
            }}
            onBlur={() =>
              // Defer closing so a click on a history row still fires.
              queueMicrotask(() => setHistoryOpen(false))
            }
            placeholder="Search workspace…"
            class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] pl-7 pr-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
            spellcheck={false}
            autocomplete="off"
          />
          <Show when={historyOpen() && service.query().trim().length === 0 && history().length > 0}>
            <div
              data-testid="search-history"
              role="listbox"
              aria-label="Recent searches"
              class="absolute left-0 right-0 top-9 z-20 rounded-md border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
            >
              <div class="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wider text-[var(--dim)]">
                <History size={11} />
                <span>Recent</span>
              </div>
              <For each={history()}>
                {(entry) => (
                  <button
                    type="button"
                    data-testid="search-history-item"
                    onMouseDown={(event) => {
                      // mousedown beats the input's blur — picks the
                      // entry before the dropdown closes.
                      event.preventDefault();
                      service.setQuery(entry);
                      setHistoryOpen(false);
                      void service.run();
                    }}
                    class="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-[var(--fg-secondary)] hover:bg-[var(--surface-hover,var(--bg-strong))] hover:text-[var(--fg)]"
                  >
                    <SearchIcon size={11} class="opacity-50" />
                    <span class="truncate">{entry}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Show when={replaceOpen()}>
          <div class="relative">
            <Pencil
              class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--dim)]"
              size={14}
            />
            <input
              data-testid="replace-input"
              value={service.replaceWith()}
              onInput={(event) =>
                service.setReplaceWith((event.currentTarget as HTMLInputElement).value)
              }
              placeholder="Replace with…"
              class="h-8 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] pl-7 pr-2 text-[12px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
              spellcheck={false}
              autocomplete="off"
            />
          </div>
        </Show>

        <div class="flex items-center gap-1">
          <ToggleButton
            label="Case sensitive"
            testId="toggle-case"
            active={service.options().case === "sensitive"}
            onClick={() =>
              service.setOptions({
                case: service.options().case === "sensitive" ? "smart" : "sensitive",
              })
            }
            icon={<CaseSensitive size={14} />}
          />
          <ToggleButton
            label="Regex"
            testId="toggle-regex"
            active={service.options().regex}
            onClick={() => service.setOptions({ regex: !service.options().regex })}
            icon={<Regex size={14} />}
          />
          <ToggleButton
            label="Replace"
            testId="toggle-replace"
            active={replaceOpen()}
            onClick={() => setReplaceOpen((v) => !v)}
            icon={<Pencil size={14} />}
          />
          <ToggleButton
            label={
              activeBufferPath()
                ? `Current file (${activeBufferPath()})`
                : "Current file (no file open)"
            }
            testId="toggle-current-file"
            active={currentFileMode()}
            disabled={!activeBufferPath()}
            onClick={toggleCurrentFileMode}
            icon={<FileText size={14} />}
          />
          <div class="ml-auto flex items-center gap-1">
            <Show when={service.state.status === "running"}>
              <span class="text-[10px] uppercase tracking-wider text-[var(--accent)]">
                searching…
              </span>
            </Show>
            <Show when={service.state.status === "cancelled"}>
              <span class="text-[10px] uppercase tracking-wider text-[var(--dim)]">cancelled</span>
            </Show>
          </div>
        </div>

        <div class="flex gap-2">
          <FilterInput
            testId="search-include"
            label="files to include"
            placeholder="src/**, packages/*/src/**"
            value={service.options().include}
            onInput={(v) => service.setOptions({ include: v })}
          />
          <FilterInput
            testId="search-exclude"
            label="files to exclude"
            placeholder="**/*.test.ts, node_modules/**"
            value={service.options().exclude}
            onInput={(v) => service.setOptions({ exclude: v })}
          />
        </div>

        <Show when={replaceOpen() && service.state.fileOrder.length > 0}>
          <button
            type="button"
            data-testid="replace-across-files"
            class="self-end rounded-md border border-[var(--accent)] bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--bg)] hover:opacity-90"
            disabled={service.replaceWith().length === 0}
            onClick={() => setConfirmAcrossFiles(true)}
          >
            Replace {totalMatchesAcrossFiles()} in {service.state.fileOrder.length} files
          </button>
        </Show>
      </div>

      <Show when={service.state.summary}>
        {(summary) => (
          <div
            data-testid="search-summary"
            class="border-b border-[var(--border)] px-3 py-1 text-[11px] text-[var(--dim)]"
          >
            <span data-testid="summary-matches">{summary().matches}</span> results in
            <span class="mx-1" data-testid="summary-files">
              {totals().fileCount}
            </span>
            files · <span data-testid="summary-elapsed">{summary().elapsedMs}ms</span>
            <Show when={summary().truncated}>
              <span class="ml-2 rounded bg-[var(--bg-strong)] px-1 py-0.5 text-[10px] uppercase text-[var(--accent)]">
                truncated
              </span>
            </Show>
          </div>
        )}
      </Show>

      <Show when={service.state.error}>
        <div
          data-testid="search-error"
          class="border-b border-[var(--red)] bg-[var(--bg-strong)] px-3 py-1 text-[11px] text-[var(--red)]"
        >
          {service.state.error}
        </div>
      </Show>

      <Show when={pendingReplace()}>
        {(result) => (
          <div
            data-testid="replace-summary"
            class="border-b border-[var(--green)] bg-[var(--bg-strong)] px-3 py-1 text-[11px] text-[var(--green)]"
          >
            Replaced {result().matchesReplaced} matches in {result().filesUpdated} files
            <Show when={result().skipped.length > 0}>
              <span class="ml-2 text-[var(--dim)]">
                {result().skipped.length} skipped ({result().skipped[0]?.reason ?? "unknown"}
                {result().skipped.length > 1 ? ", …" : ""})
              </span>
            </Show>
          </div>
        )}
      </Show>

      <Show when={replaceError()}>
        <div
          data-testid="replace-error"
          class="border-b border-[var(--red)] bg-[var(--bg-strong)] px-3 py-1 text-[11px] text-[var(--red)]"
        >
          {replaceError()}
        </div>
      </Show>

      <div
        ref={setResultsEl}
        data-testid="search-results"
        class="min-h-0 flex-1 overflow-auto"
        style={{ position: "relative" }}
      >
        <div
          data-testid="search-results-spacer"
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(vItem) => {
              // Per-row memo keyed on `entry.key`: a sibling row's
              // mutation produces a new entries() array but unchanged
              // rows keep their previous reference so the row body
              // skips re-derivation.
              const entry = createMemo(() => entries()[vItem.index]!, undefined, {
                equals: (a, b) => !!a && !!b && a.key === b.key,
              });
              return (
                <div
                  data-index={vItem.index}
                  ref={(el) => virtualizer.measureElement(el)}
                  style={{
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <ResultRow
                    entry={entry()}
                    activeMatchId={activeMatchId()}
                    replaceVisible={replaceOpen()}
                    replaceDisabled={service.replaceWith().length === 0}
                    onToggleFile={(path) => service.toggleFile(path)}
                    onReplaceFile={(path) => void replacePaths([path])}
                    onOpenMatch={openMatch}
                    onOpenContext={openContextLine}
                  />
                </div>
              );
            }}
          </For>
        </div>
        <Show
          when={
            service.state.status === "done" &&
            service.state.fileOrder.length === 0 &&
            service.query().trim().length > 0
          }
        >
          <div
            data-testid="search-empty"
            class="flex h-full items-center justify-center text-[12px] text-[var(--dim)]"
          >
            No matches
          </div>
        </Show>
      </div>

      <Show when={confirmAcrossFiles()}>
        <ConfirmReplaceDialog
          totalMatches={totalMatchesAcrossFiles()}
          fileCount={service.state.fileOrder.length}
          onCancel={() => setConfirmAcrossFiles(false)}
          onConfirm={replaceAllConfirmed}
        />
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------
// Row renderers — virtualized: each `ResultEntry` from the flattened
// list maps to one of these by `kind`.
// ---------------------------------------------------------------------

interface ResultRowProps {
  entry: ResultEntry;
  activeMatchId: string | null;
  replaceVisible: boolean;
  replaceDisabled: boolean;
  onToggleFile: (path: string) => void;
  onReplaceFile: (path: string) => void;
  onOpenMatch: (path: string, line: number, column: number, length: number) => void;
  onOpenContext: (path: string, line: number) => void;
}

function ResultRow(props: ResultRowProps): JSX.Element {
  return (
    <Show when={props.entry} keyed>
      {(entry) => {
        if (entry.kind === "file-header") {
          return (
            <FileHeaderRow
              file={entry.file}
              path={entry.path}
              replaceVisible={props.replaceVisible}
              replaceDisabled={props.replaceDisabled}
              onToggle={() => props.onToggleFile(entry.path)}
              onReplace={() => props.onReplaceFile(entry.path)}
            />
          );
        }
        if (entry.kind === "context") {
          return (
            <ContextLineRow
              line={entry.line}
              text={entry.text}
              onClick={() => props.onOpenContext(entry.path, entry.line)}
            />
          );
        }
        return (
          <MatchRowView
            path={entry.path}
            match={entry.match}
            matchId={entry.matchId}
            column={entry.column}
            length={entry.length}
            isActive={props.activeMatchId === entry.matchId}
            onClick={() =>
              props.onOpenMatch(entry.path, entry.match.line, entry.column, entry.length)
            }
          />
        );
      }}
    </Show>
  );
}

interface FileHeaderRowProps {
  path: string;
  file: FileMatch;
  replaceVisible: boolean;
  replaceDisabled: boolean;
  onToggle: () => void;
  onReplace: () => void;
}

function FileHeaderRow(props: FileHeaderRowProps): JSX.Element {
  const matchCount = createMemo(() =>
    props.file.matches.reduce((sum, m) => sum + m.submatches.length, 0),
  );
  return (
    <div
      data-testid="search-file-group"
      data-path={props.path}
      class="border-b border-[var(--border-weak,var(--border))]"
    >
      <div class="group flex w-full items-center gap-1 bg-[var(--bg-weak)] px-2 py-1 text-[11px] text-[var(--fg-secondary)]">
        <button
          type="button"
          data-testid="search-file-toggle"
          onClick={() => props.onToggle()}
          class="flex flex-1 items-center gap-1 text-left hover:text-[var(--fg)]"
        >
          {props.file.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span class="truncate font-mono">{props.path}</span>
          <span class="ml-1 text-[10px] text-[var(--dim)]">
            ({matchCount()} {matchCount() === 1 ? "match" : "matches"})
          </span>
        </button>
        <Show when={props.replaceVisible}>
          <button
            type="button"
            data-testid="search-file-replace"
            disabled={props.replaceDisabled}
            onClick={(e) => {
              e.stopPropagation();
              props.onReplace();
            }}
            class="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[var(--accent)] hover:bg-[var(--surface-hover,var(--bg-strong))] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Replace
          </button>
        </Show>
      </div>
    </div>
  );
}

interface ContextLineRowProps {
  line: number;
  text: string;
  onClick: () => void;
}

function ContextLineRow(props: ContextLineRowProps): JSX.Element {
  return (
    <button
      type="button"
      class="block w-full bg-[var(--bg)] px-3 py-0.5 text-left font-mono text-[12px] leading-relaxed text-[var(--dim)] hover:bg-[var(--surface-hover,var(--bg-strong))]"
      onClick={() => props.onClick()}
    >
      <span class="mr-3 inline-block w-8 text-right tabular-nums">{props.line}</span>
      <span>{props.text}</span>
    </button>
  );
}

interface MatchRowViewProps {
  path: string;
  match: MatchRow;
  matchId: string;
  column: number;
  length: number;
  isActive: boolean;
  onClick: () => void;
}

function MatchRowView(props: MatchRowViewProps): JSX.Element {
  return (
    <button
      type="button"
      data-testid="search-match-row"
      data-line={props.match.line}
      data-match-id={props.matchId}
      aria-current={props.isActive ? "true" : undefined}
      class={`block w-full bg-[var(--bg)] px-3 py-0.5 text-left font-mono text-[12px] leading-relaxed hover:bg-[var(--surface-hover,var(--bg-strong))] ${
        props.isActive
          ? "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] outline outline-1 outline-[var(--accent)]"
          : ""
      }`}
      onClick={() => props.onClick()}
    >
      <span class="mr-3 inline-block w-8 text-right tabular-nums text-[var(--dim)]">
        {props.match.line}
      </span>
      <For each={segmentLine(props.match.text, props.match.submatches)}>
        {(seg) =>
          seg.kind === "match" ? (
            <mark
              data-testid="search-match-highlight"
              class="rounded bg-[color-mix(in_oklab,var(--accent)_25%,transparent)] px-0.5 text-[var(--fg)]"
            >
              {seg.text}
            </mark>
          ) : (
            <span>{seg.text}</span>
          )
        }
      </For>
    </button>
  );
}

// ---------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------

interface ToggleButtonProps {
  label: string;
  testId: string;
  active: boolean;
  onClick: () => void;
  icon: JSX.Element;
  /** Disabled buttons mute their color and skip onClick. Tooltip
   *  (title) still renders the label so the user can see why. */
  disabled?: boolean;
}

function ToggleButton(props: ToggleButtonProps): JSX.Element {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-pressed={props.active}
      disabled={props.disabled ?? false}
      title={props.label}
      onClick={() => {
        if (props.disabled) return;
        props.onClick();
      }}
      class={`flex h-6 w-6 items-center justify-center rounded text-[var(--fg-secondary)] hover:bg-[var(--surface-hover,var(--bg-strong))] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        props.active
          ? "bg-[color-mix(in_oklab,var(--accent)_18%,transparent)] text-[var(--accent)]"
          : ""
      }`}
    >
      {props.icon}
    </button>
  );
}

interface FilterInputProps {
  testId: string;
  label: string;
  placeholder: string;
  value: string;
  onInput: (next: string) => void;
}

function FilterInput(props: FilterInputProps): JSX.Element {
  return (
    <label class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[10px] uppercase tracking-wider text-[var(--dim)]">{props.label}</span>
      <input
        data-testid={props.testId}
        value={props.value}
        onInput={(event) => props.onInput((event.currentTarget as HTMLInputElement).value)}
        placeholder={props.placeholder}
        class="h-7 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] text-[var(--fg)] outline-none focus:border-[var(--accent)]"
        spellcheck={false}
        autocomplete="off"
      />
    </label>
  );
}

// ---------------------------------------------------------------------
// Confirm modal
// ---------------------------------------------------------------------

interface ConfirmReplaceDialogProps {
  totalMatches: number;
  fileCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmReplaceDialog(props: ConfirmReplaceDialogProps): JSX.Element {
  let primaryRef: HTMLButtonElement | undefined;
  onMount(() => primaryRef?.focus());

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    }
  }

  return (
    <div
      data-testid="confirm-replace-dialog"
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onKeyDown={onKey}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-replace-title"
        class="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-2xl"
      >
        <h2
          id="confirm-replace-title"
          class="m-0 text-[14px] font-semibold leading-tight text-[var(--fg)]"
        >
          Replace across files
        </h2>
        <p class="mt-2 text-[12px] text-[var(--fg-secondary)]">
          About to replace <span class="font-mono">{props.totalMatches}</span> matches across{" "}
          <span class="font-mono">{props.fileCount}</span> files. This is destructive — commit your
          working tree first if you want easy revert (a non-committed file can still be restored via{" "}
          <code class="font-mono">git checkout -- .</code> if you don't reload).
        </p>
        <p class="mt-1 text-[12px] text-[var(--fg-secondary)]">
          Files modified since the last search snapshot will be skipped.
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-replace-cancel"
            onClick={() => props.onCancel()}
            class="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-[12px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Cancel
          </button>
          <button
            ref={primaryRef}
            type="button"
            data-testid="confirm-replace-confirm"
            onClick={() => props.onConfirm()}
            class="rounded-md border border-[var(--accent)] bg-[var(--accent)] px-3 py-1 text-[12px] font-medium text-[var(--bg)] hover:opacity-90"
          >
            Replace
          </button>
        </div>
      </div>
    </div>
  );
}
