/**
 * FrontendPty — xterm-backed PTY surface that survives mount/unmount.
 *
 * One instance per `sessionId` for the full session lifetime. The
 * Terminal is created synchronously in the off-screen xterm host
 * (see `xterm-host.ts`) so scrollback + cursor state are preserved
 * across DOM moves. `mount(target)` reparents the owned container
 * into the visible slot; `unmount()` moves it back to the host. The
 * Terminal is never disposed until `dispose()` is called explicitly.
 *
 * WebSocket transport: opens `/ws/pty/:id`. The daemon's `PtyBridge`
 * replays its ring buffer atomically on connect, so we never miss
 * bytes between the snapshot and the first live frame.
 *
 * Wire frames (matches Terminal.tsx + ws-route.ts):
 *   server → client: binary stdout / `{type:"error",message}` /
 *                    `{type:"exit",code}`
 *   client → server: raw bytes for stdin / `{type:"init", cols, rows,
 *                    cwd?, cmd?}` / `{type:"resize", cols, rows}`
 */

import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { ensureXtermHost } from "./xterm-host";
import { withWsBase } from "@/lib/appProtocol";
import { getSettingsSnapshot, onSettingsChange, type Settings } from "@/lib/settings";

const SCROLLBACK_FALLBACK = 100_000;

export type FrontendPtyStatus = "disconnected" | "connecting" | "ready" | "error" | "exited";

export interface FrontendPtyOptions {
  cwd?: string;
  cmd?: string[];
  initialSize?: { cols: number; rows: number };
}

interface PtyExit {
  code: number;
}

type Listener<T> = (value: T) => void;

/** Read the dashboard's CSS-variable terminal palette. Theme switches
 *  cascade to live terminals via `applyThemeToAll()`. */
function readTerminalTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--term-bg", "#101010"),
    foreground: v("--term-fg", "#eeeeee"),
    cursor: v("--term-cursor", "#fab283"),
    selectionBackground: v("--term-selection", "#334155"),
  };
}

export class FrontendPty {
  /** Every live FrontendPty — used for theme broadcasts + teardown. */
  static readonly all = new Set<FrontendPty>();

  readonly terminal: XTerm;
  readonly ownedContainer: HTMLDivElement;
  private socket: WebSocket | null = null;
  private fitAddon: FitAddon | null = null;
  private webgl: WebglAddon | null = null;
  private initSent = false;
  private writeRaf: number | null = null;
  private queue: Uint8Array[] = [];
  private encoder = new TextEncoder();
  private statusListeners = new Set<Listener<FrontendPtyStatus>>();
  private exitListeners = new Set<Listener<PtyExit>>();
  private currentStatus: FrontendPtyStatus = "disconnected";
  private lastErrorMessage: string | null = null;
  /** Last { cols, rows } pushed over the WS resize frame. Used by
   *  `PaneSizingContext` to skip redundant resends. */
  lastSentDims: { cols: number; rows: number } | null = null;

