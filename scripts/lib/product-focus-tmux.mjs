import { execFile } from "node:child_process";

export async function runBoundedFocusTmux({
  socketPath,
  args,
  deadline,
  signal,
  maxBuffer = 64 * 1_024,
  binary = "tmux",
  env = process.env,
  onSpawn,
}) {
  if (
    typeof socketPath !== "string" ||
    socketPath.length < 1 ||
    !Array.isArray(args) ||
    !Number.isFinite(deadline)
  )
    throw new Error("focus target tmux command is invalid");
  const remainingMs = Math.max(1, Math.floor(deadline - performance.now()));
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      ["-S", socketPath, ...args],
      {
        encoding: "utf8",
        timeout: Math.min(750, remainingMs),
        signal,
        maxBuffer,
        env,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    if (typeof onSpawn === "function") {
      try {
        onSpawn(child);
      } catch (error) {
        child.kill("SIGTERM");
        reject(error);
      }
    }
  });
}
