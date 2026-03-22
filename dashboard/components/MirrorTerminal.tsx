"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

function getMirrorWsUrl(sessionName: string, paneId: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws/mirror/${encodeURIComponent(sessionName)}/${encodeURIComponent(paneId)}`;
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
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [connState, setConnState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'IBM Plex Mono', monospace",
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
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(container);

    // Try WebGL renderer for performance, fall back to canvas
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available — canvas renderer is fine
    }

    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Connect WebSocket to mirror endpoint
    const ws = new WebSocket(getMirrorWsUrl(sessionName, paneId));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnState("connected");
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;

      try {
        const msg = JSON.parse(event.data) as {
          type: string;
          data?: string;
          cols?: number;
          rows?: number;
        };

        switch (msg.type) {
          case "scrollback":
          case "content":
            if (msg.data != null) {
              // For content updates, clear and rewrite the visible area
              if (msg.type === "content") {
                term.reset();
              }
              term.write(msg.data);
            }
            break;
          case "dimensions":
            // Server reported pane dimensions — resize to match
            if (msg.cols && msg.rows) {
              term.resize(msg.cols, msg.rows);
            }
            break;
        }
      } catch {
        // Not JSON — write raw data
        term.write(event.data);
      }
    };

    ws.onclose = () => {
      setConnState("error");
      term.writeln("\x1b[2m disconnected\x1b[0m");
    };

    ws.onerror = () => {
      setConnState("error");
    };

    // Forward keyboard input to WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      fitRef.current = null;
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
