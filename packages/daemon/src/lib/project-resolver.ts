/**
 * Canonical project identity and configuration discovery.
 *
 * A working tree keeps its own project root, while linked Git worktrees share
 * an identity through Git's common directory. Non-Git projects use the root
 * selected by their nearest config (or the canonical input directory when no
 * config exists). All filesystem and process I/O is injectable for focused,
 * deterministic tests.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GIT_TIMEOUT_MS = 2_000;

export type ProjectIdentitySource = "git-common-dir" | "canonical-realpath";
export type ProjectConfigKind = "workspace" | "legacy" | "none";

export type ProjectConfigSource =
  | { kind: "workspace" | "legacy"; path: string; explicit: boolean }
  | { kind: "none"; path: null; explicit: false };

export interface ProjectResolution {
  /** Canonical form of the directory supplied by the caller. */
  inputDir: string;
  /** Canonical root of this checkout/config project. Linked worktrees differ here. */
  projectRoot: string;
  /** Filesystem-safe stable key for user-scoped project state. */
  identityKey: string;
  /** The rule used to derive `identityKey`. */
  identitySource: ProjectIdentitySource;
  /** Canonical path hashed into `identityKey`. Useful for diagnostics/relinking. */
  identityAnchor: string;
  /** Winning declarative config source after applying precedence. */
  config: ProjectConfigSource;
  /** Nearest workspace candidate, even when an explicit path wins. */
  workspaceConfigPath: string | null;
  /** Nearest legacy candidate, even when a workspace/explicit path wins. */
  legacyConfigPath: string | null;
  /** Compatibility fact used by the existing project-probe wire contract. */
  hasLegacyConfigAtInput: boolean;
}

export interface ProjectResolverIo {
  exists(path: string): boolean;
  realpath(path: string): string;
  runGit(args: string[], cwd: string): Promise<string | null>;
}

export interface ResolveProjectOptions {
  /** Caller-selected config. Relative paths resolve from the canonical input directory. */
  explicitConfigPath?: string | null;
  /** Override any subset of filesystem/process operations. */
  io?: Partial<ProjectResolverIo>;
}

export const defaultProjectResolverIo: ProjectResolverIo = {
  exists: existsSync,
  realpath: realpathSync,
  runGit: (args, cwd) =>
    new Promise((resolveResult) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        {
          encoding: "utf-8",
          maxBuffer: 64 * 1024,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            resolveResult(null);
            return;
          }
          resolveResult(stdout.trim());
        },
      );
    }),
};

interface DiscoveredConfigs {
  workspacePath: string | null;
  legacyPath: string | null;
  hasLegacyAtInput: boolean;
}

function safeExists(path: string, io: ProjectResolverIo): boolean {
  try {
    return io.exists(path);
  } catch {
    return false;
  }
}

/** Canonicalize when possible and retain a deterministic absolute fallback. */
function canonicalize(path: string, io: ProjectResolverIo): string {
  const absolute = resolve(path);
  try {
    return io.realpath(absolute);
  } catch {
    return absolute;
  }
}

