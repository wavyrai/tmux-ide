/**
 * Project probe — inspects a directory and returns identity facts (name from
 * basename, ide.yml presence, git origin/branch). Pure-ish wrapper over a few
 * filesystem and git child-process calls; the io functions are pluggable for
 * tests so we don't need a full mock filesystem.
 *
 * All git invocations are hard-bounded by a 2s timeout — we never want a
 * single misbehaving repo to hang an HTTP request.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const GIT_TIMEOUT_MS = 2_000;

export interface ProjectProbe {
  name: string;
  dir: string;
  hasIdeYml: boolean;
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
}

const realIo: ProbeIo = {
  exists: existsSync,
  runGit: (args, cwd) =>
    new Promise((resolveResult) => {
      execFile(
        "git",
        ["-C", cwd, ...args],
        { timeout: GIT_TIMEOUT_MS, encoding: "utf-8" },
        (err, stdout) => {
          if (err) {
            resolveResult(null);
            return;
          }
          resolveResult(stdout.trim());
        },
      );
    }),
};

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
  const rawName = basename(absoluteDir);
  const sanitized = sanitizeName(rawName);
  const name = sanitized.length > 0 ? sanitized : "project";

  const hasIdeYml = io.exists(`${absoluteDir}/ide.yml`);

  const [gitOrigin, gitBranch] = await Promise.all([
    io.runGit(["config", "--get", "remote.origin.url"], absoluteDir),
    io.runGit(["branch", "--show-current"], absoluteDir),
  ]);

  return {
    name,
    dir: absoluteDir,
    hasIdeYml,
    // Treat empty string as null — branch --show-current returns "" on a
    // detached HEAD.
    gitOrigin: gitOrigin && gitOrigin.length > 0 ? gitOrigin : null,
    gitBranch: gitBranch && gitBranch.length > 0 ? gitBranch : null,
  };
}
