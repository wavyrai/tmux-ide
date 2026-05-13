/**
 * Tests for the search broker (G19-P4).
 *
 * Covers:
 *   - pendingSearchRequest lifecycle: publish, consume, replace.
 *   - history (last 10, MRU-first, dedup, empty-query reject).
 *   - last-query persistence: round-trip + malformed-data tolerance.
 *   - folderIncludeGlob (pure helper).
 *
 * Uses a fresh localStorage fake per test so persisted state never
 * leaks between cases.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetPendingSearchForTests,
  clearHistory,
  consumePendingSearch,
  folderIncludeGlob,
  loadHistory,
  loadPersistedQuery,
  pendingSearchRequest,
  persistQuery,
  recordToHistory,
  requestSearch,
} from "@/lib/searchBroker";

const PROJECT = "demo";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let originalStorage: Storage | undefined;

beforeEach(() => {
  __resetPendingSearchForTests();
  originalStorage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  __resetPendingSearchForTests();
  if (originalStorage) {
    Object.defineProperty(window, "localStorage", {
      value: originalStorage,
      writable: true,
      configurable: true,
    });
  }
});

describe("pendingSearchRequest", () => {
  it("starts empty", () => {
    expect(pendingSearchRequest()).toBeNull();
  });

  it("publishes + drains via consume", () => {
    requestSearch({ query: "TODO", include: "src/**" });
    expect(pendingSearchRequest()).toEqual({ query: "TODO", include: "src/**" });
    expect(consumePendingSearch()).toEqual({ query: "TODO", include: "src/**" });
    expect(pendingSearchRequest()).toBeNull();
  });

  it("replaces any prior unconsumed entry", () => {
    requestSearch({ query: "a" });
    requestSearch({ query: "b" });
    expect(pendingSearchRequest()).toEqual({ query: "b" });
  });

  it("consume returns null when empty", () => {
    expect(consumePendingSearch()).toBeNull();
  });
});

describe("history", () => {
  it("starts empty", () => {
    expect(loadHistory(PROJECT)).toEqual([]);
  });

  it("records MRU-first", () => {
    recordToHistory(PROJECT, "alpha");
    recordToHistory(PROJECT, "bravo");
    expect(loadHistory(PROJECT)).toEqual(["bravo", "alpha"]);
  });

  it("dedupes existing entries, moving them to the front", () => {
    recordToHistory(PROJECT, "alpha");
    recordToHistory(PROJECT, "bravo");
    recordToHistory(PROJECT, "alpha");
    expect(loadHistory(PROJECT)).toEqual(["alpha", "bravo"]);
  });

  it("caps at 10 entries", () => {
    for (let i = 0; i < 15; i += 1) recordToHistory(PROJECT, `q${i}`);
    const out = loadHistory(PROJECT);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe("q14");
    expect(out[9]).toBe("q5");
  });

  it("rejects whitespace-only queries", () => {
    recordToHistory(PROJECT, "alpha");
    recordToHistory(PROJECT, "   ");
    recordToHistory(PROJECT, "");
    expect(loadHistory(PROJECT)).toEqual(["alpha"]);
  });

  it("trims surrounding whitespace before recording", () => {
    recordToHistory(PROJECT, "  alpha  ");
    recordToHistory(PROJECT, "alpha");
    expect(loadHistory(PROJECT)).toEqual(["alpha"]);
  });

  it("clearHistory drops everything for the project", () => {
    recordToHistory(PROJECT, "alpha");
    clearHistory(PROJECT);
    expect(loadHistory(PROJECT)).toEqual([]);
  });

  it("history is keyed per project", () => {
    recordToHistory("a", "first");
    recordToHistory("b", "second");
    expect(loadHistory("a")).toEqual(["first"]);
    expect(loadHistory("b")).toEqual(["second"]);
  });

  it("loadHistory tolerates malformed storage values", () => {
    window.localStorage.setItem("tmux-ide:search:history:demo", "{not json");
    expect(loadHistory(PROJECT)).toEqual([]);

    window.localStorage.setItem(
      "tmux-ide:search:history:demo",
      JSON.stringify(["ok", 42, null, ""]),
    );
    expect(loadHistory(PROJECT)).toEqual(["ok"]);
  });
});

describe("persistQuery / loadPersistedQuery", () => {
  it("round-trips a query + options", () => {
    persistQuery(PROJECT, {
      query: "TODO",
      options: {
        case: "sensitive",
        regex: true,
        include: "src/**",
        exclude: "**/*.test.ts",
        context: 3,
      },
    });
    expect(loadPersistedQuery(PROJECT)).toEqual({
      query: "TODO",
      options: {
        case: "sensitive",
        regex: true,
        include: "src/**",
        exclude: "**/*.test.ts",
        context: 3,
      },
    });
  });

  it("returns null when nothing is persisted", () => {
    expect(loadPersistedQuery(PROJECT)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    window.localStorage.setItem("tmux-ide:search:last:demo", "{not json");
    expect(loadPersistedQuery(PROJECT)).toBeNull();
  });

  it("returns null when the schema doesn't match", () => {
    window.localStorage.setItem(
      "tmux-ide:search:last:demo",
      JSON.stringify({ query: "x", options: { case: "weird" } }),
    );
    expect(loadPersistedQuery(PROJECT)).toBeNull();
  });

  it("persistence is keyed per project", () => {
    persistQuery("a", {
      query: "a-q",
      options: { case: "smart", regex: false, include: "", exclude: "", context: 3 },
    });
    persistQuery("b", {
      query: "b-q",
      options: { case: "smart", regex: false, include: "", exclude: "", context: 3 },
    });
    expect(loadPersistedQuery("a")?.query).toBe("a-q");
    expect(loadPersistedQuery("b")?.query).toBe("b-q");
  });
});

describe("folderIncludeGlob", () => {
  it("appends /** to a relative folder path", () => {
    expect(folderIncludeGlob("src/foo")).toBe("src/foo/**");
  });

  it("strips trailing slashes before appending", () => {
    expect(folderIncludeGlob("src/foo/")).toBe("src/foo/**");
    expect(folderIncludeGlob("src/foo///")).toBe("src/foo/**");
  });

  it("returns ** for the workspace root", () => {
    expect(folderIncludeGlob("")).toBe("**");
    expect(folderIncludeGlob("/")).toBe("**");
  });
});
