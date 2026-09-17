import { launchDevelopmentContainerApp } from "../packages/daemon/src/lib/development-container-app.ts";
import { developmentContainer } from "../packages/daemon/src/lib/development-container.ts";
import { resolveDevelopmentComposeProject } from "../packages/daemon/src/lib/development-compose.ts";
import {
  developmentSshAuthority,
  developmentSshHandshake,
} from "../packages/daemon/src/lib/development-ssh.ts";
import { readPrivateDevelopmentFile } from "../packages/daemon/src/lib/development-state.ts";
import { validateDevelopmentDirectory } from "../packages/daemon/src/lib/development-instance.ts";
import {
  buildDevelopmentInstance,
  developmentBuildChanges,
} from "../packages/daemon/src/lib/development-build-manager.ts";
import {
  readDevelopmentBuild,
  developmentBuildLaunch,
  type DevelopmentBuildManifest,
} from "../packages/daemon/src/lib/development-build.ts";
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
    container: { type: "boolean" },
    resume: { type: "boolean" },
    "container-image": { type: "string" },
    "container-source": { type: "string" },
    "ssh-describe": { type: "boolean" },
    id: { type: "string" },
    yes: { type: "boolean" },
    "daemon-only": { type: "boolean" },
    "apply-build": { type: "boolean" },
    previous: { type: "boolean" },
    bun: { type: "string" },
    name: { type: "string" },
    store: { type: "string" },
    worktree: { type: "string" },
  },
});
const command = positionals[0];
if (
  positionals.length !== 1 ||
  ![
    "up",
    "app",
    "status",
    "list",
    "restart",
    "down",
    "reset",
    "diagnostics",
    "logs",
    "rebuild",
    "ssh-info",
  ].includes(command ?? "")
)
  throw new Error(
    "Usage: pnpm dev:instance up|app|status|list|restart|down|reset|diagnostics|logs|rebuild [--json] [--id id | --name name --worktree path] [--store absolute-path]",
  );
if (
  values.id &&
  (values.name !== undefined ||
    values.worktree !== undefined ||
    ["up", "app", "list", "rebuild"].includes(command!))
)
  throw new Error(
    "--id selects a stored instance only for status/restart/down/reset/diagnostics/logs; it cannot combine with --name/--worktree",
  );
if (
  (values["daemon-only"] && command !== "down") ||
  (values.yes && command !== "reset") ||
  (values["apply-build"] && command !== "restart") ||
  (values.previous && (command !== "restart" || !values["apply-build"])) ||
  (values.bun && command !== "rebuild" && !(values.container && command === "app")) ||
  (values["ssh-describe"] && command !== "ssh-info") ||
  (command === "ssh-info" && (!values.json || values.id))
)
  throw new Error("Lifecycle option does not apply to this command");
