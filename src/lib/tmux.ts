import { execFileSync, spawn, type ExecFileSyncOptions } from "node:child_process";
import { TmuxError } from "./errors.ts";
import type { SessionState } from "../types.ts";

const DEBUG = process.env.TMUX_IDE_DEBUG === "1";

const SESSION_NOT_FOUND_PATTERNS = ["can't find session", "can't find window", "unknown target"];

const TMUX_UNAVAILABLE_PATTERNS = [
  "failed to connect to server",
  "no server running",
  "error connecting to",
  "connection refused",
];

export { TmuxError };

export function getSessionState(session: string): SessionState {
  try {
    runTmux(["has-session", "-t", session]);
    return { running: true, reason: null };
  } catch (error) {
    if (error instanceof TmuxError) {
      if (error.code === "SESSION_NOT_FOUND") {
        return { running: false, reason: "SESSION_NOT_FOUND" };
      }
      if (error.code === "TMUX_UNAVAILABLE") {
        return { running: false, reason: "TMUX_UNAVAILABLE" };
      }
    }
    throw error;
  }
}

export function attachSession(session: string): void {
  runTmux(["attach", "-t", session], { stdio: "inherit" });
}

export function hasSession(session: string): boolean {
  try {
    runTmux(["has-session", "-t", session]);
    return true;
  } catch (error) {
    if (
      error instanceof TmuxError &&
      (error.code === "SESSION_NOT_FOUND" || error.code === "TMUX_UNAVAILABLE")
    ) {
      return false;
    }
    throw error;
  }
}

export function killSession(session: string): { stopped: boolean; reason: string | null } {
  try {
    runTmux(["kill-session", "-t", session]);
    return { stopped: true, reason: null };
  } catch (error) {
    if (error instanceof TmuxError) {
      if (error.code === "SESSION_NOT_FOUND") {
        return { stopped: false, reason: "SESSION_NOT_FOUND" };
      }
      if (error.code === "TMUX_UNAVAILABLE") {
        return { stopped: false, reason: "TMUX_UNAVAILABLE" };
      }
    }
    throw error;
  }
}

export function listPanes(session: string) {
  const raw = (
    runTmux(
      [
        "list-panes",
        "-t",
        session,
        "-F",
        "#{pane_index}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}",
      ],
      { encoding: "utf-8" },
    ) as string
  ).trim();

  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [index, title, width, height, active] = line.split("|");
    return {
      index: Number.parseInt(index!, 10),
      title,
      width: Number.parseInt(width!, 10),
      height: Number.parseInt(height!, 10),
      active: active === "1",
    };
  });
}

export function createDetachedSession(
  session: string,
  cwd: string,
  { cols, lines }: { cols?: number; lines?: number } = {},
): string {
  return (
    runTmux(
      [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-s",
        session,
        "-c",
        cwd,
        "-x",
        String(cols ?? 200),
        "-y",
        String(lines ?? 50),
      ],
      { encoding: "utf-8" },
    ) as string
  ).trim();
}

export function setSessionEnvironment(session: string, key: string, value: string | number): void {
  runTmux(["set-environment", "-t", session, key, String(value)]);
}

export function splitPane(
  targetPane: string,
  direction: string,
  cwd: string,
  percent: number,
): string {
  return (
    runTmux(
      [
        "split-window",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        targetPane,
        direction === "vertical" ? "-v" : "-h",
        "-c",
        cwd,
        "-p",
        String(percent),
      ],
      { encoding: "utf-8" },
    ) as string
  ).trim();
}

export function sendLiteral(targetPane: string, text: string): void {
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
}

export function getPaneCurrentCommand(targetPane: string): string {
  return (
    runTmux(["display-message", "-p", "-t", targetPane, "#{pane_current_command}"], {
      encoding: "utf-8",
    }) as string
  ).trim();
}

export function selectPane(targetPane: string): void {
  runTmux(["select-pane", "-t", targetPane], { stdio: "inherit" });
}

export function setPaneTitle(targetPane: string, title: string): void {
  runTmux(["select-pane", "-t", targetPane, "-T", title], { stdio: "inherit" });
}

export function setPaneOption(targetPane: string, option: string, value: string): void {
  runTmux(["set-option", "-pqt", targetPane, option, value]);
}

export function runSessionCommand(args: string[]): void {
  runTmux(args, { stdio: "inherit" });
}

/**
 * Check if a process is still alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

export function startSessionMonitor(session: string, monitorScript: string, port?: number): void {
  // Check if an existing monitor is already alive for this session.
  // This prevents duplicate monitors on rapid restart cycles.
  try {
    const existingPid = (
      runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
        encoding: "utf-8",
      }) as string
    ).trim();
    if (existingPid) {
      const pid = parseInt(existingPid, 10);
      if (isProcessAlive(pid)) {
        // Monitor is still running — kill it first for a clean handoff
        stopSessionMonitor(session);
        // Brief wait for graceful shutdown
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

  // Spawn the daemon via bun (runs TypeScript source directly).
  // Use a process group so we can kill the entire tree on stop.
  const child = _spawner("bun", [monitorScript, session, String(port ?? 0)], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
  });
  child.unref();
  // Store PID as tmux session variable for later cleanup.
  // This is the actual node process PID (not a shell wrapper).
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

export function getDaemonPort(session: string): number | null {
  try {
    const raw = runTmux(["show-option", "-qvt", session, "@command_center_port"], {
      encoding: "utf-8",
    }) as string;
    const port = parseInt(raw.trim(), 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

export async function isDaemonHealthy(session: string): Promise<boolean> {
  const port = getDaemonPort(session);
  if (!port) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export function getSessionVariable(session: string, name: string): string | null {
  try {
    const raw = runTmux(["show-option", "-qvt", session, name], {
      encoding: "utf-8",
    }) as string;
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export function setSessionVariable(session: string, name: string, value: string): void {
  runTmux(["set-option", "-t", session, name, value]);
}

type Executor = typeof execFileSync;
type Spawner = typeof spawn;

let _executor: Executor = execFileSync;
let _spawner: Spawner = spawn;

/** @internal Replace the executor for testing. Returns a restore function. */
export function _setExecutor(fn: Executor): () => void {
  const prev = _executor;
  _executor = fn;
  return () => {
    _executor = prev;
  };
}

/** @internal Replace the spawner for testing. Returns a restore function. */
export function _setSpawner(fn: Spawner): () => void {
  const prev = _spawner;
  _spawner = fn;
  return () => {
    _spawner = prev;
  };
}

declare global {
  var __tmuxIdeVerbose: boolean | undefined;
}

function runTmux(args: string[], options: ExecFileSyncOptions = {}) {
  if (DEBUG || globalThis.__tmuxIdeVerbose) {
    console.error(`  [tmux] ${args.join(" ")}`);
  }

  const execOptions: ExecFileSyncOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  };

  try {
    return _executor("tmux", args, execOptions);
  } catch (error) {
    throw classifyTmuxError(error);
  }
}

function classifyTmuxError(error: unknown): TmuxError {
  const detail = getErrorDetail(error).toLowerCase();

  if (SESSION_NOT_FOUND_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux session was not found", "SESSION_NOT_FOUND", {
      cause: error as Error,
    });
  }

  if (TMUX_UNAVAILABLE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux is unavailable or its socket is inaccessible", "TMUX_UNAVAILABLE", {
      cause: error as Error,
    });
  }

  return new TmuxError("tmux command failed", "TMUX_ERROR", { cause: error as Error });
}

function getErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer })?.stderr;
  if (typeof stderr === "string" && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8");
  return (error as Error)?.message ?? "";
}
