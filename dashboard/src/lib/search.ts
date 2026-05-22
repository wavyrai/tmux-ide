/**
 * Solid SearchService — drives the Cmd+Shift+F repo search panel.
 *
 * Owns:
 *   - Query + filter signals (query, replaceWith, options).
 *   - A `createStore`-backed `state` carrying per-file results and the
 *     stream status (`idle | running | done | error | cancelled`).
 *   - `run(query)` — opens an NDJSON fetch against
 *     `/api/project/:name/search` and streams frames into the store.
 *     Each new run cancels the previous one via AbortController.
 *   - `cancel()` — aborts the in-flight stream.
 *   - `replace({fileResults, replacement, regex})` — wraps the daemon
 *     `POST /api/project/:name/search/replace` endpoint with mtime
 *     guard tracking.
 *
 * Frame contract is pinned to the daemon's stable shape — see
 * `docs/goal-19-repo-search.md §1` and `packages/daemon/src/command-
 * center/search.ts`'s SearchFrame type.
 */

import { createSignal, type Accessor } from "solid-js";
import { createStore, type SetStoreFunction, type Store } from "solid-js/store";
import { API_BASE } from "./api";

// ---------------------------------------------------------------------
// Public types — frame schema matches the daemon's SearchFrame.
// ---------------------------------------------------------------------

export type Submatch = { start: number; end: number };

export type SearchFrame =
  | { type: "begin"; path: string }
  | {
      type: "match";
      path: string;
      line: number;
      text: string;
      submatches: Submatch[];
    }
  | { type: "context"; path: string; line: number; text: string }
  | { type: "end"; path: string }
  | {
      type: "summary";
      matches: number;
      filesSearched: number;
      elapsedMs: number;
      truncated: boolean;
    }
  | { type: "error"; message: string; fatal: boolean };

export type CaseMode = "smart" | "sensitive" | "insensitive";

export interface SearchOptions {
  case: CaseMode;
  regex: boolean;
  include: string;
  exclude: string;
  context: number;
}

export interface MatchRow {
  line: number;
  text: string;
  submatches: Submatch[];
}

export interface FileMatch {
  path: string;
  matches: MatchRow[];
  /** Context lines arriving inter-leaved between matches, keyed by line. */
  contextByLine: Record<number, string>;
  /** ISO/ms moment we observed the first frame for this file. Used as
   *  the "search snapshot" for the replace mtime guard. */
  snapshotMs: number;
  expanded: boolean;
}

export interface SearchSummary {
  matches: number;
  filesSearched: number;
  elapsedMs: number;
  truncated: boolean;
}

export type SearchStatus = "idle" | "running" | "done" | "error" | "cancelled";

export interface SearchState {
  status: SearchStatus;
  byFile: Record<string, FileMatch>;
  fileOrder: string[];
  summary: SearchSummary | null;
  error: string | null;
}

// ---------------------------------------------------------------------
// Replace types
// ---------------------------------------------------------------------

export interface ReplaceRequestFile {
  path: string;
  expectedMtimeMs?: number;
  replacements: Array<{ line: number; column: number; length: number }>;
}

