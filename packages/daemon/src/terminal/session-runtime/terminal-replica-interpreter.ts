import {
  detectWidgetMarkerFromReplicaRows,
  type CanonicalTerminalReplicaPatch,
  type CanonicalTerminalReplicaSeed,
  type CanonicalTerminalReplicaTombstone,
  type CanonicalTerminalReplicaUpdate,
  type CausalCellFailureReasonV1,
  type CausalCellProbeV1,
  type SessionRuntimeGeneration,
  type TerminalReplicaRow,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  assembleTerminalReplicaSnapshot,
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
  hashTerminalWidgetContent,
  terminalReplicaRowsEqual,
} from "@tmux-ide/core";
import {
  SYSTEM_SESSION_RUNTIME_SCHEDULER,
  type SessionRuntimeScheduler,
  type SessionRuntimeTimer,
} from "./runtime-scheduler.ts";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  type SessionRuntimeObservability,
  type SessionRuntimeTraceContext,
} from "./runtime-observability.ts";
import type {
  TerminalInterpreterBackend,
  TerminalInterpreterBackendFactory,
} from "./terminal-interpreter-backend.ts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";
import {
  CAUSAL_CELL_OSC,
  CausalCellLedger,
  type CausalCellLedgerResult,
} from "./causal-cell-ledger.ts";

type CloseReason = "pane-closed" | "session-restarted" | "runtime-disposed";
export type TerminalReplicaInterpreterOperation =
  | {
      readonly type: "write";
      readonly data: Uint8Array;
      readonly trace?: SessionRuntimeTraceContext | null;
    }
  | { readonly type: "cursor"; readonly x: number; readonly y: number }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | {
      readonly type: "reseed";
      readonly cols: number;
      readonly rows: number;
      readonly chunks: readonly Uint8Array[];
      readonly cursor: { readonly x: number; readonly y: number };
      readonly trace?: SessionRuntimeTraceContext | null;
      /** capture-pane is painted truth, not proof of hidden pre-existing VT modes. */
      readonly bootstrap: "painted-capture" | "authoritative-stream";
    }
  | { readonly type: "close"; readonly reason: CloseReason };

export interface TerminalReplicaInterpreterOptions {
  readonly generation: SessionRuntimeGeneration;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly incarnation: string;
  readonly initialRevision?: number;
  readonly cols: number;
  readonly rows: number;
  readonly scrollback?: number;
  readonly onUpdate?: (
    update: CanonicalTerminalReplicaUpdate,
    trace: SessionRuntimeTraceContext | null,
  ) => void;
  readonly onRawCommit?: (record: {
    readonly baseRevision: number;
    readonly revision: number;
    readonly chunks: readonly Uint8Array[];
    readonly contiguous: boolean;
  }) => void;
  readonly scheduler?: SessionRuntimeScheduler;
  readonly observability?: SessionRuntimeObservability;
  /** Parser implementation only; SessionRuntime remains the sole state authority. */
  readonly backendFactory?: TerminalInterpreterBackendFactory;
}

export interface TerminalReplicaInterpreterStats {
  readonly fullWalks: number;
  readonly gridRowsRead: number;
  readonly historyRowsRead: number;
  readonly placementRowsRead: number;
  readonly cellsRead: number;
  readonly parseBatches: number;
  readonly historyKeyVisits: number;
}

