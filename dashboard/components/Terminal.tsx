"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

function readTerminalTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--term-bg", "#101010"),
    foreground: v("--term-fg", "#eeeeee"),
    cursor: v("--term-cursor", "#fab283"),
    selectionBackground: v("--term-selection", "#334155"),
    black: v("--term-black", "#101010"),
    red: v("--term-red", "#fc533a"),
    green: v("--term-green", "#9bcd97"),
    yellow: v("--term-yellow", "#fcd53a"),
    blue: v("--term-blue", "#60a5fa"),
    magenta: v("--term-magenta", "#edb2f1"),
    cyan: v("--term-cyan", "#56b6c2"),
    white: v("--term-white", "#eeeeee"),
    brightBlack: v("--term-bright-black", "#777777"),
    brightRed: v("--term-bright-red", "#ff7a66"),
    brightGreen: v("--term-bright-green", "#b8e6b3"),
    brightYellow: v("--term-bright-yellow", "#ffe36d"),
    brightBlue: v("--term-bright-blue", "#93c5fd"),
    brightMagenta: v("--term-bright-magenta", "#f5c7f7"),
    brightCyan: v("--term-bright-cyan", "#80d7e2"),
    brightWhite: v("--term-bright-white", "#ffffff"),
  };
}

type ConnectionState = "loading" | "connecting" | "connected" | "disconnected" | "error";

interface TerminalProps {
  id: string;
  className?: string;
  showHeader?: boolean;
  cwd?: string;
  cmd?: string[];
  onSessionExit?: (id: string) => void;
}

interface TerminalSize {
  cols: number;
  rows: number;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n\t ]+/g, " ");
}

async function messageToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array();
}

