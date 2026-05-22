/**
 * Filesystem browsing for the dashboard's directory picker.
 *
 * Two responsibilities:
 *   1. Sandbox enforcement — the daemon refuses to list anything outside the
 *      user's home or the platform-conventional roots (/Users, /home,
 *      /Volumes). Never trust the client to limit paths.
 *   2. Entry classification — directories first, then files; alphabetical
 *      within group; symlinks resolved once to determine target kind.
 *
 * The io functions are pluggable for tests so we don't need a full mock
 * filesystem.
 */

import { realpathSync, readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import type { FilesystemBrowseResult, FilesystemEntry } from "../schemas/filesystem.ts";

/** Root directories the sandbox allows in addition to the user's home. */
const ALLOWED_PLATFORM_ROOTS = ["/Users", "/home", "/Volumes"] as const;

/** Per-entry stat budget. Slow network mounts get skipped silently. */
const STAT_BUDGET_MS = 100;

export class SandboxViolationError extends Error {
  readonly code = "outside-sandbox";
  constructor(path: string) {
    super(`Path "${path}" is outside the allowed sandbox`);
    this.name = "SandboxViolationError";
  }
}

export class PathNotFoundError extends Error {
  readonly code = "not-found";
  constructor(path: string) {
    super(`Path "${path}" does not exist`);
    this.name = "PathNotFoundError";
  }
}

export class InvalidPathError extends Error {
  readonly code = "invalid-path";
  constructor(message: string) {
    super(message);
    this.name = "InvalidPathError";
  }
}

export interface BrowseIo {
  /** `fs.realpathSync`. Throws if the path doesn't exist. */
  realpath(path: string): string;
  /** `fs.statSync`. Used to follow symlinks once when classifying. */
  stat(path: string): { isDirectory(): boolean };
  /** `fs.readdirSync(path, { withFileTypes: true })`. */
  readdir(path: string): Dirent[];
  /** `os.homedir()`. */
  home(): string;
  /** Wall-clock; injectable for tests and for the per-entry stat budget. */
  now(): number;
}

/**
 * Resolve the user's home directory. Honors `TMUX_IDE_HOME_OVERRIDE` so
 * tests can pin a temp directory without depending on `os.homedir()` (some
 * runtimes — bun in particular — cache the value at startup and do not
 * pick up later `process.env.HOME` mutations).
 */
function resolveHome(): string {
  const override = process.env.TMUX_IDE_HOME_OVERRIDE;
  if (override && override.trim().length > 0) return override;
  return homedir();
}

const realIo: BrowseIo = {
  realpath: realpathSync,
  stat: statSync,
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  home: resolveHome,
  now: () => Date.now(),
};

export interface BrowseInput {
  /** Absolute path to list. Empty/missing → home. */
  path?: string | null | undefined;
  /** When true, return entries whose names start with `.`. */
  showHidden?: boolean;
}

/**
 * Validate an input path before passing to realpath. We reject obvious
 * traversal attempts and non-absolute paths so error messages stay clean.
 * `~` and `~/...` expand to the user's home directory so the dialog's
 * "Home" quick-jump (and any caller that hands us a tilde-prefixed path)
 * doesn't trip the absolute-path check.
 */
function preflight(rawPath: string, io: BrowseIo): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new InvalidPathError("Path must not be empty");
  }
  if (trimmed.includes("\0")) {
    throw new InvalidPathError("Path contains a null byte");
  }
  let candidate = trimmed;
  if (candidate === "~") {
    candidate = io.home();
  } else if (candidate.startsWith("~/")) {
    candidate = join(io.home(), candidate.slice(2));
  }
  if (!isAbsolute(candidate)) {
    throw new InvalidPathError("Path must be absolute");
  }
  // Collapse `..` and `.` early so the realpath call has a clean input.
  return resolve(candidate);
}

/**
 * Returns true iff `canonical` is the allowed root or strictly under it.
 * Both arguments must be canonical (already realpath'd) and absolute.
 */
