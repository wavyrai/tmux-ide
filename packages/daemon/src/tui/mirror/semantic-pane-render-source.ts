import type {
  TerminalDeliveryAck,
  TerminalDeliveryEnvelope,
  TerminalDeliveryNack,
  TerminalDeliveryNegotiated,
  TerminalDeliveryServerMessage,
  TerminalReplicaCell,
  TerminalReplicaColor,
  TerminalReplicaRow,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  TerminalDeliveryAssembler,
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  decodeSemanticTerminalUpdate,
  nackTerminalDelivery,
  type TerminalDeliveryClientState,
} from "@tmux-ide/core";

import {
  SPACE_CODE,
  writeCell,
  writeContinuation,
  type CellArrays,
  type GraphemeOverride,
} from "./blit.ts";
import type { BlitOptions, CursorState } from "./pane-mirror.ts";
import type { TerminalPaneRenderSource } from "./pane-surface.tsx";
import type { TerminalPaletteProjection } from "./theme.ts";

const EMPTY_DIRTY_ROWS: readonly number[] = Object.freeze([]);
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Plain text plus the lossless bridge back to terminal cell coordinates.
 *
 * JavaScript offsets are UTF-16 code-unit offsets. Terminal selection and
 * framebuffer coordinates are cells. Those units diverge for wide glyphs,
 * emoji and combining grapheme clusters, so consumers must never use
 * `String#slice` offsets as cell columns directly.
 */
export interface TerminalCellTextRow {
  readonly text: string;
  readonly cellCount: number;
  readonly cellTextStarts: readonly number[];
  readonly cellTextEnds: readonly number[];
}

const EMPTY_TEXT_ROW: TerminalCellTextRow = Object.freeze({
  text: "",
  cellCount: 0,
  cellTextStarts: Object.freeze([]),
  cellTextEnds: Object.freeze([]),
});

export interface TerminalCellSearchMatch {
  readonly line: number;
  readonly col: number;
  readonly columns: number;
}

export type SemanticPaneReplicaChange =
  | {
      readonly kind: "applied";
      readonly rows: readonly number[];
      readonly cursorChanged: boolean;
      readonly renderKeyChanged: boolean;
      readonly renderKey: string;
      readonly version: number;
    }
  | { readonly kind: "closed"; readonly version: number };

export interface SemanticPaneReplicaOptions {
  readonly negotiated: TerminalDeliveryNegotiated;
  readonly workspaceName: string;
  readonly semanticPaneId: string;
  readonly ack: (ack: TerminalDeliveryAck) => void;
  readonly nack: (nack: TerminalDeliveryNack) => void;
  readonly onChange?: (change: SemanticPaneReplicaChange) => void;
  readonly onControlFailure?: (error: Error) => void;
}

/**
 * Retained renderer adapter for one semantic terminal replica.
 *
 * Delivery is assembled and validated off the Solid tree. A transaction is
 * ACKed only after its canonical state has been applied to this imperative
 * replica. The adapter exposes monotonic versions plus row dirtiness, while the
 * framebuffer reads cells only when OpenTUI asks it to paint.
 */
export class SemanticPaneReplica {
  readonly semanticPaneId: string;
  readonly #ack: SemanticPaneReplicaOptions["ack"];
  readonly #nack: SemanticPaneReplicaOptions["nack"];
  readonly #onChange: SemanticPaneReplicaOptions["onChange"];
  readonly #onControlFailure: SemanticPaneReplicaOptions["onControlFailure"];
  #delivery: TerminalDeliveryClientState;
  #assembler: TerminalDeliveryAssembler | null = null;
  #snapshot: TerminalReplicaSnapshot | null = null;
  #dirtyRows = new Set<number>();
  #lineTrim = 0;
  #version = 0;
  #renderKey: string;
  #surfaceOwner: object | null = null;
  readonly #textRows = new WeakMap<TerminalReplicaRow, TerminalCellTextRow>();

