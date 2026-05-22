export class IdeError extends Error {
  code: string | undefined;
  exitCode: number;

  constructor(
    message: string,
    { code, exitCode = 1, cause }: { code?: string; exitCode?: number; cause?: Error } = {},
  ) {
    super(message, { cause });
    this.name = "IdeError";
    this.code = code;
    this.exitCode = exitCode;
  }

  toJSON(): { error: string; code: string | undefined; cause?: string } {
    const obj: { error: string; code: string | undefined; cause?: string } = {
      error: this.message,
      code: this.code,
    };
    if (this.cause) obj.cause = (this.cause as Error).message;
    return obj;
  }
}

export class ConfigError extends IdeError {
  constructor(message: string, code: string, { cause }: { cause?: Error } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "ConfigError";
  }
}

// TmuxError now lives in @tmux-ide/tmux-bridge. Re-exported here so the
// existing `import { TmuxError } from "./errors.ts"` paths keep working
// across the daemon. The bridge's class extends Error directly (not IdeError);
// the CLI's printCommandError handles both via duck-typing on `code`/`exitCode`.
export { TmuxError } from "@tmux-ide/tmux-bridge";

export class SessionError extends IdeError {
  constructor(message: string, code: string, { cause }: { cause?: Error } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "SessionError";
  }
}

export type DaemonStartupReason =
  | "port_in_use"
  | "port_invalid"
  | "bind_failed"
  | "tmux_session_missing"
  | "canonical_already_running";

export class DaemonStartupError extends IdeError {
  readonly reason: DaemonStartupReason;

  constructor(message: string, reason: DaemonStartupReason, { cause }: { cause?: Error } = {}) {
    super(message, { code: `DAEMON_${reason.toUpperCase()}`, exitCode: 1, cause });
    this.name = "DaemonStartupError";
    this.reason = reason;
  }
}

export class DaemonShutdownError extends IdeError {
  constructor(message: string, { cause }: { cause?: Error } = {}) {
    super(message, { code: "DAEMON_SHUTDOWN_FAILED", exitCode: 1, cause });
    this.name = "DaemonShutdownError";
  }
}