function isUnderRoot(canonical: string, root: string): boolean {
  if (canonical === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return canonical.startsWith(prefix);
}

/**
 * Sandbox check: the canonical path must live inside the user's home OR
 * one of the platform-conventional public roots. Anything else throws.
 *
 * Exposed for tests; do NOT skip this from the route handler.
 */
export function assertInsideSandbox(canonical: string, home: string): void {
  if (isUnderRoot(canonical, home)) return;
  for (const root of ALLOWED_PLATFORM_ROOTS) {
    if (isUnderRoot(canonical, root)) return;
  }
  throw new SandboxViolationError(canonical);
}

/**
 * Compute the parent directory path for browse navigation. Returns null
 * when the parent would escape the sandbox, so the UI can disable the
 * back button.
 */
export function computeParentPath(canonical: string, home: string): string | null {
  // `path.resolve` collapses trailing separators; never returns an empty
  // string, which means "/" maps to "/".
  if (canonical === "/" || canonical === sep) return null;

  const parent = resolve(canonical, "..");
  if (parent === canonical) return null;

  try {
    assertInsideSandbox(parent, home);
  } catch {
    return null;
  }
  return parent;
}

/**
 * Sort dirs first, files second; case-insensitive alphabetical within group.
 * Stable: returns a new array, doesn't mutate input.
 */
export function sortEntries(entries: ReadonlyArray<FilesystemEntry>): FilesystemEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

interface ClassifyResult {
  entry: FilesystemEntry | null;
}

/**
 * Convert a single dirent to a `FilesystemEntry`. Symlinks are followed
 * exactly once via `stat` so we can mark `isDir` correctly. Per-entry stat
 * is bounded by `STAT_BUDGET_MS`; entries that exceed it are dropped.
 *
 * Exposed for tests.
 */
export function classifyDirent(dirent: Dirent, fullPath: string, io: BrowseIo): ClassifyResult {
  const isSymlink = dirent.isSymbolicLink();
  if (!isSymlink) {
    return {
      entry: {
        name: dirent.name,
        fullPath,
        isDir: dirent.isDirectory(),
        isSymlink: false,
      },
    };
  }

  // Follow symlinks once. Slow network mounts get a short stat budget and
  // skip silently if exceeded.
  const start = io.now();
  let isDir: boolean;
  try {
    const stat = io.stat(fullPath);
    if (io.now() - start > STAT_BUDGET_MS) {
      return { entry: null };
    }
    isDir = stat.isDirectory();
  } catch {
    // Broken symlink — keep it as a non-directory entry so the UI can
    // still show it, but mark accordingly.
    return {
      entry: {
        name: dirent.name,
        fullPath,
        isDir: false,
        isSymlink: true,
      },
    };
  }

  return {
    entry: {
      name: dirent.name,
      fullPath,
      isDir,
      isSymlink: true,
    },
  };
}

/**
 * Browse a directory. Returns canonical path + entries + parent.
 *
 * @throws {InvalidPathError}  Bad input (empty, relative, null bytes).
 * @throws {PathNotFoundError} Path doesn't exist (realpath failed).
 * @throws {SandboxViolationError} Path resolves outside the allowed sandbox.
 */
export function browseDirectory(input: BrowseInput, io: BrowseIo = realIo): FilesystemBrowseResult {
  const home = io.home();
  const requestedPath = input.path?.trim() ? input.path.trim() : home;

  let preflightPath: string;
  try {
    preflightPath = preflight(requestedPath, io);
  } catch (err) {
    if (err instanceof InvalidPathError) throw err;
    throw new InvalidPathError("Invalid path");
  }

  let canonical: string;
  try {
    canonical = io.realpath(preflightPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new PathNotFoundError(preflightPath);
    }
    throw err;
  }

  assertInsideSandbox(canonical, home);

  let dirents: Dirent[];
  try {
    dirents = io.readdir(canonical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new PathNotFoundError(canonical);
    }
    if (code === "ENOTDIR") {
      throw new InvalidPathError(`"${canonical}" is not a directory`);
    }
    throw err;
  }

  const showHidden = Boolean(input.showHidden);
  const entries: FilesystemEntry[] = [];
  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith(".")) continue;
    const fullPath = join(canonical, dirent.name);
    const { entry } = classifyDirent(dirent, fullPath, io);
    if (entry !== null) entries.push(entry);
  }

  return {
    path: canonical,
    parentPath: computeParentPath(canonical, home),
    entries: sortEntries(entries),
  };
}