  constructor(options: SemanticPaneReplicaOptions) {
    this.semanticPaneId = options.semanticPaneId;
    this.#ack = options.ack;
    this.#nack = options.nack;
    this.#onChange = options.onChange;
    this.#onControlFailure = options.onControlFailure;
    this.#delivery = createTerminalDeliveryClientState(
      options.negotiated,
      options.workspaceName,
      options.semanticPaneId,
    );
    this.#renderKey = `${options.semanticPaneId}:pending`;
  }

  get version(): number {
    return this.#version;
  }

  get renderKey(): string {
    return this.#renderKey;
  }

  get snapshot(): TerminalReplicaSnapshot | null {
    return this.#snapshot;
  }

  get dirtyRows(): readonly number[] {
    return this.#dirtyRows.size === 0
      ? EMPTY_DIRTY_ROWS
      : [...this.#dirtyRows].sort((a, b) => a - b);
  }

  accept(message: TerminalDeliveryServerMessage): void {
    if (message.type === "terminal.delivery.fault") {
      this.#assembler = null;
      this.#snapshot = null;
      this.#version += 1;
      this.#notify({ kind: "closed", version: this.#version });
      return;
    }
    if (message.type === "terminal.delivery") {
      this.#acceptEnvelope(message);
      return;
    }
    this.#acceptChunk(message);
  }

  scrollbackDepth(): number {
    return this.#snapshot?.history.length ?? 0;
  }

  lineTrim(): number {
    return this.#lineTrim;
  }

  cursorState(): CursorState | null {
    const cursor = this.#snapshot?.cursor;
    return cursor ? { ...cursor } : null;
  }

  visibleRowTexts(scrollOffset = 0): string[] {
    return this.visibleTextRows(scrollOffset).map((row) => row.text);
  }

  visibleTextRows(scrollOffset = 0): TerminalCellTextRow[] {
    const snapshot = this.#snapshot;
    if (!snapshot) return [];
    return Array.from({ length: snapshot.rows }, (_, row) =>
      this.#textRow(visibleRowAt(snapshot, scrollOffset, row)),
    );
  }

  bufferLines(): string[] {
    return this.bufferTextRows().map((row) => row.text);
  }

  bufferTextRows(): TerminalCellTextRow[] {
    const snapshot = this.#snapshot;
    if (!snapshot) return [];
    return [...snapshot.history, ...snapshot.grid].map((row) => this.#textRow(row));
  }

  extractText(
    start: { row: number; col: number },
    end: { row: number; col: number },
    maxBytes: number,
  ): string {
    return extractTerminalCellText(this.bufferTextRows(), start, end, maxBytes);
  }

  findTextMatches(query: string): TerminalCellSearchMatch[] {
    return findTerminalCellMatches(this.bufferTextRows(), query);
  }

  #textRow(row: TerminalReplicaRow | undefined): TerminalCellTextRow {
    if (!row) return EMPTY_TEXT_ROW;
    const retained = this.#textRows.get(row);
    if (retained) return retained;
    const projected = projectTerminalTextRow(row);
    this.#textRows.set(row, projected);
    return projected;
  }

  blit(
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    options: BlitOptions,
  ): void {
    if (options.consumerId) {
      if (this.#surfaceOwner && this.#surfaceOwner !== options.consumerId) {
        throw new Error(`Semantic pane ${this.semanticPaneId} already has a retained surface`);
      }
      this.#surfaceOwner = options.consumerId;
    }
    const forced = options.forceRows ? new Set(options.forceRows) : null;
    const full = options.full || scrollOffset > 0 || !this.#snapshot;
    for (let y = 0; y < height; y += 1) {
      if (!full && !this.#dirtyRows.has(y) && !forced?.has(y)) continue;
      blitSemanticRow(
        visibleRowAt(this.#snapshot, scrollOffset, y),
        buffers,
        y,
        width,
        defaultFg,
        defaultBg,
        options.graphemes,
        options.palette,
      );
      options.dirtyRows.push(y);
    }
    this.#dirtyRows.clear();
  }

  releaseSurface(consumerId: object): void {
    if (this.#surfaceOwner === consumerId) this.#surfaceOwner = null;
  }

  #acceptEnvelope(envelope: TerminalDeliveryEnvelope): void {
    const next = admitTerminalDeliveryEnvelope(this.#delivery, envelope);
    if (next.failed) {
      this.#fail("gap", envelope.transactionId, envelope);
      return;
    }
    this.#delivery = next;
    this.#assembler = new TerminalDeliveryAssembler(envelope);
  }

  #acceptChunk(
    message: Extract<TerminalDeliveryServerMessage, { type: "terminal.delivery.chunk" }>,
  ): void {
    const assembler = this.#assembler;
    if (!assembler) {
      this.#fail("protocol-violation", message.transactionId);
      return;
    }
    let committed: ReturnType<typeof commitTerminalDelivery>;
    let payload: ReturnType<typeof decodeSemanticTerminalUpdate>;
    let envelope: TerminalDeliveryEnvelope;
    const previous = this.#snapshot;
    try {
      assembler.write(message);
      this.#delivery = admitTerminalDeliveryChunk(this.#delivery, message);
      if (this.#delivery.failed) throw new TypeError("Terminal delivery chunk was rejected");
      const admittedEnvelope = this.#delivery.inFlight;
      if (!admittedEnvelope || this.#delivery.nextChunk !== admittedEnvelope.chunkCount) return;
      envelope = admittedEnvelope;
      const staged = completeTerminalDelivery(this.#delivery, assembler);
      payload = decodeSemanticTerminalUpdate(staged.bytes);
      committed = commitTerminalDelivery(this.#delivery, staged);
    } catch {
      this.#fail("decode-failed", message.transactionId);
      return;
    }
    this.#delivery = committed.state;
    this.#assembler = null;
    this.#applySnapshot(previous, committed.state.canonicalSnapshot, envelope, payload);
    // ACK strictly follows imperative presentation-state application. A failed
    // callback/transport is a connection fault, never evidence that decode or
    // canonical commit failed (and therefore never emits a contradictory NACK).
    try {
      this.#ack(committed.ack);
    } catch (error) {
      this.#controlFailure(error);
    }
  }

  #applySnapshot(
    previous: TerminalReplicaSnapshot | null,
    next: TerminalReplicaSnapshot | null,
    envelope: TerminalDeliveryEnvelope,
    payload: ReturnType<typeof decodeSemanticTerminalUpdate>,
  ): void {
    const previousKey = this.#renderKey;
    this.#snapshot = next;
    this.#renderKey = `${this.semanticPaneId}:${envelope.incarnation}`;
    if (!next) {
      this.#version += 1;
      this.#notify({ kind: "closed", version: this.#version });
      return;
    }
    const dirty = changedRows(previous, next, envelope.frame === "seed");
    for (const row of dirty) this.#dirtyRows.add(row);
    if (envelope.frame === "seed") this.#lineTrim = 0;
    else if (payload.frame === "patch" && payload.patch.historyDelta)
      this.#lineTrim += payload.patch.historyDelta.trim;
    else if (previous && next.history.length < previous.history.length)
      this.#lineTrim += previous.history.length - next.history.length;
    this.#version += 1;
    this.#notify({
      kind: "applied",
      rows: dirty,
      cursorChanged: previous?.cursor !== next.cursor,
      renderKeyChanged: previousKey !== this.#renderKey,
      renderKey: this.#renderKey,
      version: this.#version,
    });
  }

  #fail(
    reason: TerminalDeliveryNack["reason"],
    transactionId: string | null,
    attemptedEnvelope?: TerminalDeliveryEnvelope,
  ): void {
    const negotiated = this.#delivery.negotiated;
    const inFlight = this.#delivery.inFlight;
    const nack: TerminalDeliveryNack = {
      type: "terminal.delivery.nack",
      workspaceName: this.#delivery.workspaceName,
      semanticPaneId: this.semanticPaneId,
      generation: negotiated.generation,
      incarnation:
        attemptedEnvelope?.incarnation ??
        inFlight?.incarnation ??
        this.#delivery.incarnation ??
        "unknown",
      deliveryNonce: negotiated.deliveryNonce,
      transactionId: attemptedEnvelope?.transactionId ?? inFlight?.transactionId ?? transactionId,
      reason,
      appliedRevision: this.#delivery.appliedRevision,
    };
    this.#delivery = nackTerminalDelivery(this.#delivery, nack);
    this.#assembler = null;
    try {
      this.#nack(nack);
    } catch (error) {
      this.#controlFailure(error);
    }
  }

  #notify(change: SemanticPaneReplicaChange): void {
    try {
      this.#onChange?.(change);
    } catch (error) {
      this.#controlFailure(error);
    }
  }

  #controlFailure(error: unknown): void {
    this.#onControlFailure?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/** One stable multi-pane source passed to every retained pane renderable. */
export class SemanticTerminalRenderSource implements TerminalPaneRenderSource {
  readonly #panes = new Map<string, SemanticPaneReplica>();

  set(replica: SemanticPaneReplica): void {
    this.#panes.set(replica.semanticPaneId, replica);
  }

  delete(semanticPaneId: string): void {
    this.#panes.delete(semanticPaneId);
  }

  releasePane(paneId: string, consumerId: object): void {
    this.#panes.get(paneId)?.releaseSurface(consumerId);
  }

  replica(semanticPaneId: string): SemanticPaneReplica | undefined {
    return this.#panes.get(semanticPaneId);
  }

  scrollbackDepth(paneId: string): number {
    return this.#panes.get(paneId)?.scrollbackDepth() ?? 0;
  }

  cursorState(paneId: string): CursorState | null {
    return this.#panes.get(paneId)?.cursorState() ?? null;
  }

  blitPane(
    paneId: string,
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    options: BlitOptions,
  ): void {
    this.#panes
      .get(paneId)
      ?.blit(buffers, width, height, scrollOffset, defaultFg, defaultBg, options);
  }
}

function changedRows(
  previous: TerminalReplicaSnapshot | null,
  next: TerminalReplicaSnapshot,
  seed: boolean,
): number[] {
  if (seed || !previous || previous.cols !== next.cols || previous.rows !== next.rows) {
    return Array.from({ length: Math.max(previous?.rows ?? 0, next.rows) }, (_, index) => index);
  }
  const rows: number[] = [];
  for (let index = 0; index < next.rows; index += 1) {
    if (previous.grid[index] !== next.grid[index]) rows.push(index);
  }
  // History changes alter every scrolled projection; a live projection remains
  // row-stable. Mark all rows so the existing scroll/search state stays honest.
  if (previous.history !== next.history)
    return Array.from({ length: next.rows }, (_, index) => index);
  return rows;
}

function visibleRowAt(snapshot: TerminalReplicaSnapshot | null, scrollOffset: number, row: number) {
  if (!snapshot) return undefined;
  const depth = snapshot.history.length;
  const offset = Math.min(depth, Math.max(0, scrollOffset));
  const absolute = depth - offset + row;
  return absolute < depth ? snapshot.history[absolute] : snapshot.grid[absolute - depth];
}

export function projectTerminalTextRow(row: TerminalReplicaRow | undefined): TerminalCellTextRow {
  if (!row) return EMPTY_TEXT_ROW;
  const starts = Array<number>(row.cells.length).fill(0);
  const ends = Array<number>(row.cells.length).fill(0);
  let text = "";
  let previousStart = 0;
  let previousEnd = 0;
  for (let column = 0; column < row.cells.length; column += 1) {
    const cell = row.cells[column]!;
    if (cell.width === 0) {
      // A continuation cell selects the complete grapheme it visually belongs
      // to; it must not become a zero-width hole in selection coordinates.
      starts[column] = previousStart;
      ends[column] = previousEnd;
      continue;
    }
    const start = text.length;
    text += cell.grapheme || " ";
    const end = text.length;
    starts[column] = start;
    ends[column] = end;
    previousStart = start;
    previousEnd = end;
  }
  text = text.trimEnd();
  const textLength = text.length;
  for (let column = 0; column < starts.length; column += 1) {
    starts[column] = Math.min(starts[column]!, textLength);
    ends[column] = Math.min(ends[column]!, textLength);
  }
  return Object.freeze({
    text,
    cellCount: row.cells.length,
    cellTextStarts: Object.freeze(starts),
    cellTextEnds: Object.freeze(ends),
  });
}

export function extractTerminalCellText(
  rows: readonly TerminalCellTextRow[],
  first: { row: number; col: number },
  second: { row: number; col: number },
  maxBytes: number,
): string {
  if (rows.length === 0 || maxBytes <= 0) return "";
  const [start, end] =
    first.row < second.row || (first.row === second.row && first.col <= second.col)
      ? [first, second]
      : [second, first];
  if (end.row < 0 || start.row >= rows.length) return "";
  const firstRow = Math.max(0, Math.min(start.row, rows.length - 1));
  const lastRow = Math.max(0, Math.min(end.row, rows.length - 1));
  if (firstRow > lastRow) return "";
  const selected: string[] = [];
  let selectedBytes = 0;
  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const startColumn = rowIndex === firstRow ? (start.row < 0 ? 0 : start.col) : 0;
    const endColumn = rowIndex === lastRow && end.row < rows.length ? end.col : row.cellCount - 1;
    const value = sliceTerminalCells(row, startColumn, endColumn);
    selected.push(value);
    selectedBytes += Buffer.byteLength(value, "utf8") + (selected.length > 1 ? 1 : 0);
    if (selectedBytes > maxBytes) break;
  }
  return truncateUtf8(selected.join("\n"), maxBytes);
}

export function findTerminalCellMatches(
  rows: readonly TerminalCellTextRow[],
  query: string,
): TerminalCellSearchMatch[] {
  if (query.length === 0) return [];
  const needle = query.toLocaleLowerCase();
  const matches: TerminalCellSearchMatch[] = [];
  for (let line = 0; line < rows.length; line += 1) {
    const row = rows[line]!;
    const haystack = row.text.toLocaleLowerCase();
    let from = 0;
    for (;;) {
      const offset = haystack.indexOf(needle, from);
      if (offset < 0) break;
      const range = terminalCellsForTextRange(row, offset, offset + needle.length);
      if (range) matches.push({ line, col: range.start, columns: range.end - range.start + 1 });
      from = offset + Math.max(1, needle.length);
    }
  }
  return matches;
}

function sliceTerminalCells(row: TerminalCellTextRow, first: number, last: number): string {
  if (row.cellCount === 0 || last < 0 || first >= row.cellCount || first > last) return "";
  const startCell = Math.max(0, Math.min(first, row.cellCount - 1));
  const endCell = Math.max(0, Math.min(last, row.cellCount - 1));
  return row.text.slice(row.cellTextStarts[startCell], row.cellTextEnds[endCell]);
}

function terminalCellsForTextRange(
  row: TerminalCellTextRow,
  startOffset: number,
  endOffset: number,
): { start: number; end: number } | null {
  let start = -1;
  let end = -1;
  for (let column = 0; column < row.cellCount; column += 1) {
    const cellStart = row.cellTextStarts[column]!;
    const cellEnd = row.cellTextEnds[column]!;
    if (cellEnd <= startOffset || cellStart >= endOffset) continue;
    if (start < 0) start = column;
    end = column;
  }
  return start < 0 ? null : { start, end };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const size = Buffer.byteLength(segment, "utf8");
    if (bytes + size > maxBytes) break;
    result += segment;
    bytes += size;
  }
  return result;
}

