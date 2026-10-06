import type { MirrorPaneEvent } from "./events.ts";

/** Identity of one pane-wide, observed-pause snapshot attempt. */
export interface StockPaneSnapshotContext {
  readonly paneId: string;
  readonly incarnation: number;
  readonly layoutGeneration: number;
  readonly participants: readonly object[];
}

export interface StockPaneSnapshotBatch {
  readonly participant: object;
  /** Capture-time metadata only. Live bytes are owned by the transaction. */
  readonly events: readonly MirrorPaneEvent[];
}

export type StockPaneSnapshotFailure =
  | "cancelled"
  | "context-changed"
  | "context-unavailable"
  | "pause-not-observed"
  | "repaused"
  | "overflow"
  | "invalid-snapshot"
  | "consumer-error";

export type StockPaneSnapshotOutput = "unrelated" | "discarded" | "held" | "invalid" | "live";

/**
 * Stock control-mode output may overtake a capture reply behind sibling output.
 * An observed pause is the lower fence for a NOHOOKS capture/cursor/continue
 * transaction: every subsequent target byte must follow snapshot metadata.
 *
 * This object owns only that attempt's delivery contract. It neither sends tmux
 * commands nor authenticates the snapshot collector. Its caller must prove the
 * uninterrupted command transaction and retain the connection's collector lease
 * until cancelled wire work has drained. SessionChannel owns this lifecycle.
 */
export class StockPaneSnapshot {
  static readonly MAX_BYTES = 1024 * 1024;
  static readonly MAX_CHUNKS = 512;

  private phase: "awaiting-pause" | "buffering" | "publishing" | "committed" | "invalidated" =
    "awaiting-pause";
  private failure: StockPaneSnapshotFailure | null = null;
  private readonly context: StockPaneSnapshotContext;
  private readonly participants: ReadonlySet<object>;
  private readonly maxBytes: number;
  private readonly maxChunks: number;
  private chunks: Uint8Array[] = [];
  private bytes = 0;