if (values.container) {
  if (
    !["up", "status", "logs", "down", "app"].includes(command!) ||
    values.id ||
    values.yes ||
    values["daemon-only"] ||
    values["apply-build"] ||
    values.previous ||
    (values.bun && command !== "app") ||
    (command === "app" && values.json) ||
    values["ssh-describe"] ||
    (command !== "up" && (values.resume || values["container-image"] || values["container-source"]))
  )
    throw new Error(
      "Container mode supports up/status/logs/down/app; --resume and image/source pins apply only to up",
    );
  const cancellation = new AbortController();
  let cancelledExit = 130;
  const abort = () => cancellation.abort();
  const terminate = () => {
    cancelledExit = 143;
    cancellation.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", terminate);
  try {
    const project = resolveDevelopmentComposeProject({
      worktree: discoverDevelopmentWorktree(values.worktree ?? process.cwd()),
      name: values.name,
      store: values.store,
    });
    if (command === "app") {
      const admitted = await launchDevelopmentContainerApp(project, {
        bun: values.bun,
        signal: cancellation.signal,
      });
      const interrupt = () => admitted.child.kill("SIGINT"),
        terminateChild = () => admitted.child.kill("SIGTERM");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminateChild);
      try {
        if (cancellation.signal.aborted) admitted.child.kill("SIGTERM");
        process.exitCode = await admitted.completion;
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminateChild);
        try {
          await admitted.release();
        } finally {
          process.stderr.write(
            `Native client owner retained after exit: ${JSON.stringify(admitted.nativeClient)}\n`,
          );
        }
      }
    } else {
      const result = await developmentContainer(
        project,
        command as "up" | "status" | "logs" | "down",
        {
          image: values["container-image"],
          source: values["container-source"],
          resume: values.resume,
          signal: cancellation.signal,
        },
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    const suspended =
      error instanceof DevelopmentOperationError && error.reason === "instance-suspended";
    const missingBuild =
      error instanceof DevelopmentOperationError && error.reason === "build-failed";
    const sink = command === "app" ? process.stderr : process.stdout;
    sink.write(
      `${JSON.stringify({ version: 1, mode: "container", operation: command, code: "DEVELOPMENT_CONTAINER_UNAVAILABLE", reason: suspended ? "instance-suspended" : missingBuild ? "build-failed" : "container-transition-refused", next: suspended ? "Use up --container --resume" : missingBuild ? "First native client build requires app --container --bun /absolute/pinned/bun; inspect its private build receipt on failure" : "Inspect private project transition evidence" })}\n`,
    );
    process.exitCode = 1;
  }
  process.off("SIGINT", abort);
  process.off("SIGTERM", terminate);
  process.exit(cancellation.signal.aborted ? cancelledExit : (process.exitCode ?? 0));
}
if (values.resume || values["container-image"] || values["container-source"])
  throw new Error("Container options require --container");
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
  if (command === "ssh-info") {
    if (values["ssh-describe"]) {
      process.stdout.write(`${JSON.stringify((await developmentSshAuthority(instance)).lease)}\n`);
    } else {
      validateDevelopmentDirectory("/state/ssh", "/state/ssh");
      const file = readPrivateDevelopmentFile("/state/ssh/lease.json");
      if (!file) throw new Error("SSH fixture lease is unavailable");
      let lease: unknown;
      try {
        lease = JSON.parse(file.bytes.toString("utf8"));
      } catch {
        throw new Error("SSH fixture lease is invalid");
      }
      process.stdout.write(await developmentSshHandshake(instance, lease));
    }
  } else if (command === "diagnostics" || command === "logs") {
    const result =
      command === "diagnostics"
        ? await developmentDiagnostics(instance)
        : await developmentLogs(instance);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === "rebuild") {
    let previousBuild: DevelopmentBuildManifest | null = null;
    try {
      previousBuild = readDevelopmentBuild(instance, {});
    } catch {
      /* First build or unavailable compiler provenance. */
    }
    const bun = values.bun ?? previousBuild?.tools.bun;
    if (!bun)
      throw new DevelopmentOperationError(
        "build-failed",
        "rebuild requires --bun /absolute/pinned/bun for the first build",
      );
    let built: DevelopmentBuildManifest;
    try {
      built = await buildDevelopmentInstance(instance, { bun });
    } catch (error) {
      if (error instanceof DevelopmentOperationError) throw error;
      throw new DevelopmentOperationError(
        "build-failed",
        "Build failed; current runtime was not restarted. Verify source/toolchain and --bun path",
      );
    }
    const status = await statusDevelopmentInstance(instance);
    process.stdout.write(
      `${JSON.stringify({
        operation: "rebuild",
        instanceId: instance.id,
        built: {
          generation: built.generation,
          manifestHash: developmentBuildLaunch(built).environment.TMUX_IDE_DEVELOPMENT_BUILD_HASH,
          sourceDigest: built.source.digest,
        },
        comparedWith: previousBuild?.generation ?? null,
        changed: developmentBuildChanges(previousBuild, built),
        selectedBuild: status.selectedBuild,
        activeBuild: status.activeBuild,
        activation: "not-requested",
        next: "restart --apply-build replaces daemon code; close/reopen app replaces TUI code; changed tmux bundle requires full down/up",
      })}\n`,
    );
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
        ? await restartDevelopmentInstance(instance, {
            applyBuild: values["apply-build"],
            previous: values.previous,
          })
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
