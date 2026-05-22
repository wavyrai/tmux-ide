/**
 * Tests for the search-replace handler (G19-P2).
 *
 * Covers:
 *   - applyReplacementsToContent: pure last-offset-first ordering;
 *     multi-match per line; out-of-bounds rejection.
 *   - executeReplace: mtime guard, path sandboxing, file_not_found,
 *     read/write success paths.
 *   - HTTP layer end-to-end through createApp().
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setTmuxRunner } from "./discovery.ts";
import {
  applyReplacementsToContent,
  executeReplace,
  resolveSandboxedPath,
} from "./search-replace.ts";
import { createApp } from "./server.ts";
import { makePane } from "../__tests__/support.ts";

let tmpDir: string;
let restoreExec: () => void;
let restoreTmux: () => void;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "tmux-ide-replace-test-")));
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
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  restoreExec?.();
  restoreTmux?.();
});

// ---------------------------------------------------------------------
// applyReplacementsToContent — pure
// ---------------------------------------------------------------------

describe("applyReplacementsToContent", () => {
  it("replaces a single match at the recorded offset", () => {
    const out = applyReplacementsToContent(
      "TODO: alpha\nplain line\n",
      [{ line: 1, column: 0, length: 4 }],
      "FIXED",
    );
    expect(out).toEqual({ ok: true, content: "FIXED: alpha\nplain line\n", replaced: 1 });
  });

  it("handles multiple matches on the same line right-to-left", () => {
    const out = applyReplacementsToContent(
      "foo foo foo\n",
      [
        { line: 1, column: 0, length: 3 },
        { line: 1, column: 4, length: 3 },
        { line: 1, column: 8, length: 3 },
      ],
      "BAR",
    );
    expect(out).toEqual({ ok: true, content: "BAR BAR BAR\n", replaced: 3 });
  });

  it("processes multiple lines without offset drift", () => {
    const out = applyReplacementsToContent(
      "alpha\nbeta\ngamma\n",
      [
        { line: 1, column: 0, length: 5 },
        { line: 3, column: 0, length: 5 },
      ],
      "X",
    );
    expect(out).toEqual({ ok: true, content: "X\nbeta\nX\n", replaced: 2 });
  });

  it("rejects out-of-bounds line numbers", () => {
    const out = applyReplacementsToContent(
      "only one line\n",
      [{ line: 5, column: 0, length: 1 }],
      "y",
    );
    expect(out).toEqual({ ok: false, reason: "out_of_bounds" });
  });

  it("rejects column + length past the end of the line", () => {
    const out = applyReplacementsToContent("short\n", [{ line: 1, column: 3, length: 99 }], "y");
    expect(out).toEqual({ ok: false, reason: "out_of_bounds" });
  });
});

// ---------------------------------------------------------------------
// resolveSandboxedPath
// ---------------------------------------------------------------------

describe("resolveSandboxedPath", () => {
  it("accepts plain relative paths", () => {
    expect(resolveSandboxedPath("/tmp/proj", "src/foo.ts")).toBe("/tmp/proj/src/foo.ts");
  });

  it("rejects absolute paths", () => {
    expect(resolveSandboxedPath("/tmp/proj", "/etc/passwd")).toBeNull();
  });

  it("rejects .. segments", () => {
    expect(resolveSandboxedPath("/tmp/proj", "../etc/passwd")).toBeNull();
    expect(resolveSandboxedPath("/tmp/proj", "src/../../etc")).toBeNull();
  });
});

// ---------------------------------------------------------------------
// executeReplace — filesystem
// ---------------------------------------------------------------------

describe("executeReplace", () => {
  it("writes the new content and counts matches", () => {
    writeFileSync(join(tmpDir, "alpha.txt"), "TODO: one\nTODO: two\n");
    const result = executeReplace(tmpDir, {
      query: "TODO",
      regex: false,
      caseMode: "smart",
      replacement: "FIXED",
      files: [
        {
          path: "alpha.txt",
          replacements: [
            { line: 1, column: 0, length: 4 },
            { line: 2, column: 0, length: 4 },
          ],
        },
      ],
    });
    expect(result.filesUpdated).toBe(1);
    expect(result.matchesReplaced).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(join(tmpDir, "alpha.txt"), "utf-8")).toBe("FIXED: one\nFIXED: two\n");
  });

  it("skips files modified after the search snapshot (mtime guard)", () => {
    writeFileSync(join(tmpDir, "alpha.txt"), "TODO: alpha\n");
    // Anchor "snapshot" at an mtime well before now.
    const snapshotMs = Date.now() - 60_000;
    const result = executeReplace(tmpDir, {
      query: "TODO",
      regex: false,
      caseMode: "smart",
      replacement: "FIXED",
      files: [
        {
          path: "alpha.txt",
          expectedMtimeMs: snapshotMs,
          replacements: [{ line: 1, column: 0, length: 4 }],
        },
      ],
    });
    expect(result.filesUpdated).toBe(0);
    expect(result.matchesReplaced).toBe(0);
    expect(result.skipped).toEqual([
      {
        path: "alpha.txt",
        reason: "file_modified_since_search",
        details: expect.stringMatching(/mtime drift/),
      },
    ]);
    expect(readFileSync(join(tmpDir, "alpha.txt"), "utf-8")).toBe("TODO: alpha\n");
  });

  it("accepts when expectedMtimeMs matches (within tolerance)", () => {
    writeFileSync(join(tmpDir, "alpha.txt"), "TODO: alpha\n");
    // Pin mtime to a known instant.
    const now = new Date();
    utimesSync(join(tmpDir, "alpha.txt"), now, now);
    const result = executeReplace(tmpDir, {
      query: "TODO",
      regex: false,
      caseMode: "smart",
      replacement: "FIXED",
      files: [
        {
          path: "alpha.txt",
          expectedMtimeMs: now.getTime(),
          replacements: [{ line: 1, column: 0, length: 4 }],
        },
      ],
    });
    expect(result.filesUpdated).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it("skips files that don't exist", () => {
    const result = executeReplace(tmpDir, {
      query: "TODO",
      regex: false,
      caseMode: "smart",
      replacement: "FIXED",
      files: [
        {
          path: "missing.txt",
          replacements: [{ line: 1, column: 0, length: 4 }],
        },
      ],
    });
    expect(result.filesUpdated).toBe(0);
    expect(result.skipped).toEqual([{ path: "missing.txt", reason: "file_not_found" }]);
  });

  it("refuses paths that escape the workspace", () => {
    const result = executeReplace(tmpDir, {
      query: "TODO",
      regex: false,
      caseMode: "smart",
      replacement: "FIXED",
      files: [
        {
          path: "../etc/passwd",
          replacements: [{ line: 1, column: 0, length: 4 }],
        },
      ],
    });
    expect(result.filesUpdated).toBe(0);
    expect(result.skipped).toEqual([{ path: "../etc/passwd", reason: "path_escapes_workspace" }]);
  });

  it("processes a partial success — one file replaced, one skipped", () => {
    writeFileSync(join(tmpDir, "a.txt"), "TODO\n");
    writeFileSync(join(tmpDir, "b.txt"), "TODO\n");
    const future = Date.now() - 60_000;
    const result = executeReplace(tmpDir, {
      query: "TODO",
      regex: false,
      caseMode: "smart",
      replacement: "X",
      files: [
        {
          path: "a.txt",
          replacements: [{ line: 1, column: 0, length: 4 }],
        },
        {
          path: "b.txt",
          expectedMtimeMs: future,
          replacements: [{ line: 1, column: 0, length: 4 }],
        },
      ],
    });
    expect(result.filesUpdated).toBe(1);
    expect(result.matchesReplaced).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toBe("b.txt");
    expect(readFileSync(join(tmpDir, "a.txt"), "utf-8")).toBe("X\n");
    expect(readFileSync(join(tmpDir, "b.txt"), "utf-8")).toBe("TODO\n");
  });
});

// ---------------------------------------------------------------------
// HTTP route — end-to-end through createApp
// ---------------------------------------------------------------------

describe("POST /api/project/:name/search/replace", () => {
  it("404s when session is unknown", async () => {
    const app = createApp();
    const res = await app.request("/api/project/no-such/search/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "TODO",
        replacement: "X",
        files: [{ path: "a.txt", replacements: [{ line: 1, column: 0, length: 4 }] }],
      }),
    });
    expect(res.status).toBe(404);
  });

  it("400s on invalid JSON", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/search/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("400s on missing required fields", async () => {
    const app = createApp();
    const res = await app.request("/api/project/test-project/search/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "TODO" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("Invalid replace request");
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("writes the new content end-to-end through Hono", async () => {
    writeFileSync(join(tmpDir, "alpha.txt"), "TODO: alpha\nTODO: bravo\n");
    const app = createApp();
    const res = await app.request("/api/project/test-project/search/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "TODO",
        replacement: "FIXED",
        files: [
          {
            path: "alpha.txt",
            replacements: [
              { line: 1, column: 0, length: 4 },
              { line: 2, column: 0, length: 4 },
            ],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      filesUpdated: 1,
      matchesReplaced: 2,
      skipped: [],
    });
    expect(readFileSync(join(tmpDir, "alpha.txt"), "utf-8")).toBe("FIXED: alpha\nFIXED: bravo\n");
  });
});
