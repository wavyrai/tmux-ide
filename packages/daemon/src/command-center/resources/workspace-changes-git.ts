import {
  WORKSPACE_CHANGE_DIFF_MAX_LINE_LENGTH,
  type WorkspaceChangeStatus,
} from "@tmux-ide/contracts";

/**
 * Pure parsers for git's machine-readable, NUL-delimited output. They take the
 * exact bytes git produced and never touch the filesystem or spawn a process,
 * so the fragile parsing is fully unit-testable. Every consumer drives git
 * with a fixed argv array and `-z`, so unusual filenames (spaces, newlines,
 * quotes) survive intact.
 */

/** Split a NUL-delimited buffer into UTF-8 tokens, dropping a trailing empty. */
export function splitNul(buffer: Buffer): string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) {
      tokens.push(buffer.toString("utf8", start, i));
      start = i + 1;
    }
  }
  if (start < buffer.length) tokens.push(buffer.toString("utf8", start));
  return tokens;
}

export type StatusGroup = "staged" | "unstaged" | "untracked";

export interface RawChange {
  group: StatusGroup;
  status: WorkspaceChangeStatus;
  /** Repository-relative path (the post-change name for renames/copies). */
  path: string;
  /** Repository-relative pre-change path for renames/copies, else null. */
  originPath: string | null;
}

export interface StatusV2Result {
  branch: string | null;
  detached: boolean;
  changes: RawChange[];
}

function mapStatusLetter(letter: string): WorkspaceChangeStatus | null {
  switch (letter) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      return null;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z --untracked-files=all`. A file
 * with both an index and a worktree change (e.g. `MM`) yields one staged and
 * one unstaged entry; unmerged (`u`) records map to a conflicted worktree
 * entry; `?` records map to untracked entries.
 */
export function parseStatusV2(buffer: Buffer): StatusV2Result {
  const tokens = splitNul(buffer);
  let branch: string | null = null;
  let detached = false;
  const changes: RawChange[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.length === 0) continue;

    if (token.startsWith("# ")) {
      if (token.startsWith("# branch.head ")) {
        const value = token.slice("# branch.head ".length);
        if (value === "(detached)") {
          detached = true;
          branch = null;
        } else {
          branch = value;
        }
      }
      continue;
    }

    const type = token[0];
    if (type === "1" || type === "2") {
      const fields = token.split(" ");
      const xy = fields[1] ?? "..";
      const pathFrom = type === "1" ? 8 : 9;
      const path = fields.slice(pathFrom).join(" ");
      let originPath: string | null = null;
      if (type === "2") {
        originPath = tokens[i + 1] ?? null;
        i += 1;
      }
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") {
        const status = mapStatusLetter(x);
        if (status) {
          changes.push({
            group: "staged",
            status,
            path,
            originPath: status === "renamed" || status === "copied" ? originPath : null,
          });
        }
      }
      if (y !== ".") {
        const status = mapStatusLetter(y);
        if (status) {
          changes.push({
            group: "unstaged",
            status,
            path,
            originPath: status === "renamed" || status === "copied" ? originPath : null,
          });
        }
      }
    } else if (type === "u") {
      const fields = token.split(" ");
      const path = fields.slice(10).join(" ");
      if (path.length > 0) {
        changes.push({ group: "unstaged", status: "conflicted", path, originPath: null });
      }
    } else if (type === "?") {
      const path = token.slice(2);
      if (path.length > 0) {
        changes.push({ group: "untracked", status: "untracked", path, originPath: null });
      }
    }
    // `!` (ignored) records are never requested and are ignored if present.
  }

  return { branch, detached, changes };
}

export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/**
 * Parse `git diff --numstat -z`. Entries are keyed by the post-change path.
 * A binary file is reported by git as `-\t-` and yields `binary: true` with
 * null counts.
 */
export function parseNumstatZ(buffer: Buffer): Map<string, NumstatEntry> {
  const tokens = splitNul(buffer);
  const map = new Map<string, NumstatEntry>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.length === 0) continue;
    const parts = token.split("\t");
    if (parts.length < 3) continue;
    const addRaw = parts[0]!;
    const delRaw = parts[1]!;
    const inlinePath = parts.slice(2).join("\t");

    let path: string;
    if (inlinePath.length > 0) {
      path = inlinePath;
    } else {
      // Rename/copy: the empty inline path is followed by two NUL fields
      // holding the old and new names; the new name is the key git uses.
      i += 1; // old name (unused for keying)
      path = tokens[i + 1] ?? "";
      i += 1;
      if (path.length === 0) continue;
    }

    const binary = addRaw === "-" || delRaw === "-";
    map.set(path, {
      additions: binary ? null : Number.parseInt(addRaw, 10) || 0,
      deletions: binary ? null : Number.parseInt(delRaw, 10) || 0,
      binary,
    });
  }

  return map;
}

export type DiffLineKind = "context" | "insert" | "delete";

export interface ParsedDiffLine {
  kind: DiffLineKind;
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: ParsedDiffLine[];
}

export interface ParsedDiff {
  binary: boolean;
  hunks: ParsedDiffHunk[];
  /** True when at least one line's content was clamped to the length cap. */
  lineTruncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/** Parse a unified diff patch into structured hunks with running line numbers. */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const lines = patch.split("\n");
  const hunks: ParsedDiffHunk[] = [];
  let lineTruncated = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      return { binary: true, hunks: [], lineTruncated: false };
    }
    const match = HUNK_HEADER.exec(line);
    if (!match) {
      i += 1;
      continue;
    }

    const oldStart = Number.parseInt(match[1]!, 10);
    const newStart = Number.parseInt(match[2]!, 10);
    const header = line.slice(0, 255);
    const hunkLines: ParsedDiffLine[] = [];
    let oldNo = oldStart;
    let newNo = newStart;
    i += 1;

    while (i < lines.length) {
      const raw = lines[i]!;
      if (raw.startsWith("@@") || raw.startsWith("diff --git")) break;
      if (raw.startsWith("\\")) {
        i += 1;
        continue;
      }
      const marker = raw[0];
      if (marker !== " " && marker !== "+" && marker !== "-") break;
      let content = raw.slice(1);
      if (content.length > WORKSPACE_CHANGE_DIFF_MAX_LINE_LENGTH) {
        content = content.slice(0, WORKSPACE_CHANGE_DIFF_MAX_LINE_LENGTH);
        lineTruncated = true;
      }
      if (marker === " ") {
        hunkLines.push({ kind: "context", content, oldLine: oldNo, newLine: newNo });
        oldNo += 1;
        newNo += 1;
      } else if (marker === "+") {
        hunkLines.push({ kind: "insert", content, oldLine: null, newLine: newNo });
        newNo += 1;
      } else {
        hunkLines.push({ kind: "delete", content, oldLine: oldNo, newLine: null });
        oldNo += 1;
      }
      i += 1;
    }

    if (hunkLines.length > 0) {
      hunks.push({ header: header || "@@", oldStart, newStart, lines: hunkLines });
    }
  }

  return { binary: false, hunks, lineTruncated };
}
