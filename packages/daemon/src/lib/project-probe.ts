/**
 * Project probe — inspects a directory and returns identity facts (name from
 * basename, legacy ide.yml presence, git origin/branch). Canonical path and
 * config facts delegate to project-resolver; the io functions remain
 * pluggable so tests don't need a full mock filesystem.
 *
 * All git invocations are hard-bounded by a 2s timeout — we never want a
 * single misbehaving repo to hang an HTTP request.
 */

import { basename, isAbsolute, resolve } from "node:path";
import {
  defaultProjectResolverIo,
  resolveProject,
  type ProjectConfigKind,
  type ProjectResolverIo,
} from "./project-resolver.ts";

export interface ProjectProbe {
  name: string;
  dir: string;
  hasIdeYml: boolean;
  hasWorkspaceConfig: boolean;
  configKind: ProjectConfigKind;
  configPath: string | null;
  ideConfigPath: string | null;
  gitOrigin: string | null;
  gitBranch: string | null;
}

/**
 * Pluggable io for tests. The defaults are real fs/child_process calls — pass
 * `io` overrides to drive the probe deterministically in unit tests.
 */
export interface ProbeIo {
  exists(path: string): boolean;
  runGit(args: string[], cwd: string): Promise<string | null>;
  realpath?: ProjectResolverIo["realpath"];
}

const realIo: ProbeIo = defaultProjectResolverIo;

/**
 * Replace dangerous filename characters and collapse whitespace so the
 * default `name` is safe to use as a tmux session name and a registry key.
 */
export function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^-+|-+$/g, "");
}

/**
 * Probe a directory and return its identity. Never throws — returns nulls for
 * any field that can't be determined. The caller decides what's a hard error
 * (e.g. dir doesn't exist).
 */
export async function probeProject(dir: string, io: ProbeIo = realIo): Promise<ProjectProbe> {
  const absoluteDir = isAbsolute(dir) ? dir : resolve(dir);
  const resolution = await resolveProject(dir, {
    // Existing injected ProbeIo values predate canonicalization. Treat their
    // paths as canonical unless they explicitly provide a realpath operation,
    // so the probe remains a fully injected seam rather than touching real fs.
    io: { ...io, realpath: io.realpath ?? ((path) => path) },
  });
  const rawName = basename(absoluteDir);
  const sanitized = sanitizeName(rawName);
  const name = sanitized.length > 0 ? sanitized : "project";

  const [gitOrigin, gitBranch] = await Promise.all([
    runGitSafely(io, ["config", "--get", "remote.origin.url"], absoluteDir),
    runGitSafely(io, ["branch", "--show-current"], absoluteDir),
  ]);

  return {
    name,
    // Preserve the public probe/command-center contract: this is the absolute
    // caller path, while canonical roots live on ProjectResolution.
    dir: absoluteDir,
    hasIdeYml: resolution.hasLegacyConfigAtInput,
    hasWorkspaceConfig: resolution.config.kind === "workspace",
    configKind: resolution.config.kind,
    configPath: resolution.config.path,
    ideConfigPath: resolution.legacyConfigPath,
    // Treat empty string as null — branch --show-current returns "" on a
    // detached HEAD.
    gitOrigin: gitOrigin && gitOrigin.length > 0 ? gitOrigin : null,
    gitBranch: gitBranch && gitBranch.length > 0 ? gitBranch : null,
  };
}

async function runGitSafely(io: ProbeIo, args: string[], cwd: string): Promise<string | null> {
  try {
    return await io.runGit(args, cwd);
  } catch {
    return null;
  }
}
