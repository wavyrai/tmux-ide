"use client";

import { useEffect, useRef, useState } from "react";
import { init, Terminal, FitAddon } from "ghostty-web";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

// Initialize WASM once at module level
const wasmReady = init();

function getMirrorWsUrl(sessionName: string, paneId: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws/mirror/${encodeURIComponent(sessionName)}/${paneId}`;
}

type ConnectionState = "connecting" | "connected" | "error";

interface MirrorTerminalProps {
  sessionName: string;
  paneId: string;
  paneName: string;
  className?: string;
}

export function MirrorTerminal({ sessionName, paneId, paneName, className }: MirrorTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connState, setConnState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let term: Terminal | null = null;
    let ws: WebSocket | null = null;
    let fitAddon: FitAddon | null = null;

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
      // Don't call fitAddon.observeResize() — we match the tmux pane size,
      // not the browser container size. Resizing from the browser would shrink
      // the tmux pane for all clients (tmux uses smallest client size).

      // Forward keyboard input to WebSocket
      term.onData((data: string) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Connect WebSocket to mirror endpoint
      ws = new WebSocket(getMirrorWsUrl(sessionName, paneId));

      ws.onopen = () => {
        if (cancelled) {
          ws!.close();
          return;
        }
        setConnState("connected");
      };

      ws.onmessage = (event) => {
        const data = event.data;
        if (typeof data === "string" && data.startsWith("{")) {
          try {
            const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
            if (msg.type === "dimensions" && msg.cols && msg.rows) {
              // Resize terminal to match tmux pane (don't resize tmux!)
              term!.resize(msg.cols, msg.rows);
              return;
            }
          } catch {
            /* not JSON, fall through */
          }
        }
        // Raw bytes from server — write directly
        term!.write(data);
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnState("error");
      };

      ws.onerror = () => {
        if (cancelled) return;
        setConnState("error");
      };
    }

    setup();

    return () => {
      cancelled = true;
      ws?.close();
      term?.dispose();
    };
  }, [sessionName, paneId]);

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
