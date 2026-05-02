import type { RawData, WebSocket } from "ws";
import { PtyBridge, type PtyExit } from "./pty-bridge.ts";

const WS_OPEN = 1;
const KILL_ESCALATION_MS = 2000;

export interface PtyBridgeLike {
  spawn(cols: number, rows: number): void;
  write(bytes: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals): void;
  on(event: "output", listener: (bytes: Buffer) => void): this;
  on(event: "exit", listener: (exit: PtyExit) => void): this;
}

interface WsLike {
  readyState: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: RawData | string, isBinary: boolean) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: () => void): this;
}

export interface PtyWebSocketOptions {
  createBridge?: (id: string) => PtyBridgeLike;
}

export interface PtyWebSocketConnection {
  getBridge(): PtyBridgeLike | null;
}

interface InitFrame {
  type: "init";
  cols: number;
  rows: number;
}

interface ResizeFrame {
  type: "resize";
  cols: number;
  rows: number;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function rawDataToBuffer(data: RawData | string): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rawDataToText(data: RawData | string): string {
  return typeof data === "string" ? data : rawDataToBuffer(data).toString("utf8");
}

function isJsonControlFrame(data: RawData | string, isBinary: boolean): boolean {
  return !isBinary && rawDataToText(data).startsWith("{");
}

function parseJsonObject(data: RawData | string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(rawDataToText(data));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("control frame must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseInitFrame(data: RawData | string): InitFrame {
  const frame = parseJsonObject(data);
  if (frame.type !== "init") {
    throw new Error("first frame must be init");
  }
  if (!isPositiveInteger(frame.cols) || !isPositiveInteger(frame.rows)) {
    throw new Error("init requires positive integer cols and rows");
  }
  return { type: "init", cols: frame.cols, rows: frame.rows };
}

function parseResizeFrame(data: RawData | string): ResizeFrame {
  const frame = parseJsonObject(data);
  if (frame.type !== "resize") {
    throw new Error(`unsupported control frame: ${String(frame.type)}`);
  }
  if (!isPositiveInteger(frame.cols) || !isPositiveInteger(frame.rows)) {
    throw new Error("resize requires positive integer cols and rows");
  }
  return { type: "resize", cols: frame.cols, rows: frame.rows };
}

function sendError(ws: WsLike, message: string): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(JSON.stringify({ type: "error", message }));
  }
}

function closeWs(ws: WsLike): void {
  if (ws.readyState === WS_OPEN) {
    ws.close();
  }
}

export function handlePtyWebSocket(
  ws: WebSocket | WsLike,
  id: string,
  options: PtyWebSocketOptions = {},
): PtyWebSocketConnection {
  const socket = ws as WsLike;
  let bridge: PtyBridgeLike | null = null;
  let initialized = false;
  let ptyExited = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const clearKillTimer = () => {
    if (!killTimer) return;
    clearTimeout(killTimer);
    killTimer = null;
  };

  const closeWithError = (message: string) => {
    sendError(socket, message);
    closeWs(socket);
  };

  const attachBridgeEvents = (ptyBridge: PtyBridgeLike) => {
    ptyBridge.on("output", (bytes) => {
      if (socket.readyState === WS_OPEN) {
        socket.send(bytes, { binary: true });
      }
    });

    ptyBridge.on("exit", (exit) => {
      ptyExited = true;
      clearKillTimer();
      if (socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({ type: "exit", code: exit.code, signal: exit.signal }));
        socket.close();
      }
    });
  };

  socket.on("message", (data, isBinary) => {
    if (!initialized) {
      if (!isJsonControlFrame(data, isBinary)) {
        closeWithError("init frame required before input");
        return;
      }

      let init: InitFrame;
      try {
        init = parseInitFrame(data);
      } catch (err) {
        closeWithError(err instanceof Error ? err.message : String(err));
        return;
      }

      bridge = options.createBridge?.(id) ?? new PtyBridge({ id });
      attachBridgeEvents(bridge);

      try {
        bridge.spawn(init.cols, init.rows);
        initialized = true;
      } catch (err) {
        closeWithError(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (isJsonControlFrame(data, isBinary)) {
      try {
        const resize = parseResizeFrame(data);
        bridge?.resize(resize.cols, resize.rows);
      } catch (err) {
        closeWithError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    try {
      bridge?.write(rawDataToBuffer(data));
    } catch (err) {
      closeWithError(err instanceof Error ? err.message : String(err));
    }
  });

  socket.on("close", () => {
    if (!bridge || ptyExited) return;
    bridge.kill("SIGTERM");
    killTimer = setTimeout(() => {
      bridge?.kill("SIGKILL");
    }, KILL_ESCALATION_MS);
    killTimer.unref?.();
  });

  socket.on("error", () => {
    closeWs(socket);
  });

  return {
    getBridge: () => bridge,
  };
}
