import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type { CellArrays, GraphemeOverride } from "../blit.ts";
import type { TerminalPaletteProjection } from "../theme.ts";
import { blitSemanticRow } from "../semantic-pane-render-source.ts";

type Row = TerminalReplicaSnapshot["grid"][number];
interface Projection {
  buffers: CellArrays;
  graphemes: readonly GraphemeOverride[];
  bytes: number;
}

/** Bounded clean rows, never framebuffer overlays or the entire history. */
export class TerminalRowProjectionCache {
  #rows = new WeakMap<Row, Projection>();
  readonly #entries: { row: WeakRef<Row>; projection: Projection }[] = [];
  #key: readonly unknown[] = [];
  #limit = 0;
  #bytes = 0;
  #convertedRows = 0;
  #reusedRows = 0;

  clear(): void {
    if (this.#entries.length === 0 && this.#key.length === 0) return;
    this.#rows = new WeakMap();
    this.#entries.length = 0;
    this.#bytes = 0;
    this.#key = [];
  }

  configure(width: number, height: number, key: readonly unknown[]): void {
    const next = [width, height, ...key];
    if (next.length !== this.#key.length || next.some((value, i) => value !== this.#key[i])) {
      this.clear();
      this.#key = next;
    }
    // 24 bytes per cell plus bounded grapheme metadata; giant views bypass.
    this.#limit =
      width > 0 && height > 0 && height <= 256 && width * height * 2 <= 65_536 ? height * 2 : 0;
  }

  diagnostics() {
    return {
      convertedRows: this.#convertedRows,
      reusedRows: this.#reusedRows,
      cachedRows: this.#entries.length,
      cachedBytes: this.#bytes,
    };
  }

  blit(
    row: Row | undefined,
    buffers: CellArrays,
    y: number,
    width: number,
    defaultFg: number,
    defaultBg: number,
    graphemes: GraphemeOverride[] | undefined,
    palette: TerminalPaletteProjection | undefined,
    sourceColumn: number,
  ): void {
    const cached = row && this.#rows.get(row);
    if (cached) {
      this.#reusedRows++;
      buffers.char.set(cached.buffers.char, y * width);
      buffers.fg.set(cached.buffers.fg, y * width * 4);
      buffers.bg.set(cached.buffers.bg, y * width * 4);
      buffers.attributes.set(cached.buffers.attributes, y * width);
      if (graphemes) for (const g of cached.graphemes) graphemes.push({ ...g, y });
      return;
    }
    this.#convertedRows++;
    if (this.#limit === 0) {
      blitSemanticRow(
        row,
        buffers,
        y,
        width,
        defaultFg,
        defaultBg,
        graphemes,
        palette,
        sourceColumn,
      );
      return;
    }
    // Always capture graphemes, even when this particular consumer ignores them.
    const captured: GraphemeOverride[] = [];
    blitSemanticRow(row, buffers, y, width, defaultFg, defaultBg, captured, palette, sourceColumn);
    if (graphemes) graphemes.push(...captured);
    if (!row || this.#limit === 0) return;
    const bytes = width * 24 + captured.reduce((sum, g) => sum + 64 + g.chars.length * 2, 0);
    if (bytes > 8 * 1024 * 1024) return;
    while (this.#entries.length >= this.#limit || this.#bytes + bytes > 8 * 1024 * 1024) {
      const oldest = this.#entries.shift();
      if (!oldest) break;
      this.#bytes -= oldest.projection.bytes;
      const key = oldest.row.deref();
      if (key) this.#rows.delete(key);
    }
    const projection: Projection = {
      buffers: {
        char: buffers.char.slice(y * width, (y + 1) * width),
        fg: buffers.fg.slice(y * width * 4, (y + 1) * width * 4),
        bg: buffers.bg.slice(y * width * 4, (y + 1) * width * 4),
        attributes: buffers.attributes.slice(y * width, (y + 1) * width),
      },
      graphemes: captured.map((g) => ({ ...g, y: 0 })),
      bytes,
    };
    this.#rows.set(row, projection);
    this.#entries.push({ row: new WeakRef(row), projection });
    this.#bytes += bytes;
  }
}
