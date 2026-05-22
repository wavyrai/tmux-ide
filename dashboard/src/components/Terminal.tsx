/**
 * Solid xterm host — slimmer port of `dashboard/components/Terminal.tsx`.
 *
 * Lifecycle:
 *   - `onMount` boots the xterm instance + FitAddon and (when supported)
 *     WebglAddon. ResizeObserver fits on container changes.
 *   - WebSocket opens against `/ws/pty/:id` via `withWsBase`, sends
 *     `init` with cols/rows + optional cwd/cmd, streams output through
 *     a coalescing rAF write queue, forwards keystrokes / resize.
 *   - `onCleanup` disposes all handles and closes the socket.
 *
 * Deliberately omits the React port's transcript / settings hooks /
 * cursorStyle plumbing — those land in G16-P3 alongside the Solid
 * settings store. Theme is read from CSS variables on the document
 * root so theme switches still cascade.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { withWsBase } from "@/lib/appProtocol";

type ConnectionState = "loading" | "connecting" | "connected" | "disconnected" | "error";

interface TerminalProps {
  id: string;
  cwd?: string;
  cmd?: string[];
  showHeader?: boolean;
  onSessionExit?: (id: string) => void;
}

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

async function messageToBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === "string") return new TextEncoder().encode(data);
  return new Uint8Array();
}

export function Terminal(props: TerminalProps) {
  let host!: HTMLDivElement;
  const [state, setState] = createSignal<ConnectionState>("loading");
  const [message, setMessage] = createSignal("loading renderer");

  onMount(() => {
    let disposed = false;
    let term: XTerm | null = null;
    let fitAddon: FitAddon | null = null;
    let webgl: WebglAddon | null = null;
    let socket: WebSocket | null = null;
    let observer: ResizeObserver | null = null;
    let initSent = false;
    let writeRaf: number | null = null;
    let queue: Uint8Array[] = [];
    const encoder = new TextEncoder();

    const flush = () => {
      writeRaf = null;
      if (!term || queue.length === 0) return;
      if (queue.length === 1) {
        term.write(queue[0]!);
        queue = [];
        return;
      }
      const total = queue.reduce((s, c) => s + c.byteLength, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of queue) {
        merged.set(c, off);
        off += c.byteLength;
      }
      queue = [];
      term.write(merged);
    };
    const enqueue = (bytes: Uint8Array) => {
      queue.push(bytes);
      if (writeRaf !== null) return;
      writeRaf = requestAnimationFrame(flush);
    };

    void (async () => {
      try {
        if (document.fonts?.ready) {
          await document.fonts.ready;
          if (disposed) return;
        }
        const fontFamily =
          getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
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
          scrollback: 10_000,
          allowProposedApi: true,
          theme: readTerminalTheme(),
        });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(host);
        try {
          webgl = new WebglAddon();
          term.loadAddon(webgl);
        } catch {
          webgl = null;
        }
        fitAddon.fit();
        term.focus();

        observer = new ResizeObserver(() => fitAddon?.fit());
        observer.observe(host);

        term.onData((data) => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
        });
        term.onResize(({ cols, rows }) => {
          if (socket?.readyState === WebSocket.OPEN && initSent) {
            socket.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        });

        const wsUrl = withWsBase(`/ws/pty/${encodeURIComponent(props.id)}`);
        socket = new WebSocket(wsUrl);
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
              ...(props.cwd ? { cwd: props.cwd } : {}),
              ...(props.cmd ? { cmd: props.cmd } : {}),
            }),
          );
          initSent = true;
          setState("connected");
          setMessage("connected");
        };
        socket.onmessage = async (event) => {
          if (!term) return;
          if (typeof event.data === "string" && event.data.startsWith("{")) {
            const frame = JSON.parse(event.data) as
              | { type: "error"; message: string }
              | { type: "exit"; code: number };
            if (frame.type === "error") {
              setState("error");
              setMessage(frame.message);
              term.writeln(`\r\n[error] ${frame.message}`);
            } else if (frame.type === "exit") {
              setState("disconnected");
              setMessage(`exit ${frame.code}`);
              term.writeln(`\r\n[session ended: ${frame.code}]`);
              props.onSessionExit?.(props.id);
            }
            return;
          }
          const bytes = await messageToBytes(event.data);
          if (bytes.byteLength > 0) enqueue(bytes);
        };
        socket.onclose = () => {
          if (disposed) return;
          initSent = false;
          setState((current) => (current === "error" ? current : "disconnected"));
        };
        socket.onerror = () => {
          setState("error");
          setMessage("connection error");
        };
      } catch (err) {
        setState("error");
        setMessage(err instanceof Error ? err.message : String(err));
      }
    })();

    onCleanup(() => {
      disposed = true;
      observer?.disconnect();
      observer = null;
      socket?.close();
      socket = null;
      webgl?.dispose();
      webgl = null;
      fitAddon?.dispose();
      fitAddon = null;
      term?.dispose();
      term = null;
      if (writeRaf !== null) cancelAnimationFrame(writeRaf);
    });
  });

  return (
    <div
      data-testid="v2-terminal-host"
      class="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--term-bg,#101010)]"
    >
      <Show when={props.showHeader}>
        <div class="flex h-6 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-2 text-xs uppercase tracking-wide text-[var(--dim)]">
          <span>{props.id}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="v2-terminal-state">{state()}</span>
          <span aria-hidden="true">·</span>
          <span>{message()}</span>
        </div>
      </Show>
      <div ref={host} class="min-h-0 flex-1" />
    </div>
  );
}
