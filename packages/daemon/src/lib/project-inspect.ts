/**
 * Project inspect — looks at an arbitrary directory and reports whether it
 * has an `ide.yml`, basic git identity, and the detected stack signals from
 * `src/detect.ts`. Crucially, this is registry-agnostic: it never touches
 * `~/.tmux-ide/projects.json`, so the dashboard can probe directories the
 * user is just considering before deciding to register them.
 *
 * The git + ide.yml bits delegate to `probeProject` so we don't duplicate
 * the timeout-bounded git invocations. The stack detection delegates to
 * `detectStack` from `src/detect.ts` so the wire format stays in sync with
 * `tmux-ide detect`.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { detectStack } from "../detect.ts";
import type { ProjectInspect, ProjectInspectDetected } from "../schemas/inspect.ts";
import { probeProject, type ProbeIo } from "./project-probe.ts";

export class InspectDirNotFoundError extends Error {
  readonly code = "DIR_NOT_FOUND";
  constructor(dir: string) {
    super(`Directory "${dir}" does not exist`);
    this.name = "InspectDirNotFoundError";
  }
}

const KNOWN_PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"] as const);

function narrowPackageManager(raw: string | null): ProjectInspectDetected["packageManager"] {
  if (!raw) return null;
  return KNOWN_PACKAGE_MANAGERS.has(raw as "pnpm") ? (raw as "pnpm") : null;
}

/**
 * Compute a sensible test command from the detected stack. We don't have a
 * dedicated test detector in `detectStack`, so we compose one from the
 * package manager — best-effort, can be edited by the user in the wizard.
 */
function inferTestCommand(packageManager: string | null): string | null {
  if (!packageManager) return null;
  return packageManager === "npm" ? "npm test" : `${packageManager} test`;
}

export interface InspectIo {
  exists?: (path: string) => boolean;
  probeIo?: ProbeIo;
}

/**
 * Inspect a directory and return identity + detected stack. Throws
 * `InspectDirNotFoundError` if the directory doesn't exist; otherwise
 * never throws (probe + detect both swallow internal failures).
 */
export async function inspectProject(dir: string, io: InspectIo = {}): Promise<ProjectInspect> {
  const exists = io.exists ?? existsSync;
  const absoluteDir = isAbsolute(dir) ? dir : resolve(dir);
  if (!exists(absoluteDir)) {
    throw new InspectDirNotFoundError(absoluteDir);
  }

  const probe = await probeProject(absoluteDir, io.probeIo);
  const stack = detectStack(absoluteDir);

  const detected: ProjectInspectDetected = {
    packageManager: narrowPackageManager(stack.packageManager),
    frameworks: stack.frameworks,
    devCommand: stack.devCommand,
    testCommand: inferTestCommand(stack.packageManager),
  };

  return {
    name: probe.name,
    dir: probe.dir,
    hasIdeYml: probe.hasIdeYml,
    hasWorkspaceConfig: probe.hasWorkspaceConfig,
    configKind: probe.configKind,
    configPath: probe.configPath,
    ideConfigPath: probe.ideConfigPath,
    gitOrigin: probe.gitOrigin,
    gitBranch: probe.gitBranch,
    detected,
  };
}
