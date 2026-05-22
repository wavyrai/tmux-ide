import { execFileSync, spawn, type ExecFileSyncOptions } from "node:child_process";
import { TmuxError } from "./errors.ts";

const DEBUG = process.env.TMUX_IDE_DEBUG === "1";

const SESSION_NOT_FOUND_PATTERNS = ["can't find session", "can't find window", "unknown target"];

const TMUX_UNAVAILABLE_PATTERNS = [
  "failed to connect to server",
  "no server running",
  "error connecting to",
  "connection refused",
];

declare global {
  // Toggled by the CLI's --verbose flag.
  var __tmuxIdeVerbose: boolean | undefined;
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

/** @internal Access the spawner (used by monitor.ts to keep one mock surface). */
export function _getSpawner(): Spawner {
  return _spawner;
}

export function runTmux(args: string[], options: ExecFileSyncOptions = {}): string | Buffer {
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

  return new TmuxError("tmux command failed", "TMUX_ERROR", {
    cause: error as Error,
  });
}

function getErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer })?.stderr;
  if (typeof stderr === "string" && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8");
  return (error as Error)?.message ?? "";
}
