import { execFile } from "node:child_process";
/** Read-only child ownership: TERM at deadline/abort, KILL after grace; settle after close. */
export function boundedTmuxRead(
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBuffer?: number;
  },
): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new Error("Tmux read cancelled"));
  return new Promise((resolve, reject) => {
    let output = "";
    let failure: Error | null = null;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const child = execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        env: options.env,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        failure ??= error;
        output = stdout;
      },
    );
    const stop = () => {
      failure ??= new Error("Tmux read cancelled or deadline exceeded");
      if (escalation) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 250);
      escalation.unref?.();
    };
    const deadline = setTimeout(stop, options.timeoutMs ?? 5000);
    deadline.unref?.();
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", () => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", stop);
      if (failure) reject(failure);
      else resolve(output);
    });
    if (options.signal?.aborted) stop();
  });
}
