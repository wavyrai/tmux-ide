/**
 * PtyAdapter — terminal PTY adapter service contract (T087).
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation. Mirrors t3's
 * `apps/server/src/terminal/Services/PTY.ts` shape minus the Effect runtime
 * (Effect adoption is G14-T07 territory; we stay on plain TS Promises here).
 *
 * Why:
 *   - `node-pty` is a native module whose `onData` callback never fires
 *     under Bun (T085 burned half a day on the diagnosis). Routing every
 *     daemon-side PTY spawn through this interface lets us swap runtimes
 *     without touching consumers and lets tests stub the entire layer with
 *     a `MockPtyAdapter` that returns scripted output.
 *   - The Electron preload + future remote-PTY transports will eventually
 *     ship their own adapters. Keeping the seam thin makes that drop-in.
 *
 * Synchronous vs async:
 *   - `spawn(input): Promise<PtyProcess>` is the canonical entry point.
 *     Async because some adapters do real setup (e.g. NodePtyAdapter chmods
 *     node-pty's `spawn-helper` binary the first time, t3 does the same).
 *   - `spawnSync(input): PtyProcess` is a sibling for legacy synchronous
 *     callers (today: `PtyBridge.spawn` in `server/pty-bridge.ts`). It MUST
 *     have the same observable semantics as `spawn` once any one-shot setup
 *     has been done. Adapters that genuinely need async work should throw
 *     `PtySpawnError` ("sync_unsupported") from `spawnSync` so the caller
 *     can fall back to the async path.
 */

export interface PtySpawnInput {
  /** Executable to run. Defaults are adapter-defined when omitted. */
  shell: string;
  /** Argv for the executable (without argv[0]). Optional; adapters may apply defaults. */
  args?: ReadonlyArray<string>;
  /** Working directory for the spawned process. Must exist + be a directory. */
  cwd: string;
  /** Initial cols. Must be a positive integer. */
  cols: number;
  /** Initial rows. Must be a positive integer. */
  rows: number;
  /** Environment vars handed to the child. */
  env: NodeJS.ProcessEnv;
  /**
   * Terminal name (`$TERM`) handed to the child. Defaults to
   * `xterm-256color` when omitted. Some adapters honour it, some pin it.
   */
  name?: string;
  /**
   * Output encoding. `null` (default) yields raw `Buffer` data — required
   * for byte-accurate WebSocket bridging.
   */
  encoding?: "utf8" | null;
}

export interface PtyExitEvent {
  /** Process exit code. `0` is clean shutdown. */
  exitCode: number;
  /** Terminating signal (numeric), or `null` when the process exited cleanly. */
  signal: number | null;
}

/**
 * Fixed, daemon-owned limits for the fail-closed PTY input capability.
 *
 * These are lifetime limits, not watermarks. Accepted capacity is never
 * returned because the public node-pty API cannot prove that its private
 * writer queue released any particular byte. A fresh budget therefore
 * requires a fresh {@link PtyProcess}; callers cannot reset one in place.
 */
export interface PtyInputLimits {
  /** Largest single binary frame that can cross the adapter boundary. */
  readonly maxFrameBytes: number;
  /** Total bytes that can ever be handed to the opaque backend process. */
  readonly maxAcceptedBytes: number;
  /** Total non-empty frames that can ever be handed to the opaque backend. */
  readonly maxAcceptedFrames: number;
}

export type PtyInputState = "open" | "exhausted" | "failed" | "closed";

/** Immutable accounting snapshot; it never contains terminal input bytes. */
export interface PtyInputSnapshot extends PtyInputLimits {
  readonly state: PtyInputState;
  readonly acceptedBytes: number;
  readonly acceptedFrames: number;
  readonly remainingBytes: number;
  readonly remainingFrames: number;
}

export type PtyInputRejectionReason =
  | "frame_too_large"
  | "lifetime_bytes_exhausted"
  | "lifetime_frames_exhausted"
  | "process_closed"
  | "backend_write_failed";

/**
 * Typed fail-closed rejection from {@link PtyBoundedInput.write}.
 *
 * The rejected payload is deliberately absent. Capacity/backend failures
 * retire the capability permanently so a caller cannot ignore one rejected
 * frame and continue with a divergent terminal input stream.
 */
export class PtyInputRejectedError extends Error {
  readonly code = "pty_input_rejected" as const;
  readonly reason: PtyInputRejectionReason;
  readonly snapshot: PtyInputSnapshot;

  constructor(args: {
    reason: PtyInputRejectionReason;
    snapshot: PtyInputSnapshot;
    cause?: unknown;
  }) {
    super(
      `bounded PTY input rejected: ${args.reason}`,
      args.cause !== undefined ? { cause: args.cause } : undefined,
    );
    this.name = "PtyInputRejectedError";
    this.reason = args.reason;
    this.snapshot = args.snapshot;
  }
}

