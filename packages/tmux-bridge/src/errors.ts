/**
 * Error thrown by the tmux-bridge package. Carries a stable `code` so
 * callers can branch on classes of failure (session missing, tmux unavailable,
 * generic error) without parsing stderr text.
 *
 * Shape mirrors the daemon's IdeError surface (`code`, `exitCode`, `toJSON`)
 * so it can be serialized and printed by the CLI's existing error formatter.
 */
export class TmuxError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(
    message: string,
    code: string,
    options: { cause?: unknown; exitCode?: number } = {},
  ) {
    super(message, { cause: options.cause as Error | undefined });
    this.name = "TmuxError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
  }

  toJSON(): { error: string; code: string; cause?: string } {
    const out: { error: string; code: string; cause?: string } = {
      error: this.message,
      code: this.code,
    };
    if (this.cause) out.cause = (this.cause as Error).message;
    return out;
  }
}
