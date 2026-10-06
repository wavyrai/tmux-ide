import type { TerminalReplicaColor, TerminalReplicaRow } from "@tmux-ide/contracts";
import { createBufferedFnv64, type BufferedFnv64 } from "./terminal-fnv64-wasm.ts";

const ROW_HASH_CACHE = new WeakMap<object, string>();
const DEEPLY_FROZEN_ROWS = new WeakSet<object>();
const UTF8_ENCODER = new TextEncoder();

interface CanonicalKeyOrder {
  readonly original: string[];
  readonly sorted: string[];
  readonly tokens: readonly (string | null)[] | null;
}

/**
 * Streaming FNV-1a64 writer for the canonical terminal encoding.
 *
 * Keep the two 32-bit limbs: BigInt per byte made a unique 5k-row compact
 * delivery monopolize the OpenTUI event loop for almost a second.
 */
class CanonicalFnv64 {
  #high = 0xcbf29ce4;
  #low = 0x84222325;
  #remainingJsBytes: number;
  #accelerator: BufferedFnv64 | null = null;

  constructor(accelerateLargeFrame = false) {
    this.#remainingJsBytes = accelerateLargeFrame ? 64 * 1024 : 0;
  }

  #considerAcceleration(bytes: number): void {
    if (this.#remainingJsBytes <= 0) return;
    this.#remainingJsBytes -= bytes;
    if (this.#remainingJsBytes <= 0) {
      // Transfer the exact rolling state once; never restart or reserialize.
      // Each writer owns its buffer across cooperative yields. Blocked WASM
      // keeps the original JS path, without repeated initialization attempts.
      this.#accelerator = createBufferedFnv64((BigInt(this.#high) << 32n) | BigInt(this.#low));
    }
  }
  // Per-hash only: terminal objects repeat a handful of small field layouts.
  // Reuse sorted keys and short ASCII key tokens without retaining records,
  // values, or future calls. Tokens share the 16-layout/32-key cache bound.
  #keyOrders: CanonicalKeyOrder[] | null = null;