export interface ReplaceResult {
  filesUpdated: number;
  matchesReplaced: number;
  skipped: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------

export interface SearchService {
  readonly state: Store<SearchState>;
  readonly query: Accessor<string>;
  readonly setQuery: (next: string) => void;
  readonly replaceWith: Accessor<string>;
  readonly setReplaceWith: (next: string) => void;
  readonly options: Accessor<SearchOptions>;
  readonly setOptions: (next: Partial<SearchOptions>) => void;
  readonly toggleFile: (path: string) => void;
  readonly run: () => Promise<void>;
  readonly cancel: () => void;
  readonly replace: (params: {
    files: ReplaceRequestFile[];
    replacement: string;
  }) => Promise<ReplaceResult>;
}

// ---------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------

const DEFAULT_OPTIONS: SearchOptions = {
  case: "smart",
  regex: false,
  include: "",
  exclude: "",
  context: 3,
};

const INITIAL_STATE: SearchState = {
  status: "idle",
  byFile: {},
  fileOrder: [],
  summary: null,
  error: null,
};

/**
 * Build a SearchService scoped to a single project / session name.
 * The session name is curried in so React-style routing changes that
 * swap the project pull in a fresh service.
 */
export function makeSearchService(projectName: string): SearchService {
  const [state, setState] = createStore<SearchState>(structuredClone(INITIAL_STATE));
  const [query, setQuery] = createSignal("");
  const [replaceWith, setReplaceWith] = createSignal("");
  const [options, setOptionsSignal] = createSignal<SearchOptions>(DEFAULT_OPTIONS);

  let abort: AbortController | null = null;

  function setOptions(next: Partial<SearchOptions>): void {
    setOptionsSignal((prev) => ({ ...prev, ...next }));
  }

  function toggleFile(path: string): void {
    const current = state.byFile[path];
    if (!current) return;
    setState("byFile", path, "expanded", !current.expanded);
  }

  function cancel(): void {
    if (abort) abort.abort();
    abort = null;
  }

  function reset(): void {
    setState(structuredClone(INITIAL_STATE));
  }

  async function run(): Promise<void> {
    const q = query().trim();
    if (!q) {
      cancel();
      reset();
      return;
    }
    if (abort) abort.abort();
    const controller = new AbortController();
    abort = controller;

    reset();
    setState("status", "running");

    const params = new URLSearchParams();
    params.set("q", q);
    const opts = options();
    if (opts.include.trim()) params.set("include", opts.include.trim());
    if (opts.exclude.trim()) params.set("exclude", opts.exclude.trim());
    if (opts.case !== "smart") params.set("case", opts.case);
    if (opts.regex) params.set("regex", "true");
    if (opts.context > 0) params.set("context", String(opts.context));

    const url = `${API_BASE}/api/project/${encodeURIComponent(projectName)}/search?${params.toString()}`;

    try {
      const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // fallthrough — status-only message
        }
        setState({ status: "error", error: message });
        return;
      }
      const body = res.body;
      if (!body) {
        setState({ status: "error", error: "empty response body" });
        return;
      }
      await consumeNdjson(body, controller.signal, setState);
      if (!controller.signal.aborted) {
        setState("status", state.error ? "error" : "done");
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setState("status", "cancelled");
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", error: message });
    } finally {
      if (abort === controller) abort = null;
    }
  }

  async function replace(params: {
    files: ReplaceRequestFile[];
    replacement: string;
  }): Promise<ReplaceResult> {
    const url = `${API_BASE}/api/project/${encodeURIComponent(projectName)}/search/replace`;
    const body = {
      query: query().trim(),
      regex: options().regex,
      caseMode: options().case,
      replacement: params.replacement,
      files: params.files,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody?.error) message = errBody.error;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    const result = (await res.json()) as ReplaceResult;
    // Clear successfully-replaced files from the search state so the
    // UI immediately reflects the action. Skipped paths stay.
    const skippedPaths = new Set(result.skipped.map((s) => s.path));
    for (const file of params.files) {
      if (skippedPaths.has(file.path)) continue;
      setState("byFile", file.path, undefined!);
      setState("fileOrder", (order) => order.filter((p) => p !== file.path));
    }
    return result;
  }

  return {
    state,
    query,
    setQuery,
    replaceWith,
    setReplaceWith,
    options,
    setOptions,
    toggleFile,
    run,
    cancel,
    replace,
  };
}

// ---------------------------------------------------------------------
// NDJSON consumer — pulled out for testability.
// ---------------------------------------------------------------------

/**
 * Read an NDJSON ReadableStream of `SearchFrame`s and apply each frame
 * to the store. Exported for unit-test use; the runtime calls it from
 * `run()`.
 */
