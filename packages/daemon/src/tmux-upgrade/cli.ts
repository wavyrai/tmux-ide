/**
 * `tmux-ide servers upgrade` (#766): flags, the `--ssh` hand-off, the detached
 * worker's `--continue`, and the exit code. The steps are in ./run.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SavedMachineSchema } from "@tmux-ide/contracts";
import { IdeError } from "../lib/errors.ts";
import { remoteTmuxIdeArgsCommand } from "../lib/remote-tmux-command.ts";
import { createUpgradeIo, parseWorkerState, writeWorkerResult, type UpgradeTarget } from "./io.ts";
import {
  finishUpgrade,
  retryCommand,
  upgradeServer,
  type UpgradeOptions,
  type UpgradeResult,
} from "./run.ts";

export interface UpgradeCliOptions extends UpgradeOptions, UpgradeTarget {
  ssh?: string;
  /** The detached worker: finish the upgrade described in this file. */
  continueFrom?: string;
  cliEntry: string;
}

/** The flags a remote run gets: the same choices, never the local socket defaults. */
export function forwardedUpgradeArgs(options: UpgradeCliOptions): string[] {
  const args: string[] = [];
  if (options.yes) args.push("--yes");
  if (options.endRunningAgents) args.push("--end-running-agents");
  if (!options.resumeAgents) args.push("--no-resume-agents");
  if (options.dryRun) args.push("--dry-run");
  if (options.json) args.push("--json");
  if (options.socketPath) args.push("--socket-path", options.socketPath);
  if (options.socketName) args.push("--socket-name", options.socketName);
  return args;
}

const EXIT: Record<UpgradeResult["status"], number> = {
  "already-full": 0,
  preview: 0,
  declined: 0,
  "handed-off": 0,
  upgraded: 0,
  refused: 1,
  failed: 1,
};

function report(result: UpgradeResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  // The plan was already printed before the question; print it here only for a preview.
  console.log(
    result.status === "preview"
      ? `${result.message}\n\nDry run: nothing was stopped.`
      : result.message,
  );
}

export async function runUpgradeCli(options: UpgradeCliOptions): Promise<void> {
  if (options.socketPath && options.socketName)
    throw new IdeError("Pass --socket-path or --socket-name, not both.", {
      code: "USAGE",
      exitCode: 2,
    });
  if (options.ssh !== undefined) {
    SavedMachineSchema.shape.sshTarget.parse(options.ssh);
    // The remote runs the same command against its own server, bundle and
    // hostname; its prompt answers here through the terminal.
    const child = spawnSync(
      "ssh",
      [
        ...(options.json ? ["-T"] : ["-t"]),
        "--",
        options.ssh,
        remoteTmuxIdeArgsCommand(["servers", "upgrade", ...forwardedUpgradeArgs(options)]),
      ],
      { stdio: "inherit" },
    );
    if (child.error) throw new IdeError("Could not start ssh.", { code: "SSH", exitCode: 1 });
    if (child.status !== 0) process.exitCode = child.status ?? 1;
    return;
  }
  if (options.continueFrom !== undefined) {
    const work = parseWorkerState(readFileSync(options.continueFrom, "utf8"));
    const io = createUpgradeIo({
      target: { socketPath: work.server.socketPath },
      cliEntry: options.cliEntry,
      json: false,
    });
    // Nothing the foreground's terminal does may stop the worker mid-restore.
    for (const signal of ["SIGHUP", "SIGINT", "SIGPIPE"] as const) process.on(signal, () => {});
    let result: UpgradeResult;
    try {
      result = await finishUpgrade(io, work);
    } catch (error) {
      result = {
        status: "failed",
        message: `${(error as Error).message} If the sessions are missing, run: ${retryCommand(work.snapshotPath, work.resumeAgents)}`,
      };
    }
    console.log(`${new Date().toISOString()} ${result.status}: ${result.message}`);
    writeWorkerResult(join(dirname(options.continueFrom), "result.json"), result);
    process.exitCode = EXIT[result.status];
    return;
  }
  const io = createUpgradeIo({
    target: { socketPath: options.socketPath, socketName: options.socketName },
    cliEntry: options.cliEntry,
    json: options.json,
  });
  const result = await upgradeServer(io, options);
  report(result, options.json);
  process.exitCode = EXIT[result.status];
}
