/**
 * Kitty graphics protocol extraction for the daemon pane feed.
 *
 * tmux parses and drops APC sequences, so its grid never holds images. Its
 * control-mode `%output` stream, however, carries the pane's raw bytes before
 * that parse (octal-escaped, then decoded by `decodeControlBytes`), so the
 * daemon sees every `ESC _ G … ESC \` intact — split across arbitrary
 * `%output` lines. This module is the pure half: a streaming scanner, a
 * control-key parser, and a budgeted per-pane image store.
 *
 * Placement models:
 *
 *  - Unicode placeholders (`U=1` virtual placement + U+10EEEE cells): the
 *    position is ordinary grid text, so tmux keeps it through scroll, resize,
 *    copy-mode and capture-pane. The store only records the image and its
 *    virtual cell grid; renderers resolve the cells (`@tmux-ide/core`).
 *  - cursor-anchored (`a=T`/`a=p` without `U=1`), best effort: positioned by a
 *    marker OSC the scanner substitutes in place of the APC, so the VT parser
 *    reports the cursor at the exact byte position. tmux never sees these
 *    placements: they do not move the cursor, do not follow reflow, and are
 *    dropped by a capture reseed.
 *
 * Limits: direct transmission (`t=d`) only — file and shared-memory media
 * cannot cross machines; `a=d` handles all and by-id; animation, relative
 * placements and z-ordering are not modelled. Acknowledgements (`a=q`) come
 * from the patched tmux, in stream order (native/tmux/kitty-graphics.patch).
 */
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import {
  TERMINAL_GRAPHICS_MAX_IMAGE_BYTES,
  TERMINAL_GRAPHICS_MAX_IMAGES,
  TERMINAL_GRAPHICS_MAX_PLACEMENTS,
  type TerminalGraphicsFormat,
  type TerminalGraphicsPlacement,
  type TerminalGraphicsState,
} from "@tmux-ide/contracts";

