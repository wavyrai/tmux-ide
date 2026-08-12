import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  detectWidgetMarkerFromReplicaRows,
  type CanonicalTerminalReplicaPatch,
  type CanonicalTerminalReplicaSeed,
  type CanonicalTerminalReplicaTombstone,
  type CanonicalTerminalReplicaUpdate,
  type SessionRuntimeGeneration,
  type TerminalReplicaCell,
  type TerminalReplicaColor,
  type TerminalReplicaModes,
  type TerminalReplicaRow,
  type TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  applyTerminalReplicaPatch,
  assembleTerminalReplicaSnapshot,
  blankTerminalReplicaSnapshot,
  freezeTerminalReplicaRow,
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
  #terminal: Terminal;
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
  readonly #rowCache = new WeakMap<object, CachedRow>();
  #lastViewportY = 0;
  #lastBufferType = "normal";
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
  #scrollEpoch = 0;
  #lastScrollEpoch = 0;
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
    this.#terminal = this.#createTerminal(options.cols, options.rows);
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

  whenSeeded(): Promise<void> {
    return this.#seedReady;
  }

  abort(error: unknown): void {
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
      const replacement = this.#createTerminal(operation.cols, operation.rows);
      try {
        for (const chunk of operation.chunks) {
          this.#admitRaw(chunk);
          this.#observeMarkerBytes(chunk);
          await writeTerminal(replacement, chunk);
        }
      } catch (error) {
        replacement.dispose();
        throw error;
      }
      const previous = this.#terminal;
      this.#terminal = replacement;
      this.#bootstrap = {
        kind: operation.bootstrap,
        hiddenState:
          operation.bootstrap === "authoritative-stream" ? "observed-from-start" : "unknown",
      };
      setAuthoritativeCursor(this.#terminal, operation.cursor.x, operation.cursor.y);
      this.#commit(true, undefined, operation.trace ?? null);
      previous.dispose();
      return;
    }
    if (operation.type === "cursor") {
      // Cursor truth is an overlay. Never inject CUP: DECOM/margins would make
      // it relative and mutate the parser's saved/wrap state.
      setAuthoritativeCursor(this.#terminal, operation.x, operation.y);
      this.#commit(false, { start: 1, end: 0 });
      return;
    }
    if (operation.type === "resize") {
      if (terminalModes(this.#terminal).synchronizedOutput) {
        // Geometry is part of the admitted FIFO even while publication is
        // atomic. Later bytes must parse at the new size.
        this.#terminal.resize(operation.cols, operation.rows);
        this.#pendingResize = { cols: operation.cols, rows: operation.rows };
        this.#scheduleSyncRecovery();
        return;
      }
      this.#terminal.resize(operation.cols, operation.rows);
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
    this.#clearSyncRecovery();
    if (this.#needsSeed)
      this.#rejectSeedReady(new Error("Terminal replica closed before bootstrap"));
    this.#terminal.dispose();
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
    await writeTerminal(this.#terminal, data);
    if (this.#observability.enabled)
      this.#observability.recordSpan(
        "parse",
        "terminal-replica-write",
        parseStarted,
        this.#observability.nowMicros(),
        trace,
      );
    // DEC synchronized-output is atomic: no intermediate frame leaks.
    if (terminalModes(this.#terminal).synchronizedOutput) {
      this.#scheduleSyncRecovery();
      return;
    }
    this.#clearSyncRecovery();
    const pendingResize = this.#pendingResize;
    this.#pendingResize = null;
    if (pendingResize) {
      this.#commit(false, undefined, trace);
    } else {
      this.#commit(false, dirtyRange(this.#terminal), trace);
    }
  }

  #scheduleSyncRecovery(): void {
    if (this.#syncRecovery || this.#closed) return;
    this.#syncRecovery = this.#scheduler.timer(() => {
      this.#syncRecovery = null;
      const run = this.#tail.then(async () => {
        if (this.#closed || !terminalModes(this.#terminal).synchronizedOutput) return;
        await writeTerminal(this.#terminal, "\u001b[?2026l");
        this.#pendingResize = null;
        this.#commit(false);
      });
      this.#tail = run.catch(() => undefined);
    }, 250);
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
    this.#recordReduceSpan(reduceStarted, trace);
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
    if (!dirty) this.#stats.fullWalks += 1;
    const buffer = this.#terminal.buffer.active;
    const geometryStable =
      buffer.viewportY === this.#lastViewportY &&
      buffer.type === this.#lastBufferType &&
      this.#snapshot.cols === this.#terminal.cols;
    const canReuseHistory = geometryStable && this.#scrollEpoch === this.#lastScrollEpoch;
    this.#projectedHistoryDelta = null;
    let history: readonly TerminalReplicaRow[] = canReuseHistory ? this.#snapshot.history : [];
    const scrolls = this.#scrollEpoch - this.#lastScrollEpoch;
    const previousLength = this.#snapshot.history.length;
    const nextLength = buffer.viewportY;
    const incrementalHistory =
      !canReuseHistory &&
      this.#lastBufferType === buffer.type &&
      this.#snapshot.cols === this.#terminal.cols &&
      nextLength >= previousLength &&
      scrolls > 0;
    if (incrementalHistory) {
      const appended = nextLength - previousLength;
      const trim = Math.min(previousLength, Math.max(0, scrolls - appended));
      const retained = previousLength - trim;
      const nextHistory = this.#snapshot.history.slice(trim);
      for (let index = retained; index < nextLength; index += 1)
        nextHistory.push(this.#readRow(buffer, index, this.#terminal.cols, "history"));
      history = nextHistory;
      this.#projectedHistoryDelta = { trim, append: nextHistory.slice(retained) };
    } else if (!canReuseHistory && buffer.viewportY > 0) {
      const nextHistory: TerminalReplicaRow[] = [];
      for (let index = 0; index < buffer.viewportY; index += 1)
        nextHistory.push(this.#readRow(buffer, index, this.#terminal.cols, "history"));
      history = nextHistory;
    }
    const grid: TerminalReplicaRow[] = [];
    const canUseDirtyRange =
      dirty !== undefined && canReuseHistory && this.#snapshot.rows === this.#terminal.rows;
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      if (canUseDirtyRange && (row < dirty.start || row > dirty.end)) {
        grid.push(this.#snapshot.grid[row]!);
      } else {
        grid.push(this.#readRow(buffer, buffer.viewportY + row, this.#terminal.cols, "grid"));
      }
    }
    this.#lastViewportY = buffer.viewportY;
    this.#lastBufferType = buffer.type;
    this.#lastScrollEpoch = this.#scrollEpoch;
    const scanPlacements = this.#widgetGate || this.#snapshot.placements.length > 0;
    const placementRows = scanPlacements ? [...history, ...grid] : [];
    if (scanPlacements) this.#stats.placementRowsRead += placementRows.length;
    const placements = scanPlacements
      ? projectPlacements(placementRows, grid.length, this.#terminal.cols, history.length)
      : [];
    if (scanPlacements && placements.length === 0) this.#widgetGate = false;
    return assembleTerminalReplicaSnapshot({
      cols: this.#terminal.cols,
      rows: this.#terminal.rows,
      grid,
      history: history as TerminalReplicaRow[],
      cursor: cursorState(this.#terminal),
      modes: terminalModes(this.#terminal),
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

  #createTerminal(cols: number, rows: number): Terminal {
    const terminal = new Terminal({
      cols,
      rows,
      scrollback: this.#scrollback,
      allowProposedApi: true,
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.onScroll(() => {
      this.#scrollEpoch += 1;
    });
    const core = (terminal as unknown as { _core?: { coreService?: unknown } })._core;
    if (!core?.coreService) {
      terminal.dispose();
      throw new Error("Unsupported @xterm/headless private API shape");
    }
    return terminal;
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

  #readRow(
    buffer: Terminal["buffer"]["active"],
    index: number,
    cols: number,
    kind: "grid" | "history",
  ): TerminalReplicaRow {
    if (kind === "grid") this.#stats.gridRowsRead += 1;
    else this.#stats.historyRowsRead += 1;
    this.#stats.cellsRead += cols;
    return projectRowCached(this.#rowCache, buffer, index, cols);
  }
}

function writeTerminal(terminal: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function projectRowCached(
  cache: WeakMap<object, CachedRow>,
  buffer: Terminal["buffer"]["active"],
  index: number,
  cols: number,
): TerminalReplicaRow {
  const line = buffer.getLine(index);
  const cacheKey = (line as unknown as { _line?: object } | undefined)?._line ?? line;
  if (line && cacheKey) {
    const data = lineData(line);
    const combined = lineCombinedSignature(line);
    const prior = cache.get(cacheKey);
    if (
      prior &&
      rawRowsEqual(prior.data, data) &&
      prior.combined === combined &&
      prior.wrapped === line.isWrapped
    )
      return prior.row;
  }
  const cell = buffer.getNullCell();
  const cells: TerminalReplicaCell[] = [];
  for (let column = 0; column < cols; column += 1) {
    line?.getCell(column, cell);
    cells.push({
      grapheme: line ? cell.getChars() || (cell.getWidth() === 0 ? "" : " ") : " ",
      width: line ? (cell.getWidth() as 0 | 1 | 2) : 1,
      foreground: line ? cellColor(cell, "foreground") : { kind: "default" },
      background: line ? cellColor(cell, "background") : { kind: "default" },
      attributes: line ? cellAttributes(cell) : 0,
    });
  }
  const row = freezeTerminalReplicaRow({ cells, wrapped: line?.isWrapped ?? false });
  if (line && cacheKey)
    cache.set(cacheKey, {
      data: lineData(line)?.slice() ?? null,
      combined: lineCombinedSignature(line),
      wrapped: line.isWrapped,
      row,
    });
  return row;
}

interface CachedRow {
  readonly data: Uint32Array | null;
  readonly combined: string;
  readonly wrapped: boolean;
  readonly row: TerminalReplicaRow;
}

function lineData(line: object): Uint32Array | null {
  const data = (line as { _line?: { _data?: Uint32Array } })._line?._data;
  return data instanceof Uint32Array ? data : null;
}

function lineCombinedSignature(line: object): string {
  const combined = (line as { _line?: { _combined?: Record<string, string> } })._line?._combined;
  if (!combined) return "";
  return Object.keys(combined)
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => `${key.length}:${key}${combined[key]!.length}:${combined[key]}`)
    .join(";");
}

function rawRowsEqual(left: Uint32Array | null, right: Uint32Array | null): boolean {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function cellColor(
  cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>,
  channel: "foreground" | "background",
): TerminalReplicaColor {
  const rgb = channel === "foreground" ? cell.isFgRGB() : cell.isBgRGB();
  const palette = channel === "foreground" ? cell.isFgPalette() : cell.isBgPalette();
  const value = channel === "foreground" ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return { kind: "rgb", value };
  if (palette) return { kind: "indexed", index: value };
  return { kind: "default" };
}

function cellAttributes(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>): number {
  return (
    (cell.isBold() ? 1 : 0) |
    (cell.isDim() ? 2 : 0) |
    (cell.isItalic() ? 4 : 0) |
    (cell.isUnderline() ? 8 : 0) |
    (cell.isBlink() ? 16 : 0) |
    (cell.isInverse() ? 32 : 0) |
    (cell.isInvisible() ? 64 : 0) |
    (cell.isStrikethrough() ? 128 : 0)
  );
}

function cursorState(terminal: Terminal): TerminalReplicaSnapshot["cursor"] {
  const buffer = terminal.buffer.active;
  const service = (
    terminal as unknown as {
      _core?: {
        coreService?: {
          isCursorHidden?: boolean;
          decPrivateModes?: { cursorStyle?: "block" | "underline" | "bar"; cursorBlink?: boolean };
        };
      };
    }
  )._core?.coreService;
  return {
    x: Math.min(buffer.cursorX, terminal.cols - 1),
    y: Math.min(buffer.cursorY, terminal.rows - 1),
    hidden: service?.isCursorHidden === true,
    style: service?.decPrivateModes?.cursorStyle ?? terminal.options.cursorStyle ?? "block",
    blink: service?.decPrivateModes?.cursorBlink ?? terminal.options.cursorBlink ?? false,
  };
}

/** Pinned xterm 6.0.0 adapter: update parser cursor truth without CSI/DECOM side effects. */
function setAuthoritativeCursor(terminal: Terminal, x: number, y: number): void {
  const active = terminal.buffer.active as unknown as {
    _buffer?: { x?: number; y?: number; _cols?: number; _rows?: number };
  };
  const buffer = active._buffer;
  if (
    !buffer ||
    typeof buffer.x !== "number" ||
    typeof buffer.y !== "number" ||
    buffer._cols !== terminal.cols ||
    buffer._rows !== terminal.rows
  ) {
    throw new Error("Unsupported @xterm/headless 6.0.0 cursor adapter shape");
  }
  buffer.x = Math.max(0, Math.min(x, terminal.cols - 1));
  buffer.y = Math.max(0, Math.min(y, terminal.rows - 1));
}

function terminalModes(terminal: Terminal): TerminalReplicaModes {
  const core = (
    terminal as unknown as {
      _core?: {
        coreService?: {
          decPrivateModes?: Record<string, boolean>;
          modes?: Record<string, boolean>;
        };
        coreMouseService?: { _activeProtocol?: string };
      };
    }
  )._core;
  const dec = core?.coreService?.decPrivateModes ?? {};
  const modes = core?.coreService?.modes ?? {};
  return {
    alternateScreen: terminal.buffer.active.type === "alternate",
    applicationCursor: dec.applicationCursorKeys === true,
    applicationKeypad: dec.applicationKeypad === true,
    bracketedPaste: dec.bracketedPasteMode === true,
    insert: modes.insertMode === true,
    origin: dec.origin === true,
    wraparound: dec.wraparound !== false,
    mouseTracking:
      core?.coreMouseService?._activeProtocol !== undefined &&
      core.coreMouseService._activeProtocol !== "NONE",
    synchronizedOutput: dec.synchronizedOutput === true,
  };
}

function projectPlacements(
  rows: readonly TerminalReplicaRow[],
  viewportRows: number,
  cols: number,
  historyRows: number,
): TerminalReplicaSnapshot["placements"] {
  const marker = detectWidgetMarkerFromReplicaRows(rows);
  if (!marker) return [];
  return [
    {
      id: marker.id,
      kind: "widget",
      row: Math.max(0, Math.min(viewportRows - 1, marker.lineIndex - historyRows)),
      column: 0,
      columns: Math.max(1, cols),
      rows: 1,
      contentDigest: hashTerminalWidgetContent(marker.id, marker.args),
    },
  ];
}

function dirtyRange(terminal: Terminal): { start: number; end: number } | undefined {
  const tracker = (
    terminal as unknown as {
      _core?: { _inputHandler?: { _dirtyRowTracker?: { start?: number; end?: number } } };
    }
  )._core?._inputHandler?._dirtyRowTracker;
  return typeof tracker?.start === "number" && typeof tracker.end === "number"
    ? { start: tracker.start, end: tracker.end }
    : undefined;
}
