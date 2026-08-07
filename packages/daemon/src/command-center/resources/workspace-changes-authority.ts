import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";

import {
  WORKSPACE_CHANGE_BRANCH_MAX_LENGTH,
  WORKSPACE_CHANGE_DIFF_MAX_HUNKS,
  WORKSPACE_CHANGE_DIFF_MAX_LINES,
  WORKSPACE_CHANGES_CATALOG_MAX_ENTRIES,
  WorkspaceChangeDiffResourceV1SchemaZ,
  WorkspaceChangeDiffUnavailableReasonSchemaZ,
  WorkspaceChangeEntrySchemaZ,
  WorkspaceChangesCatalogResourceV1SchemaZ,
  WorkspaceChangesCatalogUnavailableReasonSchemaZ,
  WorkspaceRelativeDisplayPathSchemaZ,
  type WorkspaceChangeDiffResourceV1,
  type WorkspaceChangeEntry,
  type WorkspaceChangeGroup,
  type WorkspaceChangesCatalogResourceV1,
  type WorkspaceDiffHunk,
} from "@tmux-ide/contracts";
import type { z } from "zod";

import { looksBinary } from "./workspace-files-authority.ts";
import { changeResourceId, changesRevision } from "./workspace-resource-ids.ts";
import {
  parseNumstatZ,
  parseStatusV2,
  parseUnifiedDiff,
  type NumstatEntry,
  type ParsedDiffHunk,
  type RawChange,
} from "./workspace-changes-git.ts";

type CatalogReason = z.infer<typeof WorkspaceChangesCatalogUnavailableReasonSchemaZ>;
type DiffReason = z.infer<typeof WorkspaceChangeDiffUnavailableReasonSchemaZ>;

const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const DIFF_TOTAL_LINE_BUDGET = 20_000;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

interface GitResult {
  ok: boolean;
  status: number | null;
  stdout: Buffer;
  stderr: string;
  errorCode: string | null;
}

function runGit(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    return {
      ok: false,
      status: null,
      stdout: Buffer.alloc(0),
      stderr: result.error.message,
      errorCode: (result.error as NodeJS.ErrnoException).code ?? null,
    };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf8"),
    errorCode: null,
  };
}

interface ResolvedChange {
  entry: WorkspaceChangeEntry;
  /** Repository-relative post-change path used to drive `git diff`. */
  gitPath: string;
}

interface ComputedChanges {
  branch: string | null;
  detached: boolean;
  revision: string;
  resolved: ResolvedChange[];
  totalEntries: number;
  truncated: boolean;
}

/**
 * Produces the changes catalog and per-change structured diffs for one
 * workspace root. Git is always invoked with a fixed argv array and an
 * explicit cwd (never a shell), and every path git reports is confined to the
 * workspace subtree before it is surfaced. Every failure — no repository, a
 * detached HEAD, an unknown change id, an oversized diff — maps to a typed
 * contract state rather than an exception that could leak an absolute path.
 */
export class ChangesAuthority {
  constructor(
    private readonly root: string,
    private readonly workspaceName: string,
  ) {}

  catalog(): WorkspaceChangesCatalogResourceV1 {
    const context = this.resolveRepo();
    if ("reason" in context) {
      return this.catalogUnavailable(context.reason, context.message, context.retryable);
    }
    const computed = this.computeChanges(context.root, context.repoRoot);
    if ("reason" in computed) {
      return this.catalogUnavailable(computed.reason, computed.message, computed.retryable);
    }

    const candidate = {
      status: "ready" as const,
      workspaceName: this.workspaceName,
      revision: computed.revision,
      branch: computed.detached ? null : computed.branch,
      detached: computed.detached,
      entries: computed.resolved.map((r) => r.entry),
      totalEntries: computed.totalEntries,
      truncated: computed.truncated,
    };
    const parsed = WorkspaceChangesCatalogResourceV1SchemaZ.safeParse(candidate);
    if (!parsed.success) {
      return this.catalogUnavailable("io-error", "The changes list could not be produced.");
    }
    return parsed.data;
  }