/** Private OSC used to mark an APC's byte position for the VT parser. */
export const KITTY_PLACEMENT_OSC = 6974;
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
    // Verbatim runs stay views of the chunk; ordinary output is never copied.
    const parts: Uint8Array[] = [];
    const emit = (...bytes: number[]) => void parts.push(Uint8Array.from(bytes));
    const commands: (KittyCommand & { marker: number })[] = [];
    let ground = -1; // start of a pending verbatim run
    let escAt = -1; // index of a held ESC inside this chunk (-1: held from an earlier chunk)
    const flushGround = (end: number) => {
      if (ground >= 0) {
        if (end > ground) parts.push(chunk.subarray(ground, end));
        ground = -1;
      }
    };
    const complete = (bodyBytes: Uint8Array) => {
      const command = parseKittyCommand(Buffer.from(bodyBytes).toString("latin1"));
      if (!command) return;
      const marker = this.#nextMarker++;
      commands.push({ ...command, marker });
      parts.push(Buffer.from(`\x1b]${KITTY_PLACEMENT_OSC};${marker}\x07`, "latin1"));
    };
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i]!;
      switch (this.#state) {
        case "ground":
          // The ESC stays in the verbatim run until it turns out to start an APC/DCS.
          if (ground < 0) ground = i;
          if (byte === ESC) {
            escAt = i;
            this.#held = [byte];
            this.#state = "esc";
          }
          break;
        case "esc":
          if (byte === 0x5f || byte === 0x50) {
            if (escAt >= 0) flushGround(escAt);
            this.#held.push(byte);
            if (byte === 0x50) this.#prefixMatched = 0;
            this.#state = byte === 0x5f ? "apc-start" : "dcs-start";
          } else {
            if (escAt < 0) {
              emit(...this.#held);
              ground = i;
            }
            if (byte === ESC) {
              escAt = i;
              this.#held = [byte];
            } else {
              this.#held = [];
              this.#state = "ground";
            }
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
            emit(...this.#held, byte);
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
            escAt = -1;
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
            emit(...this.#held, byte);
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
              parts.push(
                Buffer.from(`\x1b]${KITTY_PLACEMENT_OSC};${command.marker}\x07`, "latin1"),
              );
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
    // A trailing ESC is held for the next chunk, not forwarded twice.
    flushGround(this.#state === "esc" && escAt >= 0 ? escAt : chunk.length);
    const forward =
      parts.length === 1 && parts[0]!.length === chunk.length && parts[0]!.buffer === chunk.buffer
        ? chunk
        : Uint8Array.from(Buffer.concat(parts));
    return { forward, commands };
  }
}

export type KittyImageFormat = TerminalGraphicsFormat;

export interface KittyImage {
  readonly imageId: number;
  readonly format: KittyImageFormat;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Content address; renderers fetch and cache bytes by it. */
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

export interface KittyCursorProbe {
  readonly x: number;
  /** Absolute buffer line. */
  readonly line: number;
  readonly alternate: boolean;
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

/**
 * Byte quotas shared by every pane store in the daemon. Each pane keeps at
 * most `perPaneBytes`; across panes the least recently used image goes first.
 * An evicted image disappears from its pane's graphics state, so renderers
 * stop placing it (placeholder cells then render as blank).
 */
export class KittyImageBudget {
  readonly perPaneBytes: number;
  readonly globalBytes: number;
  readonly #stores = new Set<KittyImageStore>();
  #tick = 0;

  constructor(options: { perPaneBytes: number; globalBytes: number }) {
    this.perPaneBytes = options.perPaneBytes;
    this.globalBytes = options.globalBytes;
  }

  get totalBytes(): number {
    let total = 0;
    for (const store of this.#stores) total += store.bytes;
    return total;
  }

  register(store: KittyImageStore): void {
    this.#stores.add(store);
  }

  unregister(store: KittyImageStore): void {
    this.#stores.delete(store);
  }

  nextTick(): number {
    return ++this.#tick;
  }

  enforce(): void {
    let total = this.totalBytes;
    while (total > this.globalBytes) {
      let victim: KittyImageStore | null = null;
      let oldest = Infinity;
      for (const store of this.#stores) {
        const used = store.oldestUse();
        if (used < oldest) {
          oldest = used;
          victim = store;
        }
      }
      if (!victim) return;
      total -= victim.evictOldest();
    }
  }
}

export const DEFAULT_KITTY_IMAGE_BUDGET = new KittyImageBudget({
  perPaneBytes: 64 * 1024 * 1024,
  globalBytes: 256 * 1024 * 1024,
});

export interface KittyImageStoreOptions {
  /** Nominal cell size used when a placement gives no `c`/`r`. */
  readonly cellWidthPx?: number;
  readonly cellHeightPx?: number;
  readonly budget?: KittyImageBudget;
}

/** Per-pane image store. Survives reseeds; cursor placements do not. */
export class KittyImageStore {
  readonly #images = new Map<number, KittyImage>();
  readonly #used = new Map<number, number>();
  readonly #cursorPlacements: KittyCursorPlacement[] = [];
  /** `U=1` virtual placements per image, by placement id (0 when unnamed). */
  readonly #virtual = new Map<number, Map<number, { columns: number; rows: number }>>();
  #pending: { control: ReadonlyMap<string, string>; payload: string[]; bytes: number } | null =
    null;
  #nextAnonymous = 0x7f000000;
  #bytes = 0;
  readonly #cellWidth: number;
  readonly #cellHeight: number;
  readonly #budget: KittyImageBudget;
  #revision = 0;

  constructor(options: KittyImageStoreOptions = {}) {
    this.#cellWidth = options.cellWidthPx ?? 10;
    this.#cellHeight = options.cellHeightPx ?? 20;
    this.#budget = options.budget ?? DEFAULT_KITTY_IMAGE_BUDGET;
    this.#budget.register(this);
  }

  /** Bumps whenever images or placements change. */
  get revision(): number {
    return this.#revision;
  }

  get bytes(): number {
    return this.#bytes;
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

  dispose(): void {
    this.#budget.unregister(this);
    this.#images.clear();
    this.#used.clear();
    this.#bytes = 0;
  }

  /** A capture reseed replaced the grid: tmux holds no record of cursor placements. */
  dropCursorPlacements(): void {
    if (this.#cursorPlacements.length === 0) return;
    this.#cursorPlacements.length = 0;
    this.#revision += 1;
  }

  oldestUse(): number {
    let oldest = Infinity;
    for (const used of this.#used.values()) oldest = Math.min(oldest, used);
    return oldest;
  }

  /** Evict the least recently used image; returns the bytes freed. */
  evictOldest(): number {
    let victim: number | null = null;
    let oldest = Infinity;
    for (const [id, used] of this.#used)
      if (used < oldest) {
        oldest = used;
        victim = id;
      }
    if (victim === null) return 0;
    return this.#remove(victim);
  }

  #remove(imageId: number, keepPlacements = false): number {
    const image = this.#images.get(imageId);
    if (!image) return 0;
    this.#images.delete(imageId);
    this.#used.delete(imageId);
    if (keepPlacements) {
      this.#bytes -= image.data.byteLength;
      this.#revision += 1;
      return image.data.byteLength;
    }
    this.#virtual.delete(imageId);
    this.#bytes -= image.data.byteLength;
    const kept = this.#cursorPlacements.filter((p) => p.imageId !== imageId);
    this.#cursorPlacements.length = 0;
    this.#cursorPlacements.push(...kept);
    this.#revision += 1;
    return image.data.byteLength;
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
      this.#pending.bytes += command.payload.length;
      if (this.#pending.bytes > MAX_COMMAND_BYTES) {
        this.#pending = null;
        return;
      }
      if (more) return;
      control = this.#pending.control;
      const payload = this.#pending.payload.join("");
      this.#pending = null;
      this.#finish(control, payload, cursor);
      return;
    }
    const action = control.get("a") ?? "t";
    if ((action === "t" || action === "T" || action === "f") && more) {
      this.#pending = { control, payload: [command.payload], bytes: command.payload.length };
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
    if (action === "q") return; // Answered by the patched tmux; nothing to store.
    let imageId = int(control, "i");
    if (action === "t" || action === "T") {
      if ((control.get("t") ?? "d") !== "d") return; // file/shm cannot cross machines.
      if (imageId === 0) imageId = this.#nextAnonymous++;
      const image = this.#decode(imageId, control, payload);
      if (!image) return;
      // Re-transmitting an id replaces its pixels; its placements keep showing it.
      this.#remove(imageId, true);
      this.#images.set(imageId, image);
      this.#bytes += image.data.byteLength;
      this.#used.set(imageId, this.#budget.nextTick());
      this.#revision += 1;
      while (
        (this.#bytes > this.#budget.perPaneBytes || this.#images.size > MAX_IMAGES_PER_PANE) &&
        this.#images.size > 1
      )
        this.evictOldest();
      this.#budget.enforce();
      if (action === "t" || !this.#images.has(imageId)) return;
    }
    if (action === "f") return this.#editFrame(imageId, control, payload);
    if (action !== "T" && action !== "p") return;
    const image = this.#images.get(imageId);
    if (!image) return;
    this.#used.set(imageId, this.#budget.nextTick());
    const columns = clampCells(int(control, "c") || Math.ceil(image.width / this.#cellWidth));
    const rows = clampCells(int(control, "r") || Math.ceil(image.height / this.#cellHeight));
    const placementId = int(control, "p");
    if (control.get("U") === "1") {
      const placements = this.#virtual.get(imageId) ?? new Map();
      placements.set(placementId, { columns, rows });
      this.#virtual.set(imageId, placements);
    } else if (cursor) {
      const existing = this.#cursorPlacements.findIndex(
        (p) => p.imageId === imageId && placementId !== 0 && p.placementId === placementId,
      );
      if (existing >= 0) this.#cursorPlacements.splice(existing, 1);
      if (this.#cursorPlacements.length >= TERMINAL_GRAPHICS_MAX_PLACEMENTS)
        this.#cursorPlacements.shift();
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
    const f = int(control, "f", 32);
    const zlib = control.get("o") === "z";
    // Raw pixels stay compressed end to end: renderers inflate off their UI
    // thread, and the stream carries a fraction of the bytes. PNG and other
    // compressed payloads are inflated here.
    const keepCompressed = zlib && (f === 32 || f === 24);
    if (zlib && !keepCompressed) {
      try {
        data = inflateSync(data, { maxOutputLength: TERMINAL_GRAPHICS_MAX_IMAGE_BYTES });
      } catch {
        return null;
      }
    }
    if (data.byteLength === 0 || data.byteLength > TERMINAL_GRAPHICS_MAX_IMAGE_BYTES) return null;
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
      const bytes = width * height * (f === 32 ? 4 : 3);
      if (!width || !height || bytes > MAX_RAW_IMAGE_BYTES) return null;
      if (keepCompressed) format = f === 32 ? "rgba-zlib" : "rgb-zlib";
      else {
        format = f === 32 ? "rgba" : "rgb";
        if (data.length !== bytes) return null;
      }
    } else return null;
    if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return null;
    const digest = createHash("sha256").update(data).digest("hex").slice(0, 32);
    return { imageId, format, width, height, data, digest };
  }

  /**
   * `a=f` edits of the root frame (`r=1`): RGBA/RGB rectangles written at
   * `x,y`, replacing (`X=1`) or alpha-blending the existing pixels. New
   * animation frames, `c` base frames and PNG data are not modelled.
   */
  #editFrame(imageId: number, control: ReadonlyMap<string, string>, payload: string): void {
    const image = this.#images.get(imageId);
    if (!image || int(control, "r") !== 1 || (control.get("t") ?? "d") !== "d") return;
    const source = image.format === "rgba" || image.format === "rgba-zlib" ? 4 : 3;
    if (image.format === "png") return;
    let pixels: Uint8Array;
    let patch: Uint8Array = Buffer.from(payload, "base64");
    try {
      pixels =
        image.format === "rgba-zlib" || image.format === "rgb-zlib"
          ? inflateSync(image.data, { maxOutputLength: MAX_RAW_IMAGE_BYTES })
          : Uint8Array.from(image.data);
      if (control.get("o") === "z")
        patch = inflateSync(patch, { maxOutputLength: MAX_RAW_IMAGE_BYTES });
    } catch {
      return;
    }
    const f = int(control, "f", 32);
    const depth = f === 24 ? 3 : 4;
    const width = int(control, "s") || image.width;
    const height = int(control, "v") || image.height;
    const x0 = int(control, "x");
    const y0 = int(control, "y");
    if ((f !== 32 && f !== 24) || patch.length !== width * height * depth) return;
    if (pixels.length !== image.width * image.height * source) return;
    const replace = control.get("X") === "1";
    for (let row = 0; row < height && y0 + row < image.height; row += 1)
      for (let col = 0; col < width && x0 + col < image.width; col += 1) {
        const from = (row * width + col) * depth;
        const to = ((y0 + row) * image.width + x0 + col) * source;
        const alpha = depth === 4 && !replace ? patch[from + 3]! / 255 : 1;
        for (let channel = 0; channel < 3; channel += 1)
          pixels[to + channel] = Math.round(
            patch[from + channel]! * alpha + pixels[to + channel]! * (1 - alpha),
          );
        if (source === 4)
          pixels[to + 3] =
            depth === 4 && replace
              ? patch[from + 3]!
              : Math.round(255 * alpha + pixels[to + 3]! * (1 - alpha));
      }
    const data = deflateSync(pixels, { level: 1 });
    const format = source === 4 ? "rgba-zlib" : "rgb-zlib";
    this.#remove(imageId, true);
    this.#images.set(imageId, {
      ...image,
      format,
      data,
      digest: createHash("sha256").update(data).digest("hex").slice(0, 32),
    });
    this.#bytes += data.byteLength;
    this.#used.set(imageId, this.#budget.nextTick());
    this.#revision += 1;
  }

  #delete(control: ReadonlyMap<string, string>): void {
    const what = control.get("d") ?? "a";
    const id = int(control, "i");
    const all = what === "a" || what === "A";
    const byId = (what === "i" || what === "I") && id !== 0;
    if (!all && !byId) return;
    // With `p`, only that placement of the image goes (spec: d=i/I with p).
    const placementId = control.has("p") ? int(control, "p") : null;
    const doomed = (imageId: number, placement: number) =>
      all || (imageId === id && (placementId === null || placement === placementId));
    const kept = this.#cursorPlacements.filter((p) => !doomed(p.imageId, p.placementId));
    if (kept.length !== this.#cursorPlacements.length) {
      this.#cursorPlacements.length = 0;
      this.#cursorPlacements.push(...kept);
      this.#revision += 1;
    }
    for (const [imageId, placements] of [...this.#virtual])
      for (const placement of [...placements.keys()])
        if (doomed(imageId, placement)) {
          placements.delete(placement);
          if (placements.size === 0) this.#virtual.delete(imageId);
          this.#revision += 1;
        }
    // Upper-case variants also free the image data.
    if (what === "A") for (const key of [...this.#images.keys()]) this.#remove(key);
    if (what === "I" && placementId === null) this.#remove(id);
  }

  /**
   * The pane's graphics state for renderers: the image registry (with each
   * image's placeholder grid) and cursor placements clipped to the viewport.
   * `viewportTop` is the absolute line of grid row 0.
   */
  state(
    viewportTop: number,
    gridRows: number,
    cols: number,
    alternate: boolean,
  ): TerminalGraphicsState {
    const images = [...this.#images.values()].slice(-TERMINAL_GRAPHICS_MAX_IMAGES).map((image) => ({
      imageId: image.imageId,
      digest: image.digest,
      format: image.format,
      width: image.width,
      height: image.height,
      bytes: image.data.byteLength,
      placeholder: virtualGrid(this.#virtual.get(image.imageId)),
    }));
    const placements: TerminalGraphicsPlacement[] = [];
    for (const placement of this.#cursorPlacements) {
      if (placement.alternate !== alternate) continue;
      const image = this.#images.get(placement.imageId);
      if (!image) continue;
      const top = placement.line - viewportTop;
      const first = Math.max(0, top);
      const last = Math.min(gridRows, top + placement.rows);
      const right = Math.min(cols, placement.column + placement.columns);
      if (first >= last || placement.column >= right) continue;
      placements.push({
        digest: image.digest,
        row: first,
        column: placement.column,
        rows: last - first,
        columns: right - placement.column,
        sourceRow: first - top,
        sourceColumn: 0,
        totalRows: placement.rows,
        totalColumns: placement.columns,
      });
    }
    return { revision: this.#revision, images, placements };
  }
}

const MAX_IMAGES_PER_PANE = TERMINAL_GRAPHICS_MAX_IMAGES;
/** Largest decoded raw image (a 4K RGBA frame is ~33 MB). */
const MAX_RAW_IMAGE_BYTES = 64 * 1024 * 1024;

/**
 * Placeholder cells carry the image id; with several virtual placements the
 * protocol picks one by the placement id in the underline colour. Renderers
 * resolve cells by image id, so publish the most recently placed grid.
 */
function virtualGrid(
  placements: ReadonlyMap<number, { columns: number; rows: number }> | undefined,
): { columns: number; rows: number } | null {
  if (!placements || placements.size === 0) return null;
  return [...placements.values()].at(-1)!;
}
const MAX_IMAGE_SIDE = 10_000;
const clampCells = (cells: number) => Math.max(1, Math.min(1_000, cells));
