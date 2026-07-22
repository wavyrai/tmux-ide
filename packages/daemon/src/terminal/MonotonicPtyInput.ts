import {
  PtyInputRejectedError,
  type PtyBoundedInput,
  type PtyInputLimits,
  type PtyInputRejectionReason,
  type PtyInputSnapshot,
  type PtyInputState,
  type PtyInputWriteReceipt,
} from "./PtyAdapter.ts";

/**
 * Conservative defaults for one real tmux-client PTY generation.
 *
 * 256 KiB bounds opaque payload retention while 8,192 frames bounds private
 * queue/task metadata when a renderer sends one key per frame. A 16 KiB frame
 * admits ordinary bracketed paste but makes larger paste an explicit transport
 * operation that must be chunked before it reaches this boundary.
 */
export const DEFAULT_PTY_INPUT_LIMITS: PtyInputLimits = Object.freeze({
  maxFrameBytes: 16 * 1024,
  maxAcceptedBytes: 256 * 1024,
  maxAcceptedFrames: 8_192,
});

/** Hard implementation ceilings; callers cannot trade a byte cap for task explosion. */
export const MAX_PTY_INPUT_FRAME_BYTES = 64 * 1024;
export const MAX_PTY_INPUT_ACCEPTED_BYTES = 4 * 1024 * 1024;
export const MAX_PTY_INPUT_ACCEPTED_FRAMES = 16_384;

export function validatePtyInputLimits(limits: PtyInputLimits): PtyInputLimits {
  validateLimit("maxFrameBytes", limits.maxFrameBytes, MAX_PTY_INPUT_FRAME_BYTES);
  validateLimit("maxAcceptedBytes", limits.maxAcceptedBytes, MAX_PTY_INPUT_ACCEPTED_BYTES);
  validateLimit("maxAcceptedFrames", limits.maxAcceptedFrames, MAX_PTY_INPUT_ACCEPTED_FRAMES);
  if (limits.maxFrameBytes > limits.maxAcceptedBytes) {
    throw new RangeError("maxFrameBytes cannot exceed maxAcceptedBytes");
  }
  return Object.freeze({ ...limits });
}

function validateLimit(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
}

/**
 * Bounds an opaque PTY writer by assuming the worst case: every byte and task
 * ever accepted remains queued for this process's entire lifetime.
 *
 * This deliberately does not inspect node-pty private fields and does not
 * infer progress from time or terminal echo. Capacity is reserved before the
 * sink call and is never reclaimed, including when that call throws.
 */
export class MonotonicPtyInput implements PtyBoundedInput {
  readonly #limits: PtyInputLimits;
  readonly #sink: (frame: Buffer) => void;
  #acceptedBytes = 0;
  #acceptedFrames = 0;
  #state: PtyInputState = "open";
  #terminalReason: PtyInputRejectionReason | null = null;

  constructor(limits: PtyInputLimits, sink: (frame: Buffer) => void) {
    this.#limits = validatePtyInputLimits(limits);
    this.#sink = sink;
  }

  write(data: Uint8Array): PtyInputWriteReceipt {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError("bounded PTY input must be a Uint8Array");
    }
    if (data.byteLength === 0) {
      return { status: "ignored", reason: "empty", snapshot: this.snapshot() };
    }
    if (this.#state === "exhausted") {
      const reason =
        this.#terminalReason ??
        (this.#acceptedFrames >= this.#limits.maxAcceptedFrames
          ? "lifetime_frames_exhausted"
          : "lifetime_bytes_exhausted");
      this.#reject(reason, "exhausted");
    }
    if (this.#state !== "open") {
      this.#reject("process_closed", this.#state);
    }
    if (data.byteLength > this.#limits.maxFrameBytes) {
      this.#reject("frame_too_large", "exhausted");
    }
    if (this.#acceptedFrames >= this.#limits.maxAcceptedFrames) {
      this.#reject("lifetime_frames_exhausted", "exhausted");
    }
    if (data.byteLength > this.#limits.maxAcceptedBytes - this.#acceptedBytes) {
      this.#reject("lifetime_bytes_exhausted", "exhausted");
    }

    // Copy before accounting and before crossing the opaque boundary. This
    // prevents a renderer-owned ArrayBuffer (including a shared view) from
    // changing after the exact byteLength has been reserved.
    const frame = Buffer.from(data);
    this.#acceptedBytes += frame.byteLength;
    this.#acceptedFrames += 1;
    if (
      this.#acceptedBytes === this.#limits.maxAcceptedBytes ||
      this.#acceptedFrames === this.#limits.maxAcceptedFrames
    ) {
      this.#state = "exhausted";
      this.#terminalReason =
        this.#acceptedFrames === this.#limits.maxAcceptedFrames
          ? "lifetime_frames_exhausted"
          : "lifetime_bytes_exhausted";
    }

    try {
      this.#sink(frame);
    } catch {
      this.#state = "failed";
      this.#terminalReason = "backend_write_failed";
      throw new PtyInputRejectedError({
        reason: "backend_write_failed",
        snapshot: this.snapshot(),
      });
    }

    return {
      status: "accepted",
      byteLength: frame.byteLength,
      snapshot: this.snapshot(),
    };
  }

  snapshot(): PtyInputSnapshot {
    return Object.freeze({
      ...this.#limits,
      state: this.#state,
      acceptedBytes: this.#acceptedBytes,
      acceptedFrames: this.#acceptedFrames,
      remainingBytes: this.#limits.maxAcceptedBytes - this.#acceptedBytes,
      remainingFrames: this.#limits.maxAcceptedFrames - this.#acceptedFrames,
    });
  }

  close(): void {
    if (this.#state !== "closed") {
      this.#state = "closed";
      this.#terminalReason = "process_closed";
    }
  }

  #reject(reason: PtyInputRejectionReason, state: PtyInputState): never {
    this.#state = state;
    this.#terminalReason = reason;
    throw new PtyInputRejectedError({ reason, snapshot: this.snapshot() });
  }
}
