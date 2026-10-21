import { spawn } from "node:child_process";

/** Dedicated preview binaries reject unknown flags without opening a window. */
export async function nativeSnapshotEncoding(command, { timeoutMs = 1500, signal } = {}) {
  if (signal?.aborted) return "legacy";
  return new Promise((resolve) => {
    let output = "",
      bytes = 0,
      failed = false;
    const child = spawn(command, ["--tmux-bridge-capabilities"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => {
      failed = true;
    });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4096) stop();
      else output += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      let encoding = "legacy";
      if (!failed && code === 0) {
        try {
          const value = JSON.parse(output);
          if (
            value?.version === 1 &&
            Array.isArray(value.snapshotEncodings) &&
            value.snapshotEncodings.includes("rle-v1")
          )
            encoding = "rle-v1";
        } catch {
          /* An older or incompatible binary keeps its existing wire format. */
        }
      }
      resolve(encoding);
    });
  });
}