  constructor(
    context: StockPaneSnapshotContext,
    limits: { readonly maxBytes?: number; readonly maxChunks?: number } = {},
  ) {
    if (
      !/^%(?:0|[1-9][0-9]*)$/u.test(context.paneId) ||
      !Number.isSafeInteger(context.incarnation) ||
      context.incarnation < 0 ||
      !Number.isSafeInteger(context.layoutGeneration) ||
      context.layoutGeneration < 0 ||
      context.participants.length === 0 ||
      new Set(context.participants).size !== context.participants.length ||
      context.participants.some(
        (participant) => participant === null || typeof participant !== "object",
      )
    )
      throw new TypeError("stock snapshot requires exact pane and participant identities");
    this.maxBytes = limits.maxBytes ?? StockPaneSnapshot.MAX_BYTES;
    this.maxChunks = limits.maxChunks ?? StockPaneSnapshot.MAX_CHUNKS;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > StockPaneSnapshot.MAX_BYTES ||
      !Number.isSafeInteger(this.maxChunks) ||
      this.maxChunks < 1 ||
      this.maxChunks > StockPaneSnapshot.MAX_CHUNKS
    )
      throw new RangeError("stock snapshot buffer limits must be positive and bounded");
    this.context = { ...context, participants: [...context.participants] };
    this.participants = new Set(this.context.participants);
  }

  get state() {
    return this.phase;
  }

  get failureReason(): StockPaneSnapshotFailure | null {
    return this.failure;
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  get bufferedChunks(): number {
    return this.chunks.length;
  }

  private matchesContext(context: StockPaneSnapshotContext): boolean {
    if (this.phase === "invalidated") return false;
    if (
      context.paneId !== this.context.paneId ||
      context.incarnation !== this.context.incarnation ||
      context.layoutGeneration !== this.context.layoutGeneration ||
      context.participants.length !== this.participants.size ||
      new Set(context.participants).size !== this.participants.size ||
      context.participants.some((participant) => !this.participants.has(participant))
    ) {
      this.invalidate("context-changed");
      return false;
    }
    return true;
  }

  private current(context: StockPaneSnapshotContext): boolean {
    return this.phase !== "committed" && this.matchesContext(context);
  }

  private readCurrentContext(read: () => StockPaneSnapshotContext): boolean {
    try {
      return this.current(read());
    } catch {
      this.invalidate("context-unavailable");
      return false;
    }
  }

  /** Only an actual current connection's pause notification establishes the fence. */
  observePause(context: StockPaneSnapshotContext): boolean {
    if (!this.current(context)) return false;
    if (this.phase !== "awaiting-pause") {
      this.invalidate("repaused");
      return false;
    }
    this.phase = "buffering";
    return true;
  }

  acceptOutput(
    paneId: string,
    data: Uint8Array,
    context: StockPaneSnapshotContext,
  ): StockPaneSnapshotOutput {
    if (paneId !== this.context.paneId) return "unrelated";
    if (!this.matchesContext(context)) return "invalid";
    if (this.phase === "committed") return "live";
    // The caller fences all participating feeds before requesting pause. These
    // bytes precede the observed pause and are represented by the future seed.
    if (this.phase === "awaiting-pause") return "discarded";
    if (data.byteLength === 0) return "held";
    if (this.chunks.length >= this.maxChunks || this.bytes + data.byteLength > this.maxBytes) {
      this.invalidate("overflow");
      return "invalid";
    }
    this.chunks.push(data.slice());
    this.bytes += data.byteLength;
    return "held";
  }

  /** Revoke future routing even after commit; delivered events cannot be retracted. */
  invalidate(reason: StockPaneSnapshotFailure = "cancelled"): void {
    if (this.phase === "invalidated") return;
    this.phase = "invalidated";
    this.failure = reason;
    this.chunks = [];
    this.bytes = 0;
  }

  /**
   * Publish an authenticated snapshot, then replay each retained chunk to every
   * exact participant. Context is rechecked around callbacks. A callback may
   * append more output, which joins this same bounded replay before commit.
   * Failure cannot retract already delivered events: the caller must retire or
   * reseed participants when false is returned, never release their live feeds.
   */
  publish(
    batches: readonly StockPaneSnapshotBatch[],
    currentContext: () => StockPaneSnapshotContext,
    emit: (participant: object, event: MirrorPaneEvent) => void,
  ): boolean {
    if (!this.readCurrentContext(currentContext)) return false;
    if (this.phase !== "buffering") {
      this.invalidate(this.phase === "awaiting-pause" ? "pause-not-observed" : "invalid-snapshot");
      return false;
    }
    if (
      batches.length !== this.participants.size ||
      new Set(batches.map((batch) => batch.participant)).size !== this.participants.size ||
      batches.some(
        ({ participant, events }) =>
          !this.participants.has(participant) ||
          events.length !== 3 ||
          events[0]?.type !== "reset" ||
          events[1]?.type !== "seed" ||
          events[2]?.type !== "cursor",
      )
    ) {
      this.invalidate("invalid-snapshot");
      return false;
    }
    this.phase = "publishing";
    const deliver = (participant: object, event: MirrorPaneEvent): boolean => {
      if (!this.readCurrentContext(currentContext)) return false;
      try {
        emit(participant, event);
      } catch {
        this.invalidate("consumer-error");
        return false;
      }
      return this.readCurrentContext(currentContext);
    };
    for (const { participant, events } of batches)
      for (const event of events) if (!deliver(participant, event)) return false;
    for (let index = 0; index < this.chunks.length; index += 1) {
      const data = this.chunks[index]!;
      for (const participant of this.context.participants) {
        // A subscriber cannot mutate the bytes replayed to its siblings.
        if (!deliver(participant, { type: "delta", data: data.slice() })) return false;
      }
    }
    this.chunks = [];
    this.bytes = 0;
    this.phase = "committed";
    return true;
  }
}