export async function consumeNdjson(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  setState: SetStoreFunction<SearchState>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim()) applyLine(buffer.trim(), setState);
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) applyLine(line, setState);
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function applyLine(line: string, setState: SetStoreFunction<SearchState>): void {
  let frame: SearchFrame;
  try {
    frame = JSON.parse(line) as SearchFrame;
  } catch {
    return;
  }
  switch (frame.type) {
    case "begin": {
      const now = Date.now();
      setState("byFile", frame.path, {
        path: frame.path,
        matches: [],
        contextByLine: {},
        snapshotMs: now,
        expanded: true,
      });
      setState("fileOrder", (order) =>
        order.includes(frame.path) ? order : [...order, frame.path],
      );
      return;
    }
    case "match": {
      setState("byFile", frame.path, "matches", (matches) => [
        ...matches,
        {
          line: frame.line,
          text: frame.text.replace(/\n$/, ""),
          submatches: frame.submatches,
        },
      ]);
      return;
    }
    case "context": {
      setState("byFile", frame.path, "contextByLine", (current) => ({
        ...current,
        [frame.line]: frame.text.replace(/\n$/, ""),
      }));
      return;
    }
    case "end":
      return;
    case "summary":
      setState("summary", {
        matches: frame.matches,
        filesSearched: frame.filesSearched,
        elapsedMs: frame.elapsedMs,
        truncated: frame.truncated,
      });
      return;
    case "error":
      setState({ status: "error", error: frame.message });
      return;
  }
}

// ---------------------------------------------------------------------
// iterateMatches — flatten the result store for F3 / next-match nav.
// ---------------------------------------------------------------------

export interface FlatMatch {
  path: string;
  line: number;
  /** 0-based column of the FIRST submatch on this line — the one
   *  Monaco's cursor lands at. */
  column: number;
  /** Length of the first submatch — used to build `setSelection`. */
  length: number;
  fileIndex: number;
  matchIndex: number;
  /** Stable id so the panel can highlight the current row regardless
   *  of list re-renders. */
  id: string;
}

/**
 * Flatten the search state into a linear array of `{path, line, …}`
 * tuples in display order (file order × match order within file).
 * Used by F3 / Shift+F3 to step through matches one at a time.
 *
 * Pure — pinned by unit tests. Each tuple keeps fileIndex +
 * matchIndex so callers can locate the source row.
 */
export function iterateMatches(state: SearchState): FlatMatch[] {
  const out: FlatMatch[] = [];
  state.fileOrder.forEach((path, fileIndex) => {
    const file = state.byFile[path];
    if (!file) return;
    file.matches.forEach((match, matchIndex) => {
      const first = match.submatches[0];
      out.push({
        path,
        line: match.line,
        column: first?.start ?? 0,
        length: first ? first.end - first.start : 0,
        fileIndex,
        matchIndex,
        id: `${path}:${match.line}:${first?.start ?? 0}`,
      });
    });
  });
  return out;
}

/**
 * Step from `currentId` to the next match in the flattened list.
 * Wraps around at the ends; returns the first match when no current
 * id is provided (next) or the last (prev).
 *
 * Pure — pinned by unit tests.
 */
export function stepMatch(
  matches: FlatMatch[],
  currentId: string | null,
  direction: "next" | "prev",
): FlatMatch | null {
  if (matches.length === 0) return null;
  if (!currentId) {
    return direction === "next" ? matches[0]! : matches[matches.length - 1]!;
  }
  const idx = matches.findIndex((m) => m.id === currentId);
  if (idx === -1) {
    return direction === "next" ? matches[0]! : matches[matches.length - 1]!;
  }
  if (direction === "next") {
    return matches[(idx + 1) % matches.length]!;
  }
  return matches[(idx - 1 + matches.length) % matches.length]!;
}

// ---------------------------------------------------------------------
// Pure helpers — used by the UI to render highlighted spans.
// ---------------------------------------------------------------------

/**
 * Split a line into alternating plain/highlighted segments based on
 * submatches. Sorts submatches by start to be robust against an
 * unsorted feed; clamps to the line length.
 */
export function segmentLine(
  text: string,
  submatches: Submatch[],
): Array<{ kind: "plain" | "match"; text: string }> {
  if (submatches.length === 0) return [{ kind: "plain", text }];
  const sorted = [...submatches].sort((a, b) => a.start - b.start);
  const out: Array<{ kind: "plain" | "match"; text: string }> = [];
  let cursor = 0;
  for (const sm of sorted) {
    const start = Math.max(cursor, Math.min(sm.start, text.length));
    const end = Math.max(start, Math.min(sm.end, text.length));
    if (start > cursor) {
      out.push({ kind: "plain", text: text.slice(cursor, start) });
    }
    if (end > start) {
      out.push({ kind: "match", text: text.slice(start, end) });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    out.push({ kind: "plain", text: text.slice(cursor) });
  }
  return out;
}
