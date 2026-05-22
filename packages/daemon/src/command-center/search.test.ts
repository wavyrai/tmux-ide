/**
 * Tests for the ripgrep-backed search endpoint (G19-P1).
 *
 * Covers the pure layer (parseSearchQuery / buildRgArgs /
 * reshapeRgFrame) directly, and the HTTP layer end-to-end through
 * `createApp()` with `TMUX_IDE_RIPGREP_PATH` pointing at the system
 * `rg` binary (mandatory dev dep — the test skips itself if `rg`
 * isn't on PATH).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import {
  buildRgArgs,
  parseSearchQuery,
  reshapeRgFrame,
  type SearchFrame,
  type SearchQuery,
} from "./search.ts";
import { createApp } from "./server.ts";
import { makePane } from "../__tests__/support.ts";

// --- Test fixtures ----------------------------------------------------------

let tmpDir: string;
let restoreExec: () => void;
let restoreTmux: () => void;
let previousRgPath: string | undefined;

function defaultQuery(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return {
    q: "TODO",
    include: [],
    exclude: [],
    case: "smart",
    regex: false,
    context: 0,
    maxResults: 1000,
    maxFileSize: 5 * 1024 * 1024,
    ...overrides,
  };
}

function locateSystemRg(): string | null {
  try {
    return execFileSync("which", ["rg"], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "tmux-ide-search-test-")));
  const mockPanes: PaneInfo[] = [makePane({ id: "%1", index: 0, title: "Shell", active: true })];
  restoreExec = _setExecutor((_cmd, args) => {
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}\t${p.role ?? ""}\t${p.name ?? ""}\t${p.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });
  restoreTmux = _setTmuxRunner((args) => {
    if (args[0] === "list-sessions") return "test-project";
    if (args[0] === "display-message") return tmpDir;
    return "";
  });

  // Pin the rg binary to whatever's on PATH for the HTTP-layer tests.
  // The pure-layer tests don't actually spawn rg so they work regardless.
  const systemRg = locateSystemRg();
  previousRgPath = process.env["TMUX_IDE_RIPGREP_PATH"];
  if (systemRg) process.env["TMUX_IDE_RIPGREP_PATH"] = systemRg;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  restoreExec?.();
  restoreTmux?.();
  if (previousRgPath === undefined) {
    delete process.env["TMUX_IDE_RIPGREP_PATH"];
  } else {
    process.env["TMUX_IDE_RIPGREP_PATH"] = previousRgPath;
  }
});

// ---------------------------------------------------------------------------
// parseSearchQuery — pure layer
// ---------------------------------------------------------------------------

describe("parseSearchQuery", () => {
  it("rejects missing query", () => {
    const result = parseSearchQuery({});
    expect(result).toEqual({ ok: false, error: "Missing q= query parameter" });
  });

  it("rejects globs with absolute paths or .. segments", () => {
    expect(parseSearchQuery({ q: "x", include: "/etc/**" })).toEqual({
      ok: false,
      error: "Glob escapes workspace: /etc/**",
    });
    expect(parseSearchQuery({ q: "x", exclude: "src/../etc/**" })).toEqual({
      ok: false,
      error: "Glob escapes workspace: src/../etc/**",
    });
  });

  it("accepts safe globs + clamps numeric params", () => {
    const result = parseSearchQuery({
      q: "TODO",
      include: "src/**, packages/*/src/**",
      exclude: "**/*.test.ts, node_modules/**",
      case: "sensitive",
      regex: "true",
      context: "3",
      maxResults: "999999",
      maxFileSize: "1024",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.query.include).toEqual(["src/**", "packages/*/src/**"]);
    expect(result.query.exclude).toEqual(["**/*.test.ts", "node_modules/**"]);
    expect(result.query.case).toBe("sensitive");
    expect(result.query.regex).toBe(true);
    expect(result.query.context).toBe(3);
    expect(result.query.maxResults).toBe(10_000); // ceiling-clamped
    expect(result.query.maxFileSize).toBe(1024); // floor allowed
  });

  it("defaults case to smart, regex to false, context to 0", () => {
    const result = parseSearchQuery({ q: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.query).toMatchObject({
      case: "smart",
      regex: false,
      context: 0,
      maxResults: 1000,
    });
  });
});

// ---------------------------------------------------------------------------
// buildRgArgs — pure layer
// ---------------------------------------------------------------------------

describe("buildRgArgs", () => {
  it("emits --fixed-strings for literal queries", () => {
    const args = buildRgArgs(defaultQuery({ q: "TODO" }), "/tmp/root");
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("TODO");
    expect(args).not.toContain("--regexp");
  });

  it("emits --regexp when regex=true", () => {
    const args = buildRgArgs(defaultQuery({ q: "[A-Z]+", regex: true }), "/tmp/root");
    expect(args).toContain("--regexp");
    expect(args).toContain("[A-Z]+");
    expect(args).not.toContain("--fixed-strings");
  });

  it("maps case=smart/sensitive/insensitive to the right flag", () => {
    expect(buildRgArgs(defaultQuery({ case: "smart" }), "/r")).toContain("--smart-case");
    expect(buildRgArgs(defaultQuery({ case: "sensitive" }), "/r")).toContain("--case-sensitive");
    expect(buildRgArgs(defaultQuery({ case: "insensitive" }), "/r")).toContain("--ignore-case");
  });

  it("emits --glob for include and !-prefixed for exclude", () => {
    const args = buildRgArgs(
      defaultQuery({ include: ["src/**"], exclude: ["**/*.test.ts"] }),
      "/tmp/root",
    );
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < args.length - 1; i += 1) {
      if (args[i] === "--glob") pairs.push([args[i]!, args[i + 1]!]);
    }
    expect(pairs).toEqual([
      ["--glob", "src/**"],
      ["--glob", "!**/*.test.ts"],
    ]);
  });

  it("always ends with `-- <searchRoot>`", () => {
    const args = buildRgArgs(defaultQuery(), "/abs/path");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("/abs/path");
  });

  it("pins --max-count to 50 (per-file cap) regardless of query.maxResults", () => {
    const args = buildRgArgs(defaultQuery({ maxResults: 5000 }), "/r");
    expect(args).toContain("--max-count=50");
  });

  it("omits --context when context=0", () => {
    const args = buildRgArgs(defaultQuery({ context: 0 }), "/r");
    expect(args.some((a) => a.startsWith("--context"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reshapeRgFrame — pure layer
// ---------------------------------------------------------------------------

describe("reshapeRgFrame", () => {
  const root = "/tmp/root";

  it("returns null for non-JSON input", () => {
    expect(reshapeRgFrame("not json", root)).toBeNull();
  });

  it("relativizes paths against the search root", () => {
    const frame = reshapeRgFrame(
      JSON.stringify({ type: "begin", data: { path: { text: "/tmp/root/src/foo.ts" } } }),
      root,
    );
    expect(frame).toEqual({ type: "begin", path: "src/foo.ts" });
  });

  it("flattens match data to {path, line, text, submatches}", () => {
    const raw = JSON.stringify({
      type: "match",
      data: {
        path: { text: "/tmp/root/src/foo.ts" },
        lines: { text: "  TODO: refactor\n" },
        line_number: 42,
        submatches: [{ match: { text: "TODO" }, start: 2, end: 6 }],
      },
    });
    expect(reshapeRgFrame(raw, root)).toEqual({
      type: "match",
      path: "src/foo.ts",
      line: 42,
      text: "  TODO: refactor\n",
      submatches: [{ start: 2, end: 6 }],
    });
  });

  it("drops rg's global summary (we emit our own)", () => {
    const raw = JSON.stringify({ type: "summary", data: { stats: { matches: 7 } } });
    expect(reshapeRgFrame(raw, root)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP layer — end-to-end against a real rg
// ---------------------------------------------------------------------------

/** Parse an NDJSON Response body into an array of frames. */
async function readNdjson(res: Response): Promise<SearchFrame[]> {
  expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SearchFrame);
}

describe("GET /api/project/:name/search", () => {
  it("404s when session is unknown", async () => {
    const app = createApp();
    const res = await app.request("/api/project/no-such-project/search?q=TODO");
    expect(res.status).toBe(404);
  });

  it("400s when q= is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/search");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing q= query parameter" });
  });

  it("400s on globs that escape the workspace", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/search?q=TODO&include=/etc/**");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Glob escapes/);
  });

  it("streams begin/match/end/summary frames for a literal match", async () => {
    if (!locateSystemRg()) return; // skip on CI without rg
    writeFileSync(join(tmpDir, "alpha.txt"), "TODO: alpha\nnot a match\nTODO: bravo\n");
    writeFileSync(join(tmpDir, "noise.txt"), "no matches here\n");

    const app = createApp();
    const res = await app.request("/api/project/test-project/search?q=TODO");
    expect(res.status).toBe(200);
    const frames = await readNdjson(res);

    const begins = frames.filter((f) => f.type === "begin");
    const matches = frames.filter((f) => f.type === "match");
    const ends = frames.filter((f) => f.type === "end");
    const summaries = frames.filter((f) => f.type === "summary");

    expect(begins.map((f) => "path" in f && f.path)).toEqual(["alpha.txt"]);
    expect(matches.map((f) => "line" in f && f.line)).toEqual([1, 3]);
    expect(matches.every((f) => "text" in f && f.text.startsWith("TODO"))).toBe(true);
    expect(matches.every((f) => "submatches" in f && f.submatches.length > 0)).toBe(true);
    expect(ends).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    const sum = summaries[0];
    if (sum?.type === "summary") {
      expect(sum.matches).toBe(2);
      expect(sum.truncated).toBe(false);
      expect(sum.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("honors include + exclude globs", async () => {
    if (!locateSystemRg()) return;
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "src", "__tests__"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "real.ts"), "TODO: keep me\n");
    writeFileSync(join(tmpDir, "src", "__tests__", "real.test.ts"), "TODO: skip me\n");

    const app = createApp();
    const res = await app.request(
      "/api/project/test-project/search?q=TODO&include=src/**&exclude=**/*.test.ts",
    );
    expect(res.status).toBe(200);
    const matches = (await readNdjson(res)).filter((f) => f.type === "match");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      type: "match",
      path: "src/real.ts",
    });
  });

  it("emits a truncated summary when maxResults is exceeded", async () => {
    if (!locateSystemRg()) return;
    let body = "";
    for (let i = 0; i < 20; i += 1) body += `TODO line ${i}\n`;
    writeFileSync(join(tmpDir, "many.txt"), body);

    const app = createApp();
    const res = await app.request("/api/project/test-project/search?q=TODO&maxResults=3");
    expect(res.status).toBe(200);
    const frames = await readNdjson(res);
    const matchCount = frames.filter((f) => f.type === "match").length;
    expect(matchCount).toBeLessThanOrEqual(4); // 3 + 1 over the cap that trips truncation
    const summary = frames.find((f) => f.type === "summary");
    if (summary?.type === "summary") {
      expect(summary.truncated).toBe(true);
    } else {
      throw new Error("expected summary frame");
    }
  });

  it("returns zero matches + summary when nothing matches", async () => {
    if (!locateSystemRg()) return;
    writeFileSync(join(tmpDir, "alpha.txt"), "nothing in here\n");

    const app = createApp();
    const res = await app.request("/api/project/test-project/search?q=nonesuch");
    expect(res.status).toBe(200);
    const frames = await readNdjson(res);
    expect(frames.filter((f) => f.type === "match")).toHaveLength(0);
    const summary = frames.find((f) => f.type === "summary");
    expect(summary).toBeDefined();
    if (summary?.type === "summary") {
      expect(summary.matches).toBe(0);
      expect(summary.truncated).toBe(false);
    }
  });

  it("supports --regex with a regex query", async () => {
    if (!locateSystemRg()) return;
    writeFileSync(join(tmpDir, "alpha.txt"), "TODO\nFIXED\nTBD\n");

    const app = createApp();
    const res = await app.request(
      `/api/project/test-project/search?q=${encodeURIComponent("^(TODO|FIXED)$")}&regex=true`,
    );
    expect(res.status).toBe(200);
    const matches = (await readNdjson(res)).filter((f) => f.type === "match");
    expect(matches).toHaveLength(2);
  });
});
