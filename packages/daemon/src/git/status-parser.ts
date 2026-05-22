/**
 * Pure parser for `git status --porcelain=v2 --branch -z`. Returns a
 * FullGitStatus shape the dashboard consumes directly.
 *
 * The v2 porcelain format is whitespace-delimited per record with one
 * record per line (or NUL-delimited under `-z`). Records start with a
 * one-char kind: `#` for headers, `1` for ordinary tracked changes,
 * `2` for renamed/copied, `u` for unmerged (conflict), `?` for
 * untracked. The format is stable across git versions ≥ 2.11.
 *
 * Under `-z`, the record separator is NUL, and the rename/copy record
 * also embeds a NUL between the old path and the new path. We split
 * the buffer with a small state machine to handle that.
 */

import type { FullGitStatus, GitChange, GitChangeStatus } from "@tmux-ide/contracts";

interface ParsedRecord {
  kind: "header" | "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";
  raw: string;
  /** For renamed/copied: the original path. */
  origPath?: string;
}

/** Tokenize the NUL-delimited buffer respecting the renamed-record's
 *  embedded NUL (it's part of the record, not a separator). */
function tokenizeRecords(buf: string): ParsedRecord[] {
  const out: ParsedRecord[] = [];
  let i = 0;
  while (i < buf.length) {
    const nul = buf.indexOf("\0", i);
    if (nul === -1) {
      const tail = buf.slice(i);
      if (tail) out.push(toRecord(tail));
      break;
    }
    const record = buf.slice(i, nul);
    i = nul + 1;
    if (!record) continue;
    const rec = toRecord(record);
    // Rename/copy records (`2 ...`) have one extra NUL-delimited path
    // appended that we need to absorb before the next record.
    if (rec.kind === "renamed") {
      const orig = buf.indexOf("\0", i);
      if (orig !== -1) {
        rec.origPath = buf.slice(i, orig);
        i = orig + 1;
      }
    }
    out.push(rec);
  }
  return out;
}

function toRecord(raw: string): ParsedRecord {
  switch (raw[0]) {
    case "#":
      return { kind: "header", raw };
    case "1":
      return { kind: "ordinary", raw };
    case "2":
      return { kind: "renamed", raw };
    case "u":
      return { kind: "unmerged", raw };
    case "?":
      return { kind: "untracked", raw };
    case "!":
      return { kind: "ignored", raw };
    default:
      return { kind: "ordinary", raw };
  }
}

/** Map a porcelain v2 status letter to a GitChangeStatus. `mapStatusCode`
 *  is called per side (X or Y), so the input is a single char. */
function mapStatusCode(letter: string): GitChangeStatus {
  switch (letter) {
    case "U":
      return "conflicted";
    case "R":
    case "C":
      return "renamed";
    case "D":
      return "deleted";
    case "A":
      return "added";
    case "M":
    case "T":
      return "modified";
    default:
      return "modified";
  }
}

interface Header {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  isUnborn: boolean;
}

function parseHeaders(records: ParsedRecord[]): Header {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let isUnborn = false;
  for (const rec of records) {
    if (rec.kind !== "header") continue;
    // Header records look like:
    //   "# branch.oid <commit-id-or-'(initial)'>"
    //   "# branch.head <branch-name-or-'(detached)'>"
    //   "# branch.upstream <upstream-ref>"
    //   "# branch.ab +<ahead> -<behind>"
    const parts = rec.raw.split(" ");
    if (parts[1] === "branch.head") {
      const value = parts.slice(2).join(" ");
      if (value === "(detached)") {
        branch = null;
      } else {
        branch = value;
      }
    } else if (parts[1] === "branch.upstream") {
      upstream = parts.slice(2).join(" ") || null;
    } else if (parts[1] === "branch.ab" && parts[2] && parts[3]) {
      ahead = parseInt(parts[2].replace("+", ""), 10) || 0;
      behind = parseInt(parts[3].replace("-", ""), 10) || 0;
    } else if (parts[1] === "branch.oid" && parts[2] === "(initial)") {
      isUnborn = true;
    }
  }
  return { branch, upstream, ahead, behind, isUnborn };
}

interface ChangeBuckets {
  staged: GitChange[];
  unstaged: GitChange[];
}

