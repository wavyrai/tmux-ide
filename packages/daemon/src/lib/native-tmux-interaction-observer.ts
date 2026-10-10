import {
  NativeJournalCapabilitySchemaZ,
  NativeJournalCursorSchemaZ,
  type NativeJournalCapability,
  type NativeJournalBatch,
  type NativeJournalCursor,
} from "@tmux-ide/contracts";
import {
  createServerGenerationFencedTmuxAsyncRunner,
  type NativeTmuxServerIdentity,
} from "./tmux-server-generation-runner.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import { NativeJournalControlConnection } from "./native-journal-control-connection.ts";

import { parseNativeJournalResponse } from "./native-journal-validation.ts";

class NativeJournalLeaseExpired extends Error {}
class NativeJournalCleanupFailed extends Error {}

export type NativeJournalObserverStatus =
  | "idle"
  | "probing"
  | "ready"
  | "disabled"
  | "unavailable"
  | "incompatible"
  | "retrying"
  | "degraded"
  | "retired"
  | "consumer-failed"
  | "disposed";
export type NativeJournalObserverEvent =
  | {
      readonly type: "state";
      readonly status: NativeJournalObserverStatus;
      readonly capability: NativeJournalCapability | null;
    }
  | { readonly type: "batch"; readonly batch: NativeJournalBatch }
  | {
      readonly type: "gap";
      readonly cursor: NativeJournalCursor;
      readonly missing: NonNullable<NativeJournalBatch["gap"]>;
    }
  | {
      readonly type: "reset";
      readonly previous: NativeJournalCursor;
      readonly cursor: NativeJournalCursor;
    };
