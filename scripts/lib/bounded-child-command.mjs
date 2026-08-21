import { execFile } from "node:child_process";

export function runBoundedChildCommand({
  executable,
  args,
  options,
  timeoutMs,
  signal,
  onSpawn = () => undefined,
  onSettled = () => undefined,
  terminationGraceMs = 250,
  execFileImpl = execFile,
}) {
  if (signal?.aborted) {
    const error = new Error("bounded child command aborted before spawn");
    error.code = "ABORT_ERR";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let aborted = false;
    let escalation = null;
    let timer = null;
    const child = execFileImpl(executable, args, options, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", abort);
      onSettled(child.pid);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        if (timedOut) error.productRigReason = "command-timeout";
        if (aborted) error.code = "ABORT_ERR";
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    onSpawn(child.pid);
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, terminationGraceMs);
      escalation.unref?.();
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
  });
}
