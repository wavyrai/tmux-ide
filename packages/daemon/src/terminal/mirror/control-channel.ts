/**
 * The MirrorService's tmux control-mode channel (m43 card 1).
 *
 * One channel per session, spawned with the flood-spike's VERIFIED policy:
 * `attach -f pause-after=2` bounds server-side buffering for a stalled
 * reader (~2s x output rate) and switches pane bytes to the
 * `%extended-output` framing whose age field is fall-behind telemetry. Both
 * framings are parsed (`parseControlLine` — shared with the TUI mirror, which
 * never sets pause flags and so never sees the extended framing).
 *
 * The pure {@link ControlChannelCore} owns protocol state: the line splitter,
 * the pending-reply FIFO, and SYNCHRONOUS dispatch. Reply callbacks fire
 * inline from the read loop — never from a promise continuation — because the
 * seed recipe's discard-until-reply gate is only gapless if the state flips
 * before the next `%output` line of the same chunk is processed.
 *
 * Disposal hygiene (spike-verified): resume a stalled reader, write
 * `detach-client`, and only escalate to signals after the server has had its
 * chance to detach us — killing the reader first can wedge the server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { parseControlLine } from "../../tui/mirror/control.ts";

export interface ControlReply {
  ok: boolean;
  lines: string[];
}

export interface MirrorChannelHandlers {
  /** Live pane bytes, both framings decoded. `ageMs` is null for plain
   *  `%output` and the server-buffer age for `%extended-output`. */
  onOutput: (pane: string, data: Uint8Array, ageMs: number | null) => void;
  onNotify: (name: string, rest: string) => void;
  onExit: (reason: string | null) => void;
}

/** The io surface the session channel drives; tests inject a fake. */
export interface MirrorChannelIo {
  start(): Promise<void>;
  /** Reply-matched command; resolution order follows the wire FIFO but the
   *  continuation is a microtask — use ONLY where output ordering is moot
   *  (identity join, stamping, window listing). */
  request(cmd: string): Promise<string[]>;
  /** Reply-matched command whose callback fires SYNCHRONOUSLY in channel read
   *  order — the seed recipe's primitive. */
  commandInline(cmd: string, onReply: (reply: ControlReply) => void): void;
  /** Fire-and-forget (input fast path): the reply block is consumed and
   *  dropped, errors counted. */
  send(cmd: string): void;
  dispose(): Promise<void>;
}

type ReplySink =
  | {
      kind: "promise";
      resolve: (lines: string[]) => void;
      reject: (err: Error) => void;
      lines: string[];
    }
  | { kind: "inline"; onReply: (reply: ControlReply) => void; lines: string[] }
  | { kind: "discard" };

/**
 * PURE protocol state for one control-mode byte stream. Feed it latin1
 * chunks; it dispatches complete events synchronously to the handlers and the
 * pending-reply FIFO. Every write the owner makes MUST be paired with exactly
 * one {@link push} (every control-mode command produces exactly one
 * `%begin`/`%end|%error` block, so the FIFO stays aligned by construction).
 */
export class ControlChannelCore {
  private buffer = "";
  private inReply = false;
  private readonly pending: ReplySink[] = [];
  private discardedErrors = 0;
  private failed = false;

  constructor(private readonly handlers: MirrorChannelHandlers) {}

  push(sink: ReplySink): void {
    this.pending.push(sink);
  }

  get inputErrorCount(): number {
    return this.discardedErrors;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  /** The stream died: settle every pending sink so no caller hangs. */
  fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    for (const sink of this.pending.splice(0)) {
      if (sink.kind === "promise") sink.reject(new Error(reason));
      else if (sink.kind === "inline") sink.onReply({ ok: false, lines: [reason] });
    }
  }

  private handleLine(line: string): void {
    const event = parseControlLine(line, this.inReply);
    switch (event.kind) {
      case "begin":
        this.inReply = true;
        break;
      case "reply-line": {
        const head = this.pending[0];
        if (head && head.kind !== "discard") head.lines.push(event.line);
        break;
      }
      case "end":
      case "error": {
        this.inReply = false;
        const sink = this.pending.shift();
        if (!sink) break; // unsolicited block (greeting after a race)
        if (sink.kind === "discard") {
          if (event.kind === "error") this.discardedErrors++;
          break;
        }
        if (sink.kind === "inline") {
          sink.onReply({ ok: event.kind === "end", lines: sink.lines });
          break;
        }
        if (event.kind === "error") {
          sink.reject(new Error(sink.lines.join("\n") || "tmux command failed"));
        } else {
          sink.resolve(sink.lines);
        }
        break;
      }
      case "output":
        this.handlers.onOutput(event.pane, event.data, null);
        break;
      case "extended-output":
        this.handlers.onOutput(event.pane, event.data, event.ageMs);
        break;
      case "exit":
        this.handlers.onExit(event.reason);
        break;
      case "notify":
        this.handlers.onNotify(event.name, event.rest);
        break;
    }
  }
}

