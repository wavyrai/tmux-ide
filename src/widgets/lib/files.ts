import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";

const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  "coverage",
  ".nyc_output",
  "target",
  "vendor",
  "bower_components",
]);

export { type Ignore };

export interface FileEntry {
  name: string;
  path: string; // relative to root
  absolutePath: string;
  isDir: boolean;
  ignored: boolean; // gitignored
}

export function createIgnoreFilter(rootDir: string): Ignore {
  const ig = ignore();
  const gitignorePath = join(rootDir, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }
  return ig;
}

export function readDirectory(
  dir: string,
  rootDir: string,
  ig: Ignore,
  showHidden: boolean,
  showIgnored: boolean = false,
): FileEntry[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => {
      if (ALWAYS_IGNORE.has(e.name)) return false;
      if (!showHidden && e.name.startsWith(".")) return false;
      if (showIgnored) return true;
      const rel = relative(rootDir, join(dir, e.name));
      try {
        return !ig.ignores(e.isDirectory() ? rel + "/" : rel);
      } catch {
        return true;
      }
    })
    .map((e) => {
      const rel = relative(rootDir, join(dir, e.name));
      let isIgnored = false;
      try {
        isIgnored = ig.ignores(e.isDirectory() ? rel + "/" : rel);
      } catch {
        // ignore malformed paths for ignore rules
      }
      return {
        name: e.name,
        path: rel,
        absolutePath: join(dir, e.name),
        isDir: e.isDirectory(),
        ignored: isIgnored,
      };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