/** Git-derived paths must exist so malformed output never becomes an identity. */
function canonicalizeGitPath(path: string, io: ProjectResolverIo): string | null {
  try {
    return io.realpath(resolve(path));
  } catch {
    return null;
  }
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

async function resolveGitPath(
  args: string[],
  cwd: string,
  allowRelative: boolean,
  io: ProjectResolverIo,
): Promise<string | null> {
  let output: string | null;
  try {
    output = await io.runGit(args, cwd);
  } catch {
    return null;
  }
  if (!output) return null;

  const path = output.trim();
  if (path.length === 0 || path.includes("\0") || /[\r\n]/.test(path)) return null;
  if (!isAbsolute(path) && !allowRelative) return null;

  return canonicalizeGitPath(isAbsolute(path) ? path : resolve(cwd, path), io);
}

function discoverConfigs(
  inputDir: string,
  gitProjectRoot: string | null,
  io: ProjectResolverIo,
): DiscoveredConfigs {
  let current = inputDir;
  let workspacePath: string | null = null;
  let legacyPath: string | null = null;
  let hasLegacyAtInput = false;

  while (true) {
    const workspaceCandidate = join(current, ".tmux-ide", "workspace.yml");
    const legacyCandidate = join(current, "ide.yml");

    if (!workspacePath && safeExists(workspaceCandidate, io)) {
      workspacePath = canonicalize(workspaceCandidate, io);
    }
    if (!legacyPath && safeExists(legacyCandidate, io)) {
      legacyPath = canonicalize(legacyCandidate, io);
      hasLegacyAtInput = current === inputDir;
    }

    if (workspacePath && legacyPath) break;
    if (gitProjectRoot && current === gitProjectRoot) break;

    const parent = dirname(current);
    if (parent === current) break;
    if (gitProjectRoot && !isWithin(parent, gitProjectRoot)) break;
    current = parent;
  }

  return { workspacePath, legacyPath, hasLegacyAtInput };
}

function explicitConfigSource(
  explicitPath: string,
  inputDir: string,
  io: ProjectResolverIo,
): ProjectConfigSource {
  const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(inputDir, explicitPath);
  const path = canonicalize(absolute, io);
  return {
    kind: basename(path) === "ide.yml" ? "legacy" : "workspace",
    path,
    explicit: true,
  };
}

function chooseConfig(
  explicitPath: string | null | undefined,
  inputDir: string,
  discovered: DiscoveredConfigs,
  io: ProjectResolverIo,
): ProjectConfigSource {
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitConfigSource(explicitPath, inputDir, io);
  }
  if (discovered.workspacePath) {
    return { kind: "workspace", path: discovered.workspacePath, explicit: false };
  }
  if (discovered.legacyPath) {
    return { kind: "legacy", path: discovered.legacyPath, explicit: false };
  }
  return { kind: "none", path: null, explicit: false };
}

function configProjectRoot(config: ProjectConfigSource, inputDir: string): string {
  if (config.kind === "none") return inputDir;
  const configDir = dirname(config.path);
  if (config.kind === "workspace" && basename(configDir) === ".tmux-ide") {
    return dirname(configDir);
  }
  return configDir;
}

function projectIdentityKey(source: ProjectIdentitySource, anchor: string): string {
  const prefix = source === "git-common-dir" ? "git" : "path";
  const digest = createHash("sha256").update(source).update("\0").update(anchor).digest("hex");
  return `${prefix}-${digest}`;
}

/**
 * Resolve the canonical project root, shared identity, and winning config for
 * `dir`. Git failures (including missing executables and malformed output)
 * degrade to canonical-realpath identity without throwing.
 */
export async function resolveProject(
  dir: string,
  options: ResolveProjectOptions = {},
): Promise<ProjectResolution> {
  const io: ProjectResolverIo = { ...defaultProjectResolverIo, ...options.io };
  const inputDir = canonicalize(dir, io);

  const gitTopLevel = await resolveGitPath(["rev-parse", "--show-toplevel"], inputDir, false, io);
  const gitProjectRoot = gitTopLevel && isWithin(inputDir, gitTopLevel) ? gitTopLevel : null;

  const gitCommonDir = gitProjectRoot
    ? await resolveGitPath(["rev-parse", "--git-common-dir"], gitProjectRoot, true, io)
    : null;

  const discovered = discoverConfigs(inputDir, gitProjectRoot, io);
  const config = chooseConfig(options.explicitConfigPath, inputDir, discovered, io);
  const projectRoot = gitProjectRoot ?? configProjectRoot(config, inputDir);
  const identitySource: ProjectIdentitySource = gitCommonDir
    ? "git-common-dir"
    : "canonical-realpath";
  const identityAnchor = gitCommonDir ?? projectRoot;

  return {
    inputDir,
    projectRoot,
    identityKey: projectIdentityKey(identitySource, identityAnchor),
    identitySource,
    identityAnchor,
    config,
    workspaceConfigPath: discovered.workspacePath,
    legacyConfigPath: discovered.legacyPath,
    hasLegacyConfigAtInput: discovered.hasLegacyAtInput,
  };
}