  constructor(readonly sessionId: string) {
    this.ownedContainer = document.createElement("div");
    Object.assign(this.ownedContainer.style, {
      width: "100%",
      height: "100%",
    });

    const userSettings = getSettingsSnapshot().terminal;
    const cssFontFamily =
      typeof document !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
        : "";
    const fontFamily =
      userSettings.fontFamily ||
      cssFontFamily ||
      'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace';

    this.terminal = new XTerm({
      cols: 120,
      rows: 32,
      cursorBlink: userSettings.cursorBlink,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      fontFamily,
      fontSize: userSettings.fontSize,
      fontWeight: 400,
      fontWeightBold: 600,
      scrollback: userSettings.scrollback ?? SCROLLBACK_FALLBACK,
      convertEol: true,
      allowProposedApi: true,
      scrollOnUserInput: false,
      theme: readTerminalTheme(),
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.ownedContainer);
    if (userSettings.renderer !== "dom") {
      try {
        this.webgl = new WebglAddon();
        this.terminal.loadAddon(this.webgl);
      } catch {
        this.webgl = null;
      }
    } else {
      this.webgl = null;
    }

    const el = (this.terminal as unknown as { element?: HTMLElement }).element;
    if (el) {
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.backgroundColor = "transparent";
    }

    this.terminal.onData((data) => this.sendInput(data));
    this.terminal.onResize(({ cols, rows }) => this.dispatchResize(cols, rows));

    ensureXtermHost().appendChild(this.ownedContainer);
    FrontendPty.all.add(this);
  }

  get status(): FrontendPtyStatus {
    return this.currentStatus;
  }

  get errorMessage(): string | null {
    return this.lastErrorMessage;
  }

  onStatusChange(listener: Listener<FrontendPtyStatus>): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onExit(listener: Listener<PtyExit>): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private setStatus(next: FrontendPtyStatus): void {
    if (this.currentStatus === next) return;
    this.currentStatus = next;
    for (const fn of this.statusListeners) fn(next);
  }

  /** Open the WS connection. Idempotent — subsequent calls while a
   *  socket is live are no-ops. */
  connect(opts: FrontendPtyOptions = {}): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    this.setStatus("connecting");
    this.lastErrorMessage = null;
    const wsUrl = withWsBase(`/ws/pty/${encodeURIComponent(this.sessionId)}`);
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.initSent = false;

    socket.onopen = () => {
      const cols = opts.initialSize?.cols ?? this.terminal.cols ?? 120;
      const rows = opts.initialSize?.rows ?? this.terminal.rows ?? 32;
      socket.send(
        JSON.stringify({
          type: "init",
          cols,
          rows,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.cmd ? { cmd: opts.cmd } : {}),
        }),
      );
      this.lastSentDims = { cols, rows };
      this.initSent = true;
      this.setStatus("ready");
    };

    socket.onmessage = (event) => {
      const data = event.data;
      if (typeof data === "string" && data.startsWith("{")) {
        try {
          const frame = JSON.parse(data) as
            | { type: "error"; message: string }
            | { type: "exit"; code: number };
          if (frame.type === "error") {
            this.lastErrorMessage = frame.message;
            this.terminal.writeln(`\r\n[error] ${frame.message}`);
            this.setStatus("error");
            return;
          }
          if (frame.type === "exit") {
            this.terminal.writeln(`\r\n[session ended: ${frame.code}]`);
            this.setStatus("exited");
            for (const fn of this.exitListeners) fn({ code: frame.code });
            return;
          }
        } catch {
          // Fall through to byte-write.
        }
      }
      void this.enqueueMessage(data);
    };

    socket.onclose = () => {
      this.initSent = false;
      this.socket = null;
      if (this.currentStatus !== "error" && this.currentStatus !== "exited") {
        this.setStatus("disconnected");
      }
    };

