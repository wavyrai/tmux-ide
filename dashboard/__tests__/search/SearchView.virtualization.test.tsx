/**
 * Contracts test for the virtualized SearchView results list.
 *
 * The view flattens (fileOrder, byFile) into a single linear entry
 * list (file-header + match + context rows) and feeds it to
 * @tanstack/solid-virtual. This test seeds a 200-file × 25-match
 * payload (5k matches) and asserts that only a viewport-sized
 * window of rows lands in the DOM, the spacer reports the full
 * virtual height, and file-header click-to-collapse still works.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createStore } from "solid-js/store";
import { Router, Route } from "@solidjs/router";
import type { FileMatch, MatchRow, SearchService, SearchState } from "@/lib/search";

// Make `makeSearchService` return a stub backed by a seeded store so
// the SearchView renders against deterministic data without hitting
// the daemon. All other exports from `@/lib/search` pass through.
vi.mock("@/lib/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/search")>();
  return {
    ...actual,
    makeSearchService: vi.fn(),
  };
});

// `openFileAt` would try to drive the buffer store / Monaco — stub it.
vi.mock("@/lib/editorOpen", () => ({
  openFileAt: vi.fn(),
}));

// searchBroker reads localStorage on mount; the no-op stubs keep
// happy-dom from throwing on persistence calls.
vi.mock("@/lib/searchBroker", () => ({
  consumePendingSearch: vi.fn(() => null),
  loadHistory: vi.fn(() => []),
  loadPersistedQuery: vi.fn(() => null),
  pendingSearchRequest: vi.fn(() => null),
  persistQuery: vi.fn(),
  recordToHistory: vi.fn(() => []),
}));

import { makeSearchService } from "@/lib/search";
import { SearchView } from "@/components/search/SearchView";

function match(line: number, text = "needle"): MatchRow {
  return { line, text, submatches: [{ start: 0, end: 6 }] };
}

function file(path: string, matches: MatchRow[], expanded = true): FileMatch {
  return { path, matches, contextByLine: {}, snapshotMs: 1, expanded };
}

function makeServiceStub(initial: Partial<SearchState> = {}): SearchService {
  const [state, setState] = createStore<SearchState>({
    status: "done",
    byFile: {},
    fileOrder: [],
    summary: null,
    error: null,
    ...initial,
  });
  const [query, setQuery] = createSignal("needle");
  const [replaceWith, setReplaceWith] = createSignal("");
  const [options, setOptions] = createSignal({
    case: "smart" as const,
    regex: false,
    include: "",
    exclude: "",
    context: 3,
  });
  return {
    state,
    query,
    setQuery,
    replaceWith,
    setReplaceWith,
    options,
    setOptions: (next) => setOptions((prev) => ({ ...prev, ...next })),
    toggleFile: (path: string) => {
      const f = state.byFile[path];
      if (!f) return;
      setState("byFile", path, "expanded", !f.expanded);
    },
    run: async () => undefined,
    cancel: () => undefined,
    replace: async () => ({ filesUpdated: 0, matchesReplaced: 0, skipped: [] }),
  };
}

function mount(service: SearchService) {
  vi.mocked(makeSearchService).mockReturnValue(service);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(
    () => (
      <Router>
        <Route path="/" component={() => <SearchView projectName="test" />} />
      </Router>
    ),
    container,
  );
  return { container, dispose };
}

beforeEach(() => {
  vi.mocked(makeSearchService).mockReset();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SearchView virtualization", () => {
  it("renders only a viewport-sized window of rows for a 200-file × 25-match payload", () => {
    const fileOrder: string[] = [];
    const byFile: Record<string, FileMatch> = {};
    for (let i = 0; i < 200; i += 1) {
      const path = `src/file-${i}.ts`;
      const matches = Array.from({ length: 25 }, (_, j) => match(j * 4 + 1));
      fileOrder.push(path);
      byFile[path] = file(path, matches);
    }
    // 200 file headers + 200 × 25 = 5200 entries total.
    const service = makeServiceStub({ fileOrder, byFile });

    const { container, dispose } = mount(service);

    const renderedRows = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(renderedRows.length).toBeGreaterThan(0);
    // Far below 5200 — only the viewport + overscan slice.
    expect(renderedRows.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='search-results-spacer']",
    );
    expect(spacer).toBeTruthy();
    const spacerHeight = parseInt(spacer!.style.height, 10);
    // At least 5200 entries × ~22px average = 100k+ pixels.
    expect(spacerHeight).toBeGreaterThan(100_000);

    dispose();
  });

  it("file-header click still toggles expansion through the service", () => {
    const fileOrder = ["src/a.ts"];
    const byFile = { "src/a.ts": file("src/a.ts", [match(1)], true) };
    const service = makeServiceStub({ fileOrder, byFile });

    const { container, dispose } = mount(service);

    const toggle = container.querySelector<HTMLButtonElement>(
      "[data-testid='search-file-toggle']",
    );
    expect(toggle).toBeTruthy();
    // Initially expanded → one match row visible.
    expect(container.querySelectorAll("[data-testid='search-match-row']").length).toBe(1);

    toggle!.click();
    // Collapsed → no match rows.
    expect(container.querySelectorAll("[data-testid='search-match-row']").length).toBe(0);
    // Header still rendered.
    expect(container.querySelector("[data-testid='search-file-group']")).toBeTruthy();

    dispose();
  });
});
