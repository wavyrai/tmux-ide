/**
 * InputCoalescer — the pure core of the input fast path (M21.5).
 *
 * Burst-typed LITERAL characters coalesce into one buffered run per pane and
 * leave as a single `send-keys -H <hex…>` write per flush; named/ctrl keys
 * (Enter, C-c, Up, …) are emitted immediately. THE ordering invariant: any
 * buffered literal run flushes BEFORE a named key — or a literal for a
 * DIFFERENT pane — is emitted, so bytes reach the pane in exactly the order
 * the user produced them.
 *
 * Pure core, io shell: this class owns no timers and does no io. The caller
 * injects `emit` (where flushed actions go — the control client's
 * fire-and-forget write in production) and `schedule` (when a pending literal
 * buffer should auto-flush — a microtask in production, a hand-cranked stub in
 * tests). A microtask flush still happens inside the same macrotask that
 * buffered the keystroke — strictly before the process can read more input —
 * so coalescing adds no perceivable latency; it only merges keystrokes that
 * arrived together.
 *
 * Flushes re-chunk the buffered run under {@link SEND_KEYS_CHUNK_BYTES} so a
 * large paste routed through the same path never produces an oversized
 * control-mode command.
 */
import { chunkByBytes } from "./selection.ts";

/**
 * Max UTF-8 payload bytes per `send-keys -H` write. Every byte travels as its
 * own `xx` argv token, and each token hits tmux's yacc command parser — which
 * is the REAL constraint, measured empirically against tmux 3.6b control mode
 * (M21.5), not a line-length cap:
 *
 *   - HARD LIMIT: a 16 KB payload (≈16k tokens) is REJECTED outright with
 *     `%error: yacc stack overflow` (yacc's ~10k-entry stack).
 *   - PARSE COST is superlinear in tokens: one command's reply takes ~3 ms at
 *     1 KB, ~9 ms at 2 KB, ~56 ms at 4 KB, ~170 ms at 8 KB — big chunks STALL
 *     the tmux server (and every interleaved keystroke behind it).
 *   - END-TO-END, a 100 KB paste lands byte-perfect in ~246/155/180/233/255/
 *     561/1483 ms at 64/128/256/512/1024/2048/4096-byte chunks — the optimum
 *     is ~128–256 B; the pre-M21.5 1024 was past the knee, and RAISING the
 *     chunk (the naive read of "fewer commands = faster") is strictly worse.
 *
 * 256 B is chosen: within noise of the throughput optimum, ~1 ms of server
 * parse per command (imperceptible for input interleaving), 5× headroom from
 * nothing, and 40× from the yacc cliff.
 */
export const SEND_KEYS_CHUNK_BYTES = 256;

/** One flushed input action, ready to become a control-mode write. */
export type InputAction =
  | { kind: "literal"; pane: string; text: string }
  | { kind: "key"; pane: string; key: string };

export class InputCoalescer {
  private pane = "";
  private buf = "";
  private scheduled = false;

  constructor(
    private readonly emit: (action: InputAction) => void,
    private readonly schedule: (flush: () => void) => void,
    private readonly maxChunkBytes: number = SEND_KEYS_CHUNK_BYTES,
  ) {}

  /** Buffer literal text for `pane`; a pending run for ANOTHER pane flushes
   *  first so cross-pane order is preserved. Schedules an auto-flush once per
   *  pending run. */
  literal(pane: string, text: string): void {
    if (!pane || !text) return;
    if (this.buf.length > 0 && this.pane !== pane) this.flush();
    this.pane = pane;
    this.buf += text;
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => {
        this.scheduled = false;
        this.flush();
      });
    }
  }

  /** Emit a named tmux key (Enter, C-c, Up, …) — pending literals flush first
   *  (synchronously) so the key can never overtake buffered characters. */
  key(pane: string, key: string): void {
    if (!pane || !key) return;
    this.flush();
    this.emit({ kind: "key", pane, key });
  }

  /** Drain the pending literal run now (chunked under the byte cap). Also the
   *  ordering barrier callers place before reply-matched structural commands. */
  flush(): void {
    if (this.buf.length === 0) return;
    const pane = this.pane;
    const text = this.buf;
    this.buf = "";
    for (const chunk of chunkByBytes(text, this.maxChunkBytes)) {
      this.emit({ kind: "literal", pane, text: chunk });
    }
  }

  /** Buffered-but-unflushed character count (tests/introspection only). */
  pending(): number {
    return this.buf.length;
  }
}
