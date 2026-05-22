import { _getSpawner, runTmux } from "./runner.ts";

/** Check if a process is still alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

export function startSessionMonitor(session: string, monitorScript: string, port?: number): void {
  // If an existing monitor is still alive, kill it for a clean handoff.
  try {
    const existingPid = (
      runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
        encoding: "utf-8",
      }) as string
    ).trim();
    if (existingPid) {
      const pid = parseInt(existingPid, 10);
      if (isProcessAlive(pid)) {
        stopSessionMonitor(session);
        let attempts = 0;
        while (isProcessAlive(pid) && attempts < 10) {
          const { Atomics, SharedArrayBuffer } = globalThis;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          attempts++;
        }
      }
    }
  } catch {
    // Session variable not readable — continue with fresh start
  }

  // Spawn the daemon via tsx (runs TypeScript source directly under node).
  // We DELIBERATELY do not use bun: under bun, node-pty's `onData` callback
  // never fires (the PTY spawns and exits but no data flows). T085 burned
  // half a day on this; T087 sealed the rule via PtyAdapter. Use a process
  // group so we can kill the entire tree on stop.
  const child = _getSpawner()("tsx", [monitorScript, session, String(port ?? 0)], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();
  // Store PID as tmux session variable for later cleanup. This is the actual
  // node process PID (not a shell wrapper).
  runTmux(["set-option", "-t", session, "@monitor_pid", String(child.pid)]);
}

export function stopSessionMonitor(session: string): void {
  try {
    const pid = (
      runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
        encoding: "utf-8",
      }) as string
    ).trim();
    if (pid) {
      const numPid = parseInt(pid, 10);
      // Kill the process group (negative PID) to catch any children
      try {
        process.kill(-numPid, "SIGTERM");
      } catch {
        // Process group kill failed — try direct kill
        try {
          process.kill(numPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    /* session or process already gone */
  }
}
