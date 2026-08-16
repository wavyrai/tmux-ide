/**
 * The MirrorService's tmux control-mode channel (m43 card 1).
 *
 * One channel per session, spawned with the flood-spike's VERIFIED policy:
 * `attach -f ignore-size,pause-after=2,active-pane` keeps this retained
 * observer size-passive, bounds server-side buffering for a stalled reader
 * (~2s x output rate), and switches pane bytes to the
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
import { parseControlLine } from "../protocol/control.ts";

export interface ControlReply {
  ok: boolean;
  lines: string[];
}

export interface MirrorChannelHandlers {
  /** Live pane bytes, both framings decoded. `ageMs` is null for plain
   *  `%output` and the server-buffer age for `%extended-output`. */
  onOutput: (
    pane: string,
    data: Uint8Array,
    ageMs: number | null,
    timing?: MirrorOutputTiming,
  ) => void;
  onNotify: (name: string, rest: string) => void;
  onExit: (reason: string | null) => void;
}

/**
 * Daemon-local timing for one complete control-mode output line. This stays
 * optional so production avoids clocks entirely when runtime observability is
 * disabled. `receivedAtMicros` is the child stdout callback which supplied
 * the beginning of the line; `parsedAtMicros` is immediately after protocol
 * parsing and before the semantic pane feed is notified.
 */
export interface MirrorOutputTiming {
  readonly receivedAtMicros: number;
  readonly parsedAtMicros: number;
}

/** The io surface the session channel drives; tests inject a fake. */
export interface MirrorChannelIo {
  /** Outstanding control replies before a new command is written. */
  readonly pendingCount?: number;
  start(): Promise<void>;
  /** Reply-matched command; resolution order follows the wire FIFO but the
   *  continuation is a microtask — use ONLY where output ordering is moot
   *  (identity join, stamping, window listing). */
  request(cmd: string): Promise<string[]>;
  /** Reply-matched command whose callback fires SYNCHRONOUSLY in channel read
   *  order — the seed recipe's primitive. */
  commandInline(cmd: string, onReply: (reply: ControlReply) => void): void;
  /** Atomic command-list with one reply block per command; selects the block
   *  delivered to the synchronous callback and discards the rest. */
  commandListInline(
    cmd: string,
    replyCount: number,
    resultIndex: number,
    onReply: (reply: ControlReply) => void,
  ): void;
  /** Fire-and-forget (input fast path): the reply block is consumed and
   *  dropped, errors counted. */
  send(cmd: string, onReply?: (reply: ControlReply) => void): void;
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
  | { kind: "discard"; onReply?: (reply: ControlReply) => void };

/**
 * PURE protocol state for one control-mode byte stream. Feed it latin1
 * chunks; it dispatches complete events synchronously to the handlers and the
 * pending-reply FIFO. Every write the owner makes MUST be paired with exactly
 * one {@link push} (every control-mode command produces exactly one
 * `%begin`/`%end|%error` block, so the FIFO stays aligned by construction).
 */
export class ControlChannelCore {
  private buffer = "";
  private bufferReceivedAtMicros: number | null = null;
  private inReply = false;
  /** The greeting is the sole flags=0 block that belongs to pending work.
   *  Subsequent flags=0 blocks are tmux hook command results, emitted on the
   *  initiating control client but not caused by an input line. */
  private awaitingGreeting = true;
  private currentReplyConsumesPending = false;
  private readonly pending: ReplySink[] = [];
  private discardedErrors = 0;
  private failed = false;

  constructor(
    private readonly handlers: MirrorChannelHandlers,
    private readonly nowMicros?: () => number,
  ) {}

  push(sink: ReplySink): void {
    this.pending.push(sink);
  }

