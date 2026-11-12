import { withBundledTmuxResources } from "./bundled-tmux.ts";
import { execFile } from "node:child_process";
export const BOUNDED_TMUX_KILL_GRACE_MS = 250;
/**
 * Read-only child ownership: TERM at deadline/abort, KILL after grace; settle
 * after close. "close" needs every holder of the pipes to let go, so once the
 * child has been killed the read settles one more grace later regardless: a
 * wrapper's lingering grandchild must not turn a deadline into a hang (#839).
 */
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
        env: withBundledTmuxResources(executable, options.env),
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        failure ??= error;
        output = stdout;
      },
    );
    let abandon: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      if (abandon) clearTimeout(abandon);
      options.signal?.removeEventListener("abort", stop);
      if (failure) reject(failure);
      else resolve(output);
    };
    const stop = () => {
      failure ??= new Error("Tmux read cancelled or deadline exceeded");
      if (escalation) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        abandon = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle();
        }, BOUNDED_TMUX_KILL_GRACE_MS);
        abandon.unref?.();
      }, BOUNDED_TMUX_KILL_GRACE_MS);
      escalation.unref?.();
    };
    const deadline = setTimeout(stop, options.timeoutMs ?? 5000);
    deadline.unref?.();
    options.signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", settle);
    if (options.signal?.aborted) stop();
  });
}
