import { AcpAgentExitedError, AcpError, AcpProtocolError, AcpRpcError } from "./errors.ts";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcErrorPayload;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcEndpoint {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (n: JsonRpcNotification) => void): () => void;
  onIncomingRequest(handler: (r: JsonRpcRequest) => Promise<unknown>): () => void;
  close(reason?: AcpError): Promise<void>;
  readonly closed: Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: AcpError) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    typeof value.method === "string"
  );
}

function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    value.id === undefined &&
    typeof value.method === "string"
  );
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return (
    isObject(value) &&
    value.jsonrpc === "2.0" &&
    (typeof value.id === "number" || typeof value.id === "string") &&
    value.method === undefined
  );
}

export function makeJsonRpcEndpoint(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  logger?: (event: { direction: "in" | "out"; payload: unknown }) => void;
}): JsonRpcEndpoint {
  let nextId = 1;
  let buffer = "";
  let isClosed = false;
  let incomingRequestHandler: ((r: JsonRpcRequest) => Promise<unknown>) | null = null;
  let resolveClosed!: () => void;
  const pending = new Map<number | string, PendingRequest>();
  const notificationHandlers = new Set<(n: JsonRpcNotification) => void>();
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  function log(direction: "in" | "out", payload: unknown) {
    opts.logger?.({ direction, payload });
  }

  function write(payload: unknown): void {
    if (isClosed) return;
    log("out", payload);
    opts.output.write(`${JSON.stringify(payload)}\n`);
  }

  function finish(reason: AcpError = new AcpAgentExitedError()): void {
    if (isClosed) return;
    isClosed = true;
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    resolveClosed();
  }

  function respond(
    id: number | string,
    response: { result?: unknown; error?: JsonRpcErrorPayload },
  ) {
    write({ jsonrpc: "2.0", id, ...response });
  }

  async function handleIncomingRequest(request: JsonRpcRequest) {
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
      if (err instanceof AcpRpcError) {
        respond(request.id, {
          error: { code: err.code, message: err.message, data: err.data },
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      respond(request.id, { error: { code: -32603, message } });
    }
  }

  function handleFrame(payload: unknown): void {
    log("in", payload);
    if (isJsonRpcResponse(payload)) {
      const request = pending.get(payload.id);
      if (!request) return;
      pending.delete(payload.id);
      if (payload.error) request.reject(new AcpRpcError(payload.error));
      else request.resolve(payload.result);
      return;
    }
    if (isJsonRpcNotification(payload)) {
      for (const handler of notificationHandlers) handler(payload);
      return;
    }
    if (isJsonRpcRequest(payload)) {
      void handleIncomingRequest(payload);
      return;
    }
    finish(new AcpProtocolError("Invalid JSON-RPC frame"));
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
        finish(new AcpProtocolError("Invalid JSON-RPC JSON", { cause: err }));
      }
    }
  }

  opts.input.on("data", handleChunk);
  opts.input.on("error", (err) =>
    finish(new AcpProtocolError("ACP input stream failed", { cause: err })),
  );
  opts.input.on("close", () => finish(new AcpAgentExitedError()));
  opts.input.on("end", () => finish(new AcpAgentExitedError()));
  opts.output.on?.("error", (err) =>
    finish(new AcpProtocolError("ACP output stream failed", { cause: err })),
  );

  return {
    request(method: string, params?: unknown): Promise<unknown> {
      if (isClosed) return Promise.reject(new AcpAgentExitedError());
      const id = nextId++;
      const envelope: JsonRpcRequest = { jsonrpc: "2.0", id, method };
      if (params !== undefined) envelope.params = params;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      write(envelope);
      return promise;
    },
    notify(method: string, params?: unknown): void {
      const envelope: JsonRpcNotification = { jsonrpc: "2.0", method };
      if (params !== undefined) envelope.params = params;
      write(envelope);
    },
    onNotification(handler: (n: JsonRpcNotification) => void): () => void {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onIncomingRequest(handler: (r: JsonRpcRequest) => Promise<unknown>): () => void {
      incomingRequestHandler = handler;
      return () => {
        if (incomingRequestHandler === handler) incomingRequestHandler = null;
      };
    },
    async close(reason?: AcpError): Promise<void> {
      finish(reason);
      opts.input.off?.("data", handleChunk);
      const output = opts.output as NodeJS.WritableStream & { destroyed?: boolean };
      if (!output.destroyed) output.end?.();
      await closed;
    },
    closed,
  };
}
