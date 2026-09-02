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

export type AtomicPaneSnapshotFailureReason =
  | "busy"
  | "channel-exit"
  | "foreign-sentinel"
  | "duplicate-sentinel"
  | "sentinel-order"
  | "capture-byte-cap"
  | "capture-line-cap"
  | "cursor-cardinality"
  | "cursor-byte-cap"
  | "unexpected-post-line"
  | "marker-rejected"
  | "timeout"
  | "retired";

export interface AtomicPaneSnapshotResult {
  readonly ok: boolean;
  readonly captureLines: readonly string[];
  readonly cursorLine: string | null;
  readonly continueObserved: boolean;
  readonly statusObserved: boolean;
  readonly observerEmissionObserved: boolean;
  readonly started: boolean;
  readonly lastCompletedOrdinal: number;
  readonly captureLineCount: number;
  readonly captureByteCount: number;
  readonly failureReason: AtomicPaneSnapshotFailureReason | null;
}

export interface AtomicPaneSnapshotProgress {
  readonly started: boolean;
  readonly lastCompletedOrdinal: number;
  readonly captureLineCount: number;
  readonly captureByteCount: number;
  readonly continueObserved: boolean;
  readonly statusObserved: boolean;
  readonly observerEmissionObserved: boolean;
}

export interface AtomicPaneSnapshotCollector {
  readonly nonce: string;
  readonly runtimePaneId: string;
  readonly maxCaptureBytes: number;
  readonly maxCaptureLines: number;
  readonly maxCursorBytes: number;
  /** Number of silent synchronous observer commands between continue and the
   * marker-unset command (production: set-buffer + wait-for -S). */
  readonly observerCommandCount: number;
  /** Authenticated, bounded forward progress for the currently armed owner. */
  readonly onProgress?: (progress: AtomicPaneSnapshotProgress) => void;
  readonly onSettled: (result: AtomicPaneSnapshotResult) => void;
}