export interface NativeJournalObserverIo {
  /** Must remain bound to the original socket + native server incarnation. */
  readonly runTmux: (args: readonly string[], signal: AbortSignal) => Promise<string>;
  readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
export interface NativeTmuxInteractionObserverOptions {
  readonly tmuxAuthority: WorkspacePaneTmuxAuthority;
  readonly nativeServerIdentity: NativeTmuxServerIdentity;
  /** Merely probing must never turn observation on. */
  readonly enable?: boolean;
  /** Lazy split activation pins the positive preflight epoch before enabling. */
  readonly expectedServerEpoch?: string;
  readonly cursor?: NativeJournalCursor;
  /** Synchronous ingestion, without per-reader queues. A throw stops observation explicitly. */
  readonly onEvent: (event: NativeJournalObserverEvent) => void;
  readonly io?: NativeJournalObserverIo;
  readonly timing?: {
    readonly commandMs?: number;
    readonly waitMs?: number;
    readonly retryMs?: number;
    readonly maxRetryMs?: number;
    /** Qualification-only metadata coalescing; production defaults to immediate reads. */
    readonly observationBatchMs?: 0 | 16 | 32;
  };
}
function freezeMetadata(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeMetadata(child);
  Object.freeze(value);
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError("Invalid native observer timing");
  return value;
}
/** Structural validation alone cannot prove the response belongs to this read cursor. */
export function validateNativeJournalBatch(
  batch: NativeJournalBatch,
  cursor: NativeJournalCursor,
): void {
  if (batch.serverEpoch !== cursor.serverEpoch || batch.journalEpoch !== cursor.journalEpoch)
    throw new Error("Native journal epoch mismatch");
  const after = BigInt(cursor.sequence),
    oldest = BigInt(batch.oldest),
    newest = BigInt(batch.newest);
  if (oldest > newest + 1n || after > newest) throw new Error("Invalid native journal range");
  const missing = after < oldest - 1n;
  if (
    missing
      ? !batch.gap ||
        BigInt(batch.gap.from) !== after + 1n ||
        BigInt(batch.gap.through) !== oldest - 1n
      : batch.gap !== null
  )
    throw new Error("Invalid native journal gap");
  let sequence = after + 1n < oldest ? oldest : after + 1n;
  for (const record of batch.records) {
    if (BigInt(record.sequence) !== sequence || sequence > newest)
      throw new Error("Invalid native record ordering");
    sequence += 1n;
  }
  const next = batch.records.length ? sequence - 1n : after;
  if (BigInt(batch.next) !== next || (next < newest && batch.records.length !== 64))
    throw new Error("Invalid native journal cursor advance");
}

/** One bounded reader for one proven server. It never elects or follows a replacement server. */
export class NativeTmuxInteractionObserver {
  readonly #options: NativeTmuxInteractionObserverOptions;
  readonly #io: NativeJournalObserverIo;
  readonly #lifetime = new AbortController();
  readonly #commandMs: number;
  readonly #waitMs: number;
  readonly #retryMs: number;
  readonly #maxRetryMs: number;
  readonly #observationBatchMs: number;
  #status: NativeJournalObserverStatus = "idle";
  #capability: NativeJournalCapability | null = null;
  #cursor: NativeJournalCursor | null;
  #start: Promise<NativeJournalObserverStatus> | null = null;
  #loop: Promise<void> | null = null;
  #consumerFailed = false;
  #control: NativeJournalControlConnection | null = null;
  constructor(options: NativeTmuxInteractionObserverOptions) {
    this.#options = { ...options };
    this.#cursor = options.cursor ? NativeJournalCursorSchemaZ.parse(options.cursor) : null;
    this.#commandMs = bounded(options.timing?.commandMs, 2_000, 60_000);
    this.#waitMs = bounded(options.timing?.waitMs, 60_000, 300_000);
    this.#retryMs = bounded(options.timing?.retryMs, 1_000, 60_000);
    this.#maxRetryMs = bounded(options.timing?.maxRetryMs, 30_000, 300_000);
    if (this.#maxRetryMs < this.#retryMs) throw new TypeError("Invalid native retry bounds");
    this.#observationBatchMs = options.timing?.observationBatchMs ?? 32;
    if (![0, 16, 32].includes(this.#observationBatchMs))
      throw new TypeError("Invalid native observation batching window");
    this.#io = options.io ?? {
      runTmux: createServerGenerationFencedTmuxAsyncRunner(
        options.tmuxAuthority,
        options.nativeServerIdentity,
        // Per-request signals enforce their own budget; this shared runner must
        // accommodate both startup commands and legacy reader leases.
        { timeoutMs: Math.max(this.#commandMs, this.#waitMs) },
      ),
      delay,
    };
  }
  get status(): NativeJournalObserverStatus {
    return this.#status;
  }
  get cursor(): NativeJournalCursor | null {
    return this.#cursor ? { ...this.#cursor } : null;
  }
  start(): Promise<NativeJournalObserverStatus> {
    if (this.#lifetime.signal.aborted) return Promise.resolve("disposed");
    return (this.#start ??= this.#initialize());
  }
  async dispose(): Promise<void> {
    this.#lifetime.abort();
    this.#status = "disposed";
    const settled = await Promise.allSettled(
      [this.#start, this.#loop].filter((value) => value !== null),
    );
    await this.#control?.dispose();
    this.#control = null;
    const errors = settled.filter((result) => result.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Native observation retirement failed",
      );
  }
  #emit(event: NativeJournalObserverEvent): void {
    if (this.#lifetime.signal.aborted || this.#consumerFailed) return;
    try {
      freezeMetadata(event);
      const result: unknown = this.#options.onEvent(event);
      if (result !== null && typeof result === "object" && "then" in result) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error("Native journal ingestion must be synchronous");
      }
    } catch {
      this.#consumerFailed = true;
      this.#status = "consumer-failed";
      throw new Error("Native journal consumer failed");
    }
  }
  #state(status: NativeJournalObserverStatus): void {
    if (this.#lifetime.signal.aborted) return;
    this.#status = status;
    this.#emit({ type: "state", status, capability: this.#capability });
  }
  async #request(args: readonly string[], timeoutMs: number): Promise<string> {
    this.#lifetime.signal.throwIfAborted();
    const request = new AbortController();
    const abort = () => request.abort(this.#lifetime.signal.reason);
    this.#lifetime.signal.addEventListener("abort", abort, { once: true });
    const persistent =
      !this.#options.io &&
      args[0] === "tmux-ide-events" &&
      args[1] === "-r" &&
      this.#capability?.readerTransport === "sessionless-control-v1";
    let expired = false;
    // Legacy helper leases retire a subprocess. A healthy parked peer instead
    // waits on lifetime cancellation; its begin/payload phases remain bounded.
    const deadline = persistent
      ? undefined
      : setTimeout(() => {
          expired = true;
          request.abort(new Error("Native journal deadline"));
        }, timeoutMs);
    deadline?.unref?.();
    try {
      let output: string;
      if (persistent) {
        const opening = this.#control === null;
        const control = (this.#control ??= new NativeJournalControlConnection(
          this.#options.tmuxAuthority,
          this.#capability!.serverEpoch,
          this.#commandMs,
        ));
        try {
          if (opening) {
            // Only opening a peer needs a handshake deadline. A timeout signal on
            // every read leaves uncancellable timers firing after completed work.
            const handshake = new AbortController();
            const timer = setTimeout(() => handshake.abort(), this.#commandMs);
            try {
              await control.start(AbortSignal.any([request.signal, handshake.signal]));
            } finally {
              clearTimeout(timer);
            }
          }
          output = await control.read(this.#cursor!, request.signal);
        } catch (error) {
          try {
            await control.dispose();
          } catch (cleanupError) {
            throw new NativeJournalCleanupFailed("Native journal peer retirement failed", {
              cause: cleanupError,
            });
          }
          this.#control = null;
          throw error;
        }
      } else output = await this.#io.runTmux(args, request.signal);
      request.signal.throwIfAborted();
      this.#lifetime.signal.throwIfAborted();
      if (Buffer.byteLength(output, "utf8") > 65_536)
        throw new Error("Native journal response too large");
      return output;
    } catch (error) {
      if (error instanceof NativeJournalCleanupFailed) throw error;
      if (expired && !this.#lifetime.signal.aborted && args[1] === "-r")
        throw new NativeJournalLeaseExpired();
      throw error;
    } finally {
      clearTimeout(deadline);
      this.#lifetime.signal.removeEventListener("abort", abort);
    }
  }

  async #probe(): Promise<boolean> {
    let capability: NativeJournalCapability;
    const output = await this.#request(["tmux-ide-events", "-V"], this.#commandMs);
    try {
      capability = NativeJournalCapabilitySchemaZ.parse(JSON.parse(output));
    } catch {
      this.#state("incompatible");
      return false;
    }
    if (
      (this.#options.expectedServerEpoch !== undefined &&
        this.#options.expectedServerEpoch !== capability.serverEpoch) ||
      (this.#capability && this.#capability.serverEpoch !== capability.serverEpoch) ||
      (this.#cursor && this.#cursor.serverEpoch !== capability.serverEpoch)
    ) {
      this.#state("retired");
      return false;
    }
    this.#capability = capability;
    if (!capability.enabled && this.#options.enable) {
      const enabled = NativeJournalCapabilitySchemaZ.parse(
        JSON.parse(await this.#request(["tmux-ide-events", "-e"], this.#commandMs)),
      );
      if (enabled.serverEpoch !== capability.serverEpoch) {
        this.#state("retired");
        return false;
      }
      this.#capability = capability = enabled;
    }
    if (!capability.enabled) {
      this.#state("disabled");
      return false;
    }
    if (capability.degraded) {
      this.#state("degraded");
      return false;
    }
    if (!this.#cursor)
      this.#cursor = {
        serverEpoch: capability.serverEpoch,
        journalEpoch: capability.journalEpoch,
        sequence: "0",
      };
    else if (this.#cursor.journalEpoch !== capability.journalEpoch)
      this.#reset(capability.journalEpoch);
    this.#state("ready");
    return true;
  }
  #reset(journalEpoch: string): void {
    const previous = this.#cursor!;
    this.#cursor = { ...previous, journalEpoch, sequence: "0" };
    if (this.#capability) this.#capability = { ...this.#capability, journalEpoch };
    this.#emit({ type: "reset", previous, cursor: { ...this.#cursor } });
  }
  async #initialize(): Promise<NativeJournalObserverStatus> {
    try {
      this.#state("probing");
      if (await this.#probe()) {
        this.#loop = this.#readLoop().finally(async () => {
          const control = this.#control;
          await control?.dispose();
          this.#control = null;
        });
        // Disposal still observes this rejection; prevent an unattended loop error.
        void this.#loop.catch(() => undefined);
      }
    } catch {
      if (!this.#lifetime.signal.aborted && !this.#consumerFailed) this.#state("unavailable");
    }
    return this.#status;
  }
  async #readLoop(): Promise<void> {
    let retryMs = this.#retryMs;
    while (!this.#lifetime.signal.aborted && !this.#consumerFailed) {
      try {
        const cursor = this.#cursor!;
        const raw = await this.#request(
          [
            "tmux-ide-events",
            "-r",
            "-w",
            "-E",
            cursor.journalEpoch,
            "-a",
            cursor.sequence,
            "-n",
            "64",
          ],
          this.#waitMs,
        );
        const response = parseNativeJournalResponse(raw);
        if (response.serverEpoch !== cursor.serverEpoch) {
          this.#state("retired");
          return;
        }
        if (response.type === "reset") {
          if (response.journalEpoch === cursor.journalEpoch)
            throw new Error("Spurious native reset");
          this.#reset(response.journalEpoch);
          await this.#io.delay(this.#retryMs, this.#lifetime.signal);
          continue;
        }
        validateNativeJournalBatch(response, cursor);
        if (response.gap) this.#emit({ type: "gap", cursor: { ...cursor }, missing: response.gap });
        if (response.records.length) this.#emit({ type: "batch", batch: response });
        this.#cursor = { ...cursor, sequence: response.next };
        if (response.degraded) {
          this.#capability = { ...this.#capability!, degraded: response.degraded };
          this.#state("degraded");
          return;
        }
        if (!response.records.length) throw new Error("Empty native wait response");
        retryMs = this.#retryMs;
        // Fixed non-sliding delay only while caught up. Backlog drains immediately
        // in bounded batches, and a quiet tail always gets its next parked read.
        if (this.#observationBatchMs && response.next === response.newest)
          await this.#io.delay(this.#observationBatchMs, this.#lifetime.signal);
      } catch (error) {
        if (this.#lifetime.signal.aborted || this.#consumerFailed) return;
        if (error instanceof NativeJournalCleanupFailed) {
          this.#state("degraded");
          return;
        }
        // An idle lease ending is neither a gap nor a failed observation source.
        if (error instanceof NativeJournalLeaseExpired) continue;
        try {
          this.#state("retrying");
          await this.#io.delay(retryMs, this.#lifetime.signal);
          retryMs = Math.min(retryMs * 2, this.#maxRetryMs);
          if (!(await this.#probe())) return;
        } catch {
          if (this.#lifetime.signal.aborted || this.#consumerFailed) return;
          // Retry the original fenced server after another bounded delay.
        }
      }
    }
  }
}