export function Terminal({
  id,
  className,
  showHeader = true,
  cwd,
  cmd,
  onSessionExit,
}: TerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<ConnectionState>("loading");
  const [message, setMessage] = useState("loading renderer");
  const [size, setSize] = useState<TerminalSize>({ cols: 80, rows: 24 });
  const [transcript, setTranscript] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const hostElement = host;

    let disposed = false;
    let socket: WebSocket | null = null;
    let term: XTerm | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let initSent = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const appendTranscript = (value: string) => {
      const clean = stripAnsi(value);
      if (!clean) return;
      setTranscript((current) => `${current}${clean}`.slice(-12000));
    };

    async function boot() {
      try {
        if (typeof document !== "undefined" && document.fonts?.ready) {
          await document.fonts.ready;
          if (disposed) return;
        }

        const computed = getComputedStyle(document.documentElement);
        const fontFamily =
          computed.getPropertyValue("--font-mono").trim() ||
          'ui-monospace, SFMono-Regular, "JetBrains Mono", "Menlo", monospace';

        term = new XTerm({
          cols: 80,
          rows: 24,
          cursorBlink: true,
          cursorStyle: "block",
          cursorInactiveStyle: "outline",
          fontFamily,
          fontSize: 13,
          fontWeight: 400,
          fontWeightBold: 600,
          letterSpacing: 0,
          lineHeight: 1.2,
          scrollback: 5000,
          smoothScrollDuration: 80,
          allowProposedApi: true,
          allowTransparency: false,
          drawBoldTextInBrightColors: false,
          theme: readTerminalTheme(),
        });
        termRef.current = term;

        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(hostElement);
        fitAddon.fit();
        term.focus();
        setSize({ cols: term.cols, rows: term.rows });

        resizeObserver = new ResizeObserver(() => {
          fitAddon?.fit();
        });
        resizeObserver.observe(hostElement);

        const dataDisposable = term.onData((data) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(encoder.encode(data));
          }
        });

        const binaryDisposable = term.onBinary((data) => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(encoder.encode(data));
          }
        });

        const resizeDisposable = term.onResize(({ cols, rows }) => {
          setSize({ cols, rows });
          if (socket?.readyState === WebSocket.OPEN && initSent) {
            socket.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        });

        const port = process.env.NEXT_PUBLIC_TMUX_IDE_SERVER_PORT ?? "6070";
        const wsHost = typeof window !== "undefined" ? window.location.hostname : "localhost";
        const wsProto =
          typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws";
        socket = new WebSocket(`${wsProto}://${wsHost}:${port}/ws/pty/${encodeURIComponent(id)}`);
        socket.binaryType = "arraybuffer";
        setState("connecting");
        setMessage("connecting");

        socket.onopen = () => {
          if (!term || !socket) return;
          const cols = term.cols || 80;
          const rows = term.rows || 24;
          socket.send(
            JSON.stringify({
              type: "init",
              cols,
              rows,
              ...(cwd ? { cwd } : {}),
              ...(cmd ? { cmd } : {}),
            }),
          );
          initSent = true;
          setSize({ cols, rows });
          setState("connected");
          setMessage("connected");
        };

        socket.onmessage = async (event) => {
          if (!term) return;

          if (typeof event.data === "string" && event.data.startsWith("{")) {
            const frame = JSON.parse(event.data) as
              | { type: "error"; message: string }
              | { type: "exit"; code: number; signal: string | number | null };
            if (frame.type === "error") {
              setState("error");
              setMessage(frame.message);
              term.writeln(`\r\n[error] ${frame.message}`);
            } else if (frame.type === "exit") {
              setState("disconnected");
              setMessage(`exit ${frame.code}`);
              term.writeln(`\r\n[session ended: ${frame.code}]`);
              appendTranscript(`\n[session ended: ${frame.code}]\n`);
              onSessionExit?.(id);
            }
            return;
          }

          const bytes = await messageToBytes(event.data);
          if (bytes.byteLength === 0) return;
          term.write(bytes);
          appendTranscript(decoder.decode(bytes, { stream: true }));
        };

        socket.onclose = () => {
          if (disposed) return;
          initSent = false;
          setState((current) => (current === "error" ? current : "disconnected"));
          setMessage((current) => (current.startsWith("exit ") ? current : "disconnected"));
        };

        socket.onerror = () => {
          setState("error");
          setMessage("connection error");
        };

        return () => {
          dataDisposable.dispose();
          binaryDisposable.dispose();
          resizeDisposable.dispose();
        };
      } catch (err) {
        setState("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }
    }

    let disposeTerminalHandlers: (() => void) | undefined;
    boot().then((handlers) => {
      disposeTerminalHandlers = handlers;
    });

    return () => {
      disposed = true;
      initSent = false;
      disposeTerminalHandlers?.();
      socket?.close();
      resizeObserver?.disconnect();
      fitAddon?.dispose();
      term?.dispose();
      termRef.current = null;
      hostElement.replaceChildren();
    };
  }, [cmd, cwd, id, onSessionExit]);

  // Re-apply terminal theme whenever next-themes flips the resolved theme.
  // CSS vars on :root update synchronously, but xterm caches its renderer's
  // colors per cell — push the new theme AND force a full repaint so the
  // existing buffer recolors immediately.
  useEffect(() => {
    if (!termRef.current) return;
    const apply = () => {
      const term = termRef.current;
      if (!term) return;
      term.options.theme = readTerminalTheme();
      term.refresh(0, term.rows - 1);
    };
    requestAnimationFrame(apply);
  }, [resolvedTheme]);

  const dotClass =
    state === "connected"
      ? "bg-[var(--green)]"
      : state === "error"
        ? "bg-[var(--red)]"
        : "bg-[var(--yellow)]";

  return (
    <section
      className={`flex min-h-0 flex-1 flex-col bg-[var(--term-bg)] ${className ?? ""}`}
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {showHeader && (
        <div className="h-7 shrink-0 border-b border-[var(--border-weak)] bg-[var(--surface)] px-3 flex items-center gap-3 text-[11px] tracking-[0.02em]">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`}
            aria-hidden="true"
          />
          <span className="text-[var(--fg-secondary)]">terminal</span>
          <span className="text-[var(--dim)]">/</span>
          <span className="text-[var(--accent)]">{id}</span>
          <span className="ml-auto text-[var(--dim)] tabular-nums">
            {size.cols}×{size.rows}
          </span>
          <span className="text-[var(--dim)]">·</span>
          <span className="text-[var(--fg-secondary)]">{message}</span>
        </div>
      )}
      <div
        ref={hostRef}
        data-testid="terminal-frame"
        data-state={state}
        data-cols={size.cols}
        data-rows={size.rows}
        // Suppress the browser's native context menu so right-click goes to
        // the PTY (tmux mouse-mode treats it as a binding, e.g. paste / menu).
        onContextMenu={(event) => event.preventDefault()}
        className="min-h-0 flex-1 overflow-hidden bg-[var(--term-bg)] px-3 py-2 focus:outline-none"
        style={{ fontFamily: "var(--font-mono)" }}
      />
      <pre data-testid="terminal-transcript" className="sr-only" aria-hidden="true">
        {transcript}
      </pre>
    </section>
  );
}

export default Terminal;