const ATOMIC_CAPTURE_BYTE_HARD_CAP = 16 * 1024 * 1024;
const ATOMIC_CAPTURE_LINE_HARD_CAP = 8_192;
const ATOMIC_CURSOR_BYTE_HARD_CAP = 1_024;

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
  /** Arm the single raw hook-body collector before invoking its hook. Raw
   * capture rows are consumed before ordinary control notification parsing. */
  armAtomicPaneSnapshotCollector?(spec: AtomicPaneSnapshotCollector, timeoutMs: number): boolean;
  retireAtomicPaneSnapshotCollector?(nonce: string, reason?: AtomicPaneSnapshotFailureReason): void;
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
  | {
      kind: "command-list";
      state: {
        readonly resultIndex: number;
        readonly onReply: (reply: ControlReply) => void;
        readonly lines: string[];
        settled: boolean;
      };
      readonly index: number;
    }
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
  private currentReplyNum: number | null = null;
  private currentReplyFlags: number | null = null;
  /** The greeting is the sole flags=0 block that belongs to pending work.
   *  Subsequent flags=0 blocks are tmux hook command results, emitted on the
   *  initiating control client but not caused by an input line. */
  private awaitingGreeting = true;
  private currentReplyConsumesPending = false;
  private readonly pending: ReplySink[] = [];
  private discardedErrors = 0;
  private failed = false;
  private atomicCollector: {
    spec: AtomicPaneSnapshotCollector;
    started: boolean;
    blockOrdinal: number;
    blockContentCount: number;
    captureLines: string[];
    captureBytes: number;
    totalLines: number;
    totalBytes: number;
    cursorLine: string | null;
    continueObserved: boolean;
    statusObserved: boolean;
    observerEmissionObserved: boolean;
    lastCompletedOrdinal: number;
    failureReason: AtomicPaneSnapshotFailureReason | null;
  } | null = null;

  constructor(
    private readonly handlers: MirrorChannelHandlers,
    private readonly nowMicros?: () => number,
  ) {}

  push(sink: ReplySink): void {
    this.pending.push(sink);
  }

  pushCommandList(
    replyCount: number,
    resultIndex: number,
    onReply: (reply: ControlReply) => void,
  ): void {
    const state = { resultIndex, onReply, lines: [], settled: false };
    for (let index = 0; index < replyCount; index += 1)
      this.pending.push({ kind: "command-list", state, index });
  }

  get inputErrorCount(): number {
    return this.discardedErrors;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  armAtomicPaneSnapshotCollector(spec: AtomicPaneSnapshotCollector): boolean {
    if (this.failed || this.atomicCollector) return false;
    if (!/^[0-9a-f]{32,128}$/.test(spec.nonce) || !/^%\d+$/.test(spec.runtimePaneId)) return false;
    if (
      !Number.isSafeInteger(spec.maxCaptureBytes) ||
      spec.maxCaptureBytes < 1 ||
      spec.maxCaptureBytes > ATOMIC_CAPTURE_BYTE_HARD_CAP ||
      !Number.isSafeInteger(spec.maxCaptureLines) ||
      spec.maxCaptureLines < 1 ||
      spec.maxCaptureLines > ATOMIC_CAPTURE_LINE_HARD_CAP ||
      !Number.isSafeInteger(spec.maxCursorBytes) ||
      spec.maxCursorBytes < 1 ||
      spec.maxCursorBytes > ATOMIC_CURSOR_BYTE_HARD_CAP ||
      !Number.isSafeInteger(spec.observerCommandCount) ||
      spec.observerCommandCount < 0 ||
      spec.observerCommandCount > 4
    )
      return false;
    this.atomicCollector = {
      spec,
      started: false,
      blockOrdinal: -1,
      blockContentCount: 0,
      captureLines: [],
      captureBytes: 0,
      totalLines: 0,
      totalBytes: 0,
      cursorLine: null,
      continueObserved: false,
      statusObserved: false,
      observerEmissionObserved: false,
      lastCompletedOrdinal: -1,
      failureReason: null,
    };
    return true;
  }

  retireAtomicPaneSnapshotCollector(
    nonce: string,
    reason: AtomicPaneSnapshotFailureReason = "retired",
  ): boolean {
    const collector = this.atomicCollector;
    if (!collector || collector.spec.nonce !== nonce) return false;
    this.atomicCollector = null;
    collector.spec.onSettled(
      Object.freeze({
        ok: false,
        captureLines: Object.freeze([]),
        cursorLine: null,
        continueObserved: collector.continueObserved,
        statusObserved: collector.statusObserved,
        observerEmissionObserved: collector.observerEmissionObserved,
        started: collector.started,
        lastCompletedOrdinal: collector.lastCompletedOrdinal,
        captureLineCount: collector.captureLines.length,
        captureByteCount: collector.captureBytes,
        failureReason: collector.failureReason ?? reason,
      }),
    );
    return true;
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
    if (this.atomicCollector)
      this.retireAtomicPaneSnapshotCollector(this.atomicCollector.spec.nonce, "channel-exit");
    for (const sink of this.pending.splice(0)) {
      if (sink.kind === "promise") sink.reject(new Error(reason));
      else if (sink.kind === "inline") sink.onReply({ ok: false, lines: [reason] });
      else if (sink.kind === "command-list" && !sink.state.settled) {
        sink.state.settled = true;
        sink.state.onReply({ ok: false, lines: [reason] });
      }
    }
  }

  private handleLine(line: string, receivedAtMicros: number | null): void {
    if (this.consumeAtomicPaneSnapshotLine(line)) return;
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
        this.currentReplyNum = event.num;
        this.currentReplyFlags = event.flags;
        this.currentReplyConsumesPending = this.awaitingGreeting || event.flags !== 0;
        break;
      case "reply-line": {
        const head = this.currentReplyConsumesPending ? this.pending[0] : undefined;
        if (head?.kind === "promise" || head?.kind === "inline") head.lines.push(event.line);
        else if (head?.kind === "command-list" && head.index === head.state.resultIndex)
          head.state.lines.push(event.line);
        break;
      }
      case "end":
      case "error": {
        this.inReply = false;
        this.currentReplyNum = null;
        this.currentReplyFlags = null;
        if (!this.currentReplyConsumesPending) {
          this.currentReplyConsumesPending = false;
          break;
        }
        this.currentReplyConsumesPending = false;
        this.awaitingGreeting = false;
        const sink = this.pending.shift();
        if (!sink) break; // unsolicited block (greeting after a race)
        if (sink.kind === "command-list") {
          if (event.kind === "error" && sink.index !== sink.state.resultIndex)
            this.discardedErrors += 1;
          if (event.kind === "error" && sink.index === 0) {
            while (this.pending[0]?.kind === "command-list" && this.pending[0].state === sink.state)
              this.pending.shift();
            if (!sink.state.settled) {
              sink.state.settled = true;
              sink.state.onReply({ ok: false, lines: sink.state.lines });
            }
          } else if (sink.index === sink.state.resultIndex && !sink.state.settled) {
            sink.state.settled = true;
            sink.state.onReply({ ok: event.kind === "end", lines: sink.state.lines });
          }
          break;
        }
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

  private consumeAtomicPaneSnapshotLine(line: string): boolean {
    const collector = this.atomicCollector;
    if (!collector) return false;
    const prefix = "%tmux-ide-atomic-v1 ";
    const ownPrefix = `${prefix}${collector.spec.nonce} `;
    if (line.startsWith(prefix) && !line.startsWith(ownPrefix)) {
      collector.failureReason ??= "foreign-sentinel";
      return true;
    }
    const token = line.startsWith(ownPrefix) ? line.slice(ownPrefix.length) : null;
    if (!collector.started) {
      if (token === null) return false;
      if (
        token !== "start" ||
        !this.inReply ||
        this.currentReplyFlags !== 0 ||
        this.currentReplyNum === null
      ) {
        collector.failureReason ??= "sentinel-order";
        return true;
      }
      collector.started = true;
      collector.blockOrdinal = 0;
      collector.blockContentCount = 1;
      this.reportAtomicPaneSnapshotProgress(collector);
      return true;
    }
    collector.totalLines += 1;
    collector.totalBytes += Buffer.byteLength(line, "latin1") + 1;
    if (collector.totalLines > collector.spec.maxCaptureLines + 64)
      collector.failureReason ??= "capture-line-cap";
    if (collector.totalBytes > collector.spec.maxCaptureBytes + 64 * 1024)
      collector.failureReason ??= "capture-byte-cap";

    const guard = parseControlLine(line, this.inReply);
    if (guard.kind === "begin") {
      if (guard.flags !== 0 || this.inReply) collector.failureReason ??= "sentinel-order";
      this.inReply = true;
      this.currentReplyNum = guard.num;
      this.currentReplyFlags = guard.flags;
      collector.blockOrdinal += 1;
      collector.blockContentCount = 0;
      return true;
    }
    if (guard.kind === "end" || guard.kind === "error") {
      const guardInvalid =
        !this.inReply ||
        guard.flags !== 0 ||
        this.currentReplyFlags !== 0 ||
        guard.num !== this.currentReplyNum;
      if (guardInvalid) collector.failureReason ??= "sentinel-order";
      if (guard.kind === "error") collector.failureReason ??= "sentinel-order";
      // The ownership compare-and-unset is an if-shell command plus exactly
      // one selected branch command. Both commands retain the control client
      // and therefore each has its own flags=0 guard block.
      const markerBranchOrdinal = 7 + collector.spec.observerCommandCount;
      const statusOrdinal = 8 + collector.spec.observerCommandCount;
      const completeOrdinal = 10 + collector.spec.observerCommandCount;
      const contentRequired = new Set([0, 2, 3, 4, statusOrdinal, completeOrdinal]);
      const contentSilent =
        collector.blockOrdinal !== 1 &&
        collector.blockOrdinal !== markerBranchOrdinal &&
        !contentRequired.has(collector.blockOrdinal);
      const markerBranchValid =
        collector.blockOrdinal !== markerBranchOrdinal || collector.blockContentCount <= 1;
      if (
        (contentRequired.has(collector.blockOrdinal) && collector.blockContentCount !== 1) ||
        (contentSilent && collector.blockContentCount !== 0) ||
        !markerBranchValid
      )
        collector.failureReason ??= "sentinel-order";
      if (
        guard.kind === "end" &&
        !guardInvalid &&
        collector.spec.observerCommandCount > 0 &&
        collector.blockOrdinal === 5 + collector.spec.observerCommandCount
      )
        collector.observerEmissionObserved = true;
      if (!guardInvalid && guard.kind === "end") {
        collector.lastCompletedOrdinal = collector.blockOrdinal;
        this.reportAtomicPaneSnapshotProgress(collector);
      }
      this.inReply = false;
      this.currentReplyNum = null;
      this.currentReplyFlags = null;
      if (collector.blockOrdinal === completeOrdinal) {
        this.atomicCollector = null;
        const ok =
          collector.failureReason === null &&
          collector.cursorLine !== null &&
          collector.statusObserved;
        collector.spec.onSettled(
          Object.freeze({
            ok,
            captureLines: Object.freeze(ok ? [...collector.captureLines] : []),
            cursorLine: ok ? collector.cursorLine : null,
            continueObserved: collector.continueObserved,
            statusObserved: collector.statusObserved,
            observerEmissionObserved: collector.observerEmissionObserved,
            started: collector.started,
            lastCompletedOrdinal: collector.lastCompletedOrdinal,
            captureLineCount: collector.captureLines.length,
            captureByteCount: collector.captureBytes,
            failureReason: ok ? null : (collector.failureReason ?? "sentinel-order"),
          }),
        );
      }
      return true;
    }

    if (line === `%continue ${collector.spec.runtimePaneId}` && collector.blockOrdinal === 5) {
      if (collector.continueObserved) collector.failureReason ??= "duplicate-sentinel";
      collector.continueObserved = true;
      return true;
    }
    if (!this.inReply && (line === "%exit" || line.startsWith("%exit "))) {
      this.retireAtomicPaneSnapshotCollector(collector.spec.nonce, "channel-exit");
      return false;
    }

    if (!this.inReply) {
      collector.failureReason ??= "unexpected-post-line";
      return true;
    }

    const markerBranchOrdinal = 7 + collector.spec.observerCommandCount;
    const statusOrdinal = 8 + collector.spec.observerCommandCount;
    const completeOrdinal = 10 + collector.spec.observerCommandCount;
    collector.blockContentCount += 1;
    if (collector.blockOrdinal === 1) {
      collector.captureBytes += Buffer.byteLength(line, "latin1") + 1;
      if (collector.captureBytes > collector.spec.maxCaptureBytes)
        collector.failureReason ??= "capture-byte-cap";
      if (collector.captureLines.length >= collector.spec.maxCaptureLines)
        collector.failureReason ??= "capture-line-cap";
      else collector.captureLines.push(line);
      this.reportAtomicPaneSnapshotProgress(collector);
      return true;
    }
    if (collector.blockOrdinal === 3) {
      if (collector.cursorLine !== null) collector.failureReason ??= "cursor-cardinality";
      else if (Buffer.byteLength(line, "latin1") > collector.spec.maxCursorBytes)
        collector.failureReason ??= "cursor-byte-cap";
      else collector.cursorLine = line;
      return true;
    }
    const markerRejected = `marker-rejected`;
    if (collector.blockOrdinal === markerBranchOrdinal) {
      collector.failureReason ??= token === markerRejected ? "marker-rejected" : "sentinel-order";
      return true;
    }
    const expectedToken =
      collector.blockOrdinal === 2
        ? "capture-end"
        : collector.blockOrdinal === 4
          ? "cursor-end"
          : collector.blockOrdinal === statusOrdinal
            ? "status-ok"
            : collector.blockOrdinal === completeOrdinal
              ? "complete"
              : null;
    if (expectedToken === null || token !== expectedToken)
      collector.failureReason ??= token === "start" ? "duplicate-sentinel" : "sentinel-order";
    if (collector.blockOrdinal === statusOrdinal && token === "status-ok") {
      if (collector.statusObserved) collector.failureReason ??= "duplicate-sentinel";
      collector.statusObserved = true;
    }
    return true;
  }

  private reportAtomicPaneSnapshotProgress(
    collector: NonNullable<ControlChannelCore["atomicCollector"]>,
  ): void {
    if (collector.failureReason !== null) return;
    collector.spec.onProgress?.(
      Object.freeze({
        started: collector.started,
        lastCompletedOrdinal: collector.lastCompletedOrdinal,
        captureLineCount: Math.min(collector.captureLines.length, ATOMIC_CAPTURE_LINE_HARD_CAP),
        captureByteCount: Math.min(collector.captureBytes, ATOMIC_CAPTURE_BYTE_HARD_CAP),
        continueObserved: collector.continueObserved,
        statusObserved: collector.statusObserved,
        observerEmissionObserved: collector.observerEmissionObserved,
      }),
    );
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
  private atomicCollectorTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.core.pushCommandList(replyCount, resultIndex, onReply);
    proc.stdin.write(`${cmd}\n`);
  }

  armAtomicPaneSnapshotCollector(spec: AtomicPaneSnapshotCollector, timeoutMs: number): boolean {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) return false;
    const wrapped = {
      ...spec,
      onSettled: (result: AtomicPaneSnapshotResult): void => {
        if (this.atomicCollectorTimer) clearTimeout(this.atomicCollectorTimer);
        this.atomicCollectorTimer = null;
        spec.onSettled(result);
      },
    };
    if (!this.core.armAtomicPaneSnapshotCollector(wrapped)) return false;
    this.atomicCollectorTimer = setTimeout(() => {
      this.atomicCollectorTimer = null;
      this.core.retireAtomicPaneSnapshotCollector(spec.nonce, "timeout");
    }, timeoutMs);
    this.atomicCollectorTimer.unref?.();
    return true;
  }

  retireAtomicPaneSnapshotCollector(
    nonce: string,
    reason: AtomicPaneSnapshotFailureReason = "retired",
  ): void {
    if (!this.core.retireAtomicPaneSnapshotCollector(nonce, reason)) return;
    if (this.atomicCollectorTimer) clearTimeout(this.atomicCollectorTimer);
    this.atomicCollectorTimer = null;
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
    if (this.atomicCollectorTimer) clearTimeout(this.atomicCollectorTimer);
    this.atomicCollectorTimer = null;
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