  /**
   * A cheap bounded count of working-tree changes, for the dock badge only. It
   * runs a single `git status` (no per-change numstat or diff) and applies the
   * same workspace confinement and per-group dedupe as the full catalog.
   * Returns null when the repository cannot be read so the caller can fall back
   * to a zero count rather than a fabricated one.
   */
  changeCount(): number | null {
    const context = this.resolveRepo();
    if ("reason" in context) return null;
    const status = runGit(
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      context.repoRoot,
    );
    if (!status.ok) return null;
    const parsed = parseStatusV2(status.stdout);
    const seen = new Set<string>();
    let count = 0;
    for (const raw of parsed.changes) {
      const displayPath = confineToWorkspace(context.root, context.repoRoot, raw.path);
      if (displayPath === null) continue;
      if (
        raw.originPath !== null &&
        confineToWorkspace(context.root, context.repoRoot, raw.originPath) === null
      ) {
        continue;
      }
      const key = `${raw.group} ${displayPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
      if (count >= WORKSPACE_CHANGES_CATALOG_MAX_ENTRIES) break;
    }
    return count;
  }

  diff(changeId: string): WorkspaceChangeDiffResourceV1 {
    const context = this.resolveRepo();
    if ("reason" in context) {
      return this.diffUnavailable(
        changeId,
        mapCatalogReasonToDiff(context.reason),
        context.message,
      );
    }
    const computed = this.computeChanges(context.root, context.repoRoot);
    if ("reason" in computed) {
      return this.diffUnavailable(
        changeId,
        mapCatalogReasonToDiff(computed.reason),
        computed.message,
      );
    }

    const match = computed.resolved.find((r) => r.entry.id === changeId);
    if (!match) {
      return this.diffUnavailable(changeId, "change-not-found", "The requested change is unknown.");
    }

    const base = {
      workspaceName: this.workspaceName,
      changesRevision: computed.revision,
      changeId,
      group: match.entry.group,
      relativePath: match.entry.relativePath,
      originPath: match.entry.originPath,
    };

    if (match.entry.binary) {
      return this.diffParse(changeId, {
        status: "binary",
        ...base,
        oldBytes: null,
        newBytes: null,
      });
    }

    if (match.entry.group === "untracked") {
      return this.untrackedDiff(changeId, base, resolvePath(context.repoRoot, match.gitPath));
    }

    const args =
      match.entry.group === "staged"
        ? ["diff", "--cached", "-M", "-C", "--no-color", "--", match.gitPath]
        : ["diff", "-M", "-C", "--no-color", "--", match.gitPath];
    const result = runGit(args, context.repoRoot);
    if (!result.ok) {
      return this.diffUnavailable(changeId, "io-error", "The diff could not be produced.");
    }
    if (result.stdout.length > DIFF_MAX_BYTES) {
      return this.diffParse(changeId, {
        status: "too-large",
        ...base,
        totalBytes: result.stdout.length,
        limitBytes: DIFF_MAX_BYTES,
      });
    }

    const parsed = parseUnifiedDiff(result.stdout.toString("utf8"));
    if (parsed.binary) {
      return this.diffParse(changeId, {
        status: "binary",
        ...base,
        oldBytes: null,
        newBytes: null,
      });
    }
    return this.readyDiff(changeId, base, parsed.hunks, parsed.lineTruncated);
  }

  private untrackedDiff(
    changeId: string,
    base: DiffBase,
    absPath: string,
  ): WorkspaceChangeDiffResourceV1 {
    let buffer: Buffer;
    try {
      const stat = statSync(absPath);
      if (stat.size > DIFF_MAX_BYTES) {
        return this.diffParse(changeId, {
          status: "too-large",
          ...base,
          totalBytes: stat.size,
          limitBytes: DIFF_MAX_BYTES,
        });
      }
      buffer = readFileSync(absPath);
    } catch {
      return this.diffUnavailable(changeId, "io-error", "The file could not be read.");
    }
    if (looksBinary(buffer)) {
      return this.diffParse(changeId, {
        status: "binary",
        ...base,
        oldBytes: 0,
        newBytes: buffer.length,
      });
    }

    const text = buffer.toString("utf8");
    const rawLines = text.split("\n");
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
    const synthetic: ParsedDiffHunk = {
      header: `@@ -0,0 +1,${rawLines.length} @@`,
      oldStart: 0,
      newStart: 1,
      lines: rawLines.map((content, index) => ({
        kind: "insert" as const,
        content: content.slice(0, 4096),
        oldLine: null,
        newLine: index + 1,
      })),
    };
    return this.readyDiff(changeId, base, rawLines.length === 0 ? [] : [synthetic], false);
  }

  private readyDiff(
    changeId: string,
    base: DiffBase,
    hunks: readonly ParsedDiffHunk[],
    lineTruncated: boolean,
  ): WorkspaceChangeDiffResourceV1 {
    const bounded = boundHunks(hunks);
    const candidate = {
      status: "ready" as const,
      ...base,
      hunks: bounded.hunks,
      totalHunks: hunks.length,
      totalLines: bounded.totalLines,
      truncated: bounded.truncated || lineTruncated,
    };
    return this.diffParse(changeId, candidate);
  }

  private resolveRepo():
    | { root: string; repoRoot: string }
    | { reason: CatalogReason; message: string; retryable: boolean } {
    let realRoot: string;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      return {
        reason: "workspace-unavailable",
        message: "Workspace root is unavailable.",
        retryable: true,
      };
    }
    const top = runGit(["rev-parse", "--show-toplevel"], realRoot);
    if (top.errorCode === "ENOENT") {
      return { reason: "io-error", message: "git is not available.", retryable: false };
    }
    if (top.errorCode === "EACCES" || top.errorCode === "EPERM") {
      return {
        reason: "permission-denied",
        message: "The repository cannot be read.",
        retryable: false,
      };
    }
    if (!top.ok) {
      return {
        reason: "not-a-git-repository",
        message: "The workspace is not a git repository.",
        retryable: false,
      };
    }
    const repoRoot = top.stdout.toString("utf8").trim();
    if (repoRoot.length === 0) {
      return {
        reason: "not-a-git-repository",
        message: "The workspace is not a git repository.",
        retryable: false,
      };
    }
    return { root: realRoot, repoRoot };
  }

  private computeChanges(
    realRoot: string,
    repoRoot: string,
  ): ComputedChanges | { reason: CatalogReason; message: string; retryable: boolean } {
    const status = runGit(
      ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
      repoRoot,
    );
    if (!status.ok) {
      return { reason: "io-error", message: "Change status could not be read.", retryable: true };
    }
    const parsed = parseStatusV2(status.stdout);
    const stagedNumstat = parseNumstatZ(
      runGit(["diff", "--cached", "--numstat", "-z", "-M", "-C"], repoRoot).stdout,
    );
    const unstagedNumstat = parseNumstatZ(
      runGit(["diff", "--numstat", "-z", "-M", "-C"], repoRoot).stdout,
    );

    const resolved: ResolvedChange[] = [];
    const seen = new Set<string>();
    let totalEntries = 0;

    for (const raw of parsed.changes) {
      const displayPath = confineToWorkspace(realRoot, repoRoot, raw.path);
      if (displayPath === null) continue;
      const originPath =
        raw.originPath === null ? null : confineToWorkspace(realRoot, repoRoot, raw.originPath);
      if (raw.originPath !== null && originPath === null) continue;

      const dedupeKey = `${raw.group}\u0000${displayPath}`;
      if (seen.has(dedupeKey)) continue;

      const counts = this.countsFor(raw, repoRoot, stagedNumstat, unstagedNumstat);
      const entry = buildChangeEntry(raw, displayPath, originPath, counts);
      if (entry === null) continue;

      seen.add(dedupeKey);
      totalEntries += 1;
      if (resolved.length < WORKSPACE_CHANGES_CATALOG_MAX_ENTRIES) {
        resolved.push({ entry, gitPath: raw.path });
      }
    }

    const revision = changesRevision(
      JSON.stringify({
        branch: parsed.branch,
        detached: parsed.detached,
        ids: resolved.map((r) => r.entry.id),
      }),
    );

    return {
      branch:
        parsed.branch && parsed.branch.length <= WORKSPACE_CHANGE_BRANCH_MAX_LENGTH
          ? parsed.branch
          : null,
      detached: parsed.detached,
      revision,
      resolved,
      totalEntries,
      truncated: totalEntries > resolved.length,
    };
  }

  private countsFor(
    raw: RawChange,
    repoRoot: string,
    staged: Map<string, NumstatEntry>,
    unstaged: Map<string, NumstatEntry>,
  ): NumstatEntry {
    if (raw.group === "untracked") {
      try {
        const buffer = readFileSync(resolvePath(repoRoot, raw.path));
        if (looksBinary(buffer)) return { additions: null, deletions: null, binary: true };
        const text = buffer.toString("utf8");
        const lines = text.length === 0 ? 0 : text.replace(/\n$/u, "").split("\n").length;
        return { additions: lines, deletions: 0, binary: false };
      } catch {
        return { additions: 0, deletions: 0, binary: false };
      }
    }
    const source = raw.group === "staged" ? staged : unstaged;
    return source.get(raw.path) ?? { additions: 0, deletions: 0, binary: false };
  }

  private catalogUnavailable(
    reason: CatalogReason,
    message: string,
    retryable = false,
  ): WorkspaceChangesCatalogResourceV1 {
    return WorkspaceChangesCatalogResourceV1SchemaZ.parse({
      status: "unavailable",
      workspaceName: this.workspaceName,
      reason,
      message,
      retryable,
    });
  }

  private diffUnavailable(
    changeId: string,
    reason: DiffReason,
    message: string,
    retryable = false,
  ): WorkspaceChangeDiffResourceV1 {
    return WorkspaceChangeDiffResourceV1SchemaZ.parse({
      status: "unavailable",
      workspaceName: this.workspaceName,
      changesRevision: changesRevision(`unavailable:${changeId}`),
      changeId,
      reason,
      message,
      retryable,
    });
  }

  private diffParse(changeId: string, candidate: unknown): WorkspaceChangeDiffResourceV1 {
    const parsed = WorkspaceChangeDiffResourceV1SchemaZ.safeParse(candidate);
    if (!parsed.success) {
      return this.diffUnavailable(changeId, "io-error", "The diff could not be produced.");
    }
    return parsed.data;
  }
}

interface DiffBase {
  workspaceName: string;
  changesRevision: string;
  changeId: string;
  group: WorkspaceChangeGroup;
  relativePath: string;
  originPath: string | null;
}

function mapCatalogReasonToDiff(reason: CatalogReason): DiffReason {
  switch (reason) {
    case "workspace-unavailable":
      return "workspace-unavailable";
    case "not-a-git-repository":
      return "not-a-git-repository";
    case "permission-denied":
      return "permission-denied";
    case "resource-changed":
      return "resource-changed";
    default:
      return "io-error";
  }
}

/**
 * Convert a repository-relative path to a workspace-relative display path,
 * returning null when it escapes the workspace subtree or cannot be a valid
 * display path. This is the confinement boundary for the Changes resource: a
 * change outside the workspace root is never surfaced.
 */
export function confineToWorkspace(
  realRoot: string,
  repoRoot: string,
  gitPath: string,
): string | null {
  if (gitPath.length === 0 || gitPath.includes("\0")) return null;
  const abs = resolvePath(repoRoot, gitPath);
  const rel = relative(realRoot, abs);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  const display = rel.split(/[\\/]+/u).join("/");
  return WorkspaceRelativeDisplayPathSchemaZ.safeParse(display).success ? display : null;
}

function buildChangeEntry(
  raw: RawChange,
  displayPath: string,
  originPath: string | null,
  counts: NumstatEntry,
): WorkspaceChangeEntry | null {
  const carriesOrigin = raw.status === "renamed" || raw.status === "copied";
  const candidate = {
    id: changeResourceId(raw.group, displayPath),
    group: raw.group,
    status: raw.status,
    name: basename(displayPath),
    relativePath: displayPath,
    originPath: carriesOrigin ? (originPath ?? null) : null,
    binary: counts.binary,
    additions: counts.binary ? null : (counts.additions ?? 0),
    deletions: counts.binary ? null : (counts.deletions ?? 0),
  };
  if (candidate.originPath !== null && candidate.originPath === candidate.relativePath) {
    candidate.originPath = null;
  }
  if (carriesOrigin && candidate.originPath === null) return null;
  const parsed = WorkspaceChangeEntrySchemaZ.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Apply the contract's hunk, per-hunk line, and total line caps. */
function boundHunks(hunks: readonly ParsedDiffHunk[]): {
  hunks: WorkspaceDiffHunk[];
  totalLines: number;
  truncated: boolean;
} {
  const totalLines = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const kept: WorkspaceDiffHunk[] = [];
  let rendered = 0;
  let truncated = false;

  for (const hunk of hunks) {
    if (kept.length >= WORKSPACE_CHANGE_DIFF_MAX_HUNKS) {
      truncated = true;
      break;
    }
    let lines = hunk.lines;
    if (lines.length > WORKSPACE_CHANGE_DIFF_MAX_LINES) {
      lines = lines.slice(0, WORKSPACE_CHANGE_DIFF_MAX_LINES);
      truncated = true;
    }
    if (rendered + lines.length > DIFF_TOTAL_LINE_BUDGET) {
      const room = DIFF_TOTAL_LINE_BUDGET - rendered;
      if (room <= 0) {
        truncated = true;
        break;
      }
      lines = lines.slice(0, room);
      truncated = true;
    }
    if (lines.length === 0) continue;

    const oldLines = lines.filter((l) => l.kind !== "insert").length;
    const newLines = lines.filter((l) => l.kind !== "delete").length;
    kept.push({
      header: hunk.header.slice(0, 255) || "@@",
      oldStart: oldLines > 0 ? hunk.oldStart : 0,
      oldLines,
      newStart: newLines > 0 ? hunk.newStart : 0,
      newLines,
      lines: lines.map((l) => ({ ...l })),
    });
    rendered += lines.length;
  }

  return {
    hunks: kept,
    totalLines,
    truncated: truncated || hunks.length > kept.length || totalLines > rendered,
  };
}
