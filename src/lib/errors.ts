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

export class TmuxError extends IdeError {
  constructor(message: string, code: string, { cause }: { cause?: Error } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "TmuxError";
  }
}

export class SessionError extends IdeError {
  constructor(message: string, code: string, { cause }: { cause?: Error } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "SessionError";
  }
}
