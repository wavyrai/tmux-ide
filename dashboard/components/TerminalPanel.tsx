"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5050";

function getWsUrl(widgetType: string): string {
  const base = API_BASE.replace(/^http/, "ws");
  return `${base}/ws/${widgetType}`;
}

interface TerminalPanelProps {
  widgetType: string;
  className?: string;
}

export function TerminalPanel({ widgetType, className }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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

    // Connect WebSocket
    const cols = term.cols;
    const rows = term.rows;
    const ws = new WebSocket(`${getWsUrl(widgetType)}?cols=${cols}&rows=${rows}`);
    wsRef.current = ws;

    ws.onopen = () => {
      term.writeln(`\x1b[2m connecting to ${widgetType}...\x1b[0m`);
    };

    ws.onmessage = (event) => {
      term.write(typeof event.data === "string" ? event.data : "");
    };

    ws.onclose = () => {
      term.writeln("\x1b[2m disconnected\x1b[0m");
    };

    ws.onerror = () => {
      term.writeln("\x1b[31m connection error\x1b[0m");
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
  }, [widgetType]);

  return (
    <div className={className}>
      <div className="flex items-center h-6 px-2 bg-[var(--surface)] border-b border-[var(--border)]">
        <span className="text-[var(--dim)] text-xs">{widgetType}</span>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0"
        style={{ width: "100%", height: "calc(100% - 24px)" }}
      />
    </div>
  );
}
