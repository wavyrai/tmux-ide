/**
 * SPIKE — kitty graphics protocol extraction for the daemon pane feed.
 *
 * tmux parses and drops APC sequences, so its grid never holds images. Its
 * control-mode `%output` stream, however, carries the pane's raw bytes before
 * that parse (octal-escaped, then decoded by `decodeControlBytes`), so the
 * daemon sees every `ESC _ G … ESC \` intact — split across arbitrary
 * `%output` lines. This module is the pure half: a streaming scanner, a
 * control-key parser, and a per-pane image store with placement projection.
 *
 * Two placement models are projected onto the replica's existing
 * `placements` contract (kind `kitty-image`):
 *
 *  - cursor-anchored (`a=T`/`a=p` without `U=1`): positioned by a marker OSC
 *    the scanner substitutes in place of the APC, so the VT parser reports the
 *    cursor at the exact byte position. tmux never sees these placements, so
 *    they cannot survive a capture reseed.
 *  - Unicode placeholders (`U=1` virtual placement + U+10EEEE cells): the
 *    position is ordinary grid text, so tmux keeps it through scroll, resize,
 *    copy-mode and capture-pane. Only the image bytes live in the daemon.
 *
 * Spike limits: direct transmission (`t=d`) only; `a=q` is never answered;
 * `a=d` handles all/by-id; animation, relative placements and z-ordering are
 * not modelled.
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

/** Private OSC used to mark an APC's byte position for the VT parser. */
export const KITTY_PLACEMENT_OSC = 6974;
export const KITTY_PLACEHOLDER = 0x10eeee;
const ESC = 0x1b;
const MAX_COMMAND_BYTES = 32 * 1024 * 1024;
const PASSTHROUGH_PREFIX = [0x74, 0x6d, 0x75, 0x78, 0x3b]; // "tmux;"

export interface KittyCommand {
  readonly control: ReadonlyMap<string, string>;
  readonly payload: string;
}

export interface KittyScanResult {
  /** Bytes for the VT parser: APCs replaced by marker OSCs, everything else verbatim. */
  readonly forward: Uint8Array;
  /** Commands in stream order; `marker` matches the OSC payload forwarded in their place. */
  readonly commands: readonly (KittyCommand & { readonly marker: number })[];
}

type State =
  | "ground"
  | "esc"
  | "apc-start"
  | "apc-body"
  | "apc-esc"
  | "dcs-start"
  | "pt-body"
  | "pt-esc";

/** PURE — parse `G<control>;<payload>` (the APC body after `ESC _`). */
export function parseKittyCommand(body: string): KittyCommand | null {
  if (!body.startsWith("G")) return null;
  const separator = body.indexOf(";");
  const controlText = separator < 0 ? body.slice(1) : body.slice(1, separator);
  const payload = separator < 0 ? "" : body.slice(separator + 1);
  const control = new Map<string, string>();
  for (const pair of controlText.split(",")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq !== 1) return null;
    control.set(pair[0]!, pair.slice(2));
  }
  return { control, payload };
}

/**
 * Streaming extractor. One instance per pane feed; chunks may split any
 * sequence at any byte. Also unwraps tmux DCS passthrough
 * (`ESC P tmux; … ESC \` with doubled ESCs), which reaches control mode
 * verbatim regardless of `allow-passthrough`.
 */
export class KittyApcScanner {
  #state: State = "ground";
  #held: number[] = [];
  #body: Uint8Array[] = [];
  #bodyBytes = 0;
  #prefixMatched = 0;
  #inner: number[] = [];
  #nextMarker = 1;
  #overflowed = false;

