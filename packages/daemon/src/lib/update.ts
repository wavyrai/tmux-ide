import {
  managedInstallerPrefix,
  runManagedInstallerUpdate,
  MANAGED_INSTALLER_URL,
} from "./managed-installer-update.ts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";
import { parseStrictSemver } from "./semver.ts";
/** Origin-aware update planning; unsupported origins never fall back to npm. */
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  getCurrentVersion,
  refreshUpdateStatus,
  deriveStatus,
  updateChannel,
  type fetchLatestVersion,
  type UpdateChannel,
  type UpdateStatus,
  type UpdateStatusSource,
} from "./update-check.ts";
import { IdeError } from "./errors.ts";
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
  installerPrefix?: string;
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
  if (method === "installer") {
    const prefix = managedInstallerPrefix(input.cliPath);
    if (prefix) {
      return {
        method,
        channel,
        installerPrefix: prefix,
        command: `installer ${MANAGED_INSTALLER_URL} --prefix ${JSON.stringify(prefix)} --version ${channel}`,
        reason: `verified active managed installation (${prefix})`,
      };
    }
  }
  const guidance: Record<Exclude<InstallOrigin, PackageManager>, string> = {
    installer:
      "Rerun https://tmux-ide.com/install.sh with the same --prefix to update atomically and retain rollback. This managed release must not be modified by npm in place.",
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
  {
    current,
    latest,
    dryRun,
    source = "registry",
  }: { current: string; latest: string | null; dryRun: boolean; source?: UpdateStatusSource },
): string {
  // "Up to date" is the registry's word only; a cached answer can be weeks old.
  const status =
    latest && deriveStatus(latest, current).updateAvailable
      ? `tmux-ide v${current} → v${latest} available`
      : source === "cache"
        ? `tmux-ide v${current}: could not reach the npm registry (last known release: ${latest ? `v${latest}` : "unknown"})`
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
/** The update command prints its own failure; ours is one line, never a stack trace. */
function updateFailure(what: string, error: unknown): IdeError {
  const { status, signal, message } = error as { status?: unknown; signal?: unknown } & Error;
  const how =
    typeof status === "number"
      ? `exited with status ${status}`
      : typeof signal === "string"
        ? `was stopped by ${signal}`
        : `could not run (${String(message).split("\n")[0]})`;
  return new IdeError(
    `The update did not finish: ${what} ${how}. Its own message is above. Retry with: tmux-ide update`,
    { code: "UPDATE_FAILED", cause: error instanceof Error ? error : undefined },
  );
}
/** Does not refresh skills: the installed package's postinstall owns that step. */
export async function runUpdate(
  { cliDir, dryRun, json = false }: { cliDir: string; dryRun: boolean; json?: boolean },
  dependencies: {
    execute?: typeof execFileSync;
    query?: (executable: string, args: string[]) => string;
    currentVersion?: () => string;
    status?: (scope: {
      currentVersion: string;
    }) =>
      | (UpdateStatus & { source?: UpdateStatusSource })
      | Promise<UpdateStatus & { source?: UpdateStatusSource }>;
    fetchLatest?: typeof fetchLatestVersion;
    output?: (line: string) => void;
  } = {},
): Promise<UpdatePlan> {
  if (resolveRuntimeNamespace().development)
    throw new Error("Development instances rebuild exact artifacts; package updates are disabled");
  const current = (dependencies.currentVersion ?? getCurrentVersion)();
  const { latest, source: latestSource = "registry" } = await (
    dependencies.status ??
    ((scope) => refreshUpdateStatus({ ...scope, fetchLatest: dependencies.fetchLatest }))
  )({ currentVersion: current });
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
  if (!json) output(renderPlan(plan, { current, latest, dryRun, source: latestSource }));
  let executed = false;
  if (!dryRun && plan.executable && plan.args) {
    try {
      // argv only: paths and version metadata never become shell source.
      (dependencies.execute ?? execFileSync)(plan.executable, plan.args, {
        stdio: json ? ["ignore", 2, 2] : "inherit",
      });
    } catch (error) {
      throw updateFailure([plan.executable, ...plan.args].join(" "), error);
    }
    executed = true;
  }
  if (!dryRun && plan.installerPrefix && plan.channel) {
    try {
      runManagedInstallerUpdate(plan.installerPrefix, plan.channel, json, dependencies.execute);
    } catch (error) {
      throw updateFailure("the installer", error);
    }
    executed = true;
  }
  if (json) output(JSON.stringify({ ...plan, current, latest, latestSource, dryRun, executed }));
  return plan;
}
