export class CodexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CodexProtocolError extends CodexError {}

export class CodexRpcError extends CodexError {
  readonly code: number;
  readonly data?: unknown;

  constructor(payload: { code: number; message: string; data?: unknown }) {
    super(payload.message);
    this.code = payload.code;
    this.data = payload.data;
  }
}

export class CodexAgentExitedError extends CodexError {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | string | null;

  constructor(
    message = "Codex agent exited",
    options?: { code?: number | null; signal?: string | null },
  ) {
    super(message);
    this.code = options?.code ?? null;
    this.signal = options?.signal ?? null;
  }
}

export class CodexAgentSpawnError extends CodexError {}
