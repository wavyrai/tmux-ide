import type {
  CanonicalTerminalReplicaUpdate,
  CausalCellFailureReasonV1,
  CausalCellProbeV1,
  SessionRuntimeGeneration,
} from "@tmux-ide/contracts";
import type { MirrorLayoutEvent, MirrorPaneEvent } from "../mirror/events.ts";
import type { MirrorService, MirrorSubscription } from "../mirror/mirror-service.ts";
import { terminalReplicaRowsEqual } from "@tmux-ide/core";
import type { NativeGridReadResult } from "../mirror/native-grid-reader.ts";
import { projectNativeGridRow } from "../mirror/native-grid-projection.ts";
import {
  TerminalReplicaInterpreter,
  type TerminalReplicaInterpreterStats,
} from "./terminal-replica-interpreter.ts";
import {
  SYSTEM_SESSION_RUNTIME_SCHEDULER,
  type SessionRuntimeScheduler,
  type SessionRuntimeTimer,
} from "./runtime-scheduler.ts";
import type {
  SessionRuntimeObservability,
  SessionRuntimeTraceContext,
} from "./runtime-observability.ts";
import { DISABLED_SESSION_RUNTIME_OBSERVABILITY } from "./runtime-observability.ts";
import type { CausalCellLedgerResult } from "./causal-cell-ledger.ts";

export interface TerminalReplicaSubscription {
  readonly generation: SessionRuntimeGeneration;
  readonly semanticPaneId: string;
  close(): Promise<void>;
}

export type TerminalReplicaSourceSubscription = TerminalReplicaSubscription;
export interface TerminalReplicaCommittedRaw {
  readonly baseRevision: number;
  readonly revision: number;
  readonly bytes: Uint8Array;
  readonly contiguous: boolean;
}

export interface TerminalReplicaQualificationSnapshot {
  readonly incarnation: string | null;
  readonly revision: number | null;
  readonly stateHash: string | null;
  readonly stats: TerminalReplicaInterpreterStats;
}

/** Daemon-private backing admission; this is not a client transport schema. */
export type TerminalReplicaNativeBackingResult =
  | Exclude<NativeGridReadResult, { status: "captured" }>
  | { readonly status: "mismatch" }
  | (Extract<NativeGridReadResult, { status: "captured" }> & {
      readonly authority: {
        readonly generation: SessionRuntimeGeneration;
        readonly workspaceName: string;
        readonly semanticPaneId: string;
        readonly incarnation: string;
        readonly revision: number;
        readonly stateHash: string;
      };
    });

interface ReseedCandidate {
  readonly nativeCols: number;
  readonly nativeRows: number;
  readonly layoutLease: LayoutLease | null;
  readonly subscriptionEpoch: number;
  readonly chunks: Uint8Array[];
  readonly trace: SessionRuntimeTraceContext | null;
}

/** One parser/replica owner for one semantic pane inside one SessionRuntime. */
export class SessionRuntimeTerminalReplicaOwner {
  readonly #interpreter: TerminalReplicaInterpreter;
  readonly #listeners = new Set<
    (update: CanonicalTerminalReplicaUpdate, trace: SessionRuntimeTraceContext | null) => void
  >();
  readonly #rawListeners = new Set<(record: TerminalReplicaCommittedRaw) => void>();
  readonly #onClosed: (() => void) | undefined;
  readonly #onFault: ((error: unknown) => void) | undefined;
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #observability: SessionRuntimeObservability;
  #takeOutputTrace: (() => SessionRuntimeTraceContext | null) | undefined;
  readonly #start: Promise<void>;
  #upstream: MirrorSubscription | null = null;
  #disposed = false;
  #cols = 80;
  #rows = 24;
  #layoutEpoch = 0;
  #layoutLease: LayoutLease | null = null;
  #subscriptionEpoch = 1;
  #reseedRetryCount = 0;
  #reseed: ReseedCandidate | null = null;
  #bootstrapped = false;
  #waitingForGeometryCapture = false;
  #historyTimer: SessionRuntimeTimer | null = null;
  #historyChecking = false;
  #historyDirty = false;

