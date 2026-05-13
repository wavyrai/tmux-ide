/**
 * Ripgrep-backed repo search (G19-P1).
 *
 * Public surface:
 *   - `resolveRipgrepPath()` — picks the binary, with env override + bundled
 *     fallback (see audit §2).
 *   - `parseSearchQuery(req)` — Zod-validated query-param decoder + glob
 *     sandboxing.
 *   - `buildRgArgs(query)` — pure: turn a validated query into rg argv.
 *   - `reshapeRgFrame(line)` — pure: rg's `--json` line → the daemon's
 *     stable NDJSON shape (see docs/goal-19-repo-search.md §1).
 *   - `runSearch(opts)` — async iterator over normalized frames; spawns rg,
 *     parses line-by-line, enforces total-match cap, kills the child on
 *     abort.
 *
 * The HTTP handler in `server.ts` wires `runSearch` to a Hono `stream(...)`
 * response with `Content-Type: application/x-ndjson`.
 *
 * Path sandboxing: callers MUST resolve the search root via
 * `realpathSync(session.dir)` before invoking. Globs are validated by
 * `parseSearchQuery` — leading `/` and `..` segments are rejected to keep
 * `--glob` from escaping the workspace.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { z } from "zod";

/** Hard ceilings — query params clamp at these. */
const MAX_RESULTS_CEILING = 10_000;
const MAX_FILESIZE_BYTES_CEILING = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_RESULTS = 1000;
const DEFAULT_MAX_FILESIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_CONTEXT = 0;
const PER_FILE_MAX_COUNT = 50;

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the ripgrep binary path. Three-tier:
 *   1. `process.env.TMUX_IDE_RIPGREP_PATH` — explicit override (used by
 *      tests and ops). When set, returned as-is (no existence check —
 *      callers handle ENOENT on spawn).
 *   2. `@vscode/ripgrep`'s `rgPath` — bundled platform binary. The
 *      package ships per-platform binaries via npm optional-deps; pnpm
 *      installs the right one for the host. When the dep resolves but
 *      the binary is missing (rare — broken postinstall), falls through
 *      to (3).
 *   3. Bare `"rg"` — defer to $PATH. Always works on macOS dev machines
 *      with Homebrew rg.
 *
 * Returns the path string. Async because step 2 requires dynamic import
 * (we don't want the bundled binary loaded at module init for callers
 * that override via env).
 */
