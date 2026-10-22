import type { Writable } from "node:stream";
import { createHostedSessionLifecycle } from "./hosted-session-lifecycle.ts";

/** Existing process fallback: publication/coalescing stays in live.ts.
 * The unavailable frame must be admitted before end(), and a blocked reader
 * cannot retain the helper forever. Only this adapter may destroy its output.
 */
export function createProcessSessionRetirement(options: {
  output: Writable;
  blocked(): boolean;
  unavailable(): void;
  revoke(): void;
  close(): void;
  failed(): void;
  timeoutMs?: number;
}) {
  const output = options.output;
  return createHostedSessionLifecycle<never, void>({
    retirementMs: options.timeoutMs,
    dispatch: () => {},
    unavailable: () => undefined,
    emit: () => options.unavailable(),
    revoke: options.revoke,
    drain: (signal) => drainProcessOutput(output, options.blocked, signal),
    close: () => {
      try {
        options.close();
      } finally {
        if (!output.writableFinished) output.destroy();
      }
    },
    onRetired: (result) => {
      if (result.timedOut || result.failures.length) options.failed();
    },
  });
}

export function drainProcessOutput(output: Writable, blocked: () => boolean, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let ending = false;
    const cleanup = () => {
      output.off("drain", drain);
      output.off("error", error);
      output.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const error = () => {
      cleanup();
      reject(new Error("Session output failed"));
    };
    const closed = () => {
      if (!output.writableFinished) error();
    };
    const aborted = () => {
      cleanup();
      reject(new Error("Session output drain expired"));
    };
    const drain = () => {
      if (ending || signal.aborted) return;
      if (output.destroyed) {
        error();
        return;
      }
      try {
        if (blocked()) return;
        ending = true;
        output.end((failure?: Error | null) => {
          cleanup();
          if (failure) reject(failure);
          else resolve();
        });
      } catch {
        error();
      }
    };
    output.on("drain", drain);
    output.once("error", error);
    output.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else drain();
  });
}
