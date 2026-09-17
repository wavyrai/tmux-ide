/** Interactive access to the selected private snapshot, never an implicit start. */
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import type { DevelopmentComposeProject } from "./development-compose.ts";
import { withReadyDevelopmentContainer } from "./development-container.ts";

export class DevelopmentContainerTerminalRequiredError extends Error {
  constructor() {
    super("Container shell requires an interactive terminal");
  }
}

export function developmentContainerShellCommand(project: DevelopmentComposeProject): string {
  return [
    "/usr/local/bin/node",
    "/workspace/tree/scripts/development-instance.mjs",
    "app",
    "--worktree",
    "/workspace/tree",
    "--store",
    "/state/instances",
    "--name",
    project.name,
  ]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

export async function launchDevelopmentContainerShell(
  project: DevelopmentComposeProject,
  options: { signal?: AbortSignal } = {},
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new DevelopmentContainerTerminalRequiredError();
  let child: ChildProcess | undefined;
  let completion: Promise<number> | undefined;
  let closed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (!child || closed) return;
    child.kill("SIGTERM");
    escalation ??= setTimeout(() => {
      if (!closed) child?.kill("SIGKILL");
    }, 250);
  };
  try {
    const admitted = await withReadyDevelopmentContainer(
      project,
      async ({ containerId }) => {
        options.signal?.throwIfAborted();
        process.stderr.write(
          `Private Linux snapshot (no host source sync). Managed app:\n${developmentContainerShellCommand(project)}\nDocker client cancellation does not prove the inner shell exited; container down stops its private process tree.\n`,
        );
        child = spawn(
          "docker",
          [
            "exec",
            "--interactive",
            "--tty",
            "--user",
            "1000",
            "--workdir",
            "/workspace/tree",
            containerId,
            "/bin/bash",
            "--noprofile",
            "--norc",
          ],
          { stdio: "inherit" },
        );
        const owned = child;
        completion = new Promise<number>((resolve, reject) => {
          let failed = false;
          owned.once("error", () => {
            failed = true;
          });
          owned.once("close", (code, signal) => {
            closed = true;
            clearTimeout(escalation);
            options.signal?.removeEventListener("abort", cancel);
            if (failed) reject(new Error("Container shell Docker client failed"));
            else resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
          });
        });
        // A spawn failure can occur before admission returns; keep its completion handled.
        void completion.catch(() => {});
        options.signal?.addEventListener("abort", cancel, { once: true });
        if (options.signal?.aborted) cancel();
        await new Promise<void>((resolve, reject) => {
          owned.once("spawn", resolve);
          owned.once("error", () => reject(new Error("Container shell Docker client unavailable")));
        });
        options.signal?.throwIfAborted();
        return { child: owned, completion, cancel };
      },
      options.signal,
    );
    return admitted;
  } catch (error) {
    cancel();
    await completion?.catch(() => {});
    throw error;
  }
}
