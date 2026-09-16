/** Worktree-local development manager. No installed executable discovery or source TUI fallback. */
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import {
  discoverDevelopmentWorktree,
  resolveDevelopmentInstance,
} from "../packages/daemon/src/lib/development-instance.ts";
import {
  statusDevelopmentInstance,
  upDevelopmentInstance,
  developmentAppLaunch,
} from "../packages/daemon/src/lib/development-lifecycle.ts";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    name: { type: "string" },
    store: { type: "string" },
    worktree: { type: "string" },
  },
});
const command = positionals[0];
if (positionals.length !== 1 || !["up", "app", "status"].includes(command ?? ""))
  throw new Error(
    "Usage: pnpm dev:instance up|app|status [--json] [--name name] [--store absolute-path] [--worktree path]",
  );
const instance = resolveDevelopmentInstance({
  worktree: discoverDevelopmentWorktree(values.worktree ?? process.cwd()),
  name: values.name,
  store: values.store,
});
try {
  if (command === "app") {
    if (values.json)
      throw new Error("app is interactive; use status --json for an inspection receipt");
    const launch = await developmentAppLaunch(instance);
    const child = spawn(launch.bin, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: "inherit",
    });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const interrupt = forward("SIGINT");
    const terminate = forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          process.exitCode = code ?? 1;
          resolve();
        });
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } else {
    const status =
      command === "up"
        ? await upDevelopmentInstance(instance)
        : await statusDevelopmentInstance(instance);
    process.stdout.write(
      values.json
        ? `${JSON.stringify(status)}\n`
        : `${status.instance.id}: ${status.state}${status.reason ? ` (${status.reason})` : ""}\nOwner log: ${status.logs.owner}\n`,
    );
    if (status.state === "blocked") process.exitCode = 1;
  }
} catch (error) {
  if (values.json)
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: "DEVELOPMENT_INSTANCE_FAILED", instanceId: instance.id, receipt: `${instance.root}/startup-receipt.json` })}\n`,
    );
  else
    process.stderr.write(
      `${error instanceof Error ? error.message : "Development instance failed"}\n`,
    );
  process.exitCode = 1;
}
