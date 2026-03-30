// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel — adapted for tmux pane capture.

import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import type { AuthConfig } from "../auth/types.ts";
import { AuthService } from "../auth/auth-service.ts";
import { listSessionPanes } from "../../widgets/lib/pane-comms.ts";
import {
  decodeWsV3Frame,
  decodeWsV3ResizePayload,
  decodeWsV3SubscribePayload,
  encodeWsV3Frame,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from "./protocol.ts";

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

export interface WsV3HubDeps {
  capturePane: (paneId: string) => string;
  paneExists: (session: string, paneId: string) => boolean;
  sendLiteral: (paneId: string, data: string) => void;
  resizePane: (paneId: string, cols: number, rows: number) => void;
}

export function createDefaultTmuxDeps(): WsV3HubDeps {
  return {
    capturePane: (paneId: string) =>
      execFileSync("tmux", ["capture-pane", "-t", paneId, "-p", "-e"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    paneExists: (session: string, paneId: string) => {
      try {
        return listSessionPanes(session).some((p) => p.id === paneId);
      } catch {
        return false;
      }
    },
    sendLiteral: (paneId: string, data: string) => {
      execFileSync("tmux", ["send-keys", "-t", paneId, "-l", "--", data], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    },
    resizePane: (paneId: string, cols: number, rows: number) => {
      execFileSync("tmux", ["resize-pane", "-t", paneId, "-x", String(cols), "-y", String(rows)], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    },
  };
}

function hubKey(session: string, paneId: string): string {
  return `${session}:${paneId}`;
}

type ClientMeta = {
  session: string;
  paneId: string;
  key: string;
  authenticated: boolean;
  flags: number;
};

/**
 * WebSocket v3 hub: binary framed mirror of tmux panes (per session:paneId), with subscribe flags
 * and JWT auth via initial HELLO frame.
 */
export class WsV3Hub {
  private readonly clients = new WeakMap<WebSocket, ClientMeta>();
  private readonly subs = new Map<string, Set<WebSocket>>();
  private readonly intervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastCapture = new Map<string, string>();
  private readonly deps: WsV3HubDeps;
  private readonly pollMs: number;

  constructor(
    private readonly authService: AuthService,
    private readonly authConfig: AuthConfig,
    deps?: WsV3HubDeps,
    options?: { pollIntervalMs?: number },
  ) {
    this.deps = deps ?? createDefaultTmuxDeps();
    this.pollMs = options?.pollIntervalMs ?? 100;
  }

  /** Wire protocol entry: URL already selected session + paneId. */
  handleConnection(ws: WebSocket, session: string, paneId: string): void {
    const key = hubKey(session, paneId);
    const meta: ClientMeta = {
      session,
      paneId,
      key,
      authenticated: false,
      flags: 0,
    };
    this.clients.set(ws, meta);

    const authTimeout = setTimeout(() => {
      const m = this.clients.get(ws);
      if (m && !m.authenticated && ws.readyState === WebSocket.OPEN) {
        this.sendError(ws, session, paneId, "Authentication timeout");
        ws.close();
      }
    }, 15_000);

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data)
        ? new Uint8Array(data)
        : new Uint8Array(data as ArrayBuffer);
      const frame = decodeWsV3Frame(buf);
      if (!frame) return;
      void this.dispatchFrame(ws, meta, frame.type, frame.payload, () => clearTimeout(authTimeout));
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      this.removeFromCapture(ws);
    });

    ws.on("error", () => {
      clearTimeout(authTimeout);
    });
  }

  /** Register client for pane streaming (expects SUBSCRIBE to have set flags on meta). */
  subscribe(ws: WebSocket, session: string, paneId: string): void {
    const meta = this.clients.get(ws);
    if (!meta?.authenticated) return;
    this.addSubscriber(ws, meta);
    this.ensurePolling(session, paneId);
  }

  /** Stop capture for this socket; connection may stay open. */
  unsubscribe(ws: WebSocket): void {
    this.removeFromCapture(ws);
  }

  /** Push a pre-encoded v3 frame to every subscriber for this pane. */
  broadcast(session: string, paneId: string, data: Uint8Array): void {
    const key = hubKey(session, paneId);
    for (const client of this.subs.get(key) ?? []) {
      this.safeSend(client, data);
    }
  }

  stopAll(): void {
    for (const [, iv] of this.intervals) clearInterval(iv);
    this.intervals.clear();
    this.lastCapture.clear();
    for (const [, set] of this.subs) {
      for (const ws of set) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.subs.clear();
  }

  private removeFromCapture(ws: WebSocket): void {
    const meta = this.clients.get(ws);
    if (!meta) return;

    const set = this.subs.get(meta.key);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        this.subs.delete(meta.key);
        const iv = this.intervals.get(meta.key);
        if (iv) {
          clearInterval(iv);
          this.intervals.delete(meta.key);
        }
        this.lastCapture.delete(meta.key);
      }
    }
  }

  private async dispatchFrame(
    ws: WebSocket,
    meta: ClientMeta,
    type: WsV3MessageType,
    payload: Uint8Array,
    clearAuthTimeout: () => void,
  ): Promise<void> {
    if (!meta.authenticated) {
      if (type !== WsV3MessageType.HELLO) {
        this.sendError(ws, meta.session, meta.paneId, "Expected HELLO frame first");
        ws.close();
        return;
      }
      const ok = this.authenticateHello(payload);
      if (!ok) {
        this.sendError(ws, meta.session, meta.paneId, "Invalid or missing token");
        ws.close();
        return;
      }
      meta.authenticated = true;
      clearAuthTimeout();
      this.safeSend(
        ws,
        encodeWsV3Frame({
          type: WsV3MessageType.WELCOME,
          sessionId: meta.key,
          payload: utf8.encode(JSON.stringify({ ok: true, version: 3 })),
        }),
      );
      return;
    }

    const sid = hubKey(meta.session, meta.paneId);

    try {
      switch (type) {
        case WsV3MessageType.PING:
          this.safeSend(
            ws,
            encodeWsV3Frame({ type: WsV3MessageType.PONG, sessionId: sid, payload }),
          );
          return;

        case WsV3MessageType.SUBSCRIBE: {
          const sub = decodeWsV3SubscribePayload(payload);
          if (!sub) throw new Error("Invalid SUBSCRIBE payload");
          if (!this.deps.paneExists(meta.session, meta.paneId)) {
            this.sendError(ws, meta.session, meta.paneId, "Pane not found");
            return;
          }
          meta.flags = sub.flags;
          this.subscribe(ws, meta.session, meta.paneId);
          if (meta.flags & WsV3SubscribeFlags.Events) {
            this.safeSend(
              ws,
              encodeWsV3Frame({
                type: WsV3MessageType.EVENT,
                sessionId: sid,
                payload: utf8.encode(
                  JSON.stringify({
                    kind: "subscribed",
                    session: meta.session,
                    paneId: meta.paneId,
                  }),
                ),
              }),
            );
          }
          return;
        }

        case WsV3MessageType.UNSUBSCRIBE:
          this.unsubscribe(ws);
          return;

        case WsV3MessageType.INPUT_TEXT: {
          const text = utf8d.decode(payload);
          this.deps.sendLiteral(meta.paneId, text);
          return;
        }

        case WsV3MessageType.RESIZE: {
          const dims = decodeWsV3ResizePayload(payload);
          if (!dims) throw new Error("Invalid RESIZE payload");
          this.deps.resizePane(meta.paneId, dims.cols, dims.rows);
          return;
        }

        default:
          return;
      }
    } catch (e) {
      this.sendError(ws, meta.session, meta.paneId, e instanceof Error ? e.message : String(e));
    }
  }

  private authenticateHello(payload: Uint8Array): boolean {
    if (this.authConfig.method === "none") return true;
    try {
      const j = JSON.parse(utf8d.decode(payload)) as { token?: string };
      const token = j.token;
      if (!token) return false;
      const r = this.authService.verifyToken(token);
      return r.valid;
    } catch {
      return false;
    }
  }

  private addSubscriber(ws: WebSocket, meta: ClientMeta): void {
    let set = this.subs.get(meta.key);
    if (!set) {
      set = new Set();
      this.subs.set(meta.key, set);
    }
    set.add(ws);
  }

  private ensurePolling(session: string, paneId: string): void {
    const key = hubKey(session, paneId);
    if (this.intervals.has(key)) return;

    const interval = setInterval(() => {
      let content: string;
      try {
        content = this.deps.capturePane(paneId);
      } catch {
        this.broadcastError(key, "capture-pane failed (pane gone?)");
        this.stopKey(key);
        return;
      }

      const prev = this.lastCapture.get(key) ?? "";
      if (content === prev) return;
      this.lastCapture.set(key, content);

      const bytes = utf8.encode(content);
      const set = this.subs.get(key);
      if (!set) return;

      for (const client of set) {
        const m = this.clients.get(client);
        if (!m) continue;
        if (m.flags & WsV3SubscribeFlags.Stdout) {
          this.safeSend(
            client,
            encodeWsV3Frame({ type: WsV3MessageType.STDOUT, sessionId: key, payload: bytes }),
          );
        }
        if (m.flags & WsV3SubscribeFlags.Snapshots) {
          this.safeSend(
            client,
            encodeWsV3Frame({ type: WsV3MessageType.SNAPSHOT_VT, sessionId: key, payload: bytes }),
          );
        }
      }
    }, this.pollMs);

    this.intervals.set(key, interval);
  }

  private stopKey(key: string): void {
    const iv = this.intervals.get(key);
    if (iv) clearInterval(iv);
    this.intervals.delete(key);
    this.lastCapture.delete(key);
    const set = this.subs.get(key);
    if (!set) return;
    for (const ws of [...set]) this.removeFromCapture(ws);
  }

  private broadcastError(key: string, message: string): void {
    const payload = utf8.encode(JSON.stringify({ message }));
    for (const client of this.subs.get(key) ?? []) {
      this.safeSend(
        client,
        encodeWsV3Frame({ type: WsV3MessageType.ERROR, sessionId: key, payload }),
      );
    }
  }

  private sendError(ws: WebSocket, session: string, paneId: string, message: string): void {
    const sid = hubKey(session, paneId);
    this.safeSend(
      ws,
      encodeWsV3Frame({
        type: WsV3MessageType.ERROR,
        sessionId: sid,
        payload: utf8.encode(JSON.stringify({ message })),
      }),
    );
  }

  private safeSend(ws: WebSocket, data: Uint8Array): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(data);
    } catch {
      /* ignore */
    }
  }
}