  keyOrder(record: Record<string, unknown>): CanonicalKeyOrder {
    const keys = Object.keys(record);
    if (keys.length > 32) return { original: keys, sorted: keys.sort(), tokens: null };
    for (const order of this.#keyOrders ?? []) {
      if (order.original.length !== keys.length) continue;
      let matches = true;
      for (let index = 0; index < keys.length; index++) {
        if (order.original[index] !== keys[index]) {
          matches = false;
          break;
        }
      }
      if (matches) return order;
    }
    if ((this.#keyOrders?.length ?? 0) >= 16)
      return { original: keys, sorted: keys.sort(), tokens: null };
    const sorted = keys.length < 2 ? keys : keys.slice().sort();
    const order = {
      original: keys,
      sorted,
      tokens: sorted.map((key) => {
        if (key.length > 32) return null;
        for (let index = 0; index < key.length; index++)
          if (key.charCodeAt(index) > 0x7f) return null;
        return `s${key.length}:${key};`;
      }),
    };
    (this.#keyOrders ??= []).push(order);
    return order;
  }

  #byte(value: number): void {
    const low = (this.#low ^ value) >>> 0;
    const product = low * 0x1b3;
    const carry = Math.floor(product / 0x1_0000_0000);
    this.#low = product >>> 0;
    this.#high = (this.#high * 0x1b3 + carry + low * 0x100) >>> 0;
  }

  ascii(value: string): number {
    this.#considerAcceleration(value.length);
    if (this.#accelerator) return this.#accelerator.ascii(value);
    // Canonical color/field tags dominate full-row hashing. Keep the limbs
    // local through each fragment instead of reading/writing fields per byte.
    let high = this.#high;
    let low = this.#low;
    for (let index = 0; index < value.length; index += 1) {
      low = (low ^ value.charCodeAt(index)) >>> 0;
      const product = low * 0x1b3;
      high = (high * 0x1b3 + Math.floor(product / 0x1_0000_0000) + low * 0x100) >>> 0;
      low = product >>> 0;
    }
    this.#high = high;
    this.#low = low;
    return value.length;
  }

  bytes(value: Uint8Array): void {
    this.#considerAcceleration(value.byteLength);
    if (this.#accelerator) this.#accelerator.bytes(value);
    else for (const byte of value) this.#byte(byte);
  }

  string(value: string): number {
    // Most terminal cells are empty or ASCII. Their UTF-8 bytes are already
    // the code units; avoid allocating a Uint8Array for every history cell.
    let ascii = true;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) > 0x7f) {
        ascii = false;
        break;
      }
    }
    if (ascii) {
      this.ascii(`s${value.length}:`);
      this.ascii(value);
      this.ascii(";");
      return value.length;
    }
    const bytes = UTF8_ENCODER.encode(value);
    this.ascii(`s${bytes.byteLength}:`);
    this.bytes(bytes);
    this.ascii(";");
    return bytes.byteLength;
  }

  number(value: number): void {
    const text = String(value);
    this.ascii(`d${text.length}:${text};`);
  }

  boolean(value: boolean): void {
    this.ascii(value ? "b1;" : "b0;");
  }

  value(value: unknown): void {
    if (value === null) {
      this.ascii("n;");
      return;
    }
    if (typeof value === "boolean") {
      this.boolean(value);
      return;
    }
    if (typeof value === "number") {
      this.number(value);
      return;
    }
    if (typeof value === "string") {
      this.string(value);
      return;
    }
    if (Array.isArray(value)) {
      this.ascii(`a${value.length}:`);
      for (const entry of value) this.value(entry);
      this.ascii(";");
      return;
    }
    const record = value as Record<string, unknown>;
    const { sorted: keys, tokens } = this.keyOrder(record);
    this.ascii(`o${keys.length}:`);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      const token = tokens?.[index];
      if (token !== null && token !== undefined) this.ascii(token);
      else this.string(key);
      this.value(record[key]);
    }
    this.ascii(";");
  }

  digest(): string {
    if (this.#accelerator) return this.#accelerator.digest();
    return `${this.#high.toString(16).padStart(8, "0")}${this.#low.toString(16).padStart(8, "0")}`;
  }
}

export function hashCanonicalTerminalValue(value: unknown): string {
  const hash = new CanonicalFnv64(true);
  hash.value(value);
  return hash.digest();
}

export async function hashCanonicalTerminalValueCooperatively(
  value: unknown,
  yieldControl: () => Promise<void>,
  workPerSlice = 4 * 1_024,
): Promise<string> {
  const hash = new CanonicalFnv64(true);
  let work = 0;
  const checkpoint = (amount: number): boolean => {
    work += amount;
    if (work < workPerSlice) return false;
    work = 0;
    return true;
  };
  // Parallel stacks preserve the traversal and yield order without allocating
  // a wrapper object for every value/key/token. pop() drops consumed references.
  const kinds: ("value" | "ascii" | "string")[] = ["value"];
  const values: unknown[] = [value];
  while (values.length > 0) {
    const kind = kinds.pop()!;
    const value = values.pop();
    if (kind === "ascii") {
      if (checkpoint(hash.ascii(value as string))) await yieldControl();
      continue;
    }
    if (kind === "string") {
      if (checkpoint(hash.string(value as string) + 8)) await yieldControl();
      continue;
    }
    const entry = value;
    if (entry === null) {
      hash.ascii("n;");
      if (checkpoint(2)) await yieldControl();
      continue;
    }
    if (typeof entry === "boolean") {
      hash.boolean(entry);
      if (checkpoint(3)) await yieldControl();
      continue;
    }
    if (typeof entry === "number") {
      hash.number(entry);
      if (checkpoint(String(entry).length + 4)) await yieldControl();
      continue;
    }
    if (typeof entry === "string") {
      if (checkpoint(hash.string(entry) + 8)) await yieldControl();
      continue;
    }
    if (Array.isArray(entry)) {
      if (checkpoint(hash.ascii(`a${entry.length}:`) + 1)) await yieldControl();
      kinds.push("ascii");
      values.push(";");
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        kinds.push("value");
        values.push(entry[index]);
      }
      continue;
    }
    const record = entry as Record<string, unknown>;
    const keys = hash.keyOrder(record).sorted;
    if (checkpoint(hash.ascii(`o${keys.length}:`) + keys.length)) await yieldControl();
    kinds.push("ascii");
    values.push(";");
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      kinds.push("value", "string");
      values.push(record[key], key);
    }
  }
  return hash.digest();
}

function writeColor(hash: CanonicalFnv64, color: TerminalReplicaColor): void {
  // Field order and byte tags are fixed by the canonical color schema.
  // Avoid allocating/sorting field lists or re-encoding their names per cell.
  if (color.kind === "default") {
    hash.ascii("o1:s4:kind;s7:default;;");
  } else if (color.kind === "indexed") {
    hash.ascii("o2:s5:index;");
    hash.number(color.index);
    hash.ascii("s4:kind;s7:indexed;;");
  } else {
    hash.ascii("o2:s4:kind;s3:rgb;s5:value;");
    hash.number(color.value);
    hash.ascii(";");
  }
}

interface PreparedCanonicalCell {
  readonly prefix: string;
  readonly graphemeBytes: Uint8Array;
  readonly suffix: string;
}

