import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-backed modification dates for sitemap `<lastmod>` and `dateModified`.
 *
 * A date is the committer time of the last commit touching the given paths.
 * In a shallow clone the boundary commit looks like it touched every file, so
 * a date that comes from a boundary commit is unknown, not "now": callers omit
 * it rather than publish a date the history cannot back. Full history on the
 * build host (e.g. VERCEL_DEEP_CLONE=true) makes every date available.
 */

const docsDir = process.cwd();

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: docsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

let boundaryCommits: Set<string> | undefined;

function shallowBoundary(): Set<string> {
  if (boundaryCommits) return boundaryCommits;
  boundaryCommits = new Set();
  const shallowFile = git(["rev-parse", "--path-format=absolute", "--git-path", "shallow"]);
  if (shallowFile && existsSync(shallowFile)) {
    for (const line of readFileSync(shallowFile, "utf8").split("\n")) {
      if (line.trim()) boundaryCommits.add(line.trim());
    }
  }
  return boundaryCommits;
}

const cache = new Map<string, Date | undefined>();

/** Last commit date for paths relative to the docs package, or undefined when unknown. */
export function lastModified(paths: string[]): Date | undefined {
  const key = paths.join("\0");
  if (cache.has(key)) return cache.get(key);

  let date: Date | undefined;
  const out = git(["log", "-1", "--format=%H %cI", "--", ...paths.map((p) => resolve(docsDir, p))]);
  if (out) {
    const [hash, iso] = out.split(" ");
    const parsed = new Date(iso ?? "");
    if (hash && !shallowBoundary().has(hash) && !Number.isNaN(parsed.getTime())) date = parsed;
  }
  cache.set(key, date);
  return date;
}

/** Last commit date of a docs page, by its path inside content/docs. */
export function docLastModified(pagePath: string): Date | undefined {
  return lastModified([`content/docs/${pagePath}`]);
}

/** Sources that render the marketing homepage. */
export const HOME_SOURCES = ["app/(home)", "lib/landing-content.ts", "components/marketing"];
