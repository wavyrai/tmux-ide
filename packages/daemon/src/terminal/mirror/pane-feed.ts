/**
 * PaneFeed — PURE per-subscriber delivery gate implementing the atomic
 * seed/reseed recipe (m43 flood spike, verified on tmux 3.7b).
 *
 * tmux is a painter, not a stream: history and the live screen are separate
 * authorities, and a capture may only be spliced onto a live stream at an
 * explicit seam. The seam works because the control channel is FIFO — the
 * `capture-pane` reply comes back at the exact point in the byte stream where
 * the capture was taken, so:
 *
 *   - every `%output` delta read BEFORE the capture reply was produced before
 *     the capture instant → its bytes are already IN the capture → DISCARD
 *     (applying them too would double-apply);
 *   - every delta read AFTER the capture reply is strictly-after-capture →
 *     it must be applied on top of the seed → no gap.
 *
 * The cursor probe is a second command issued back-to-back with the capture.
 * Deltas that land between the two replies (normally none — both commands sit
 * in one command-queue batch) are HELD and replayed after the seed but BEFORE
 * the cursor event: they were produced between the two probe instants, so the
 * cursor probe's answer already accounts for them.
 *
 * Overlapping reseeds are epoch-guarded: a newer `beginReseed` invalidates
 * every in-flight reply of the older one, so two captures from different
 * instants can never composite onto one screen.
 *
 * All transitions are synchronous — the caller invokes them inline from the
 * control channel's read loop, never from a promise continuation (a microtask
 * hop would let same-chunk deltas overtake the state change and be dropped).
 */
import type { MirrorPaneEvent } from "./events.ts";

export type PaneFeedState = "live" | "quarantined" | "awaiting-capture" | "awaiting-cursor";

/** Parsed `display-message "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"`. */
export interface CursorProbe {
  x: number;
  y: number;
  cols: number;
  rows: number;
}

/** PURE — parse the cursor/size probe reply line. Null on any malformed shape. */
export function parseCursorProbe(line: string): CursorProbe | null {
  const [x, y, cols, rows] = line.trim().split(/\s+/).map(Number);
  if (
    ![x, y, cols, rows].every((n) => Number.isInteger(n) && n !== undefined && n >= 0) ||
    !cols ||
    !rows
  ) {
    return null;
  }
  return { x: x!, y: y!, cols: cols!, rows: rows! };
}

/**
 * PURE — capture reply lines to seed bytes. The control client reads replies
 * as latin1 (one JS char per wire byte), so the reply is a byte string in
 * disguise: re-encode latin1 → bytes before the VT parser sees it, or every
 * multibyte glyph shatters into mojibake (the retained mirror lesson).
 */
export function seedBytesFromCapture(lines: readonly string[]): Uint8Array {
  return Buffer.from(lines.join("\r\n"), "latin1");
}

export class PaneFeed {
  static readonly MAX_HELD_CHUNKS = 512;
  static readonly MAX_HELD_BYTES = 1024 * 1024;
  private state: PaneFeedState = "live";
  private epoch = 0;
  private seedLines: readonly string[] | null = null;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private overflowed = false;

  currentState(): PaneFeedState {
    return this.state;
  }

  /** Arm a reseed. Returns the epoch token the two reply hooks must present;
   *  an in-flight older reseed is invalidated wholesale. */
  beginReseed(): number {
    this.epoch += 1;
    this.state = "awaiting-capture";
    this.seedLines = null;
    this.held = [];
    this.heldBytes = 0;
    this.overflowed = false;
    return this.epoch;
  }

  /** Route one live output delta. Discarded while a capture is pending (the
   *  bytes are in the capture), held while the cursor probe is pending, and a
   *  plain delta event otherwise. */
  delta(data: Uint8Array): MirrorPaneEvent[] {
    if (this.state === "live") return [{ type: "delta", data }];
    if (this.state === "quarantined") return [];
    if (this.state === "awaiting-cursor") {
      if (
        this.held.length >= PaneFeed.MAX_HELD_CHUNKS ||
        this.heldBytes + data.byteLength > PaneFeed.MAX_HELD_BYTES
      ) {
        this.state = "quarantined";
        this.seedLines = null;
        this.held = [];
        this.heldBytes = 0;
        this.overflowed = true;
        return [];
      }
      this.held.push(data);
      this.heldBytes += data.byteLength;
    }
    return [];
  }

  takeOverflowed(): boolean {
    const overflowed = this.overflowed;
    this.overflowed = false;
    return overflowed;
  }

  /** The capture reply landed (synchronously, in channel read order). */
  captureReply(epoch: number, lines: readonly string[]): void {
    if (epoch !== this.epoch || this.state !== "awaiting-capture") return;
    this.seedLines = lines;
    this.state = "awaiting-cursor";
  }

  /**
   * The cursor/size probe reply landed — emit the atomic seed batch:
   * `reset, seed, …held deltas, cursor`. On a malformed probe line the batch
   * degrades honestly: with `fallbackSize` known the reset still happens (no
   * cursor event); with nothing to size the emulator by, only seed + held
   * deltas flow (the consumer keeps its previous grid).
   */
  cursorReply(
    epoch: number,
    line: string,
    fallbackSize: { cols: number; rows: number } | null = null,
  ): MirrorPaneEvent[] {
    if (epoch !== this.epoch || this.state !== "awaiting-cursor") return [];
    const seed = seedBytesFromCapture(this.seedLines ?? []);
    const held = this.held;
    this.state = "live";
    this.seedLines = null;
    this.held = [];
    this.heldBytes = 0;

    const probe = parseCursorProbe(line);
    const events: MirrorPaneEvent[] = [];
    if (probe) events.push({ type: "reset", cols: probe.cols, rows: probe.rows });
    else if (fallbackSize) {
      events.push({ type: "reset", cols: fallbackSize.cols, rows: fallbackSize.rows });
    }
    events.push({ type: "seed", data: seed });
    for (const data of held) events.push({ type: "delta", data });
    if (probe) events.push({ type: "cursor", x: probe.x, y: probe.y });
    return events;
  }

  /** A probe errored (pane raced away, channel died). Quarantine subsequent
   *  deltas until a new authoritative seed succeeds or the owner retires it. */
  abort(epoch: number): void {
    if (epoch !== this.epoch || this.state === "live") return;
    this.state = "quarantined";
    this.seedLines = null;
    this.held = [];
    this.heldBytes = 0;
    this.overflowed = false;
  }

  abortCurrent(): void {
    this.epoch += 1;
    this.state = "quarantined";
    this.seedLines = null;
    this.held = [];
    this.heldBytes = 0;
    this.overflowed = false;
  }

  /** Keep a completed authoritative snapshot as the recovery candidate while
   * dropping later raw deltas until the owner proves convergence. */
  quarantine(epoch: number): void {
    if (epoch !== this.epoch || this.state !== "live") return;
    this.state = "quarantined";
  }

  /** Recovery owner only: the published candidate has passed its independent
   * confirmation proof, so subsequent deltas may flow again. */
  releaseQuarantine(): void {
    if (this.state === "quarantined") this.state = "live";
  }
}
