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
      const rel = relative(rootDir, join(dir, e.name));
      try {
        return !ig.ignores(e.isDirectory() ? rel + "/" : rel);
      } catch {
        return true;
      }
    })
    .map((e) => ({
      name: e.name,
      path: relative(rootDir, join(dir, e.name)),
      absolutePath: join(dir, e.name),
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}