  constructor(
    readonly generation: SessionRuntimeGeneration,
    readonly session: string,
    readonly semanticPaneId: string,
    mirror: MirrorService,
    options: {
      readonly incarnation: string;
      readonly initialRevision: number;
      readonly onRevision?: (revision: number) => void;
      readonly onClosed?: () => void;
      readonly onFault?: (error: unknown) => void;
      readonly scheduler?: SessionRuntimeScheduler;
      readonly observability?: SessionRuntimeObservability;
      readonly takeOutputTrace?: () => SessionRuntimeTraceContext | null;
    },
  ) {
    this.#onClosed = options.onClosed;
    this.#onFault = options.onFault;
    this.#scheduler = options.scheduler ?? SYSTEM_SESSION_RUNTIME_SCHEDULER;
    this.#observability = options.observability ?? DISABLED_SESSION_RUNTIME_OBSERVABILITY;
    this.#takeOutputTrace = options.takeOutputTrace;
    this.#interpreter = new TerminalReplicaInterpreter({
      generation,
      workspaceName: session,
      semanticPaneId,
      incarnation: options.incarnation,
      initialRevision: options.initialRevision,
      cols: this.#cols,
      rows: this.#rows,
      scheduler: options.scheduler,
      observability: options.observability,
      onNativeReseedRequired: () => {
        if (this.#disposed || this.#reseed || this.#waitingForGeometryCapture) return;
        this.#waitingForGeometryCapture = true;
        this.#supervise(
          this.#start.then(() => {
            if (!this.#disposed && this.#waitingForGeometryCapture) this.#upstream?.reseed();
          }),
        );
      },
      onUpdate: (update, trace) => {
        if (update.type === "terminal.seed") {
          this.#bootstrapped = true;
          this.#reseedRetryCount = 0;
        }
        options.onRevision?.(update.revision);
        for (const listener of this.#listeners) {
          try {
            listener(update, trace);
          } catch {
            // A client projection cannot block sibling subscribers.
          }
        }
      },
      onRawCommit: (record) => {
        // Schedule observers outside the parser stack. Registration happens
        // before the matching canonical callback schedules delivery.
        this.#scheduler.microtask(() => {
          const size = record.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of record.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          for (const listener of this.#rawListeners) {
            try {
              listener({
                baseRevision: record.baseRevision,
                revision: record.revision,
                bytes,
                contiguous: record.contiguous,
              });
            } catch {
              // Compatibility observers are isolated from parser ownership.
            }
          }
        });
      },
    });
    this.#start = mirror
      .subscribe({
        session,
        semanticPaneId,
        onEvent: (event) => this.#observePane(event),
        onLayout: (event) => this.#observeLayout(event),
      })
      .then((subscription) => {
        if (this.#disposed) return subscription.close();
        this.#upstream = subscription;
      });
    // Semantic delivery subscribes directly to this cached owner. A failed
    // bootstrap must retire its rejected start promise through the same
    // registry fault barrier as a parser failure, so the next open can retry.
    this.#supervise(this.#start);
  }

  installOutputTraceReader(reader: () => SessionRuntimeTraceContext | null): void {
    this.#takeOutputTrace ??= reader;
  }

  prioritizeNextWrite(): void {
    this.#interpreter.prioritizeNextWrite();
  }

  armCausalCellProbe(
    probe: CausalCellProbeV1,
    onResult: (result: CausalCellLedgerResult) => void,
  ): void {
    this.#interpreter.armCausalCellProbe(probe, onResult);
  }

  noteCausalCellControlReply(traceId: string, ok: boolean): void {
    this.#interpreter.noteCausalCellControlReply(traceId, ok);
  }

  failCausalCell(reason: CausalCellFailureReasonV1, traceId?: string): void {
    this.#interpreter.failCausalCell(reason, traceId);
  }

  qualificationSnapshot(): TerminalReplicaQualificationSnapshot {
    const seed = this.#interpreter.currentSeed();
    return Object.freeze({
      incarnation: seed?.incarnation ?? null,
      revision: seed?.revision ?? null,
      stateHash: seed?.stateHash ?? null,
      stats: this.#interpreter.stats(),
    });
  }

  async captureNativeBacking(): Promise<TerminalReplicaNativeBackingResult> {
    await this.#start;
    await this.#interpreter.whenIdle();
    if (this.#disposed) return { status: "retired" };
    const upstream = this.#upstream;
    if (!upstream?.captureNativeBacking) return { status: "unsupported" };
    const initial = this.#interpreter.currentSeed();
    if (!initial || this.#reseed || this.#waitingForGeometryCapture) return { status: "changed" };
    const epoch = this.#subscriptionEpoch;
    const captured = await upstream.captureNativeBacking();
    if (captured.status !== "captured") return captured;
    await this.#interpreter.whenIdle();
    const isCurrent = () => {
      const current = this.#interpreter.currentSeed();
      return (
        !this.#disposed &&
        this.#upstream === upstream &&
        this.#subscriptionEpoch === epoch &&
        !this.#reseed &&
        !this.#waitingForGeometryCapture &&
        captured.isCurrent() &&
        current?.incarnation === initial.incarnation &&
        current.revision === initial.revision &&
        current.stateHash === initial.stateHash
      );
    };
    if (!isCurrent()) return { status: "changed" };
    const native = captured.snapshot;
    const canonical = initial.snapshot;
    if (
      native.cols !== canonical.cols ||
      native.rows !== canonical.rows ||
      native.history !== canonical.history.length ||
      Math.min(native.cursor[0], native.cols - 1) !== canonical.cursor.x ||
      native.cursor[1] !== canonical.cursor.y
    )
      return { status: "mismatch" };
    const rows = [...canonical.history, ...canonical.grid];
    for (let index = 0; index < rows.length; index++) {
      const projected = projectNativeGridRow(
        native.grid[index],
        native.cols,
        0,
        index > 0 && (native.grid[index - 1]!.flags & 1) !== 0,
      );
      if (!projected || !terminalReplicaRowsEqual(rows[index]!, projected))
        return { status: "mismatch" };
    }
    return Object.freeze({
      ...captured,
      isCurrent,
      authority: Object.freeze({
        generation: this.generation,
        workspaceName: initial.workspaceName,
        semanticPaneId: this.semanticPaneId,
        incarnation: initial.incarnation,
        revision: initial.revision,
        stateHash: initial.stateHash,
      }),
    });
  }

  async subscribe(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
  ): Promise<TerminalReplicaSubscription> {
    if (this.#disposed) throw new Error("Terminal replica owner is disposed");
    try {
      await this.#start;
      await this.#interpreter.whenSeeded();
      this.#listeners.add(listener);
      const seed = this.#interpreter.currentSeed();
      if (!seed) throw new Error("Terminal replica bootstrap did not produce a seed");
      try {
        listener(seed, null);
      } catch {
        // Bootstrap delivery has the same client-isolation rule as live frames.
      }
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    let closed = false;
    return {
      generation: this.generation,
      semanticPaneId: this.semanticPaneId,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#listeners.delete(listener);
      },
    };
  }

  async subscribeSource(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
    onRaw: (record: TerminalReplicaCommittedRaw) => void,
  ): Promise<TerminalReplicaSourceSubscription> {
    const canonical = await this.subscribe(listener);
    this.#rawListeners.add(onRaw);
    let closed = false;
    return {
      ...canonical,
      close: async () => {
        if (closed) return;
        closed = true;
        this.#rawListeners.delete(onRaw);
        await canonical.close();
      },
    };
  }

  async dispose(
    reason: "pane-closed" | "session-restarted" | "runtime-disposed" = "runtime-disposed",
  ): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#historyTimer?.cancel();
    this.#historyTimer = null;
    this.#subscriptionEpoch += 1;
    await this.#interpreter.enqueue({ type: "close", reason });
    await this.#start.catch(() => undefined);
    await this.#upstream?.close();
    this.#upstream = null;
    this.#listeners.clear();
    this.#rawListeners.clear();
  }

  #scheduleHistoryCheck(): void {
    if (this.#disposed || this.#historyTimer || this.#historyChecking) return;
    this.#historyTimer = this.#scheduler.timer(() => {
      this.#historyTimer = null;
      void this.#checkHistory();
    }, 250);
  }

  async #checkHistory(): Promise<void> {
    if (this.#disposed || this.#historyChecking) return;
    this.#historyChecking = true;
    this.#historyDirty = false;
    try {
      await this.#start;
      const upstream = this.#upstream;
      if (this.#disposed || !upstream?.readHistorySize) return;
      const epoch = this.#subscriptionEpoch;
      const size = await upstream.readHistorySize();
      await this.#interpreter.whenIdle();
      if (
        this.#disposed ||
        epoch !== this.#subscriptionEpoch ||
        // Output received during the probe makes its count incomparable with
        // the newer parser state. The dirty flag schedules another check.
        this.#historyDirty ||
        this.#reseed ||
        this.#waitingForGeometryCapture ||
        size === null
      )
        return;
      const seed = this.#interpreter.currentSeed();
      if (seed && seed.snapshot.history.length !== size) upstream.reseed();
    } catch {
      // Unavailable metadata is not evidence that history disappeared.
    } finally {
      this.#historyChecking = false;
      if (this.#historyDirty) this.#scheduleHistoryCheck();
    }
  }

  #observePane(event: MirrorPaneEvent): void {
    if (event.type === "delta") {
      this.#historyDirty = true;
      this.#scheduleHistoryCheck();
    }
    if (event.type === "reset") {
      // Deterministic capture point: reset opens the atomic capture. A probe
      // armed after reset belongs to the next post-capture delta, never to this
      // already-started reseed.
      this.#reseed = {
        nativeCols: event.cols,
        nativeRows: event.rows,
        layoutLease: this.#layoutLease,
        subscriptionEpoch: this.#subscriptionEpoch,
        chunks: [],
        trace: this.#consumeOutputTrace(),
      };
    } else if (event.type === "seed" || event.type === "delta") {
      if (this.#waitingForGeometryCapture && !this.#reseed) return;
      if (this.#reseed) this.#reseed.chunks.push(event.data.slice());
      else
        this.#supervise(
          this.#interpreter.enqueue({
            type: "write",
            data: event.data,
            trace: this.#consumeOutputTrace(),
          }),
        );
    } else if (event.type === "cursor") {
      this.#waitingForGeometryCapture = false;
      const reseed = this.#reseed;
      this.#reseed = null;
      const lease = reseed ? this.#qualifyReseed(reseed, event.x, event.y) : null;
      this.#supervise(
        reseed && lease
          ? this.#interpreter.enqueue({
              type: "reseed",
              nativeCols: reseed.nativeCols,
              nativeRows: reseed.nativeRows,
              cols: reseed.nativeCols,
              rows: reseed.nativeRows,
              chunks: reseed.chunks,
              historyLimit: event.historyLimit,
              historySize: event.historySize,
              trace: reseed.trace,
              // tmux can retain an offscreen x after a non-reflow width shrink
              // (screen_resize_cursor), as well as x === cols for wrap pending.
              // Preserve wrap pending in the parser. The backend's canonical
              // projection, not its input cursor, clamps to the final cell.
              cursor: { x: event.x, y: event.y },
              wraparound: event.wraparound,
              observedModes: event.observedModes,
              bootstrap: "painted-capture",
              validateBeforeCommit: () => this.#leaseIsCurrent(lease, reseed.subscriptionEpoch),
              onInvalidated: () => this.#retryReseedOrFault("terminal reseed layout lease crossed"),
            })
          : reseed
            ? (this.#retryReseedOrFault(
                `terminal reseed geometry is incompatible: capture ${reseed.nativeCols}x${reseed.nativeRows}, layout ${reseed.layoutLease?.pane.width}x${reseed.layoutLease?.pane.height}, border ${reseed.layoutLease?.paneBorderStatus}`,
              ),
              Promise.resolve())
            : this.#interpreter.enqueue({
                type: "cursor",
                x: event.x,
                y: event.y,
                wraparound: event.wraparound,
                observedModes: event.observedModes,
              }),
      );
    } else if (event.type === "fault") {
      const error = new Error("Native terminal recovery failed");
      this.#interpreter.abort(error);
      this.#onFault?.(error);
    } else if (event.type === "closed") {
      const closed = this.#interpreter.enqueue({ type: "close", reason: "pane-closed" });
      this.#supervise(closed);
      void closed.then(
        async () => {
          await this.dispose("pane-closed");
          this.#onClosed?.();
        },
        () => undefined,
      );
    }
  }

  #observeLayout(event: MirrorLayoutEvent): void {
    const observed = this.#readLayoutLease(event);
    if (observed.kind === "irrelevant") return;
    if (observed.kind === "invalid") {
      this.#layoutEpoch += 1;
      this.#layoutLease = null;
      return;
    }
    const lease = observed.lease;
    if (this.#layoutLease && layoutLeaseEqual(this.#layoutLease, lease)) return;
    const priorCols = this.#cols;
    const priorRows = this.#rows;
    this.#layoutEpoch += 1;
    this.#layoutLease = { ...lease, epoch: this.#layoutEpoch };
    this.#cols = lease.pane.width;
    this.#rows = nativeRowsForLease(lease);
    if (priorCols === this.#cols && priorRows === this.#rows) return;
    // A painted capture does not carry tmux's reflow/alternate-screen history.
    // Locally resizing it can turn native clipped rows into wrapped rows. Keep
    // the last coherent image until a capture at the new native size replaces it.
    // One outstanding capture also coalesces geometry bursts; crossed leases
    // request the latest capture through the normal qualification retry path.
    this.#reseedRetryCount = 0;
    if (!this.#bootstrapped || this.#reseed || this.#waitingForGeometryCapture) return;
    this.#waitingForGeometryCapture = true;
    void this.#start.then(() => {
      if (!this.#disposed && this.#waitingForGeometryCapture) this.#upstream?.reseed();
    });
  }

  #readLayoutLease(event: MirrorLayoutEvent): LayoutLeaseObservation {
    if (event.session !== this.session) return { kind: "irrelevant" };
    const targetCount = event.panes.filter(
      (pane) => pane.semanticPaneId === this.semanticPaneId,
    ).length;
    if (targetCount === 0 && event.semanticWindowId !== null) {
      if (
        this.#layoutLease === null ||
        event.semanticWindowId !== this.#layoutLease.semanticWindowId
      )
        return { kind: "irrelevant" };
    }
    if (event.semanticWindowId === null || targetCount !== 1) return { kind: "invalid" };
    const identities = event.panes.map((pane) => pane.semanticPaneId);
    if (identities.some((identity) => identity === null)) return { kind: "invalid" };
    if (new Set(identities).size !== identities.length) return { kind: "invalid" };
    const pane = event.panes.find((candidate) => candidate.semanticPaneId === this.semanticPaneId)!;
    if (
      !boundedPositive(event.cols) ||
      !boundedPositive(event.rows) ||
      !boundedPositive(pane.width) ||
      !boundedPositive(pane.height) ||
      !Number.isSafeInteger(pane.left) ||
      !Number.isSafeInteger(pane.top) ||
      pane.left < 0 ||
      pane.top < 0 ||
      pane.left + pane.width > event.cols ||
      pane.top + pane.height > event.rows
    )
      return { kind: "invalid" };
    return {
      kind: "valid",
      lease: {
        semanticWindowId: event.semanticWindowId,
        currentWindow: event.currentWindow,
        zoomed: event.zoomed,
        windowCols: event.cols,
        windowRows: event.rows,
        paneBorderStatus: event.paneBorderStatus,
        pane: { ...pane },
      },
    };
  }

  #qualifyReseed(reseed: ReseedCandidate, cursorX: number, cursorY: number): LayoutLease | null {
    const lease = reseed.layoutLease;
    if (!lease || !this.#leaseIsCurrent(lease, reseed.subscriptionEpoch)) return null;
    if (lease.pane.width !== reseed.nativeCols) return null;
    if (!nativeRowsMatchLease(lease, reseed.nativeRows)) return null;
    if (
      !Number.isSafeInteger(cursorX) ||
      !Number.isSafeInteger(cursorY) ||
      cursorX < 0 ||
      cursorY < 0 ||
      cursorY >= reseed.nativeRows
    )
      return null;
    return lease;
  }

  #leaseIsCurrent(lease: LayoutLease, subscriptionEpoch: number): boolean {
    return (
      !this.#disposed &&
      subscriptionEpoch === this.#subscriptionEpoch &&
      this.#layoutLease !== null &&
      this.#layoutLease.epoch === lease.epoch &&
      layoutLeaseEqual(this.#layoutLease, lease)
    );
  }

  #retryReseedOrFault(message: string): void {
    if (this.#disposed || this.#waitingForGeometryCapture) return;
    if (this.#reseedRetryCount >= 1) {
      const error = new Error(message);
      this.#interpreter.abort(error);
      this.#onFault?.(error);
      return;
    }
    this.#reseedRetryCount += 1;
    this.#waitingForGeometryCapture = true;
    void this.#start.then(() => {
      if (!this.#disposed) this.#upstream?.reseed();
    });
  }

  #supervise(operation: Promise<void>): void {
    void operation.catch((error) => {
      this.#interpreter.abort(error);
      this.#onFault?.(error);
    });
  }

  #consumeOutputTrace(): SessionRuntimeTraceContext | null {
    const trace = this.#takeOutputTrace?.() ?? null;
    if (trace && this.#observability.enabled) {
      const atMicros = this.#observability.nowMicros();
      this.#observability.recordSpan("tmux", "first-output-observed", atMicros, atMicros, trace);
    }
    return trace;
  }
}

