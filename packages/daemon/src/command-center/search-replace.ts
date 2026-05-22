/**
 * Search-replace handler — applies offset-based replacements to files
 * inside a session, with an mtime guard to detect "file modified
 * since the search snapshot".
 *
 * Wire: `POST /api/project/:name/search/replace` calls
 * `executeReplace(sessionDir, body)` and returns the result envelope.
 *
 * Why offset-based (not regex re-run): the search panel already knows
 * exactly which (line, column, length) ranges matched. Re-running the
 * regex per file would (a) cost CPU, (b) risk subtly different matches
 * when the file shifted between search and replace. Offset-based
 * replacement is dumb + safe — the only failure mode is "file shifted
 * since search" which the mtime guard rejects.
 *
 * Limitations:
 *   - No capture-group expansion: `$1`/`$2` in the replacement string
 *     pass through literally. This trades regex power for safety; the
 *     audit (§4) flags it as a known scope cut. Future iteration can
 *     add a `regex: true` branch that re-runs the regex per match
 *     site.
 *   - Not atomic across files: partial failure is possible (file 3
 *     skipped because it changed mid-flight). The per-file `skipped`
 *     array surfaces this; the UI re-runs search to reconcile.
 */

import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------
// Request / response schemas (pinned in tests).
// ---------------------------------------------------------------------

const ReplacementZ = z
  .object({
    line: z.number().int().min(1),
    column: z.number().int().min(0),
    length: z.number().int().min(0),
  })
  .strict();

const FileTargetZ = z
  .object({
    path: z.string().min(1),
    expectedMtimeMs: z.number().int().nonnegative().optional(),
    replacements: z.array(ReplacementZ).min(1),
  })
  .strict();

export const ReplaceRequestZ = z
  .object({
    query: z.string(),
    regex: z.boolean().default(false),
    caseMode: z.enum(["smart", "sensitive", "insensitive"]).default("smart"),
    replacement: z.string(),
    files: z.array(FileTargetZ).min(1),
  })
  .strict();

export type ReplaceRequest = z.infer<typeof ReplaceRequestZ>;

export interface ReplaceResult {
  filesUpdated: number;
  matchesReplaced: number;
  skipped: Array<{ path: string; reason: ReplaceSkipReason; details?: string }>;
}

export type ReplaceSkipReason =
  | "file_modified_since_search"
  | "path_escapes_workspace"
  | "file_not_found"
  | "read_failed"
  | "out_of_bounds"
  | "write_failed";

// ---------------------------------------------------------------------
// Path sandbox
// ---------------------------------------------------------------------

/**
 * Resolve a workspace-relative path against `sessionDir`, refusing
 * absolute paths or `..` segments. Mirrors the validator on
 * `/api/project/:name/git/file`.
 */
export function resolveSandboxedPath(sessionDir: string, relPath: string): string | null {
  if (!relPath) return null;
  if (relPath.startsWith("/")) return null;
  if (relPath.split("/").some((seg) => seg === "..")) return null;
  const resolved = pathResolve(sessionDir, relPath);
  const root = sessionDir.endsWith("/") ? sessionDir : sessionDir + "/";
  if (!(resolved === sessionDir || resolved.startsWith(root))) return null;
  return resolved;
}

// ---------------------------------------------------------------------
// Per-file replacement
// ---------------------------------------------------------------------

/**
 * Apply the request's replacements to a single file. Pure of any
 * filesystem effect — takes the current content + a list of
 * line/column/length triples + the replacement string, returns the
 * new content (or an error reason). Exported for unit tests.
 *
 * Replacements are applied last-line-first then last-column-first so
 * earlier offsets remain valid as later ones rewrite the text.
 */
export function applyReplacementsToContent(
  content: string,
  replacements: ReadonlyArray<{ line: number; column: number; length: number }>,
  replacement: string,
): { ok: true; content: string; replaced: number } | { ok: false; reason: "out_of_bounds" } {
  const lines = content.split("\n");
  const sorted = [...replacements].sort((a, b) => {
    if (a.line !== b.line) return b.line - a.line;
    return b.column - a.column;
  });
  let replaced = 0;
  for (const r of sorted) {
    if (r.line < 1 || r.line > lines.length) return { ok: false, reason: "out_of_bounds" };
    const lineIndex = r.line - 1;
    const original = lines[lineIndex] ?? "";
    if (r.column < 0 || r.column + r.length > original.length) {
      return { ok: false, reason: "out_of_bounds" };
    }
    lines[lineIndex] =
      original.slice(0, r.column) + replacement + original.slice(r.column + r.length);
    replaced += 1;
  }
  return { ok: true, content: lines.join("\n"), replaced };
}

/**
 * Atomic write: write to `<path>.tmp.<pid>.<rand>` then rename. Same
 * pattern as the rest of the daemon's filesystem writes.
 */
function writeAtomic(target: string, content: string): void {
  const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf-8" });
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw err;
  }
}

// ---------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------

export interface ExecuteReplaceDeps {
  /** Mtime-tolerance window. The audit warns that disk mtimes have
   *  millisecond resolution; some filesystems quantize. Allow ±10ms
   *  to absorb that without losing the race-detection contract. */
  mtimeToleranceMs?: number;
}

const DEFAULT_MTIME_TOLERANCE_MS = 10;

export function executeReplace(
  sessionDir: string,
  body: ReplaceRequest,
  deps: ExecuteReplaceDeps = {},
): ReplaceResult {
  const tolerance = deps.mtimeToleranceMs ?? DEFAULT_MTIME_TOLERANCE_MS;
  let filesUpdated = 0;
  let matchesReplaced = 0;
  const skipped: ReplaceResult["skipped"] = [];

  for (const file of body.files) {
    const target = resolveSandboxedPath(sessionDir, file.path);
    if (!target) {
      skipped.push({ path: file.path, reason: "path_escapes_workspace" });
      continue;
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(target);
    } catch {
      skipped.push({ path: file.path, reason: "file_not_found" });
      continue;
    }

    if (file.expectedMtimeMs !== undefined) {
      const drift = Math.abs(stat.mtimeMs - file.expectedMtimeMs);
      if (drift > tolerance) {
        skipped.push({
          path: file.path,
          reason: "file_modified_since_search",
          details: `mtime drift ${drift.toFixed(0)}ms`,
        });
        continue;
      }
    }

    let original: string;
    try {
      original = readFileSync(target, "utf-8");
    } catch (err) {
      skipped.push({
        path: file.path,
        reason: "read_failed",
        details: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const applied = applyReplacementsToContent(original, file.replacements, body.replacement);
    if (!applied.ok) {
      skipped.push({ path: file.path, reason: applied.reason });
      continue;
    }

    try {
      // Ensure parent directory exists (it should — we just statSync'd
      // the target — but be defensive against TOCTOU races where the
      // file is moved between stat and write).
      const parent = dirname(target);
      if (!parent) {
        skipped.push({ path: file.path, reason: "write_failed" });
        continue;
      }
      writeAtomic(target, applied.content);
    } catch (err) {
      skipped.push({
        path: file.path,
        reason: "write_failed",
        details: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    filesUpdated += 1;
    matchesReplaced += applied.replaced;
  }

  return { filesUpdated, matchesReplaced, skipped };
}
