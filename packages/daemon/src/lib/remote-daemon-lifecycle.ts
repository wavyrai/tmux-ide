import { spawn } from "node:child_process";
import { SavedMachineSchema } from "@tmux-ide/contracts/saved-machines";

/** Only explicit user actions call this; catalog discovery and retries never do. */
export async function startInstalledRemoteDaemon(
  alias: string,
  options: { signal?: AbortSignal; spawn?: typeof spawn } = {},
): Promise<void> {
  SavedMachineSchema.shape.sshTarget.parse(alias);
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(30_000),
  ]);
  if (signal.aborted) throw new Error("Remote daemon start cancelled");
  await new Promise<void>((resolve, reject) => {
    const child = (options.spawn ?? spawn)(
      "ssh",
      [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        alias,
        "tmux-ide",
        "update",
        "--daemon",
        "--json",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let settled = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (ok) resolve();
      else
        reject(
          new Error(
            "Remote daemon start failed. Check SSH access and the installed tmux-ide version.",
          ),
        );
    };
    const abort = () => {
      child.kill("SIGTERM");
      force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 250);
      force.unref();
      finish(false);
    };
    // Drain without storing remote output, which is not a trusted diagnostic surface.
    child.stdout?.resume();
    child.stderr?.resume();
    child.once("error", () => finish(false));
    child.once("close", (code) => {
      if (force) clearTimeout(force);
      finish(code === 0);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