export interface MirrorControlChannelOptions {
  session: string;
  handlers: MirrorChannelHandlers;
  /** `tmux -L <name>` — isolated servers in tests; omit for the default. */
  socketName?: string;
  /** `tmux -S <path>` — an explicit socket authority (wins over socketName). */
  socketPath?: string;
  /** Absolute tmux executable; defaults to `tmux` on PATH. */
  executable?: string;
  /** `tmux -f <file>` (server config, only honored when the server is born
   *  from this attach) — tests pass /dev/null. */
  configFile?: string;
  /** `attach -f pause-after=<s>` — the verified flow-control policy. */
  pauseAfterSeconds?: number;
}

/** Spike-verified default: bounds a stalled reader's server-side buffering
 *  without pausing during ordinary render hitches. */
export const DEFAULT_PAUSE_AFTER_SECONDS = 2;

export class MirrorControlChannel implements MirrorChannelIo {
  private proc: ChildProcess | null = null;
  private readonly core: ControlChannelCore;
  private readonly opts: MirrorControlChannelOptions;
  private exited = false;

  constructor(opts: MirrorControlChannelOptions) {
    this.opts = opts;
    this.core = new ControlChannelCore({
      ...opts.handlers,
      onExit: (reason) => this.noteExit(reason),
    });
  }

  start(): Promise<void> {
    const { session, socketName, socketPath, configFile } = this.opts;
    const pauseAfter = this.opts.pauseAfterSeconds ?? DEFAULT_PAUSE_AFTER_SECONDS;
    const args = [
      ...(socketPath ? ["-S", socketPath] : socketName ? ["-L", socketName] : []),
      ...(configFile ? ["-f", configFile] : []),
      "-C",
      "attach",
      "-t",
      session,
      "-f",
      `pause-after=${pauseAfter}`,
    ];
    const proc = spawn(this.opts.executable ?? "tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMUX: "" },
    });
    this.proc = proc;
    proc.stdout!.setEncoding("latin1");
    proc.stdout!.on("data", (chunk: string) => this.core.feed(chunk));
    proc.on("exit", () => {
      this.core.fail("control channel exited");
      this.noteExit(null);
    });
    // tmux opens with an unsolicited %begin/%end greeting block; a queued
    // resolver makes start() settle when the protocol is actually live.
    return new Promise((resolve, reject) => {
      this.core.push({ kind: "promise", resolve: () => resolve(), reject, lines: [] });
      proc.on("error", (err) => {
        this.core.fail(String(err));
        reject(err);
      });
    });
  }

  request(cmd: string): Promise<string[]> {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return Promise.reject(new Error("control channel not running"));
    return new Promise((resolve, reject) => {
      this.core.push({ kind: "promise", resolve, reject, lines: [] });
      proc.stdin!.write(`${cmd}\n`);
    });
  }

  commandInline(cmd: string, onReply: (reply: ControlReply) => void): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) {
      onReply({ ok: false, lines: ["control channel not running"] });
      return;
    }
    this.core.push({ kind: "inline", onReply, lines: [] });
    proc.stdin.write(`${cmd}\n`);
  }

  send(cmd: string): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return;
    this.core.push({ kind: "discard" });
    proc.stdin.write(`${cmd}\n`);
  }

  get inputErrorCount(): number {
    return this.core.inputErrorCount;
  }

  /** TESTS ONLY — stop draining tmux's stdout to simulate a stalled renderer
   *  (the flood/%pause live scenario). */
  stallReaderForTest(): void {
    this.proc?.stdout?.pause();
  }

  /** TESTS ONLY — resume the stalled reader. */
  resumeReaderForTest(): void {
    this.proc?.stdout?.resume();
  }

  /**
   * Detach-before-kill hygiene: resume a stalled reader (the server must be
   * able to flush), ask tmux to detach us, and drain until the process exits;
   * signals are a fallback, never the first move (wedged-server hazard).
   */
  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdout?.resume();
    } catch {
      // already gone
    }
    try {
      proc.stdin?.write("detach-client\n");
    } catch {
      // already gone
    }
    if (await waitForExit(proc, 750)) return;
    try {
      proc.kill();
    } catch {
      // already gone
    }
    if (await waitForExit(proc, 500)) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    await waitForExit(proc, 250);
  }

  private noteExit(reason: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.opts.handlers.onExit(reason);
  }
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    proc.once("exit", onExit);
  });
}
