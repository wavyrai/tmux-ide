import { execFile } from "node:child_process";

/** Cooperative fixture cancellation. Never kills an npm/compiler process tree by inference. */
export function createPackedCancellation({ signals = process } = {}) {
  const controller = new AbortController();
  const commands = [];
  let cleanupDepth = 0,
    cancelledAt = null,
    receivedSignal = null,
    uncertainCommand = false;
  const cancel = (name) => {
    if (!controller.signal.aborted) {
      receivedSignal = name;
      cancelledAt = Date.now();
      controller.abort(new Error("Packed qualification cancelled"));
    }
  };
  const onInt = () => cancel("SIGINT"),
    onTerm = () => cancel("SIGTERM");
  signals.on("SIGINT", onInt);
  signals.on("SIGTERM", onTerm);
  const check = () => {
    if (!cleanupDepth) controller.signal.throwIfAborted();
  };
  const waitFor = async (promise, timeoutMs = 10000) => {
    check();
    let timer, abort;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Packed fixture wait deadline exceeded")),
            timeoutMs,
          );
          abort = () => reject(controller.signal.reason);
          if (!cleanupDepth) controller.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
    }
  };
  return {
    check,
    waitFor,
    signal: () => (cleanupDepth ? undefined : controller.signal),
    async pause(ms) {
      let timer;
      try {
        await waitFor(
          new Promise((r) => {
            timer = setTimeout(r, ms);
          }),
          ms + 1000,
        );
      } finally {
        clearTimeout(timer);
      }
    },
    async cleanup(work) {
      cleanupDepth++;
      try {
        return await work();
      } finally {
        cleanupDepth--;
      }
    },
    beginCleanup() {
      cleanupDepth++;
    },
    facts() {
      return {
        requested: controller.signal.aborted,
        signal: receivedSignal,
        sinceRequestMs: cancelledAt === null ? null : Date.now() - cancelledAt,
        uncertainCommand,
        commands: commands.map((entry) => ({ ...entry })),
      };
    },
    async command(file, args, options = {}) {
      check();
      let child;
      const result = await new Promise((resolve) => {
        child = execFile(
          file,
          args,
          {
            ...options,
            encoding: "utf8",
            timeout: options.timeout ?? 180000,
            maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
          },
          (error, stdout, stderr) =>
            resolve({
              status: error ? (typeof error.code === "number" ? error.code : null) : 0,
              signal: error?.signal ?? null,
              error: error ?? undefined,
              stdout,
              stderr,
            }),
        );
        if (options.stdio === "inherit") {
          child.stdout?.pipe(process.stdout, { end: false });
          child.stderr?.pipe(process.stderr, { end: false });
        }
      });
      // execFile callback settles after close. Timeout/buffer termination does not
      // prove descendants stopped; retain roots and make the final receipt refuse.
      if (
        result.error &&
        (result.error.killed || result.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      )
        uncertainCommand = true;
      commands.push({
        pid: child.pid ?? null,
        status: result.status,
        signal: result.signal,
        settled: true,
      });
      check();
      return { ...result, pid: child.pid ?? null };
    },
    dispose() {
      signals.removeListener("SIGINT", onInt);
      signals.removeListener("SIGTERM", onTerm);
    },
  };
}