/** Daemon-owned, sans-I/O VT interpreter with one FIFO for bytes and geometry. */
export class TerminalReplicaInterpreter {
  readonly #generation: SessionRuntimeGeneration;
  readonly #workspaceName: string;
  readonly #semanticPaneId: string;
  readonly #incarnation: string;
  readonly #scrollback: number;
  readonly #listeners = new Set<
    (update: CanonicalTerminalReplicaUpdate, trace: SessionRuntimeTraceContext | null) => void
  >();
  readonly #onRawCommit: TerminalReplicaInterpreterOptions["onRawCommit"];
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #observability: SessionRuntimeObservability;
  readonly #backendFactory: TerminalInterpreterBackendFactory;
  #backend: TerminalInterpreterBackend;
  #prioritizeNextWrite = false;
  #causalCell: CausalCellLedger | null = null;
  #releaseCausalOsc: (() => void) | null = null;
  #tail: Promise<void> = Promise.resolve();
  #revision = 0;
  #snapshot: TerminalReplicaSnapshot;
  #needsSeed = true;
  #closed = false;
  #walkCount = 0;
  #pendingWrites: Array<{
    data: Uint8Array;
    trace: SessionRuntimeTraceContext | null;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  #writeFlushScheduled = false;
  #widgetGate = false;
  #markerTail = "";
  #pendingResize: { cols: number; rows: number } | null = null;
  #pendingRaw: Uint8Array[] = [];
  #pendingRawBytes = 0;
  #rawContinuityLost = false;
  #syncRecovery: SessionRuntimeTimer | null = null;
  #bootstrap: TerminalReplicaSnapshot["bootstrap"] = {
    kind: "painted-capture",
    hiddenState: "unknown",
  };
  #projectedHistoryDelta: CanonicalTerminalReplicaPatch["patch"]["historyDelta"] | null = null;
  #stats = {
    fullWalks: 0,
    gridRowsRead: 0,
    historyRowsRead: 0,
    placementRowsRead: 0,
    cellsRead: 0,
    parseBatches: 0,
    historyKeyVisits: 0,
  };
  readonly #seedReady: Promise<void>;
  #resolveSeedReady!: () => void;
  #rejectSeedReady!: (error: unknown) => void;

  constructor(options: TerminalReplicaInterpreterOptions) {
    this.#generation = options.generation;
    this.#workspaceName = options.workspaceName;
    this.#semanticPaneId = options.semanticPaneId;
    this.#incarnation = options.incarnation;
    this.#revision = options.initialRevision ?? 0;
    this.#scrollback = options.scrollback ?? 5000;
    this.#onRawCommit = options.onRawCommit;
    this.#scheduler = options.scheduler ?? SYSTEM_SESSION_RUNTIME_SCHEDULER;
    this.#observability = options.observability ?? DISABLED_SESSION_RUNTIME_OBSERVABILITY;
    this.#backendFactory = options.backendFactory ?? createXtermTerminalInterpreterBackend;
    this.#backend = this.#backendFactory({
      cols: options.cols,
      rows: options.rows,
      scrollback: this.#scrollback,
    });
    this.#snapshot = blankTerminalReplicaSnapshot(options.cols, options.rows);
    this.#seedReady = new Promise((resolve, reject) => {
      this.#resolveSeedReady = resolve;
      this.#rejectSeedReady = reject;
    });
    void this.#seedReady.catch(() => undefined);
    if (options.onUpdate) this.#listeners.add(options.onUpdate);
  }

  onUpdate(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  enqueue(operation: TerminalReplicaInterpreterOperation): Promise<void> {
    if (operation.type === "write") {
      const data = operation.data.slice();
      const trace = operation.trace ?? null;
      const pendingTrace = this.#pendingWrites[0]?.trace ?? null;
      if (
        this.#pendingWrites.length > 0 &&
        (pendingTrace?.traceId ?? null) !== (trace?.traceId ?? null)
      )
        this.#flushWrites();
      const promise = new Promise<void>((resolve, reject) => {
        this.#pendingWrites.push({ data, trace, resolve, reject });
      });
      if (!this.#writeFlushScheduled) {
        this.#writeFlushScheduled = true;
        this.#scheduler.microtask(() => this.#flushWrites());
      }
      return promise;
    }
    this.#flushWrites();
    const admitted =
      operation.type === "reseed"
        ? { ...operation, chunks: operation.chunks.map((chunk) => chunk.slice()) }
        : operation;
    return this.#append(admitted);
  }

  whenIdle(): Promise<void> {
    this.#flushWrites();
    return this.#tail;
  }

  currentSnapshot(): TerminalReplicaSnapshot {
    return this.#snapshot;
  }

  currentSeed(): CanonicalTerminalReplicaSeed | null {
    return this.#needsSeed ? null : this.#seed(this.#revision, this.#snapshot);
  }

  /** Prioritize one future parser admission, independent of diagnostic tracing. */
  prioritizeNextWrite(): void {
    if (!this.#closed) this.#prioritizeNextWrite = true;
  }

  armCausalCellProbe(
    probe: CausalCellProbeV1,
    onResult: (result: CausalCellLedgerResult) => void,
  ): void {
    if (this.#closed) throw new Error("Terminal replica is closed");
    if (this.#causalCell) throw new Error("A causal-cell probe is already active");
    const seed = this.currentSeed();
    if (
      !seed ||
      seed.revision !== probe.baselineRevision ||
      seed.stateHash !== probe.baselineStateHash ||
      seed.incarnation !== probe.incarnation ||
      this.#snapshot.cols !== probe.geometry.cols ||
      this.#snapshot.rows !== probe.geometry.rows ||
      JSON.stringify(this.#snapshot.grid[probe.geometry.row]?.cells[probe.geometry.column]) !==
        JSON.stringify(probe.before)
    )
      throw new Error("Causal-cell baseline drifted before admission");
    const ledger = new CausalCellLedger({
      probe,
      baseline: this.#snapshot,
      scheduler: this.#scheduler,
      onResult: (result) => {
        if (this.#causalCell === ledger) this.#clearCausalCell();
        onResult(result);
      },
    });
    this.#causalCell = ledger;
    this.#releaseCausalOsc = this.#backend.registerOscHandler(CAUSAL_CELL_OSC, (data) =>
      ledger.observeOsc(data),
    );
  }

  noteCausalCellControlReply(traceId: string, ok: boolean): void {
    if (this.#causalCell?.traceId === traceId) this.#causalCell.observeControlReply(ok);
  }

  failCausalCell(reason: CausalCellFailureReasonV1, traceId?: string): void {
    if (traceId === undefined || this.#causalCell?.traceId === traceId) {
      this.#causalCell?.fail(reason);
    }
  }

  whenSeeded(): Promise<void> {
    return this.#seedReady;
  }

  abort(error: unknown): void {
    this.#causalCell?.fail("transport-closed");
    if (this.#needsSeed) this.#rejectSeedReady(error);
  }

  gridWalkCount(): number {
    return this.#walkCount;
  }

  stats(): TerminalReplicaInterpreterStats {
    return Object.freeze({ ...this.#stats });
  }

  #append(
    operation: Exclude<TerminalReplicaInterpreterOperation, { type: "write" }>,
  ): Promise<void> {
    const run = this.#tail.then(() => this.#apply(operation));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #apply(
    operation: Exclude<TerminalReplicaInterpreterOperation, { type: "write" }>,
  ): Promise<void> {
    if (this.#closed) return;
    if (operation.type === "reseed") {
      this.#causalCell?.fail("reseeded");
      const replacement = this.#backendFactory({
        cols: operation.cols,
        rows: operation.rows,
        scrollback: this.#scrollback,
      });
      try {
        for (const chunk of operation.chunks) {
          this.#admitRaw(chunk);
          this.#observeMarkerBytes(chunk);
          await this.#writeToBackend(replacement, chunk);
        }
      } catch (error) {
        replacement.dispose();
        throw error;
      }
      const previous = this.#backend;
      this.#backend = replacement;
      this.#bootstrap = {
        kind: operation.bootstrap,
        hiddenState:
          operation.bootstrap === "authoritative-stream" ? "observed-from-start" : "unknown",
      };
      this.#backend.setAuthoritativeCursor(operation.cursor.x, operation.cursor.y);
      this.#commit(true, undefined, operation.trace ?? null);
      previous.dispose();
      return;
    }
    if (operation.type === "cursor") {
      // Cursor truth is an overlay. Never inject CUP: DECOM/margins would make
      // it relative and mutate the parser's saved/wrap state.
      this.#backend.setAuthoritativeCursor(operation.x, operation.y);
      this.#commit(false, { start: 1, end: 0 });
      return;
    }
    if (operation.type === "resize") {
      this.#causalCell?.fail("geometry-drift");
      if (this.#backend.modes().synchronizedOutput) {
        // Geometry is part of the admitted FIFO even while publication is
        // atomic. Later bytes must parse at the new size.
        this.#backend.resize(operation.cols, operation.rows);
        this.#pendingResize = { cols: operation.cols, rows: operation.rows };
        this.#scheduleSyncRecovery();
        return;
      }
      this.#backend.resize(operation.cols, operation.rows);
      this.#commit(false);
      return;
    }
    const baseRevision = this.#revision;
    const revision = baseRevision + 1;
    const update: CanonicalTerminalReplicaTombstone = {
      type: "terminal.tombstone",
      ...this.#address(),
      baseRevision,
      revision,
      cols: this.#snapshot.cols,
      rows: this.#snapshot.rows,
      stateHash: hashTerminalReplicaTombstone(operation.reason),
      hashAlgorithm: "fnv1a64-v1",
      tombstone: { reason: operation.reason },
    };
    this.#revision = revision;
    this.#closed = true;
    this.#causalCell?.fail("transport-closed");
    this.#clearSyncRecovery();
    if (this.#needsSeed)
      this.#rejectSeedReady(new Error("Terminal replica closed before bootstrap"));
    this.#backend.dispose();
    this.#emit(update);
  }

  async #write(data: Uint8Array, continuedTrace: SessionRuntimeTraceContext | null): Promise<void> {
    if (this.#closed) return;
    // This optional id is only a controlled next-output probe. It is not a
    // causal assertion: unrelated external tmux output arriving first may
    // consume the armed probe and become the measured output.
    const trace = continuedTrace;
    this.#admitRaw(data);
    this.#stats.parseBatches += 1;
    this.#observeMarkerBytes(data);
    const parseStarted = this.#observability.enabled ? this.#observability.nowMicros() : 0;
    await this.#writeToBackend(this.#backend, data);
    if (this.#observability.enabled)
      this.#observability.recordSpan(
        "parse",
        "terminal-replica-write",
        parseStarted,
        this.#observability.nowMicros(),
        trace,
      );
    // DEC synchronized-output is atomic: no intermediate frame leaks.
    if (this.#backend.modes().synchronizedOutput) {
      this.#scheduleSyncRecovery();
      return;
    }
    this.#clearSyncRecovery();
    const pendingResize = this.#pendingResize;
    this.#pendingResize = null;
    if (pendingResize) {
      this.#commit(false, undefined, trace);
    } else {
      this.#commit(false, this.#backend.dirtyRange(), trace);
    }
  }

  #scheduleSyncRecovery(): void {
    if (this.#syncRecovery || this.#closed) return;
    this.#syncRecovery = this.#scheduler.timer(() => {
      this.#syncRecovery = null;
      const run = this.#tail.then(async () => {
        if (this.#closed || !this.#backend.modes().synchronizedOutput) return;
        // Recovery is synthetic parser maintenance, not pane output caused by
        // the user's input. Preserve the one-shot for the next real stream or
        // reseed byte instead of consuming it here.
        await this.#backend.write("\u001b[?2026l");
        this.#pendingResize = null;
        this.#commit(false);
      });
      this.#tail = run.catch(() => undefined);
    }, 250);
  }

  #writeToBackend(backend: TerminalInterpreterBackend, data: Uint8Array | string): Promise<void> {
    if (this.#prioritizeNextWrite) {
      this.#prioritizeNextWrite = false;
      backend.prioritizeNextWrite();
    }
    return backend.write(data);
  }

  #clearSyncRecovery(): void {
    if (!this.#syncRecovery) return;
    this.#syncRecovery.cancel();
    this.#syncRecovery = null;
  }

  #commit(
    forceSeed: boolean,
    dirty?: { start: number; end: number },
    trace: SessionRuntimeTraceContext | null = null,
  ): void {
    const reduceStarted = this.#observability.enabled ? this.#observability.nowMicros() : 0;
    const projected = this.#project(forceSeed ? undefined : dirty);
    const previous = this.#snapshot;
    const dirtyRows: CanonicalTerminalReplicaPatch["patch"]["rows"] = [];
    for (let index = 0; index < projected.grid.length; index += 1) {
      const row = projected.grid[index]!;
      if (!terminalReplicaRowsEqual(previous.grid[index], row)) dirtyRows.push({ index, row });
    }
    const historyChanged = previous.history !== projected.history;
    const historyDelta = historyChanged ? this.#projectedHistoryDelta : null;
    const next = applyTerminalReplicaPatch(previous, {
      ...(projected.cols !== previous.cols || projected.rows !== previous.rows
        ? { dimensions: { cols: projected.cols, rows: projected.rows } }
        : {}),
      rows: dirtyRows,
      ...(historyChanged ? (historyDelta ? { historyDelta } : { history: projected.history }) : {}),
      cursor: projected.cursor,
      modes: projected.modes,
      placements: projected.placements,
      bootstrap: projected.bootstrap,
    });
    const nextHash = hashTerminalReplicaSnapshot(next);
    const priorHash = hashTerminalReplicaSnapshot(previous);
    if (!forceSeed && nextHash === priorHash) {
      this.#causalCell?.observeCommit(next, this.#revision, nextHash);
      this.#recordReduceSpan(reduceStarted, trace);
      return;
    }
    if (forceSeed || this.#needsSeed) {
      const revision = this.#needsSeed ? this.#revision : this.#revision + 1;
      this.#revision = revision;
      this.#snapshot = next;
      this.#needsSeed = false;
      this.#resolveSeedReady();
      this.#emitRaw(revision, revision);
      this.#emit(this.#seed(revision, next), trace);
      this.#causalCell?.observeCommit(next, revision, nextHash);
      this.#recordReduceSpan(reduceStarted, trace);
      return;
    }
    const baseRevision = this.#revision;
    const revision = baseRevision + 1;
    const update: CanonicalTerminalReplicaPatch = {
      type: "terminal.patch",
      ...this.#address(),
      baseRevision,
      revision,
      cols: next.cols,
      rows: next.rows,
      stateHash: nextHash,
      hashAlgorithm: "fnv1a64-v1",
      patch: {
        ...(next.cols !== previous.cols || next.rows !== previous.rows
          ? { dimensions: { cols: next.cols, rows: next.rows } }
          : {}),
        rows: dirtyRows,
        ...(historyChanged ? (historyDelta ? { historyDelta } : { history: next.history }) : {}),
        cursor: next.cursor,
        modes: next.modes,
        placements: next.placements,
        bootstrap: next.bootstrap,
      },
    };
    this.#revision = revision;
    this.#snapshot = next;
    this.#emitRaw(baseRevision, revision);
    this.#emit(update, trace);
    this.#causalCell?.observeCommit(next, revision, nextHash);
    this.#recordReduceSpan(reduceStarted, trace);
  }

  #clearCausalCell(): void {
    this.#causalCell = null;
    this.#releaseCausalOsc?.();
    this.#releaseCausalOsc = null;
  }

  #recordReduceSpan(
    startedAtMicros: number,
    trace: SessionRuntimeTraceContext | null = null,
  ): void {
    if (!this.#observability.enabled) return;
    this.#observability.recordSpan(
      "reduce",
      "terminal-replica-project-commit",
      startedAtMicros,
      this.#observability.nowMicros(),
      trace,
    );
  }

  #emitRaw(baseRevision: number, revision: number): void {
    const chunks = this.#pendingRaw;
    this.#pendingRaw = [];
    this.#pendingRawBytes = 0;
    const contiguous = !this.#rawContinuityLost;
    this.#rawContinuityLost = false;
    if (!this.#onRawCommit || (chunks.length === 0 && contiguous)) return;
    this.#onRawCommit({ baseRevision, revision, chunks, contiguous });
  }

  #admitRaw(data: Uint8Array): void {
    if (this.#pendingRawBytes + data.byteLength <= 4 * 1024 * 1024) {
      this.#pendingRaw.push(data);
      this.#pendingRawBytes += data.byteLength;
    } else {
      this.#rawContinuityLost = true;
    }
  }

  #project(dirty?: { start: number; end: number }): TerminalReplicaSnapshot {
    this.#walkCount += 1;
    const projection = this.#backend.project(this.#snapshot, dirty);
    this.#stats.fullWalks += projection.stats.fullWalks;
    this.#stats.gridRowsRead += projection.stats.gridRowsRead;
    this.#stats.historyRowsRead += projection.stats.historyRowsRead;
    this.#stats.cellsRead += projection.stats.cellsRead;
    this.#projectedHistoryDelta = projection.historyDelta;
    const scanPlacements = this.#widgetGate || this.#snapshot.placements.length > 0;
    const placementRows = scanPlacements ? [...projection.history, ...projection.grid] : [];
    if (scanPlacements) this.#stats.placementRowsRead += placementRows.length;
    const placements = scanPlacements
      ? projectPlacements(placementRows, projection.grid.length, projection.cols)
      : [];
    if (scanPlacements && placements.length === 0) this.#widgetGate = false;
    return assembleTerminalReplicaSnapshot({
      cols: projection.cols,
      rows: projection.rows,
      grid: projection.grid as TerminalReplicaRow[],
      history: projection.history as TerminalReplicaRow[],
      cursor: projection.cursor,
      modes: projection.modes,
      placements,
      bootstrap: this.#bootstrap,
    });
  }

  #seed(revision: number, snapshot: TerminalReplicaSnapshot): CanonicalTerminalReplicaSeed {
    return {
      type: "terminal.seed",
      ...this.#address(),
      revision,
      cols: snapshot.cols,
      rows: snapshot.rows,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
      snapshot,
    };
  }

  #address() {
    return {
      workspaceName: this.#workspaceName,
      semanticPaneId: this.#semanticPaneId,
      generation: this.#generation,
      incarnation: this.#incarnation,
    } as const;
  }

  #emit(
    update: CanonicalTerminalReplicaUpdate,
    trace: SessionRuntimeTraceContext | null = null,
  ): void {
    for (const listener of this.#listeners) {
      try {
        listener(update, trace);
      } catch {
        // Renderer callbacks never poison the authoritative parser FIFO.
      }
    }
  }

  #flushWrites(): void {
    this.#writeFlushScheduled = false;
    if (this.#pendingWrites.length === 0) return;
    const pending = this.#pendingWrites.splice(0);
    const length = pending.reduce((total, entry) => total + entry.data.length, 0);
    const data = new Uint8Array(length);
    let offset = 0;
    for (const entry of pending) {
      data.set(entry.data, offset);
      offset += entry.data.length;
    }
    const trace = pending.find(({ trace }) => trace !== null)?.trace ?? null;
    const run = this.#tail.then(() => this.#write(data, trace));
    this.#tail = run.catch(() => undefined);
    void run.then(
      () => pending.forEach((entry) => entry.resolve()),
      (error) => pending.forEach((entry) => entry.reject(error)),
    );
  }

  #observeMarkerBytes(data: Uint8Array): void {
    if (this.#widgetGate) return;
    const text = this.#markerTail + new TextDecoder().decode(data);
    if (text.includes("TMUXIDE-WIDGET/1")) this.#widgetGate = true;
    this.#markerTail = text.slice(-32);
  }
}

function projectPlacements(
  rows: readonly TerminalReplicaRow[],
  viewportRows: number,
  cols: number,
): TerminalReplicaSnapshot["placements"] {
  const marker = detectWidgetMarkerFromReplicaRows(rows);
  if (!marker) return [];
  return [
    {
      id: marker.id,
      kind: "widget",
      // A pane widget replaces the terminal viewport while its authenticated
      // marker remains present. The marker's physical row is transport detail,
      // not widget geometry: projecting only that row gives the host enough
      // room for chrome but clips every content row below it.
      row: 0,
      column: 0,
      columns: Math.max(1, cols),
      rows: Math.max(1, viewportRows),
      contentDigest: hashTerminalWidgetContent(marker.id, marker.args),
    },
  ];
}
