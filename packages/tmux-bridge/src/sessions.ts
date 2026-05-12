import type { SessionState } from "@tmux-ide/contracts";
import { TmuxError } from "./errors.ts";
import { runTmux } from "./runner.ts";

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

/**
 * Resolve the cwd of a tmux session by reading its first pane's
 * `pane_current_path`. Used as a fallback when looking up a project that
 * isn't in the registry but does have a live tmux session — e.g. when
 * the user opens the dashboard against tmux sessions they spawned by
 * other means. Returns null if the session has no panes or tmux can't
 * resolve the path.
 */
export function getSessionCwd(session: string): string | null {
  try {
    const raw = runTmux(
      ["display-message", "-p", "-t", session, "#{pane_current_path}"],
      { encoding: "utf-8" },
    ) as string;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
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

export function setSessionEnvironment(
  session: string,
  key: string,
  value: string | number,
): void {
  runTmux(["set-environment", "-t", session, key, String(value)]);
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

export function setSessionVariable(
  session: string,
  name: string,
  value: string,
): void {
  runTmux(["set-option", "-t", session, name, value]);
}

export function runSessionCommand(args: string[]): void {
  runTmux(args, { stdio: "inherit" });
}
