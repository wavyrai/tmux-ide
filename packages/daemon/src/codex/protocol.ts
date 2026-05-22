import { CodexAgentExitedError, CodexError, CodexProtocolError, CodexRpcError } from "./errors.ts";

export interface CodexJsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface CodexJsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: CodexJsonRpcErrorPayload;
}

export interface CodexJsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexJsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexJsonRpcEndpoint {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (n: CodexJsonRpcNotification) => void): () => void;
  onIncomingRequest(handler: (r: CodexJsonRpcRequest) => Promise<unknown>): () => void;
  close(reason?: CodexError): Promise<void>;
  readonly closed: Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: CodexError) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function isErrorPayload(value: unknown): value is CodexJsonRpcErrorPayload {
  return (
    isObject(value) &&
    typeof value.code === "number" &&
    typeof value.message === "string" &&
    (value.data === undefined || true)
  );
}

function isCodexRequest(value: unknown): value is CodexJsonRpcRequest {
  return isObject(value) && isJsonRpcId(value.id) && typeof value.method === "string";
}

function isCodexNotification(value: unknown): value is CodexJsonRpcNotification {
  return isObject(value) && value.id === undefined && typeof value.method === "string";
}

function isCodexResponse(value: unknown): value is CodexJsonRpcResponse {
  return isObject(value) && isJsonRpcId(value.id) && value.method === undefined;
}

export function makeJsonRpcEndpoint(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  logger?: (event: { direction: "in" | "out"; payload: unknown }) => void;
}): CodexJsonRpcEndpoint {
  let nextId = 1;
  let buffer = "";
  let isClosed = false;
  let incomingRequestHandler: ((r: CodexJsonRpcRequest) => Promise<unknown>) | null = null;
  let resolveClosed!: () => void;
  const pending = new Map<number | string, PendingRequest>();
  const notificationHandlers = new Set<(n: CodexJsonRpcNotification) => void>();
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function log(direction: "in" | "out", payload: unknown) {
    opts.logger?.({ direction, payload });
  }

  function finish(reason: CodexError = new CodexAgentExitedError()): void {
    if (isClosed) return;
    isClosed = true;
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    resolveClosed();
  }

  function write(payload: unknown): void {
    if (isClosed) return;
    log("out", payload);
    try {
      opts.output.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      finish(new CodexProtocolError("Failed to encode Codex protocol message", { cause: err }));
    }
  }

  function respond(
    id: number | string,
    response: { result?: unknown; error?: CodexJsonRpcErrorPayload },
  ) {
    // Codex app-server uses JSON-RPC shapes over JSONL, but omits the
    // `jsonrpc: "2.0"` member that ACP includes.
    write({ id, ...response });
  }

  async function handleIncomingRequest(request: CodexJsonRpcRequest) {
    try {
      if (!incomingRequestHandler) {
        respond(request.id, {
          error: { code: -32601, message: `Method not found: ${request.method}` },
        });
        return;
      }
      const result = await incomingRequestHandler(request);
      respond(request.id, { result });
    } catch (err) {
      if (err instanceof CodexRpcError) {
        respond(request.id, { error: { code: err.code, message: err.message, data: err.data } });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      respond(request.id, { error: { code: -32603, message } });
    }
  }

  function handleFrame(payload: unknown): void {
    log("in", payload);
    if (isCodexResponse(payload)) {
      const request = pending.get(payload.id);
      if (!request) return;
      pending.delete(payload.id);
      if (payload.error !== undefined) {
        if (!isErrorPayload(payload.error)) {
          request.reject(new CodexProtocolError("Invalid Codex error response"));
          return;
        }
        request.reject(new CodexRpcError(payload.error));
      } else {
        request.resolve(payload.result);
      }
      return;
    }
    if (isCodexNotification(payload)) {
      for (const handler of notificationHandlers) handler(payload);
      return;
    }
    if (isCodexRequest(payload)) {
      void handleIncomingRequest(payload);
      return;
    }
    finish(new CodexProtocolError("Invalid Codex protocol frame"));
  }

  function handleChunk(chunk: unknown): void {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        handleFrame(JSON.parse(line));
      } catch (err) {
        finish(new CodexProtocolError("Invalid Codex protocol JSON", { cause: err }));
      }
    }
  }

  opts.input.on("data", handleChunk);
  opts.input.on("error", (err) =>
    finish(new CodexProtocolError("Codex input stream failed", { cause: err })),
  );
  opts.input.on("close", () => finish(new CodexAgentExitedError()));
  opts.input.on("end", () => finish(new CodexAgentExitedError()));
  opts.output.on?.("error", (err) =>
    finish(new CodexProtocolError("Codex output stream failed", { cause: err })),
  );

  return {
    request(method: string, params?: unknown): Promise<unknown> {
      if (isClosed) return Promise.reject(new CodexAgentExitedError());
      const id = nextId++;
      const envelope: CodexJsonRpcRequest = { id, method };
      if (params !== undefined) envelope.params = params;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      write(envelope);
      return promise;
    },
    notify(method: string, params?: unknown): void {
      const envelope: CodexJsonRpcNotification = { method };
      if (params !== undefined) envelope.params = params;
      write(envelope);
    },
    onNotification(handler: (n: CodexJsonRpcNotification) => void): () => void {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onIncomingRequest(handler: (r: CodexJsonRpcRequest) => Promise<unknown>): () => void {
      incomingRequestHandler = handler;
      return () => {
        if (incomingRequestHandler === handler) incomingRequestHandler = null;
      };
    },
    async close(reason?: CodexError): Promise<void> {
      finish(reason);
      opts.input.off?.("data", handleChunk);
      const output = opts.output as NodeJS.WritableStream & { destroyed?: boolean };
      if (!output.destroyed) output.end?.();
      await closed;
    },
    closed,
  };
}
