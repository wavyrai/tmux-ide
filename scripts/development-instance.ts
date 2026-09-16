import {
  developmentDiagnostics,
  developmentLogs,
} from "../packages/daemon/src/lib/development-diagnostics.ts";
import {
  DevelopmentOperationError,
  developmentFailureResult,
} from "../packages/daemon/src/lib/development-state.ts";
import type { DevelopmentInstance } from "../packages/daemon/src/lib/development-instance.ts";
/** Worktree-local development manager. No installed executable discovery or source TUI fallback. */
import { parseArgs } from "node:util";
import { launchDevelopmentApp } from "../packages/daemon/src/lib/development-app.ts";
import {
  discoverDevelopmentWorktree,
  resolveDevelopmentInstance,
} from "../packages/daemon/src/lib/development-instance.ts";
import {
  statusDevelopmentInstance,
  upDevelopmentInstance,
} from "../packages/daemon/src/lib/development-lifecycle.ts";
import {
  selectRecordedDevelopmentInstance,
  listDevelopmentInstances,
  developmentWorktreeState,
} from "../packages/daemon/src/lib/development-selection.ts";
import {
  restartDevelopmentInstance,
  downDevelopmentInstance,
  resetDevelopmentInstance,
} from "../packages/daemon/src/lib/development-control.ts";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    id: { type: "string" },
    yes: { type: "boolean" },
    "daemon-only": { type: "boolean" },
    "apply-build": { type: "boolean" },
    name: { type: "string" },
    store: { type: "string" },
    worktree: { type: "string" },
  },
});
const command = positionals[0];
if (
  positionals.length !== 1 ||
  !["up", "app", "status", "list", "restart", "down", "reset", "diagnostics", "logs"].includes(
    command ?? "",
  )
)
  throw new Error(
    "Usage: pnpm dev:instance up|app|status|list|restart|down|reset|diagnostics|logs [--json] [--id id | --name name --worktree path] [--store absolute-path]",
  );
if (
  values.id &&
  (values.name !== undefined ||
    values.worktree !== undefined ||
    ["up", "app", "list"].includes(command!))
)
  throw new Error(
    "--id selects a stored instance only for status/restart/down/reset/diagnostics/logs; it cannot combine with --name/--worktree",
  );
if (
  (values["daemon-only"] && command !== "down") ||
  (values.yes && command !== "reset") ||
  (values["apply-build"] && command !== "restart")
)
  throw new Error("Lifecycle option does not apply to this command");
let selectedInstance: DevelopmentInstance | undefined;
let selectionComplete = false;
try {
  if (command === "list") {
    if (values.name !== undefined || values.worktree !== undefined)
      throw new Error("list selects a store, not a worktree/name");
    process.stdout.write(`${JSON.stringify(await listDevelopmentInstances(values.store))}\n`);
    process.exit(0);
  }
  const instance = values.id
    ? await selectRecordedDevelopmentInstance(values.id, values.store)
    : resolveDevelopmentInstance({
        worktree: discoverDevelopmentWorktree(values.worktree ?? process.cwd()),
        name: values.name,
        store: values.store,
      });
  selectedInstance = instance;
  selectionComplete = true;
  if (command === "diagnostics" || command === "logs") {
    const result =
      command === "diagnostics"
        ? await developmentDiagnostics(instance)
        : await developmentLogs(instance);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "app") {
    if (values.json)
      throw new Error("app is interactive; use status --json for an inspection receipt");
    const admitted = await launchDevelopmentApp(instance);
    const child = admitted.child;
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const interrupt = forward("SIGINT");
    const terminate = forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      process.exitCode = await admitted.completion;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      await admitted.release();
    }
  } else if (command === "restart" || command === "down" || command === "reset") {
    const result =
      command === "restart"
        ? await restartDevelopmentInstance(instance, { applyBuild: values["apply-build"] })
        : command === "down"
          ? await downDevelopmentInstance(instance, { daemonOnly: values["daemon-only"] })
          : await resetDevelopmentInstance(instance, { yes: values.yes });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const status =
      command === "up"
        ? await upDevelopmentInstance(instance)
        : await statusDevelopmentInstance(instance, { allowOrphan: Boolean(values.id) });
    const result = { ...status, worktreeState: await developmentWorktreeState(instance) };
    process.stdout.write(
      values.json
        ? `${JSON.stringify(result)}\n`
        : `${status.instance.id}: ${status.state}${status.reason ? ` (${status.reason})` : ""}\nOwner log: ${status.logs.owner}\n`,
    );
    if (status.state === "blocked") process.exitCode = 1;
  }
} catch (error) {
  const failure = developmentFailureResult(
    command!,
    error,
    selectedInstance,
    selectionComplete ? "operation-failed" : "identity-unavailable",
  );
  if (values.json) process.stdout.write(`${JSON.stringify(failure)}\n`);
  else
    process.stderr.write(
      `${error instanceof DevelopmentOperationError ? error.message : `Development ${command} failed (${failure.reason}); inspect private instance records`}\n`,
    );
  process.exitCode = 1;
}