export async function resolveRipgrepPath(): Promise<string> {
  const override = process.env["TMUX_IDE_RIPGREP_PATH"]?.trim();
  if (override) return override;

  try {
    const mod = (await import("@vscode/ripgrep")) as { rgPath: string };
    if (mod.rgPath) return mod.rgPath;
  } catch {
    // optional — fall through
  }

  return "rg";
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * Parsed + sanitized query options. Callers pass these to `buildRgArgs`.
 * Globs are split + trimmed; each segment is validated to ensure it
 * can't escape the search root.
 */
export interface SearchQuery {
  q: string;
  include: string[];
  exclude: string[];
  case: "smart" | "sensitive" | "insensitive";
  regex: boolean;
  context: number;
  maxResults: number;
  maxFileSize: number;
}

const CaseModeZ = z.enum(["smart", "sensitive", "insensitive"]).default("smart");
const BoolFlagZ = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/**
 * Decode + validate a query-param record (Hono's `c.req.query()` shape).
 * Returns either the sanitized query or a structured error frame
 * suitable for emitting on the NDJSON stream.
 */
export function parseSearchQuery(
  raw: Record<string, string | undefined>,
): { ok: true; query: SearchQuery } | { ok: false; error: string } {
  const q = (raw["q"] ?? "").trim();
  if (!q) return { ok: false, error: "Missing q= query parameter" };

  const include = splitGlobs(raw["include"]);
  const exclude = splitGlobs(raw["exclude"]);
  const bad = [...include, ...exclude].find((glob) => !isSafeGlob(glob));
  if (bad) return { ok: false, error: `Glob escapes workspace: ${bad}` };

  const caseMode = CaseModeZ.safeParse(raw["case"]);
  const regex = BoolFlagZ.safeParse(raw["regex"]);
  const context = clampInt(raw["context"], 0, 10, DEFAULT_CONTEXT);
  const maxResults = clampInt(raw["maxResults"], 1, MAX_RESULTS_CEILING, DEFAULT_MAX_RESULTS);
  const maxFileSize = clampInt(
    raw["maxFileSize"],
    1024,
    MAX_FILESIZE_BYTES_CEILING,
    DEFAULT_MAX_FILESIZE_BYTES,
  );

  return {
    ok: true,
    query: {
      q,
      include,
      exclude,
      case: caseMode.success ? caseMode.data : "smart",
      regex: regex.success ? regex.data : false,
      context,
      maxResults,
      maxFileSize,
    },
  };
}

function splitGlobs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * A glob is safe when:
 *   - it doesn't start with `/` (absolute escape),
 *   - no segment is exactly `..` (parent escape).
 * `**`, `*`, `?`, `[…]` are allowed — they're ripgrep glob syntax, not
 * path traversal.
 */
function isSafeGlob(glob: string): boolean {
  if (!glob) return false;
  if (glob.startsWith("/")) return false;
  const segs = glob.split("/");
  return !segs.some((seg) => seg === "..");
}

function clampInt(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ---------------------------------------------------------------------------
// Argv builder
// ---------------------------------------------------------------------------

/**
 * Build the `rg` argv for a validated query. Pure — no IO. The search
 * root is the only positional path; everything else flows through flags
 * so a malicious glob can't break out (rg refuses absolute-path globs
 * by design but we double-check in `parseSearchQuery`).
 *
 * The caller passes `searchRoot` separately because the daemon resolves
 * it via `realpathSync(session.dir)` for sandboxing — keeping that
 * outside this pure builder makes the unit tests trivial.
 */
export function buildRgArgs(query: SearchQuery, searchRoot: string): string[] {
  const args: string[] = [
    "--json",
    `--max-count=${PER_FILE_MAX_COUNT}`,
    `--max-filesize=${query.maxFileSize}`,
    "--hidden",
    "--no-messages",
    "--color=never",
  ];

  switch (query.case) {
    case "sensitive":
      args.push("--case-sensitive");
      break;
    case "insensitive":
      args.push("--ignore-case");
      break;
    case "smart":
      args.push("--smart-case");
      break;
  }

  if (query.context > 0) {
    args.push(`--context=${query.context}`);
  }

  for (const include of query.include) {
    args.push("--glob", include);
  }
  for (const exclude of query.exclude) {
    args.push("--glob", `!${exclude}`);
  }

  if (query.regex) {
    args.push("--regexp", query.q);
  } else {
    args.push("--fixed-strings", query.q);
  }

  args.push("--", searchRoot);
  return args;
}

// ---------------------------------------------------------------------------
// NDJSON frame shapes (public to renderers + contracts tests)
// ---------------------------------------------------------------------------

export type SearchFrame =
  | { type: "begin"; path: string }
  | {
      type: "match";
      path: string;
      line: number;
      text: string;
      submatches: Array<{ start: number; end: number }>;
    }
  | {
      type: "context";
      path: string;
      line: number;
      text: string;
    }
  | { type: "end"; path: string }
  | {
      type: "summary";
      matches: number;
      filesSearched: number;
      elapsedMs: number;
      truncated: boolean;
    }
  | { type: "error"; message: string; fatal: boolean };

/**
 * Reshape one raw rg `--json` line into the daemon's stable NDJSON
 * frame. Returns `null` for frame types we don't surface (e.g. the
 * trailing `{"type":"summary"}` global summary that's redundant once
 * we've already emitted per-file ends).
 *
 * Strips the search-root prefix from paths so the renderer sees
 * workspace-relative paths only.
 *
 * Pure — pinned by unit tests.
 */
export function reshapeRgFrame(line: string, searchRoot: string): SearchFrame | null {
  let raw: RgRawFrame;
  try {
    raw = JSON.parse(line) as RgRawFrame;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !("type" in raw)) return null;

  switch (raw.type) {
    case "begin":
      return { type: "begin", path: relativizePath(raw.data?.path?.text ?? "", searchRoot) };
    case "match": {
      const rel = relativizePath(raw.data?.path?.text ?? "", searchRoot);
      const text = raw.data?.lines?.text ?? "";
      const submatches = (raw.data?.submatches ?? []).map((sm) => ({
        start: sm.start,
        end: sm.end,
      }));
      return {
        type: "match",
        path: rel,
        line: raw.data?.line_number ?? 0,
        text,
        submatches,
      };
    }
    case "context":
      return {
        type: "context",
        path: relativizePath(raw.data?.path?.text ?? "", searchRoot),
        line: raw.data?.line_number ?? 0,
        text: raw.data?.lines?.text ?? "",
      };
    case "end":
      return { type: "end", path: relativizePath(raw.data?.path?.text ?? "", searchRoot) };
    case "summary":
      // The per-file end frame already carries per-file stats; the
      // global summary is redundant. The handler emits its own summary
      // (with the truncated flag) once the stream completes.
      return null;
    default:
      return null;
  }
}

function relativizePath(absolute: string, searchRoot: string): string {
  if (!absolute) return "";
  if (absolute === searchRoot) return ".";
  const prefix = searchRoot.endsWith("/") ? searchRoot : searchRoot + "/";
  return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute;
}

interface RgRawFrame {
  type: "begin" | "match" | "context" | "end" | "summary";
  data?: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    submatches?: Array<{ match?: { text: string }; start: number; end: number }>;
  };
}

// ---------------------------------------------------------------------------
// runSearch — spawn + parse + emit
// ---------------------------------------------------------------------------

export interface RunSearchOpts {
  rgPath: string;
  query: SearchQuery;
  /** Already-sandboxed absolute path (caller does `realpathSync(session.dir)`). */
  searchRoot: string;
  /** Aborted by Hono `stream.onAbort(...)` when the client disconnects. */
  signal: AbortSignal;
  /** Test seam — defaults to `spawn` from node:child_process. */
  spawn?: typeof spawn;
}

/**
 * Async generator yielding `SearchFrame`s. The handler pipes each frame
 * to the response as one NDJSON line.
 *
 * Lifecycle:
 *   - On spawn failure (rg binary missing / ENOENT), yields one
 *     `{type: 'error', fatal: true}` and returns.
 *   - On non-zero exit with no matches, yields nothing extra — the
 *     summary frame at the end is sufficient. Non-zero with stderr
 *     output (regex syntax error, etc.) yields a fatal error frame.
 *   - When `signal` aborts mid-stream, sends SIGTERM to the child and
 *     stops yielding. Any partial output is dropped.
 *   - Enforces the total-match cap (`query.maxResults`). On hit, kills
 *     the child and yields a summary with `truncated: true`.
 */
export async function* runSearch(opts: RunSearchOpts): AsyncGenerator<SearchFrame> {
  const args = buildRgArgs(opts.query, opts.searchRoot);
  const spawnFn = opts.spawn ?? spawn;
  const startedAt = Date.now();

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawnFn(opts.rgPath, args, {
      cwd: opts.searchRoot,
      stdio: ["ignore", "pipe", "pipe"],
      // Don't inherit env beyond what rg actually needs; rg only reads
      // a couple of vars and a clean env is cheaper / more predictable.
      env: { PATH: process.env["PATH"] ?? "" },
    }) as ChildProcessByStdio<null, Readable, Readable>;
  } catch (err) {
    yield {
      type: "error",
      message: err instanceof Error ? err.message : "Failed to spawn ripgrep",
      fatal: true,
    };
    return;
  }

  const onAbort = (): void => {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // child already exited
      }
    }
  };
  opts.signal.addEventListener("abort", onAbort);

  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });

  let filesSearched = 0;
  let matches = 0;
  let truncated = false;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (opts.signal.aborted) break;
      const frame = reshapeRgFrame(line, opts.searchRoot);
      if (!frame) continue;
      if (frame.type === "begin") filesSearched += 1;
      if (frame.type === "match") {
        matches += 1;
        if (matches > opts.query.maxResults) {
          truncated = true;
          if (!child.killed) child.kill("SIGTERM");
          break;
        }
      }
      yield frame;
    }
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    rl.close();
  }

  // Drain the child so the OS doesn't accumulate zombies. Best-effort.
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
    },
  );

  // rg exit codes: 0 = matches found, 1 = no matches, 2 = error.
  // SIGTERM after a maxResults trip is also "fine" — the cap is the
  // contract, not an error to surface.
  const aborted = opts.signal.aborted;
  if (exit.code === 2 && !aborted && !truncated) {
    yield {
      type: "error",
      message: stderr.trim() || "ripgrep exited with code 2",
      fatal: true,
    };
    return;
  }

  if (aborted) return;

  yield {
    type: "summary",
    matches,
    filesSearched,
    elapsedMs: Date.now() - startedAt,
    truncated,
  };
}