interface LayoutLease {
  readonly epoch: number;
  readonly semanticWindowId: string;
  readonly currentWindow: boolean;
  readonly zoomed: boolean;
  readonly windowCols: number;
  readonly windowRows: number;
  readonly paneBorderStatus: MirrorLayoutEvent["paneBorderStatus"];
  readonly pane: MirrorLayoutEvent["panes"][number];
}

type LayoutLeaseObservation =
  | { readonly kind: "irrelevant" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly lease: Omit<LayoutLease, "epoch"> };

function boundedPositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function nativeRowsMatchLease(lease: LayoutLease, nativeRows: number): boolean {
  return nativeRowsForLease(lease) === nativeRows;
}

function nativeRowsForLease(lease: Omit<LayoutLease, "epoch">): number {
  if (lease.paneBorderStatus === "off") return lease.pane.height;

  // pane-border-status consumes a terminal row only on the pane touching the
  // configured outer window edge. Interior separators are drawn inside the
  // layout and tmux reports their capture at the full visible pane height.
  const touchesStatusEdge =
    lease.paneBorderStatus === "top"
      ? lease.pane.top === 0
      : lease.pane.top + lease.pane.height === lease.windowRows;
  return lease.pane.height - (touchesStatusEdge ? 1 : 0);
}

function layoutLeaseEqual(
  left: LayoutLease | Omit<LayoutLease, "epoch">,
  right: LayoutLease | Omit<LayoutLease, "epoch">,
): boolean {
  // Focus is ordinary mutable tmux state, not terminal geometry. A second
  // attached client can switch the current window or active pane while an
  // atomic capture is in flight without changing the bytes' dimensions or
  // identity. Treating those flags as part of the capture lease made that
  // harmless navigation invalidate bootstrap, eventually faulting the whole
  // pane stream after the single reseed retry.
  return (
    left.semanticWindowId === right.semanticWindowId &&
    left.zoomed === right.zoomed &&
    left.windowCols === right.windowCols &&
    left.windowRows === right.windowRows &&
    left.paneBorderStatus === right.paneBorderStatus &&
    left.pane.semanticPaneId === right.pane.semanticPaneId &&
    left.pane.left === right.pane.left &&
    left.pane.top === right.pane.top &&
    left.pane.width === right.pane.width &&
    left.pane.height === right.pane.height
  );
}
