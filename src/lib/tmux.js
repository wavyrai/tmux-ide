import { execFileSync, spawn } from "node:child_process";
import { TmuxError } from "./errors.js";

const DEBUG = process.env.TMUX_IDE_DEBUG === "1";

const SESSION_NOT_FOUND_PATTERNS = ["can't find session", "can't find window", "unknown target"];

const TMUX_UNAVAILABLE_PATTERNS = [
  "failed to connect to server",
  "no server running",
  "error connecting to",
  "connection refused",
];

export { TmuxError };

export function getSessionState(session) {
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

export function attachSession(session) {
  runTmux(["attach", "-t", session], { stdio: "inherit" });
}

export function hasSession(session) {
  try {
    runTmux(["has-session", "-t", session]);
    return true;
  } catch (error) {
    if (error instanceof TmuxError && error.code === "SESSION_NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

export function killSession(session) {
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

export function listPanes(session) {
  const raw = runTmux(
    [
      "list-panes",
      "-t",
      session,
      "-F",
      "#{pane_index}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}",
    ],
    { encoding: "utf-8" },
  ).trim();

  if (!raw) return [];

  return raw.split("\n").map((line) => {
    const [index, title, width, height, active] = line.split("|");
    return {
      index: Number.parseInt(index, 10),
      title,
      width: Number.parseInt(width, 10),
      height: Number.parseInt(height, 10),
      active: active === "1",
    };
  });
}

export function createDetachedSession(session, cwd, { cols, lines } = {}) {
  return runTmux(
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
  ).trim();
}

export function setSessionEnvironment(session, key, value) {
  runTmux(["set-environment", "-t", session, key, String(value)]);
}

export function splitPane(targetPane, direction, cwd, percent) {
  return runTmux(
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
  ).trim();
}

export function sendLiteral(targetPane, text) {
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
}

export function getPaneCurrentCommand(targetPane) {
  return runTmux(["display-message", "-p", "-t", targetPane, "#{pane_current_command}"], {
    encoding: "utf-8",
  }).trim();
}

export function selectPane(targetPane) {
  runTmux(["select-pane", "-t", targetPane], { stdio: "inherit" });
}

export function setPaneTitle(targetPane, title) {
  runTmux(["select-pane", "-t", targetPane, "-T", title], { stdio: "inherit" });
}

export function runSessionCommand(args) {
  runTmux(args, { stdio: "inherit" });
}

export function startSessionMonitor(session, monitorScript) {
  const child = spawn("node", [monitorScript, session], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  // Store PID as tmux session variable for later cleanup
  runTmux(["set-option", "-t", session, "@monitor_pid", String(child.pid)]);
}

export function stopSessionMonitor(session) {
  try {
    const pid = runTmux(["show-option", "-gqvt", session, "@monitor_pid"], {
      encoding: "utf-8",
    }).trim();
    if (pid) process.kill(parseInt(pid, 10));
  } catch {
    /* session or process already gone */
  }
}

export function getSessionVariable(session, name) {
  try {
    const raw = runTmux(["show-option", "-gqvt", session, name], {
      encoding: "utf-8",
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}

export function setSessionVariable(session, name, value) {
  runTmux(["set-option", "-t", session, name, value]);
}

function runTmux(args, options = {}) {
  if (DEBUG || globalThis.__tmuxIdeVerbose) {
    console.error(`  [tmux] ${args.join(" ")}`);
  }

  const execOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  };

  try {
    return execFileSync("tmux", args, execOptions);
  } catch (error) {
    throw classifyTmuxError(error);
  }
}

function classifyTmuxError(error) {
  const detail = getErrorDetail(error).toLowerCase();

  if (SESSION_NOT_FOUND_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux session was not found", "SESSION_NOT_FOUND", { cause: error });
  }

  if (TMUX_UNAVAILABLE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux is unavailable or its socket is inaccessible", "TMUX_UNAVAILABLE", {
      cause: error,
    });
  }

  return new TmuxError("tmux command failed", "TMUX_ERROR", { cause: error });
}

function getErrorDetail(error) {
  const stderr = error?.stderr;
  if (typeof stderr === "string" && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8");
  return error?.message ?? "";
}