  scan(chunk: Uint8Array): KittyScanResult {
    const out: number[] = [];
    const commands: (KittyCommand & { marker: number })[] = [];
    let ground = -1; // start of a pending verbatim run
    const flushGround = (end: number) => {
      if (ground >= 0) {
        for (let k = ground; k < end; k += 1) out.push(chunk[k]!);
        ground = -1;
      }
    };
    const complete = (bodyBytes: Uint8Array) => {
      const command = parseKittyCommand(Buffer.from(bodyBytes).toString("latin1"));
      if (!command) return;
      const marker = this.#nextMarker++;
      commands.push({ ...command, marker });
      for (const byte of Buffer.from(`\x1b]${KITTY_PLACEMENT_OSC};${marker}\x07`, "latin1"))
        out.push(byte);
    };
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i]!;
      switch (this.#state) {
        case "ground":
          if (byte === ESC) {
            flushGround(i);
            this.#held = [byte];
            this.#state = "esc";
          } else if (ground < 0) ground = i;
          break;
        case "esc":
          if (byte === 0x5f) {
            this.#held.push(byte);
            this.#state = "apc-start";
          } else if (byte === 0x50) {
            this.#held.push(byte);
            this.#prefixMatched = 0;
            this.#state = "dcs-start";
          } else if (byte === ESC) {
            out.push(...this.#held);
            this.#held = [byte];
          } else {
            out.push(...this.#held, byte);
            this.#held = [];
            this.#state = "ground";
          }
          break;
        case "apc-start":
          if (byte === 0x47) {
            this.#body = [Uint8Array.of(byte)];
            this.#bodyBytes = 1;
            this.#overflowed = false;
            this.#held = [];
            this.#state = "apc-body";
          } else {
            // Another APC: the VT parser ignores it; pass it through untouched.
            out.push(...this.#held, byte);
            this.#held = [];
            this.#state = "ground";
          }
          break;
        case "apc-body": {
          const end = chunk.indexOf(ESC, i);
          const stop = end < 0 ? chunk.length : end;
          if (!this.#overflowed && this.#bodyBytes + (stop - i) <= MAX_COMMAND_BYTES) {
            this.#body.push(chunk.subarray(i, stop).slice());
            this.#bodyBytes += stop - i;
          } else this.#overflowed = true;
          i = stop - 1;
          if (end >= 0) {
            i = end;
            this.#state = "apc-esc";
          }
          break;
        }
        case "apc-esc": {
          const body = this.#overflowed ? null : Buffer.concat(this.#body);
          this.#body = [];
          this.#bodyBytes = 0;
          if (body) complete(body);
          this.#state = "ground";
          // ESC \ is the terminator; anything else aborts the string and is reparsed.
          if (byte !== 0x5c) {
            this.#state = "esc";
            this.#held = [ESC];
            i -= 1;
          }
          break;
        }
        case "dcs-start":
          if (byte === PASSTHROUGH_PREFIX[this.#prefixMatched]) {
            this.#held.push(byte);
            this.#prefixMatched += 1;
            if (this.#prefixMatched === PASSTHROUGH_PREFIX.length) {
              this.#held = [];
              this.#inner = [];
              this.#state = "pt-body";
            }
          } else {
            out.push(...this.#held, byte);
            this.#held = [];
            this.#state = "ground";
          }
          break;
        case "pt-body":
          if (byte === ESC) this.#state = "pt-esc";
          else if (this.#inner.length < MAX_COMMAND_BYTES) this.#inner.push(byte);
          break;
        case "pt-esc":
          if (byte === ESC) {
            this.#inner.push(ESC);
            this.#state = "pt-body";
          } else if (byte === 0x5c) {
            // Passthrough content targets the outer terminal — which is us.
            // Only its kitty commands matter; other wrapped output is dropped.
            const nested = new KittyApcScanner();
            nested.#nextMarker = this.#nextMarker;
            const result = nested.scan(Uint8Array.from(this.#inner));
            this.#nextMarker = nested.#nextMarker;
            for (const command of result.commands) {
              commands.push(command);
              for (const b of Buffer.from(
                `\x1b]${KITTY_PLACEMENT_OSC};${command.marker}\x07`,
                "latin1",
              ))
                out.push(b);
            }
            this.#inner = [];
            this.#state = "ground";
          } else {
            this.#inner.push(ESC, byte);
            this.#state = "pt-body";
          }
          break;
      }
    }
    flushGround(chunk.length);
    return { forward: Uint8Array.from(out), commands };
  }
}

export type KittyImageFormat = "png" | "rgba" | "rgb";

export interface KittyImage {
  readonly imageId: number;
  readonly format: KittyImageFormat;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Content address used by placements and the GUI's side-channel. */
  readonly digest: string;
}

export interface KittyCursorPlacement {
  readonly imageId: number;
  readonly placementId: number;
  /** Absolute buffer line (history + viewport) of the top-left cell. */
  readonly line: number;
  readonly column: number;
  readonly columns: number;
  readonly rows: number;
  readonly alternate: boolean;
}

export interface KittyVirtualPlacement {
  readonly imageId: number;
  readonly placementId: number;
  readonly columns: number;
  readonly rows: number;
}

export interface KittyCursorProbe {
  readonly x: number;
  /** Absolute buffer line. */
  readonly line: number;
  readonly alternate: boolean;
}

export interface KittyProjectedPlacement {
  readonly id: string;
  readonly kind: "kitty-image";
  readonly row: number;
  readonly column: number;
  readonly columns: number;
  readonly rows: number;
  readonly contentDigest: string;
}

function int(control: ReadonlyMap<string, string>, key: string, fallback = 0): number {
  const value = control.get(key);
  if (value === undefined || !/^-?[0-9]+$/u.test(value)) return fallback;
  return Number(value);
}

/** PURE — width/height from a PNG IHDR, or null. */
export function pngDimensions(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((b, i) => data[i] !== b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface KittyImageStoreOptions {
  /** Nominal cell size used when a placement gives no `c`/`r`. */
  readonly cellWidthPx?: number;
  readonly cellHeightPx?: number;
  readonly maxBytes?: number;
}

/** Per-pane image store. Survives reseeds; cursor placements do not. */
export class KittyImageStore {
  readonly #images = new Map<number, KittyImage>();
  readonly #cursorPlacements: KittyCursorPlacement[] = [];
  readonly #virtual = new Map<number, KittyVirtualPlacement>();
  #pending: { control: ReadonlyMap<string, string>; payload: string[] } | null = null;
  #nextAnonymous = 0x7f000000;
  readonly #cellWidth: number;
  readonly #cellHeight: number;
  readonly #maxBytes: number;
  #revision = 0;

  constructor(options: KittyImageStoreOptions = {}) {
    this.#cellWidth = options.cellWidthPx ?? 10;
    this.#cellHeight = options.cellHeightPx ?? 20;
    this.#maxBytes = options.maxBytes ?? 320 * 1024 * 1024;
  }

  /** Bumps whenever images or placements change; cheap projection gate. */
  get revision(): number {
    return this.#revision;
  }

  images(): ReadonlyMap<number, KittyImage> {
    return this.#images;
  }

  imageByDigest(digest: string): KittyImage | undefined {
    for (const image of this.#images.values()) if (image.digest === digest) return image;
    return undefined;
  }

  cursorPlacements(): readonly KittyCursorPlacement[] {
    return this.#cursorPlacements;
  }

  /** A capture reseed replaced the grid: tmux holds no record of cursor placements. */
  dropCursorPlacements(): void {
    if (this.#cursorPlacements.length === 0) return;
    this.#cursorPlacements.length = 0;
    this.#revision += 1;
  }

  /**
   * Apply one command. `cursor` is the parser's position at the command's byte
   * offset (from the marker OSC); null when unavailable.
   */
  apply(command: KittyCommand, cursor: KittyCursorProbe | null): void {
    let { control } = command;
    const more = control.get("m") === "1";
    if (this.#pending) {
      // Continuation chunks carry only m (and q); the first chunk's keys rule.
      this.#pending.payload.push(command.payload);
      if (more) return;
      control = this.#pending.control;
      const payload = this.#pending.payload.join("");
      this.#pending = null;
      this.#finish(control, payload, cursor);
      return;
    }
    const action = control.get("a") ?? "t";
    if ((action === "t" || action === "T") && more) {
      this.#pending = { control, payload: [command.payload] };
      return;
    }
    this.#finish(control, command.payload, cursor);
  }

  #finish(
    control: ReadonlyMap<string, string>,
    payload: string,
    cursor: KittyCursorProbe | null,
  ): void {
    const action = control.get("a") ?? "t";
    if (action === "d") return this.#delete(control);
    if (action === "q") return; // Spike: never answered (see findings).
    let imageId = int(control, "i");
    if (action === "t" || action === "T") {
      if ((control.get("t") ?? "d") !== "d") return; // file/shm cannot cross machines.
      if (imageId === 0) imageId = this.#nextAnonymous++;
      const image = this.#decode(imageId, control, payload);
      if (!image) return;
      this.#images.set(imageId, image);
      this.#evict();
      this.#revision += 1;
      if (action === "t") return;
    }
    if (action !== "T" && action !== "p") return;
    const image = this.#images.get(imageId);
    if (!image) return;
    const columns = int(control, "c") || Math.max(1, Math.ceil(image.width / this.#cellWidth));
    const rows = int(control, "r") || Math.max(1, Math.ceil(image.height / this.#cellHeight));
    const placementId = int(control, "p");
    if (control.get("U") === "1") {
      this.#virtual.set(imageId, { imageId, placementId, columns, rows });
    } else if (cursor) {
      const existing = this.#cursorPlacements.findIndex(
        (p) => p.imageId === imageId && placementId !== 0 && p.placementId === placementId,
      );
      if (existing >= 0) this.#cursorPlacements.splice(existing, 1);
      this.#cursorPlacements.push({
        imageId,
        placementId,
        line: cursor.line,
        column: cursor.x,
        columns,
        rows,
        alternate: cursor.alternate,
      });
    }
    this.#revision += 1;
  }

  #decode(
    imageId: number,
    control: ReadonlyMap<string, string>,
    payload: string,
  ): KittyImage | null {
    let data: Uint8Array = Buffer.from(payload, "base64");
    if (control.get("o") === "z") {
      try {
        data = inflateSync(data);
      } catch {
        return null;
      }
    }
    const f = int(control, "f", 32);
    let format: KittyImageFormat;
    let width: number;
    let height: number;
    if (f === 100) {
      const size = pngDimensions(data);
      if (!size) return null;
      ({ width, height } = size);
      format = "png";
    } else if (f === 32 || f === 24) {
      width = int(control, "s");
      height = int(control, "v");
      format = f === 32 ? "rgba" : "rgb";
      if (!width || !height || data.length !== width * height * (f === 32 ? 4 : 3)) return null;
    } else return null;
    const digest = createHash("sha256").update(data).digest("hex").slice(0, 32);
    return { imageId, format, width, height, data, digest };
  }

  #delete(control: ReadonlyMap<string, string>): void {
    const what = control.get("d") ?? "a";
    const id = int(control, "i");
    const before = this.#cursorPlacements.length + this.#virtual.size + this.#images.size;
    const keep = (p: { imageId: number }) =>
      what === "a" || what === "A"
        ? false
        : (what === "i" || what === "I") && p.imageId === id
          ? false
          : true;
    const kept = this.#cursorPlacements.filter(keep);
    this.#cursorPlacements.length = 0;
    this.#cursorPlacements.push(...kept);
    for (const [key, value] of this.#virtual) if (!keep(value)) this.#virtual.delete(key);
    // Upper-case variants also free the image data.
    if (what === "A") this.#images.clear();
    if (what === "I") this.#images.delete(id);
    if (before !== this.#cursorPlacements.length + this.#virtual.size + this.#images.size)
      this.#revision += 1;
  }

  #evict(): void {
    let total = 0;
    for (const image of this.#images.values()) total += image.data.byteLength;
    for (const [id, image] of this.#images) {
      if (total <= this.#maxBytes) break;
      total -= image.data.byteLength;
      this.#images.delete(id);
    }
  }

  /**
   * PURE over its inputs — project both placement models onto the visible
   * grid. `viewportTop` is the absolute line of grid row 0. A partially
   * visible placement is clipped; the id carries the source sub-rectangle as
   * `kitty:<image>:<srcRow>:<srcCol>:<totalRows>:<totalCols>` (spike encoding:
   * the shared placement contract has no source-rect fields).
   */
  project(
    grid: readonly {
      readonly cells: readonly { readonly grapheme: string; readonly foreground: KittyCellColor }[];
    }[],
    cols: number,
    viewportTop: number,
    alternate: boolean,
  ): KittyProjectedPlacement[] {
    const placements: KittyProjectedPlacement[] = [];
    const push = (
      image: KittyImage,
      row: number,
      column: number,
      rows: number,
      columns: number,
      srcRow: number,
      srcCol: number,
      totalRows: number,
      totalCols: number,
    ) => {
      placements.push({
        id: `kitty:${image.imageId}:${srcRow}:${srcCol}:${totalRows}:${totalCols}`,
        kind: "kitty-image",
        row,
        column,
        columns,
        rows,
        contentDigest: image.digest,
      });
    };
    for (const placement of this.#cursorPlacements) {
      if (placement.alternate !== alternate) continue;
      const image = this.#images.get(placement.imageId);
      if (!image) continue;
      const top = placement.line - viewportTop;
      const first = Math.max(0, top);
      const last = Math.min(grid.length, top + placement.rows);
      const right = Math.min(cols, placement.column + placement.columns);
      if (first >= last || placement.column >= right) continue;
      push(
        image,
        first,
        placement.column,
        last - first,
        right - placement.column,
        first - top,
        0,
        placement.rows,
        placement.columns,
      );
    }
    for (const run of placeholderRects(grid)) {
      const image = this.#images.get(run.imageId);
      const virtual = this.#virtual.get(run.imageId);
      if (!image || !virtual) continue;
      if (run.srcRow + run.rows > virtual.rows || run.srcCol + run.columns > virtual.columns)
        continue;
      push(
        image,
        run.row,
        run.column,
        run.rows,
        run.columns,
        run.srcRow,
        run.srcCol,
        virtual.rows,
        virtual.columns,
      );
    }
    return placements;
  }
}

export type KittyCellColor =
  | { readonly kind: "default" }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly value: number };

// Row/column diacritics for Unicode placeholders, in protocol order (index = value).
const DIACRITICS = [
  "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 035B 0363 0364",
  "0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484 0485 0486 0487 0592 0593 0594",
  "0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1 05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612",
  "0613 0614 0615 0616 0617 0657 0658 0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC",
  "06DF 06E0 06E1 06E2 06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741",
  "0743 0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819 081B 081C",
  "081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C 082D 0951 0953 0954 0F82",
  "0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76 1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D",
  "1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1 1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7",
  "1DC8 1DC9 1DCB 1DCC 1DD1 1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF",
  "1DE0 1DE1 1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7 20E9",
  "20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9 2DEA 2DEB 2DEC 2DED 2DEE",
  "2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA 2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C",
  "A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5 A8E6 A8E7 A8E8 A8E9 A8EA A8EB A8EC A8ED A8EE A8EF",
  "A8F0 A8F1 AAB0 AAB2 AAB3 AAB7 AAB8 AABE AABF AAC1 FE20 FE21 FE22 FE23 FE24 FE25 FE26 10A0F 10A38",
  "1D185 1D186 1D187 1D188 1D189 1D1AA 1D1AB 1D1AC 1D1AD 1D242 1D243 1D244",
]
  .join(" ")
  .split(" ");
const DIACRITIC_VALUE = new Map(DIACRITICS.map((hex, index) => [Number.parseInt(hex, 16), index]));

interface PlaceholderCell {
  imageId: number;
  row: number;
  col: number;
}

/** PURE — decode one cell; null when it is not a placeholder. */
export function decodePlaceholderCell(
  grapheme: string,
  foreground: KittyCellColor,
  left: PlaceholderCell | null,
): PlaceholderCell | null {
  const points = [...grapheme].map((ch) => ch.codePointAt(0)!);
  if (points[0] !== KITTY_PLACEHOLDER) return null;
  const marks = points.slice(1).map((p) => DIACRITIC_VALUE.get(p));
  let imageId =
    foreground.kind === "indexed"
      ? foreground.index
      : foreground.kind === "rgb"
        ? foreground.value & 0xffffff
        : 0;
  if (marks[2] !== undefined) imageId += marks[2] * 0x1000000;
  const continues = left !== null && (marks[0] === undefined || marks[0] === left.row);
  const row = marks[0] ?? (continues ? left!.row : 0);
  const col = marks[1] ?? (continues ? left!.col + 1 : 0);
  if (marks[2] === undefined && continues && imageId === (left!.imageId & 0xffffff))
    imageId = left!.imageId;
  return { imageId, row, col };
}

interface PlaceholderRect {
  imageId: number;
  row: number;
  column: number;
  rows: number;
  columns: number;
  srcRow: number;
  srcCol: number;
}

function placeholderRects(
  grid: readonly {
    readonly cells: readonly { readonly grapheme: string; readonly foreground: KittyCellColor }[];
  }[],
): PlaceholderRect[] {
  // Horizontal runs: same image and source row, consecutive source columns.
  const open: PlaceholderRect[] = [];
  const done: PlaceholderRect[] = [];
  for (let y = 0; y < grid.length; y += 1) {
    const runs: PlaceholderRect[] = [];
    let left: PlaceholderCell | null = null;
    let run: PlaceholderRect | null = null;
    const cells = grid[y]!.cells;
    for (let x = 0; x < cells.length; x += 1) {
      const cell = decodePlaceholderCell(cells[x]!.grapheme, cells[x]!.foreground, left);
      left = cell;
      if (
        cell &&
        run &&
        cell.imageId === run.imageId &&
        cell.row === run.srcRow &&
        cell.col === run.srcCol + run.columns
      ) {
        run.columns += 1;
        continue;
      }
      if (run) runs.push(run);
      run = cell
        ? {
            imageId: cell.imageId,
            row: y,
            column: x,
            rows: 1,
            columns: 1,
            srcRow: cell.row,
            srcCol: cell.col,
          }
        : null;
    }
    if (run) runs.push(run);
    // Merge with the rectangle directly above when it continues the image.
    const stillOpen: PlaceholderRect[] = [];
    for (const candidate of runs) {
      const above = open.find(
        (rect) =>
          rect.imageId === candidate.imageId &&
          rect.column === candidate.column &&
          rect.columns === candidate.columns &&
          rect.srcCol === candidate.srcCol &&
          rect.row + rect.rows === y &&
          rect.srcRow + rect.rows === candidate.srcRow,
      );
      if (above) {
        above.rows += 1;
        open.splice(open.indexOf(above), 1);
        stillOpen.push(above);
      } else stillOpen.push(candidate);
    }
    done.push(...open);
    open.length = 0;
    open.push(...stillOpen);
  }
  done.push(...open);
  return done;
}