function resolveColor(
  color: TerminalReplicaColor,
  foreground: boolean,
  palette: TerminalPaletteProjection | undefined,
): number | null {
  if (color.kind === "default") return null;
  if (color.kind === "rgb") {
    return palette
      ? foreground
        ? palette.resolveForeground(color.value)
        : palette.resolveBackground(color.value)
      : color.value;
  }
  return foreground
    ? (palette?.ansiForeground[color.index] ?? null)
    : (palette?.ansiBackground[color.index] ?? null);
}

function blitSemanticRow(
  row: TerminalReplicaSnapshot["grid"][number] | undefined,
  buffers: CellArrays,
  y: number,
  width: number,
  defaultFg: number,
  defaultBg: number,
  graphemes: GraphemeOverride[] | undefined,
  palette: TerminalPaletteProjection | undefined,
): void {
  const dfR = (defaultFg >> 16) & 0xff;
  const dfG = (defaultFg >> 8) & 0xff;
  const dfB = defaultFg & 0xff;
  const dbR = (defaultBg >> 16) & 0xff;
  const dbG = (defaultBg >> 8) & 0xff;
  const dbB = defaultBg & 0xff;
  let sourceIndex = 0;
  for (let x = 0; x < width; x += 1) {
    const idx = y * width + x;
    const cell: TerminalReplicaCell | undefined = row?.cells[sourceIndex];
    if (!cell) {
      writeCell(buffers, idx, SPACE_CODE, null, null, 0, dfR, dfG, dfB, dbR, dbG, dbB);
      continue;
    }
    sourceIndex += 1;
    if (cell.width === 0) {
      writeContinuation(buffers, idx);
      continue;
    }
    let foreground = resolveColor(cell.foreground, true, palette);
    let background = resolveColor(cell.background, false, palette);
    let attributes = cell.attributes;
    if ((attributes & 32) !== 0) {
      [foreground, background] = [background, foreground];
      attributes &= ~32;
    }
    const grapheme = cell.grapheme || " ";
    const codepoint = grapheme.codePointAt(0) ?? SPACE_CODE;
    writeCell(
      buffers,
      idx,
      codepoint,
      foreground,
      background,
      attributes,
      dfR,
      dfG,
      dfB,
      dbR,
      dbG,
      dbB,
    );
    if (String.fromCodePoint(codepoint).length !== grapheme.length) {
      graphemes?.push({ x, y, chars: grapheme, fg: foreground, bg: background, attrs: attributes });
    }
  }
}
