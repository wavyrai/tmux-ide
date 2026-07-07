/**
 * A tmux control-mode client.
 *
 * Spawns `tmux -C attach -t <target>` and speaks the control protocol over
 * stdio: commands written to stdin get their replies back wrapped in
 * `%begin`/`%end` blocks (FIFO order), while live pane bytes stream in as
 * `%output` notifications between blocks. This is the same integration
 * surface iTerm2 uses for its native tmux mode — tmux stays the multiplexer
 * and persistence layer; the caller renders.
 *
 * stdout is read as latin1 (one JS char per byte) so pane bytes survive
 * intact; `parseControlLine`/`decodeControlBytes` do the pure protocol work.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseControlLine, textToHexKeys } from "./control.ts";

interface PendingReply {
  discard?: false;
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  lines: string[];
}

/** A fire-and-forget command's FIFO placeholder: its reply block is consumed
 *  and dropped (errors counted). `lines` collects the error body only when
 *  TMUX_IDE_MIRROR_DEBUG asks for it. */
interface DiscardedReply {
  discard: true;
  lines?: string[];
}

type Pending = PendingReply | DiscardedReply;

/** The shared no-debug placeholder — fire-and-forget input allocates NOTHING. */
const DISCARDED: DiscardedReply = { discard: true };

export interface ControlClientOptions {
  /** Session (or other tmux target) to attach the control client to. */
  attachTarget: string;
  /** Live pane bytes: `%output` events, decoded. */
  onOutput?: (pane: string, data: Uint8Array) => void;
  /** Non-output notifications (layout-change, window-add, …). */
  onNotify?: (name: string, rest: string) => void;
  /** Control client ended (tmux exited or detached us). */
  onExit?: (reason: string | null) => void;
}

export class ControlModeClient {
  private proc: ChildProcess | null = null;
  private readonly pending: Pending[] = [];
  private inReply = false;
  private buffer = "";
  private discardedErrors = 0;
  private readonly opts: ControlClientOptions;

  constructor(opts: ControlClientOptions) {
    this.opts = opts;
  }

  /** Spawn the control client and resolve once tmux's greeting block passed. */
  start(): Promise<void> {
    const proc = spawn("tmux", ["-C", "attach", "-t", this.opts.attachTarget], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TMUX: "" },
    });
    this.proc = proc;
    proc.stdout!.setEncoding("latin1");
    proc.stdout!.on("data", (chunk: string) => this.feed(chunk));
    proc.on("exit", () => this.opts.onExit?.(null));

    // tmux opens the conversation with an unsolicited %begin/%end greeting
    // block; queue a resolver for it so `start()` settles when the protocol
    // is actually live (and so the pending queue stays aligned).
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve: () => resolve(), reject, lines: [] });
      proc.on("error", reject);
    });
  }

  /** Run a tmux command over the control channel, resolving its reply body. */
  command(cmd: string): Promise<string[]> {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return Promise.reject(new Error("control client not running"));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, lines: [] });
      proc.stdin!.write(`${cmd}\n`);
    });
  }

  /**
   * The INPUT FAST PATH (M21.5): write a command fire-and-forget. The bytes
   * hit tmux's stdin exactly as immediately as `command()`'s do, but no
   * Promise/resolver is allocated and nothing ever waits on the reply. Every
   * control-mode command still produces exactly one `%begin/%end` block, so a
   * placeholder is pushed onto the SAME pending FIFO — reply matching for
   * reply-carrying commands (list-panes, capture-pane, …) stays aligned by
   * construction. Errors are swallowed but counted ({@link inputErrorCount});
   * with TMUX_IDE_MIRROR_DEBUG set the error body is appended to
   * /tmp/zz-input-errors.log.
   */
  send(cmd: string): void {
    const proc = this.proc;
    if (!proc?.stdin?.writable) return;
    this.pending.push(process.env.TMUX_IDE_MIRROR_DEBUG ? { discard: true, lines: [] } : DISCARDED);
    proc.stdin.write(`${cmd}\n`);
  }

  /** Type literal text into a pane (UTF-8, sent as hex bytes — quote-proof).
   *  Fire-and-forget: input never queues behind a slow structural reply. */
  sendText(pane: string, text: string): void {
    this.send(`send-keys -t ${pane} -H ${textToHexKeys(text).join(" ")}`);
  }

  /** Send a named tmux key (Enter, Escape, Up, C-c, …) to a pane. Fire-and-forget. */
  sendKey(pane: string, key: string): void {
    this.send(`send-keys -t ${pane} ${key}`);
  }

  /** How many fire-and-forget commands came back `%error` (debug/tests). */
  get inputErrorCount(): number {
    return this.discardedErrors;
  }

  dispose(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin?.write("detach-client\n");
    } catch {
      // already gone
    }
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill();
    }, 250).unref?.();
  }

  private feed(chunk: string): void {
    const t0 = process.env.TMUX_IDE_ZZ_PERF ? performance.now() : 0;
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      // tmux terminates lines with \r\n in control mode; strip both.
      let line = this.buffer.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
    if (t0) {
      try {
        appendFileSync(
          "/tmp/zz-feed.log",
          `${chunk.length} ${(performance.now() - t0).toFixed(2)}\n`,
        );
      } catch {
        /* perf tap */
      }
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
        // Discarded (fire-and-forget) replies skip body collection entirely —
        // unless the debug placeholder brought its own lines buffer.
        if (head) head.lines?.push(event.line);
        break;
      }
      case "end":
      case "error": {
        this.inReply = false;
        const reply = this.pending.shift();
        if (!reply) break; // unsolicited block (e.g. greeting after a race)
        if (reply.discard) {
          if (event.kind === "error") {
            this.discardedErrors++;
            if (process.env.TMUX_IDE_MIRROR_DEBUG) {
              try {
                appendFileSync(
                  "/tmp/zz-input-errors.log",
                  `#${this.discardedErrors} ${reply.lines?.join(" | ") ?? ""}\n`,
                );
              } catch {
                // debug tap only
              }
            }
          }
          break;
        }
        if (event.kind === "error") {
          reply.reject(new Error(reply.lines.join("\n") || "tmux command failed"));
        } else {
          reply.resolve(reply.lines);
        }
        break;
      }
      case "output":
        this.opts.onOutput?.(event.pane, event.data);
        break;
      case "exit":
        this.opts.onExit?.(event.reason);
        break;
      case "notify":
        this.opts.onNotify?.(event.name, event.rest);
        break;
    }
  }
}