function parseChanges(records: ParsedRecord[]): ChangeBuckets {
  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  for (const rec of records) {
    if (rec.kind === "ordinary") {
      // Format: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      const parts = rec.raw.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(8).join(" ");
      addBuckets(staged, unstaged, path, xy);
    } else if (rec.kind === "renamed") {
      // Format: "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>"
      // (the original path follows the NUL — already lifted into rec.origPath).
      const parts = rec.raw.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(9).join(" ");
      addBuckets(staged, unstaged, path, xy);
    } else if (rec.kind === "untracked") {
      const path = rec.raw.slice(2); // "? <path>"
      unstaged.push({ path, status: "added", additions: 0, deletions: 0 });
    } else if (rec.kind === "unmerged") {
      // Format: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      const parts = rec.raw.split(" ");
      const path = parts.slice(10).join(" ");
      const entry: GitChange = { path, status: "conflicted", additions: 0, deletions: 0 };
      unstaged.push(entry);
    }
  }
  return { staged, unstaged };
}

function addBuckets(staged: GitChange[], unstaged: GitChange[], path: string, xy: string): void {
  const X = xy[0] ?? ".";
  const Y = xy[1] ?? ".";
  if (X !== "." && X !== "?") {
    staged.push({ path, status: mapStatusCode(X), additions: 0, deletions: 0 });
  }
  if (Y !== "." && Y !== "?") {
    unstaged.push({ path, status: mapStatusCode(Y), additions: 0, deletions: 0 });
  }
}

/** Parse the output of `git status --porcelain=v2 --branch -z`. */
export function parseStatus(rawZ: string): FullGitStatus {
  const records = tokenizeRecords(rawZ);
  const header = parseHeaders(records);
  const { staged, unstaged } = parseChanges(records);
  return {
    staged,
    unstaged,
    currentBranch: header.branch,
    ahead: header.ahead,
    behind: header.behind,
    isUnborn: header.isUnborn,
    // `numstat` is plumbed separately (status -z doesn't carry add/del
    // counts). For now we leave the totals at zero — UI surfaces show
    // a separate diff endpoint when it needs per-file numbers.
    totalAdded: 0,
    totalDeleted: 0,
  };
}

/** Parse the output of `git branch --list --format='%(HEAD)\x00%(refname:short)\x00%(upstream:short)\x00%(upstream:track,nobracket)'`.
 *  Each branch is one line, fields NUL-delimited. */
export function parseBranchList(raw: string): {
  current: string | null;
  branches: Array<{
    name: string;
    isCurrent: boolean;
    upstream?: string;
    ahead?: number;
    behind?: number;
  }>;
} {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const branches: Array<{
    name: string;
    isCurrent: boolean;
    upstream?: string;
    ahead?: number;
    behind?: number;
  }> = [];
  let current: string | null = null;
  for (const line of lines) {
    const [headFlag, name, upstream, track] = line.split("\0");
    if (!name) continue;
    const isCurrent = headFlag === "*";
    const entry: {
      name: string;
      isCurrent: boolean;
      upstream?: string;
      ahead?: number;
      behind?: number;
    } = {
      name,
      isCurrent,
    };
    if (upstream) entry.upstream = upstream;
    if (track) {
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      if (ahead) entry.ahead = parseInt(ahead[1]!, 10);
      if (behind) entry.behind = parseInt(behind[1]!, 10);
    }
    if (isCurrent) current = name;
    branches.push(entry);
  }
  return { current, branches };
}

/** Parse `git remote -v` into a deduped { name, url } list. */
export function parseRemotes(raw: string): Array<{ name: string; url: string }> {
  const seen = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "<name>\t<url> (fetch|push)"
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const name = trimmed.slice(0, tab);
    const rest = trimmed.slice(tab + 1);
    const space = rest.indexOf(" ");
    const url = space === -1 ? rest : rest.slice(0, space);
    if (!seen.has(name)) seen.set(name, url);
  }
  return Array.from(seen, ([name, url]) => ({ name, url }));
}

/** Parse `git branch -r --format='%(refname:short)'` into RemoteBranch shapes. */
export function parseRemoteBranches(
  raw: string,
  remotes: Array<{ name: string; url: string }>,
): Array<{ type: "remote"; branch: string; remote: { name: string; url: string } }> {
  const out: Array<{ type: "remote"; branch: string; remote: { name: string; url: string } }> = [];
  const remoteByName = new Map(remotes.map((r) => [r.name, r] as const));
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip "origin/HEAD -> origin/main" entries — pure pointers.
    if (trimmed.includes(" -> ")) continue;
    const slash = trimmed.indexOf("/");
    if (slash === -1) continue;
    const remoteName = trimmed.slice(0, slash);
    const branch = trimmed.slice(slash + 1);
    const remote = remoteByName.get(remoteName) ?? { name: remoteName, url: "" };
    out.push({ type: "remote", branch, remote });
  }
  return out;
}
