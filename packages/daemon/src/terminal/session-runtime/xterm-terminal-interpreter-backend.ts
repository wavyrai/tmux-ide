import { Terminal } from "@xterm/headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type {
  TerminalReplicaCell,
  TerminalReplicaColor,
  TerminalReplicaModes,
  TerminalReplicaRow,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import { freezeTerminalReplicaRow } from "@tmux-ide/core";
import type {
  TerminalInterpreterBackend,
  TerminalInterpreterBackendFactoryOptions,
  TerminalInterpreterBackendProjection,
} from "./terminal-interpreter-backend.ts";

/** Pinned xterm 6 adapter and the rollback oracle for native backends. */
export class XtermTerminalInterpreterBackend implements TerminalInterpreterBackend {
  readonly kind = "xterm";
  readonly #terminal: Terminal;
  readonly #rowCache = new WeakMap<object, CachedRow>();
  #scrollEpoch = 0;
  #lastScrollEpoch = 0;
  #lastViewportY = 0;
  #lastBufferType = "normal";
  #hasProjected = false;

  constructor(options: TerminalInterpreterBackendFactoryOptions) {
    this.#terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
    });
    this.#terminal.loadAddon(new Unicode11Addon());
    this.#terminal.unicode.activeVersion = "11";
    this.#terminal.onScroll(() => {
      this.#scrollEpoch += 1;
    });
    const core = (
      this.#terminal as unknown as {
        _core?: { coreService?: unknown };
      }
    )._core;
    if (!core?.coreService) {
      this.#terminal.dispose();
      throw new Error("Unsupported @xterm/headless private API shape");
    }
  }

  get cols(): number {
    return this.#terminal.cols;
  }

  get rows(): number {
    return this.#terminal.rows;
  }

  write(data: Uint8Array | string): Promise<void> {
    return new Promise((resolve) => this.#terminal.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
  }

  setAuthoritativeCursor(x: number, y: number): void {
    const active = this.#terminal.buffer.active as unknown as {
      _buffer?: { x?: number; y?: number; _cols?: number; _rows?: number };
    };
    const buffer = active._buffer;
    if (
      !buffer ||
      typeof buffer.x !== "number" ||
      typeof buffer.y !== "number" ||
      buffer._cols !== this.#terminal.cols ||
      buffer._rows !== this.#terminal.rows
    )
      throw new Error("Unsupported @xterm/headless 6.0.0 cursor adapter shape");
    buffer.x = Math.max(0, Math.min(x, this.#terminal.cols - 1));
    buffer.y = Math.max(0, Math.min(y, this.#terminal.rows - 1));
  }

  modes(): TerminalReplicaModes {
    const core = (
      this.#terminal as unknown as {
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
      alternateScreen: this.#terminal.buffer.active.type === "alternate",
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

  dirtyRange(): { start: number; end: number } | undefined {
    const tracker = (
      this.#terminal as unknown as {
        _core?: { _inputHandler?: { _dirtyRowTracker?: { start?: number; end?: number } } };
      }
    )._core?._inputHandler?._dirtyRowTracker;
    return typeof tracker?.start === "number" && typeof tracker.end === "number"
      ? { start: tracker.start, end: tracker.end }
      : undefined;
  }

  project(
    previous: TerminalReplicaSnapshot,
    dirty?: { start: number; end: number },
  ): TerminalInterpreterBackendProjection {
    const buffer = this.#terminal.buffer.active;
    // A newly constructed xterm and the interpreter's blank snapshot already
    // describe the same zero-history geometry. Requiring a prior projection
    // turns the first dirty write into an unnecessary full-grid walk.
    const ownsPrevious = this.#hasProjected || isCanonicalBlankSnapshot(previous);
    const geometryStable =
      ownsPrevious &&
      buffer.viewportY === this.#lastViewportY &&
      buffer.type === this.#lastBufferType &&
      previous.cols === this.#terminal.cols;
    const canReuseHistory = geometryStable && this.#scrollEpoch === this.#lastScrollEpoch;
    const stats = { fullWalks: dirty ? 0 : 1, gridRowsRead: 0, historyRowsRead: 0, cellsRead: 0 };
    let history: readonly TerminalReplicaRow[] = canReuseHistory ? previous.history : [];
    let historyDelta: TerminalInterpreterBackendProjection["historyDelta"] = null;
    const scrolls = this.#scrollEpoch - this.#lastScrollEpoch;
    const previousLength = previous.history.length;
    const nextLength = buffer.viewportY;
    const incrementalHistory =
      !canReuseHistory &&
      this.#lastBufferType === buffer.type &&
      previous.cols === this.#terminal.cols &&
      nextLength >= previousLength &&
      scrolls > 0;
    if (incrementalHistory) {
      const appended = nextLength - previousLength;
      const trim = Math.min(previousLength, Math.max(0, scrolls - appended));
      const retained = previousLength - trim;
      const nextHistory = previous.history.slice(trim);
      for (let index = retained; index < nextLength; index += 1)
        nextHistory.push(this.#readRow(buffer, index, this.#terminal.cols, "history", stats));
      history = nextHistory;
      historyDelta = { trim, append: nextHistory.slice(retained) };
    } else if (!canReuseHistory && buffer.viewportY > 0) {
      const nextHistory: TerminalReplicaRow[] = [];
      for (let index = 0; index < buffer.viewportY; index += 1)
        nextHistory.push(this.#readRow(buffer, index, this.#terminal.cols, "history", stats));
      history = nextHistory;
    }
    const grid: TerminalReplicaRow[] = [];
    const canUseDirtyRange =
      dirty !== undefined && canReuseHistory && previous.rows === this.#terminal.rows;
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      if (canUseDirtyRange && (row < dirty.start || row > dirty.end))
        grid.push(previous.grid[row]!);
      else
        grid.push(
          this.#readRow(buffer, buffer.viewportY + row, this.#terminal.cols, "grid", stats),
        );
    }
    this.#lastViewportY = buffer.viewportY;
    this.#lastBufferType = buffer.type;
    this.#lastScrollEpoch = this.#scrollEpoch;
    this.#hasProjected = true;
    return {
      cols: this.#terminal.cols,
      rows: this.#terminal.rows,
      grid,
      history,
      cursor: this.#cursorState(),
      modes: this.modes(),
      historyDelta,
      stats,
    };
  }

  dispose(): void {
    this.#terminal.dispose();
  }

  #cursorState(): TerminalReplicaSnapshot["cursor"] {
    const buffer = this.#terminal.buffer.active;
    const service = (
      this.#terminal as unknown as {
        _core?: {
          coreService?: {
            isCursorHidden?: boolean;
            decPrivateModes?: {
              cursorStyle?: "block" | "underline" | "bar";
              cursorBlink?: boolean;
            };
          };
        };
      }
    )._core?.coreService;
    return {
      x: Math.min(buffer.cursorX, this.#terminal.cols - 1),
      y: Math.min(buffer.cursorY, this.#terminal.rows - 1),
      hidden: service?.isCursorHidden === true,
      style: service?.decPrivateModes?.cursorStyle ?? this.#terminal.options.cursorStyle ?? "block",
      blink: service?.decPrivateModes?.cursorBlink ?? this.#terminal.options.cursorBlink ?? false,
    };
  }

  #readRow(
    buffer: Terminal["buffer"]["active"],
    index: number,
    cols: number,
    kind: "grid" | "history",
    stats: { gridRowsRead: number; historyRowsRead: number; cellsRead: number },
  ): TerminalReplicaRow {
    if (kind === "grid") stats.gridRowsRead += 1;
    else stats.historyRowsRead += 1;
    stats.cellsRead += cols;
    return projectRowCached(this.#rowCache, buffer, index, cols);
  }
}

function isCanonicalBlankSnapshot(snapshot: TerminalReplicaSnapshot): boolean {
  if (snapshot.history.length > 0 || snapshot.grid.length !== snapshot.rows) return false;
  return snapshot.grid.every(
    (row) =>
      !row.wrapped &&
      row.cells.length === snapshot.cols &&
      row.cells.every(
        (cell) =>
          cell.grapheme === " " &&
          cell.width === 1 &&
          cell.attributes === 0 &&
          cell.foreground.kind === "default" &&
          cell.background.kind === "default",
      ),
  );
}

export function createXtermTerminalInterpreterBackend(
  options: TerminalInterpreterBackendFactoryOptions,
): TerminalInterpreterBackend {
  return new XtermTerminalInterpreterBackend(options);
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