  get inputErrorCount(): number {
    return this.discardedErrors;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  feed(chunk: string, receivedAtMicros?: number): void {
    if (this.buffer.length === 0 && receivedAtMicros !== undefined)
      this.bufferReceivedAtMicros = receivedAtMicros;
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(nl + 1);
      const lineReceivedAtMicros = this.bufferReceivedAtMicros;
      this.bufferReceivedAtMicros = this.buffer.length > 0 ? (receivedAtMicros ?? null) : null;
      this.handleLine(line, lineReceivedAtMicros);
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

  private handleLine(line: string, receivedAtMicros: number | null): void {
    const event = parseControlLine(line, this.inReply);
    const timing =
      receivedAtMicros !== null && this.nowMicros
        ? Object.freeze({
            receivedAtMicros,
            parsedAtMicros: this.nowMicros(),
          })
        : undefined;
    switch (event.kind) {
      case "begin":
        this.inReply = true;
        this.currentReplyConsumesPending = this.awaitingGreeting || event.flags !== 0;
        break;
      case "reply-line": {
        const head = this.currentReplyConsumesPending ? this.pending[0] : undefined;
        if (head && head.kind !== "discard") head.lines.push(event.line);
        break;
      }
      case "end":
      case "error": {
        this.inReply = false;
        if (!this.currentReplyConsumesPending) {
          this.currentReplyConsumesPending = false;
          break;
        }
        this.currentReplyConsumesPending = false;
        this.awaitingGreeting = false;
        const sink = this.pending.shift();
        if (!sink) break; // unsolicited block (greeting after a race)
        if (sink.kind === "discard") {
          if (event.kind === "error") this.discardedErrors++;
          sink.onReply?.({ ok: event.kind === "end", lines: [] });
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
        this.handlers.onOutput(event.pane, event.data, null, timing);
        break;
      case "extended-output":
        this.handlers.onOutput(event.pane, event.data, event.ageMs, timing);
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
  /** Qualification-only clock. Omitted in production's zero-observer path. */
  nowMicros?: () => number;
}

export function mirrorControlAttachArgs(
  options: Pick<
    MirrorControlChannelOptions,
    "session" | "socketName" | "socketPath" | "configFile"
  >,
  pauseAfterSeconds = DEFAULT_PAUSE_AFTER_SECONDS,
): string[] {
  return [
    ...(options.socketPath
      ? ["-S", options.socketPath]
      : options.socketName
        ? ["-L", options.socketName]
        : []),
    ...(options.configFile ? ["-f", options.configFile] : []),
    "-C",
    "attach",
    "-t",
    options.session,
    "-f",
    `ignore-size,pause-after=${pauseAfterSeconds},active-pane`,
  ];
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
    this.core = new ControlChannelCore(
      {
        ...opts.handlers,
        onExit: (reason) => this.noteExit(reason),
      },
      opts.nowMicros,
    );
  }

  start(): Promise<void> {
    const pauseAfter = this.opts.pauseAfterSeconds ?? DEFAULT_PAUSE_AFTER_SECONDS;
    const args = mirrorControlAttachArgs(this.opts, pauseAfter);
    const proc = spawn(this.opts.executable ?? "tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMUX: "" },
    });
    this.proc = proc;
    // A control client whose session is killed exits while we may still be
    // writing to it, and a pipe error on a child stream arrives ASYNCHRONOUSLY
    // as an 'error' event — no try/catch around `write()` can catch it, and an
    // unhandled one takes the whole daemon down. Process exit is the only
    // authority on channel death (it fails every pending sink below), so pipe
    // errors are inert here by design.
    proc.stdin?.on("error", () => {});
    proc.stdout!.on("error", () => {});
    proc.stderr?.on("error", () => {});
    proc.stdout!.setEncoding("latin1");
    proc.stdout!.on("data", (chunk: string) => this.core.feed(chunk, this.opts.nowMicros?.()));
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

  commandListInline(
    cmd: string,
    replyCount: number,
    resultIndex: number,
    onReply: (reply: ControlReply) => void,
  ): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) {
      onReply({ ok: false, lines: ["control channel not running"] });
      return;
    }
    if (replyCount < 1 || resultIndex < 0 || resultIndex >= replyCount) {
      onReply({ ok: false, lines: ["invalid control command-list reply selection"] });
      return;
    }
    for (let index = 0; index < replyCount; index++) {
      this.core.push(
        index === resultIndex ? { kind: "inline", onReply, lines: [] } : { kind: "discard" },
      );
    }
    proc.stdin.write(`${cmd}\n`);
  }

  send(cmd: string, onReply?: (reply: ControlReply) => void): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return;
    this.core.push({ kind: "discard", ...(onReply ? { onReply } : {}) });
    proc.stdin.write(`${cmd}\n`);
  }

  get inputErrorCount(): number {
    return this.core.inputErrorCount;
  }

  get pendingCount(): number {
    return this.core.pendingCount;
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
