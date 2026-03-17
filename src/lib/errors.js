export class IdeError extends Error {
  constructor(message, { code, exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = "IdeError";
    this.code = code;
    this.exitCode = exitCode;
  }

  toJSON() {
    const obj = { error: this.message, code: this.code };
    if (this.cause) obj.cause = this.cause.message;
    return obj;
  }
}

export class ConfigError extends IdeError {
  constructor(message, code, { cause } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "ConfigError";
  }
}

export class TmuxError extends IdeError {
  constructor(message, code, { cause } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "TmuxError";
  }
}

export class SessionError extends IdeError {
  constructor(message, code, { cause } = {}) {
    super(message, { code, exitCode: 1, cause });
    this.name = "SessionError";
  }
}
