import type { MirrorObservedTerminalModes } from "../mirror/events.ts";
import { Terminal } from "@tmux-ide/xterm-headless";
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
  #bufferChangedSinceProjection = false;
  #mouseUtf8 = false;
  #capturedAlternate = false;
  #nativeReseedRequired = false;
  #nativeModesObserved = false;
  #historyProjectionInvalidated = false;
  #scrollOnClear: boolean | undefined;

  constructor(options: TerminalInterpreterBackendFactoryOptions) {
    this.#terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      tmuxHistoryLimit: options.historyLimit ?? options.scrollback,
      allowProposedApi: true,
    });
    this.#terminal.loadAddon(new Unicode11Addon());
    this.#terminal.unicode.activeVersion = "11";
    this.#terminal.buffer.onBufferChange((buffer) => {
      // A normal→alternate→normal round trip can occur within one write.
      // Its scroll notifications are not normal-history append operations.
      this.#bufferChangedSinceProjection = true;
      if (this.#capturedAlternate && buffer.type === "normal") this.#nativeReseedRequired = true;
    });
    // Stock tmux retains DECSET 1005 independently of SGR. xterm no longer
    // interprets it; retain the flag for renderer-neutral mouse encoding truth.
    for (const [final, enabled] of [
      ["h", true],
      ["l", false],
    ] as const) {
      this.#terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(1005)) this.#mouseUtf8 = enabled;
        return false;
      });
    }
    this.#terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.#mouseUtf8 = false;
      this.#historyProjectionInvalidated = true;
      return false;
    });
    this.#terminal.parser.registerCsiHandler({ final: "J" }, (params) => {
      if (params[0] === 3) this.#historyProjectionInvalidated = true;
      if (
        params[0] === 2 &&
        this.#nativeModesObserved &&
        this.#scrollOnClear === undefined &&
        this.#terminal.buffer.active.type === "normal"
      )
        this.#nativeReseedRequired = true;
      return false;
    });
    this.#terminal.onScroll(() => {
      // tmux retains normal history while alternate rows scroll independently.
      // Neither captured nor live alternate scrolling may trim that history.
      if (this.#terminal.buffer.active.type === "normal") this.#scrollEpoch += 1;
    });
    const core = (
      this.#terminal as unknown as {
        _core?: { coreService?: unknown };
      }
    )._core;
    if (!core?.coreService) {
      this.#terminal.dispose();
      throw new Error("Unsupported @tmux-ide/xterm-headless private API shape");
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

  prioritizeNextWrite(): void {
    this.#terminal.prioritizeNextWrite();
  }

  registerOscHandler(identifier: number, handler: (data: string) => boolean): () => void {
    const disposable = this.#terminal.parser.registerOscHandler(identifier, handler);
    return () => disposable.dispose();
  }

  resize(cols: number, rows: number): void {
    // Native tmux is authoritative for transitions through one column. The
    // parser deliberately skips its incompatible wide-cell reflow in this case.
    if (cols !== this.cols && (cols === 1 || this.cols === 1)) this.#nativeReseedRequired = true;
    if (cols !== this.cols || rows !== this.rows) this.#historyProjectionInvalidated = true;
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
      throw new Error("Unsupported @tmux-ide/xterm-headless 6.0.0 cursor adapter shape");
    // x === cols is parser state: the next printable character must wrap.
    // Only the published cursor is clamped to an addressable cell below.
    buffer.x = Math.max(0, Math.min(x, this.#terminal.cols));
    buffer.y = Math.max(0, Math.min(y, this.#terminal.rows - 1));
  }

  setAuthoritativeWraparound(enabled: boolean): void {
    const core = (
      this.#terminal as unknown as {
        _core: { coreService: { decPrivateModes: { wraparound: boolean } } };
      }
    )._core;
    core.coreService.decPrivateModes.wraparound = enabled;
  }

  requiresNativeReseed(): boolean {
    return this.#nativeReseedRequired;
  }

  #restoreCapturedAlternate(): void {
    if (this.#terminal.buffer.active.type === "normal") {
      type Line = { clone(): Line };
      const core = (
        this.#terminal as unknown as {
          _core: {
            buffers: {
              normal: { ybase: number; lines: { get(index: number): Line | undefined } };
              alt: { lines: { set(index: number, line: Line): void } };
              activateAltBuffer(): void;
            };
          };
        }
      )._core;
      const buffers = core.buffers;
      const lines = Array.from({ length: this.rows }, (_, row) => {
        const line = buffers.normal.lines.get(buffers.normal.ybase + row);
        if (!line || typeof line.clone !== "function")
          throw new Error("Unsupported xterm captured-buffer shape");
        return line.clone();
      });
      buffers.activateAltBuffer();
      for (let row = 0; row < lines.length; row++) buffers.alt.lines.set(row, lines[row]!);
    }
    // The normal buffer retains captured native history, but its visible grid
    // is not the saved shell. Returning to it requires a fresh native capture.
    this.#capturedAlternate = true;
  }

  setAuthoritativeModes(modes: MirrorObservedTerminalModes): void {
    this.#nativeModesObserved = true;
    if (modes.scrollOnClear !== undefined) {
      this.#scrollOnClear = modes.scrollOnClear;
      this.#terminal.options.tmuxScrollOnClear = modes.scrollOnClear;
    }
    if (modes.alternateScreen === true) this.#restoreCapturedAlternate();
    const core = (
      this.#terminal as unknown as {
        _core: {
          coreService: {
            decPrivateModes: {
              applicationCursorKeys: boolean;
              applicationKeypad: boolean;
              bracketedPasteMode: boolean;
              origin: boolean;
            };
            modes: { insertMode: boolean };
            isCursorHidden: boolean;
          };
          coreMouseService: { activeProtocol: string; activeEncoding: string };
        };
      }
    )._core;
    const service = core.coreService;
    if (modes.scrolling) {
      const { top, bottom, origin } = modes.scrolling;
      if (
        !Number.isSafeInteger(top) ||
        !Number.isSafeInteger(bottom) ||
        top < 0 ||
        top > bottom ||
        bottom >= this.rows
      )
        throw new RangeError("Native scrolling region is outside the interpreter grid");
      const buffer = (
        this.#terminal.buffer.active as unknown as {
          _buffer?: { scrollTop: number; scrollBottom: number };
        }
      )._buffer;
      if (
        !buffer ||
        typeof buffer.scrollTop !== "number" ||
        typeof buffer.scrollBottom !== "number"
      )
        throw new Error("Unsupported @tmux-ide/xterm-headless scrolling-region adapter shape");
      // Never replay DECSTBM/DECOM here: both commands move the cursor and can
      // corrupt the capture seam's pending-wrap or absolute cursor position.
      buffer.scrollTop = top;
      buffer.scrollBottom = bottom;
      service.decPrivateModes.origin = origin;
    }
    if (modes.applicationCursor !== undefined)
      service.decPrivateModes.applicationCursorKeys = modes.applicationCursor;
    if (modes.applicationKeypad !== undefined)
      service.decPrivateModes.applicationKeypad = modes.applicationKeypad;
    if (modes.insert !== undefined) service.modes.insertMode = modes.insert;
    if (modes.cursorVisible !== undefined) service.isCursorHidden = !modes.cursorVisible;
    if (modes.bracketedPaste !== undefined)
      service.decPrivateModes.bracketedPasteMode = modes.bracketedPaste;
    if (modes.mouseProtocol !== undefined) {
      const protocols = { none: "NONE", vt200: "VT200", drag: "DRAG", any: "ANY" };
      core.coreMouseService.activeProtocol = protocols[modes.mouseProtocol];
    }
    if (modes.mouseSgr !== undefined)
      core.coreMouseService.activeEncoding = modes.mouseSgr ? "SGR" : "DEFAULT";
    if (modes.mouseUtf8 !== undefined) this.#mouseUtf8 = modes.mouseUtf8;
  }

  modes(): TerminalReplicaModes {
    const core = (
      this.#terminal as unknown as {
        _core?: {
          coreService?: {
            decPrivateModes?: Record<string, boolean>;
            modes?: Record<string, boolean>;
          };
          coreMouseService?: { _activeProtocol?: string; _activeEncoding?: string };
        };
      }
    )._core;
    const dec = core?.coreService?.decPrivateModes ?? {};
    const modes = core?.coreService?.modes ?? {};
    const protocol = core?.coreMouseService?._activeProtocol?.toUpperCase();
    const encoding = core?.coreMouseService?._activeEncoding?.toUpperCase();
    return {
      alternateScreen: this.#terminal.buffer.active.type === "alternate",
      applicationCursor: dec.applicationCursorKeys === true,
      applicationKeypad: dec.applicationKeypad === true,
      bracketedPaste: dec.bracketedPasteMode === true,
      insert: modes.insertMode === true,
      origin: dec.origin === true,
      wraparound: dec.wraparound !== false,
      mouseTracking: protocol !== undefined && protocol !== "NONE",
      mouseProtocol:
        protocol === "X10"
          ? "x10"
          : protocol === "VT200"
            ? "vt200"
            : protocol === "DRAG"
              ? "drag"
              : protocol === "ANY"
                ? "any"
                : "none",
      mouseEncoding:
        encoding === "SGR"
          ? "sgr"
          : encoding === "SGR_PIXELS"
            ? "sgr-pixels"
            : encoding === "UTF8" || this.#mouseUtf8
              ? "utf8"
              : "default",
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
    const historyBuffer = this.#terminal.buffer.normal;
    // A newly constructed xterm and the interpreter's blank snapshot already
    // describe the same zero-history geometry. Requiring a prior projection
    // turns the first dirty write into an unnecessary full-grid walk.
    const ownsPrevious = this.#hasProjected || isCanonicalBlankSnapshot(previous);
    const geometryStable =
      ownsPrevious &&
      !this.#historyProjectionInvalidated &&
      !this.#bufferChangedSinceProjection &&
      historyBuffer.viewportY === this.#lastViewportY &&
      buffer.type === this.#lastBufferType &&
      previous.cols === this.#terminal.cols;
    const canReuseHistory = geometryStable && this.#scrollEpoch === this.#lastScrollEpoch;
    const stats = { fullWalks: dirty ? 0 : 1, gridRowsRead: 0, historyRowsRead: 0, cellsRead: 0 };
    let history: readonly TerminalReplicaRow[] = canReuseHistory ? previous.history : [];
    let historyDelta: TerminalInterpreterBackendProjection["historyDelta"] = null;
    const scrolls = this.#scrollEpoch - this.#lastScrollEpoch;
    const previousLength = previous.history.length;
    const nextLength = historyBuffer.viewportY;
    const incrementalHistory =
      !canReuseHistory &&
      !this.#historyProjectionInvalidated &&
      !this.#bufferChangedSinceProjection &&
      this.#lastBufferType === buffer.type &&
      previous.cols === this.#terminal.cols &&
      scrolls > 0;
    if (incrementalHistory) {
      // ED2 may collect ten percent of native history before appending.
      // A negative length delta is still an incremental trim/append when
      // no reset, resize, or buffer transition invalidated scroll accounting.
      const appended = nextLength - previousLength;
      const trim = Math.min(previousLength, Math.max(0, scrolls - appended));
      const retained = previousLength - trim;
      const nextHistory = previous.history.slice(trim);
      for (let index = retained; index < nextLength; index += 1)
        nextHistory.push(
          this.#readRow(historyBuffer, index, this.#terminal.cols, "history", stats),
        );
      history = nextHistory;
      historyDelta = { trim, append: nextHistory.slice(retained) };
    } else if (!canReuseHistory && historyBuffer.viewportY > 0) {
      const nextHistory: TerminalReplicaRow[] = [];
      for (let index = 0; index < historyBuffer.viewportY; index += 1)
        nextHistory.push(
          this.#readRow(historyBuffer, index, this.#terminal.cols, "history", stats),
        );
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
    this.#lastViewportY = historyBuffer.viewportY;
    this.#lastBufferType = buffer.type;
    this.#lastScrollEpoch = this.#scrollEpoch;
    this.#hasProjected = true;
    this.#bufferChangedSinceProjection = false;
    this.#historyProjectionInvalidated = false;
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
          (cell.grapheme || " ") === " " &&
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
      // Empty width-one cells are unused storage; literal spaces are content.
      // Both paint as blanks, but preserving the distinction is necessary for
      // reflow and for recognizing padding before a wrapped wide glyph.
      grapheme: line && column + cell.getWidth() <= cols ? cell.getChars() : "",
      width: line && column + cell.getWidth() <= cols ? (cell.getWidth() as 0 | 1 | 2) : 1,
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
