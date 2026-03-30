"use client";

import { useEffect, useRef, useState } from "react";
import { init, Terminal, FitAddon } from "ghostty-web";
import {
  decodeFrame,
  encodeHelloAuthFrame,
  encodeInputTextFrame,
  encodeSubscribeStdoutFrame,
  paneSessionKey,
  WsV3MessageType,
} from "@/lib/ws-v3-client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

const wasmReady = init();

function wsBaseFromApi(): string {
  return API_BASE.replace(/^http/, "ws");
}

function getV3WsUrl(sessionName: string, paneId: string): string {
  return `${wsBaseFromApi()}/ws/v3/${encodeURIComponent(sessionName)}/${paneId}`;
}

function getMirrorV1WsUrl(sessionName: string, paneId: string, token?: string): string {
  let url = `${wsBaseFromApi()}/ws/mirror/${encodeURIComponent(sessionName)}/${paneId}`;
  if (token) {
    url += `?token=${encodeURIComponent(token)}`;
  }
  return url;
}

function getWsAuthToken(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    const fromStorage = window.localStorage.getItem("tmux-ide-ws-token");
    if (fromStorage) return fromStorage;
  }
  const env = process.env.NEXT_PUBLIC_WS_TOKEN;
  return env || undefined;
}

type ConnectionState = "connecting" | "connected" | "error";

interface MirrorTerminalProps {
  sessionName: string;
  paneId: string;
  paneName: string;
  className?: string;
  /** Optional JWT for HELLO (v3) and v1 `?token=` when auth is enabled on the command center. */
  authToken?: string;
}

export function MirrorTerminal({
  sessionName,
  paneId,
  paneName,
  className,
  authToken: authTokenProp,
}: MirrorTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const useV3Ref = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let term: Terminal | null = null;
    let ws: WebSocket | null = null;
    let fitAddon: FitAddon | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let v1FallbackStarted = false;

    const token = getWsAuthToken(authTokenProp);

    function cleanupTimers() {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    }

    function connectV1() {
      if (v1FallbackStarted || cancelled || !term) return;
      v1FallbackStarted = true;
      useV3Ref.current = false;
      cleanupTimers();

      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;

      const v1 = new WebSocket(getMirrorV1WsUrl(sessionName, paneId, token));

      v1.onopen = () => {
        if (cancelled) {
          v1.close();
          return;
        }
        ws = v1;
        setConnState("connected");
      };

      v1.onmessage = (event) => {
        const data = event.data;
        if (typeof data === "string" && data.startsWith("{")) {
          try {
            const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
            if (msg.type === "dimensions" && msg.cols && msg.rows) {
              term!.resize(msg.cols, msg.rows);
              return;
            }
          } catch {
            /* not JSON */
          }
        }
        term!.write(data);
      };

      v1.onclose = () => {
        if (cancelled) return;
        setConnState("error");
      };

      v1.onerror = () => {
        if (cancelled) return;
        setConnState("error");
      };
    }

    function tryConnectV3() {
      if (cancelled || !term) return;

      const v3 = new WebSocket(getV3WsUrl(sessionName, paneId));
      v3.binaryType = "arraybuffer";

      v3.onclose = () => {
        if (cancelled || v1FallbackStarted) return;
        if (useV3Ref.current && ws === v3) setConnState("error");
      };

      let handshake = true;
      let opened = false;

      fallbackTimer = setTimeout(() => {
        if (cancelled || opened) return;
        try {
          v3.close();
        } catch {
          /* ignore */
        }
        connectV1();
      }, 8000);

      v3.onopen = () => {
        if (cancelled) {
          v3.close();
          return;
        }
        opened = true;
        cleanupTimers();

        v3.onmessage = (event) => {
          if (cancelled || !term) return;
          const raw = event.data;
          const buf =
            raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
          const frame = decodeFrame(buf);
          if (!frame) return;

          if (handshake) {
            if (frame.type === WsV3MessageType.ERROR) {
              handshake = false;
              try {
                v3.close();
              } catch {
                /* ignore */
              }
              connectV1();
              return;
            }
            if (frame.type === WsV3MessageType.WELCOME) {
              handshake = false;
              return;
            }
          }

          if (frame.type === WsV3MessageType.STDOUT || frame.type === WsV3MessageType.SNAPSHOT_VT) {
            term.write(new TextDecoder().decode(frame.payload));
          }
        };

        v3.send(encodeHelloAuthFrame(token));
        window.setTimeout(() => {
          if (cancelled || v3.readyState !== WebSocket.OPEN) return;
          v3.send(encodeSubscribeStdoutFrame(paneSessionKey(sessionName, paneId)));
        }, 25);

        ws = v3;
        useV3Ref.current = true;
        setConnState("connected");
      };

      v3.onerror = () => {
        if (cancelled || opened) return;
        cleanupTimers();
        connectV1();
      };
    }

    async function setup() {
      await wasmReady;
      if (cancelled) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "Monaco, Menlo, 'Courier New', monospace",
        theme: {
          background: "#101010",
          foreground: "rgba(255, 255, 255, 0.936)",
          cursor: "#fab283",
          selectionBackground: "rgba(255, 255, 255, 0.15)",
          black: "#101010",
          red: "#fc533a",
          green: "#9bcd97",
          yellow: "#fcd53a",
          blue: "#56b6c2",
          magenta: "#edb2f1",
          cyan: "#56b6c2",
          white: "rgba(255, 255, 255, 0.936)",
        },
        scrollback: 10000,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.open(container!);
      if (cancelled) {
        term.dispose();
        return;
      }

      fitAddon.fit();

      term.onData((data: string) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (useV3Ref.current) {
          const key = paneSessionKey(sessionName, paneId);
          ws.send(encodeInputTextFrame(key, data));
        } else {
          ws.send(data);
        }
      });

      tryConnectV3();
    }

    setup();

    return () => {
      cancelled = true;
      cleanupTimers();
      ws?.close();
      term?.dispose();
    };
  }, [sessionName, paneId, authTokenProp]);

  const stateColor =
    connState === "connected"
      ? "var(--green)"
      : connState === "connecting"
        ? "var(--yellow)"
        : "var(--red)";

  return (
    <div className={className}>
      <div className="flex items-center h-6 px-2 bg-[var(--surface)] border-b border-[var(--border)]">
        <span
          className="w-1.5 h-1.5 rounded-full mr-2 shrink-0"
          style={{ backgroundColor: stateColor }}
        />
        <span className="text-[var(--dim)] text-xs truncate">{paneName}</span>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ width: "100%", height: "calc(100% - 24px)" }}
      />
    </div>
  );
}