const compactColorKey = (color: TerminalReplicaColor): number =>
  color.kind === "default" ? -1 : color.kind === "indexed" ? color.index : 256 + color.value;

/** Package-private per-decode cache for exact canonical cell byte segments. */
export class TerminalReplicaRunEncodingCache {
  #canonicalBytes = 0;
  #cachedCells = 0;
  #retainedEncodingBytes = 0;

  createHash(): CanonicalFnv64 | NonNullable<ReturnType<typeof createBufferedFnv64>> {
    // Small deliveries benefit more from row reuse than from crossing into
    // WASM. Count only completed, uncached work in this decode transaction.
    return (
      (this.#canonicalBytes >= 64 * 1_024 ? createBufferedFnv64() : null) ?? new CanonicalFnv64()
    );
  }

  recordCanonicalBytes(bytes: number): void {
    this.#canonicalBytes = Math.min(64 * 1_024, this.#canonicalBytes + bytes);
  }

  readonly #entries = new Map<
    string,
    Map<number, Map<number, Map<number, Map<number, PreparedCanonicalCell>>>>
  >();

  prepare(cell: TerminalReplicaRow["cells"][number]): {
    readonly prepared: PreparedCanonicalCell;
    readonly allocatedBytes: number;
    readonly cacheMiss: boolean;
  } {
    const foregroundKey = compactColorKey(cell.foreground);
    const backgroundKey = compactColorKey(cell.background);
    const cached = this.#entries
      .get(cell.grapheme)
      ?.get(cell.width)
      ?.get(foregroundKey)
      ?.get(backgroundKey)
      ?.get(cell.attributes);
    if (cached) return { prepared: cached, allocatedBytes: 0, cacheMiss: false };
    const graphemeBytes = UTF8_ENCODER.encode(cell.grapheme);
    const numberText = (value: number): string => {
      const text = String(value);
      return `d${text.length}:${text};`;
    };
    const colorText = (color: TerminalReplicaColor): string => {
      if (color.kind === "default") return "o1:s4:kind;s7:default;;";
      if (color.kind === "indexed")
        return `o2:s5:index;${numberText(color.index)}s4:kind;s7:indexed;;`;
      return `o2:s4:kind;s3:rgb;s5:value;${numberText(color.value)};`;
    };
    const prepared = Object.freeze({
      prefix: `a5:s${graphemeBytes.byteLength}:`,
      graphemeBytes,
      suffix: `;${numberText(cell.width)}${colorText(cell.foreground)}${colorText(
        cell.background,
      )}${numberText(cell.attributes)};`,
    });
    // A transaction may contain arbitrary text and RGB values. Bound both
    // entry count and retained string/byte payload; uncached cells hash identically.
    const retainedBytes =
      graphemeBytes.byteLength +
      2 * (cell.grapheme.length + prepared.prefix.length + prepared.suffix.length);
    if (this.#cachedCells < 1_024 && this.#retainedEncodingBytes + retainedBytes <= 64 * 1_024) {
      const widths = this.#entries.get(cell.grapheme) ?? new Map();
      this.#entries.set(cell.grapheme, widths);
      const foregrounds = widths.get(cell.width) ?? new Map();
      widths.set(cell.width, foregrounds);
      const backgrounds = foregrounds.get(foregroundKey) ?? new Map();
      foregrounds.set(foregroundKey, backgrounds);
      const attributes = backgrounds.get(backgroundKey) ?? new Map();
      backgrounds.set(backgroundKey, attributes);
      attributes.set(cell.attributes, prepared);
      this.#cachedCells++;
      this.#retainedEncodingBytes += retainedBytes;
    }
    return { prepared, allocatedBytes: graphemeBytes.byteLength, cacheMiss: true };
  }
}

export function hashTerminalReplicaRowCached(
  row: TerminalReplicaRow,
  onMiss?: () => void,
  encodingCache?: TerminalReplicaRunEncodingCache,
): string {
  const cached = ROW_HASH_CACHE.get(row);
  if (cached) return cached;
  onMiss?.();
  const hash = encodingCache?.createHash() ?? new CanonicalFnv64();
  let canonicalBytes = 10 + String(row.cells.length).length;
  hash.ascii("a2:");
  hash.boolean(row.wrapped);
  hash.ascii(`a${row.cells.length}:`);
  for (const cell of row.cells) {
    if (encodingCache) {
      const { prepared } = encodingCache.prepare(cell);
      hash.ascii(prepared.prefix);
      hash.bytes(prepared.graphemeBytes);
      hash.ascii(prepared.suffix);
      canonicalBytes +=
        prepared.prefix.length + prepared.graphemeBytes.length + prepared.suffix.length;
    } else {
      const direct = hash as CanonicalFnv64;
      direct.ascii("a5:");
      direct.string(cell.grapheme);
      direct.number(cell.width);
      writeColor(direct, cell.foreground);
      writeColor(direct, cell.background);
      direct.number(cell.attributes);
      direct.ascii(";");
    }
  }
  hash.ascii(";;");
  const digest = hash.digest();
  encodingCache?.recordCanonicalBytes(canonicalBytes);
  if (isTerminalReplicaRowDeeplyFrozen(row)) {
    DEEPLY_FROZEN_ROWS.add(row);
    ROW_HASH_CACHE.set(row, digest);
  }
  return digest;
}

export async function hashTerminalReplicaRowCooperatively(
  row: TerminalReplicaRow,
  yieldControl: () => Promise<void>,
  bytesPerSlice = 16 * 1_024,
): Promise<string> {
  const cached = ROW_HASH_CACHE.get(row);
  if (cached) return cached;
  const hash = new CanonicalFnv64();
  hash.ascii("a2:");
  hash.boolean(row.wrapped);
  hash.ascii(`a${row.cells.length}:`);
  let bytesSinceYield = 0;
  for (const cell of row.cells) {
    hash.ascii("a5:");
    bytesSinceYield += hash.string(cell.grapheme) + 64;
    hash.number(cell.width);
    writeColor(hash, cell.foreground);
    writeColor(hash, cell.background);
    hash.number(cell.attributes);
    hash.ascii(";");
    if (bytesSinceYield >= bytesPerSlice) {
      bytesSinceYield = 0;
      await yieldControl();
    }
  }
  hash.ascii(";;");
  const digest = hash.digest();
  if (isTerminalReplicaRowDeeplyFrozen(row)) {
    DEEPLY_FROZEN_ROWS.add(row);
    ROW_HASH_CACHE.set(row, digest);
  }
  return digest;
}

/**
 * Hash an already schema-validated compact row without materializing its
 * expanded cell array. The byte stream is exactly the canonical row stream
 * used above; callers must still collision-check against any reuse candidate.
 */
export async function hashTerminalReplicaRowRunsCooperatively(
  wrapped: boolean,
  cellCount: number,
  runs: readonly (readonly [number, TerminalReplicaRow["cells"][number]])[],
  yieldControl: () => Promise<void>,
  cellsPerSlice = 64,
  onEncodedRun?: (bytes: number) => void,
  encodingCache = new TerminalReplicaRunEncodingCache(),
): Promise<string> {
  const hash = encodingCache.createHash();
  let canonicalBytes = 10 + String(cellCount).length;
  hash.ascii("a2:");
  hash.boolean(wrapped);
  hash.ascii(`a${cellCount}:`);
  let cellsSinceYield = 0;
  for (const [count, cell] of runs) {
    const { prepared, allocatedBytes, cacheMiss } = encodingCache.prepare(cell);
    if (cacheMiss) onEncodedRun?.(allocatedBytes);
    canonicalBytes +=
      (prepared.prefix.length + prepared.graphemeBytes.length + prepared.suffix.length) * count;
    for (let index = 0; index < count; index += 1) {
      hash.ascii(prepared.prefix);
      hash.bytes(prepared.graphemeBytes);
      hash.ascii(prepared.suffix);
      cellsSinceYield += 1;
      if (cellsSinceYield >= cellsPerSlice) {
        cellsSinceYield = 0;
        await yieldControl();
      }
    }
  }
  hash.ascii(";;");
  const digest = hash.digest();
  encodingCache.recordCanonicalBytes(canonicalBytes);
  return digest;
}

/** Package-private verified-decoder seam; this module is not a package export. */
export function primeTerminalReplicaRowHash(row: TerminalReplicaRow, digest: string): void {
  if (!/^[0-9a-f]{16}$/u.test(digest) || !isTerminalReplicaRowDeeplyFrozen(row))
    throw new TypeError("Terminal replica row hash authority was invalid");
  DEEPLY_FROZEN_ROWS.add(row);
  ROW_HASH_CACHE.set(row, digest);
}

export function isTerminalReplicaRowDeeplyFrozen(row: TerminalReplicaRow): boolean {
  if (DEEPLY_FROZEN_ROWS.has(row)) return true;
  if (!Object.isFrozen(row) || !Object.isFrozen(row.cells)) return false;
  for (const cell of row.cells) {
    if (
      !Object.isFrozen(cell) ||
      !Object.isFrozen(cell.foreground) ||
      !Object.isFrozen(cell.background)
    )
      return false;
  }
  DEEPLY_FROZEN_ROWS.add(row);
  return true;
}