export type PtyInputWriteReceipt =
  | {
      readonly status: "accepted";
      readonly byteLength: number;
      readonly snapshot: PtyInputSnapshot;
    }
  | {
      readonly status: "ignored";
      readonly reason: "empty";
      readonly snapshot: PtyInputSnapshot;
    };

/**
 * A bounded binary-only input capability for native attachment transports.
 *
 * `write` snapshots accepted input and reserves its byte+frame quota before
 * invoking the opaque backend. It either returns an accepted/empty receipt or
 * throws {@link PtyInputRejectedError}; it never silently drops a non-empty
 * frame. There is intentionally no reset method.
 */
export interface PtyBoundedInput {
  write(data: Uint8Array): PtyInputWriteReceipt;
  snapshot(): PtyInputSnapshot;
  /** Permanently reject future writes without releasing accepted capacity. */
  close(): void;
}

/**
 * Optional listeners installed on the adapter's process wrapper before that
 * wrapper subscribes to the native child. This closes the post-spawn handle
 * handoff gap and captures even a child implementation which emits
 * synchronously while `onData`/`onExit` is registered. It does not claim that
 * a native backend can accept callbacks before its own `spawn(...)` returns.
 */
export interface PtySpawnListeners {
  readonly onData?: (data: Buffer) => void;
  readonly onExit?: (event: PtyExitEvent) => void;
}

/**
 * Handle to a live PTY child returned by `PtyAdapter.spawn`. Modelled on
 * t3's `PtyProcess` and `node-pty`'s `IPty` so wrapping is trivial.
 *
 * Listeners returned by `onData`/`onExit` are disposers — call them to
 * detach. After `kill()` the adapter is expected to emit a single
 * synthetic `onExit` event so the bridge layer can converge on shutdown.
 */
export interface PtyProcess {
  /** Underlying OS PID (or a synthetic positive integer for mocks). */
  readonly pid: number;
  /**
   * Fail-closed input for native attachment transports. This is the only PTY
   * input surface whose opaque-backend memory can be bounded without a public
   * node-pty drain callback.
   */
  readonly boundedInput: PtyBoundedInput;
  /**
   * Legacy, non-authoritative input with no completion or capacity proof.
   * Native attachment transports MUST receive only `boundedInput`, never this
   * process or method. Retained solely for the historical shell bridge.
   */
  write(data: string | Uint8Array): void;
  /** Resize the controlling terminal. */
  resize(cols: number, rows: number): void;
  /** Pause delivery from the native PTY without terminating its child. */
  pause(): void;
  /** Resume delivery after a matching pause. */
  resume(): void;
  /**
   * Send a signal to the child. Defaults to `SIGTERM` so adapters that
   * can't deliver arbitrary signals (mocks, sandboxed remotes) still
   * honour the common case.
   */
  kill(signal?: NodeJS.Signals | number): void;
  /**
   * Subscribe to data emissions. Returns a disposer; calling it detaches
   * the listener without affecting any sibling subscribers.
   */
  onData(callback: (data: Buffer) => void): () => void;
  /**
   * Subscribe to exit. Returns a disposer. Adapters MUST guarantee at
   * most one terminal `onExit` per process; resubscribing after exit is
   * a no-op that returns an inert disposer.
   */
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

/** Discriminator codes for `PtySpawnError`. */
export type PtySpawnErrorCode =
  | "cwd_invalid"
  | "shell_not_found"
  | "permission_denied"
  | "sync_unsupported"
  | "unknown";

/**
 * Typed failure for `PtyAdapter.spawn` / `spawnSync`. Adapters MUST throw
 * (or reject with) this class so the WS bridge can translate to a
 * structured error frame without sniffing native error message strings.
 */
export class PtySpawnError extends Error {
  readonly adapter: string;
  readonly code: PtySpawnErrorCode;
  constructor(args: {
    adapter: string;
    code: PtySpawnErrorCode;
    message: string;
    cause?: unknown;
  }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "PtySpawnError";
    this.adapter = args.adapter;
    this.code = args.code;
  }
}

/**
 * The adapter contract every PTY backend must satisfy. Async is the
 * canonical surface; `spawnSync` is provided for the synchronous callers
 * that exist today (PtyBridge / ws-route). New code should prefer `spawn`.
 */
export interface PtyAdapter {
  /** Human-readable adapter id, surfaced in `PtySpawnError.adapter`. */
  readonly id: string;
  /** Canonical async spawn. Resolves once the child PID is known. */
  spawn(input: PtySpawnInput, listeners?: PtySpawnListeners): Promise<PtyProcess>;
  /**
   * Synchronous spawn. Adapters that can't satisfy this (because they
   * need async setup) MUST throw `PtySpawnError({ code: "sync_unsupported" })`.
   */
  spawnSync(input: PtySpawnInput, listeners?: PtySpawnListeners): PtyProcess;
}
