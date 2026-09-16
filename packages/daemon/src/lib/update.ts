import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import { parseStrictSemver } from "./semver.ts";
/** Origin-aware update planning; unsupported origins never fall back to npm. */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  getCurrentVersion,
  getUpdateStatus,
  deriveStatus,
  updateChannel,
  type UpdateChannel,
} from "./update-check.ts";
import {
  installOrigin,
  detectPackageManager,
  findGitCheckoutRoot,
  type InstallOrigin,
} from "./install-origin.ts";
export { detectPackageManager, findGitCheckoutRoot };
export type PackageManager = "npm" | "pnpm" | "bun";
export interface UpdatePlan {
  method: InstallOrigin;
  command: string | null;
  reason: string;
  channel?: UpdateChannel;
  executable?: PackageManager;
  args?: string[];
  guidance?: string;
  proposedCommand?: string;
}
export const UPDATE_COMMANDS: Record<PackageManager, string> = {
  npm: "npm install -g tmux-ide@latest",
  pnpm: "pnpm add -g tmux-ide@latest",
  bun: "bun add -g tmux-ide@latest",
};
export function planUpdate(input: {
  cliPath: string;
  gitRoot: string | null;
  currentVersion?: string;
}): UpdatePlan {
  const current = input.currentVersion ?? getCurrentVersion();
  const method = input.gitRoot ? "dev" : detectPackageManager(input.cliPath);
  if (!parseStrictSemver(current)) {
    return {
      method,
      command: null,
      reason: "Running version is unknown or invalid.",
      guidance:
        "Cannot infer a safe update channel. Update explicitly using the original installation method and intended release channel.",
    };
  }
  const channel = updateChannel(current);
  if (method === "npm" || method === "pnpm" || method === "bun") {
    const args = [method === "npm" ? "install" : "add", "-g", `tmux-ide@${channel}`];
    return {
      method,
      command: [method, ...args].join(" "),
      executable: method,
      args,
      channel,
      reason: `global ${method} layout (${input.cliPath})`,
    };
  }
  const guidance: Record<Exclude<InstallOrigin, PackageManager>, string> = {
    dev: "Update this checkout with git pull, then follow its build instructions.",
    homebrew: "Update with brew upgrade tmux-ide (using the tap/formula you installed).",
    yarn: `Update this Yarn global installation with yarn global add tmux-ide@${channel}.`,
    npx: `Run npx tmux-ide@${channel}; this cached invocation is not a global install.`,
    unknown: "Install origin is unknown. Update using the original installation method.",
  };
  return {
    method,
    command: null,
    channel,
    reason: input.gitRoot ? `git checkout at ${input.gitRoot}` : `installation at ${input.cliPath}`,
    guidance: guidance[method],
  };
}
export function renderPlan(
  plan: UpdatePlan,
  { current, latest, dryRun }: { current: string; latest: string | null; dryRun: boolean },
): string {
  const status =
    latest && deriveStatus(latest, current).updateAvailable
      ? `tmux-ide v${current} → v${latest} available`
      : latest
        ? `tmux-ide v${current} is up to date (registry: v${latest})`
        : `tmux-ide v${current} (latest version unknown)`;
  return [
    status,
    "",
    plan.command
      ? `${dryRun ? "Would run" : "Running"}: ${plan.command}`
      : (plan.guidance ?? "Update this checkout with git pull."),
    `(${plan.reason})`,
    "",
    "After updating, relaunch the app. Use tmux-ide update --daemon to replace a running daemon with installed code.",
  ].join("\n");
}
/** Does not refresh skills: the installed package's postinstall owns that step. */
export function runUpdate(
  { cliDir, dryRun, json = false }: { cliDir: string; dryRun: boolean; json?: boolean },
  dependencies: {
    execute?: typeof execFileSync;
    query?: (executable: string, args: string[]) => string;
    currentVersion?: () => string;
    status?: typeof getUpdateStatus;
    output?: (line: string) => void;
  } = {},
): UpdatePlan {
  if (resolveRuntimeNamespace().development)
    throw new Error("Development instances rebuild exact artifacts; package updates are disabled");
  const current = (dependencies.currentVersion ?? getCurrentVersion)();
  const { latest } = (dependencies.status ?? getUpdateStatus)({ currentVersion: current });
  const source = installOrigin(cliDir);
  let plan: UpdatePlan =
    source.origin === "unknown"
      ? {
          method: "unknown" as const,
          command: null,
          channel: updateChannel(current),
          reason: `unverified installation (${source.path})`,
          guidance: "Install origin is unknown. Update using the original installation method.",
        }
      : planUpdate({ cliPath: source.path, gitRoot: source.gitRoot, currentVersion: current });
  if (plan.executable) {
    try {
      const query =
        dependencies.query ??
        ((executable: string, args: string[]) =>
          execFileSync(executable, args, {
            encoding: "utf8",
            timeout: 3000,
            maxBuffer: 65536,
            stdio: ["ignore", "pipe", "pipe"],
          }));
      const root = query(
        plan.executable,
        plan.executable === "bun" ? ["pm", "bin", "-g"] : ["root", "-g"],
      ).trim();
      if (!root.startsWith("/")) throw new Error("invalid manager path");
      const target =
        plan.executable === "bun"
          ? dirname(realpathSync(join(root, "tmux-ide")))
          : realpathSync(join(root, "tmux-ide", "bin"));
      if (target !== source.path) throw new Error("different installation");
    } catch {
      plan = {
        ...plan,
        proposedCommand: plan.command ?? undefined,
        command: null,
        executable: undefined,
        args: undefined,
        guidance:
          "The active package manager does not resolve to this installation. Select the original manager/prefix and retry; no automatic update was run.",
      };
    }
  }
  const output = dependencies.output ?? console.log;
  if (!json) output(renderPlan(plan, { current, latest, dryRun }));
  let executed = false;
  if (!dryRun && plan.executable && plan.args) {
    // argv only: paths and version metadata never become shell source.
    (dependencies.execute ?? execFileSync)(plan.executable, plan.args, {
      stdio: json ? ["ignore", 2, 2] : "inherit",
    });
    executed = true;
  }
  if (json) output(JSON.stringify({ ...plan, current, latest, dryRun, executed }));
  return plan;
}