    socket.onerror = () => {
      this.lastErrorMessage = "connection error";
      this.setStatus("error");
    };
  }

  private async enqueueMessage(data: unknown): Promise<void> {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (typeof data === "string") bytes = this.encoder.encode(data);
    else if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
    else return;
    if (bytes.byteLength === 0) return;
    this.queue.push(bytes);
    if (this.writeRaf !== null) return;
    this.writeRaf = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.writeRaf = null;
    if (this.queue.length === 0) return;
    if (this.queue.length === 1) {
      this.terminal.write(this.queue[0]!);
      this.queue = [];
      return;
    }
    const total = this.queue.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of this.queue) {
      merged.set(c, off);
      off += c.byteLength;
    }
    this.queue = [];
    this.terminal.write(merged);
  }

  /** Forward raw input to the daemon. Drops silently when the socket
   *  isn't open — callers can poll `status` to gate. */
  sendInput(data: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(this.encoder.encode(data));
  }

  private dispatchResize(cols: number, rows: number): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.initSent) return;
    if (this.lastSentDims && this.lastSentDims.cols === cols && this.lastSentDims.rows === rows) {
      return;
    }
    this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
    this.lastSentDims = { cols, rows };
  }

  /** Refit the terminal to its container. No-op if the container is
   *  detached (off-screen host) or the addon was disposed. */
  refit(): void {
    if (!this.fitAddon) return;
    if (!this.ownedContainer.isConnected) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* disposed terminal */
    }
  }

  /** Resize from outside the xterm DOM lifecycle. Used by
   *  PaneSizingContext to broadcast pane geometry to background
   *  sessions (their own xterm hasn't ResizeObserver-fired yet). */
  resize(cols: number, rows: number): void {
    if (
      this.terminal.cols === cols &&
      this.terminal.rows === rows &&
      this.lastSentDims?.cols === cols &&
      this.lastSentDims?.rows === rows
    ) {
      return;
    }
    try {
      this.terminal.resize(cols, rows);
    } catch {
      // xterm throws on disposed terminals; ignore.
    }
    this.dispatchResize(cols, rows);
  }

  /** Append the owned container into a visible slot. If targetDims
   *  are passed the xterm Terminal is resized BEFORE reparenting so
   *  the canvas paints at the right cell size on first frame. Forces
   *  a refresh next rAF so the canvas backing surface doesn't go
   *  blank after the DOM move. */
  mount(target: HTMLElement, targetDims?: { cols: number; rows: number }): void {
    if (
      targetDims &&
      (this.terminal.cols !== targetDims.cols || this.terminal.rows !== targetDims.rows)
    ) {
      try {
        this.terminal.resize(targetDims.cols, targetDims.rows);
      } catch {
        // ignore — disposed terminal
      }
    }
    target.appendChild(this.ownedContainer);
    requestAnimationFrame(() => {
      const t = this.terminal as unknown as { _isDisposed?: boolean };
      if (t._isDisposed) return;
      try {
        this.terminal.refresh(0, this.terminal.rows - 1);
        this.fitAddon?.fit();
        this.terminal.focus();
      } catch {
        // ignore
      }
    });
  }

  /** Move the container back to the off-screen host. The Terminal
   *  stays alive — scrollback + cursor are preserved. */
  unmount(): void {
    ensureXtermHost().appendChild(this.ownedContainer);
  }

  /** Tear down for good — closes the WS, disposes xterm, drops the
   *  container. Only called when the session is explicitly deleted
   *  (tab close in P3). */
  dispose(): void {
    FrontendPty.all.delete(this);
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
    this.socket = null;
    if (this.writeRaf !== null) {
      cancelAnimationFrame(this.writeRaf);
      this.writeRaf = null;
    }
    this.queue = [];
    try {
      this.webgl?.dispose();
    } catch {
      // ignore
    }
    this.webgl = null;
    try {
      this.fitAddon?.dispose();
    } catch {
      // ignore
    }
    this.fitAddon = null;
    try {
      this.terminal.dispose();
    } catch {
      // ignore
    }
    try {
      this.ownedContainer.remove();
    } catch {
      // ignore
    }
    this.setStatus("disconnected");
    this.statusListeners.clear();
    this.exitListeners.clear();
  }
}

/** Apply a theme update to every live FrontendPty. Called by the
 *  app-level theme switcher. */
export function applyThemeToAll(theme?: Partial<ITheme>): void {
  const base = readTerminalTheme();
  const next: ITheme = { ...base, ...(theme ?? {}) };
  for (const pty of FrontendPty.all) {
    pty.terminal.options.theme = next;
  }
}

/** Apply terminal preferences (fontSize, fontFamily, cursorBlink) to
 *  every live FrontendPty. `scrollback` and `renderer` aren't safely
 *  mutable on a running terminal — they take effect on next session. */
export function applyTerminalOptionsToAll(terminal: Settings["terminal"]): void {
  const cssFontFamily =
    typeof document !== "undefined"
      ? getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
      : "";
  const fontFamily =
    terminal.fontFamily ||
    cssFontFamily ||
    'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace';
  for (const pty of FrontendPty.all) {
    try {
      pty.terminal.options.fontSize = terminal.fontSize;
      pty.terminal.options.fontFamily = fontFamily;
      pty.terminal.options.cursorBlink = terminal.cursorBlink;
      pty.refit();
    } catch {
      /* disposed terminal — skip */
    }
  }
}

onSettingsChange((next, prev) => {
  if (
    next.terminal.fontSize === prev.terminal.fontSize &&
    next.terminal.fontFamily === prev.terminal.fontFamily &&
    next.terminal.cursorBlink === prev.terminal.cursorBlink
  ) {
    return;
  }
  applyTerminalOptionsToAll(next.terminal);
});

/** Dispose every live FrontendPty. Wired into the
 *  TerminalPoolProvider's `onCleanup`. */
export function disposeAllPtys(): void {
  for (const pty of [...FrontendPty.all]) {
    pty.dispose();
  }
}
