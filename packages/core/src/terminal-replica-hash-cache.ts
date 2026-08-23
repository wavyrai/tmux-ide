import type { TerminalReplicaColor, TerminalReplicaRow } from "@tmux-ide/contracts";

const ROW_HASH_CACHE = new WeakMap<object, string>();
const DEEPLY_FROZEN_ROWS = new WeakSet<object>();
const UTF8_ENCODER = new TextEncoder();

/**
 * Allocation-free FNV-1a64 writer for the canonical terminal encoding.
 *
 * Keep the two 32-bit limbs: BigInt per byte made a unique 5k-row compact
 * delivery monopolize the OpenTUI event loop for almost a second.
 */
class CanonicalFnv64 {
  #high = 0xcbf29ce4;
  #low = 0x84222325;

  #byte(value: number): void {
    const low = (this.#low ^ value) >>> 0;
    const product = low * 0x1b3;
    const carry = Math.floor(product / 0x1_0000_0000);
    this.#low = product >>> 0;
    this.#high = (this.#high * 0x1b3 + carry + low * 0x100) >>> 0;
  }

  ascii(value: string): number {
    for (let index = 0; index < value.length; index += 1) this.#byte(value.charCodeAt(index));
    return value.length;
  }

  bytes(value: Uint8Array): void {
    for (const byte of value) this.#byte(byte);
  }

  string(value: string): number {
    const bytes = UTF8_ENCODER.encode(value);
    this.ascii(`s${bytes.byteLength}:`);
    for (const byte of bytes) this.#byte(byte);
    this.#byte(0x3b);
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
    const keys = Object.keys(record).sort();
    this.ascii(`o${keys.length}:`);
    for (const key of keys) {
      this.string(key);
      this.value(record[key]);
    }
    this.ascii(";");
  }

  array(length: number, entries: () => void): void {
    this.ascii(`a${length}:`);
    entries();
    this.ascii(";");
  }

  digest(): string {
    return `${this.#high.toString(16).padStart(8, "0")}${this.#low.toString(16).padStart(8, "0")}`;
  }
}

export function hashCanonicalTerminalValue(value: unknown): string {
  const hash = new CanonicalFnv64();
  hash.value(value);
  return hash.digest();
}

export async function hashCanonicalTerminalValueCooperatively(
  value: unknown,
  yieldControl: () => Promise<void>,
  workPerSlice = 4 * 1_024,
): Promise<string> {
  const hash = new CanonicalFnv64();
  let work = 0;
  const checkpoint = (amount: number): boolean => {
    work += amount;
    if (work < workPerSlice) return false;
    work = 0;
    return true;
  };
  type WorkItem =
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "ascii"; readonly value: string }
    | { readonly kind: "string"; readonly value: string };
  const stack: WorkItem[] = [{ kind: "value", value }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === "ascii") {
      if (checkpoint(hash.ascii(item.value))) await yieldControl();
      continue;
    }
    if (item.kind === "string") {
      if (checkpoint(hash.string(item.value) + 8)) await yieldControl();
      continue;
    }
    const entry = item.value;
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
      stack.push({ kind: "ascii", value: ";" });
      for (let index = entry.length - 1; index >= 0; index -= 1)
        stack.push({ kind: "value", value: entry[index] });
      continue;
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (checkpoint(hash.ascii(`o${keys.length}:`) + keys.length)) await yieldControl();
    stack.push({ kind: "ascii", value: ";" });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]!;
      stack.push({ kind: "value", value: record[key] });
      stack.push({ kind: "string", value: key });
    }
  }
  return hash.digest();
}

function writeColor(hash: CanonicalFnv64, color: TerminalReplicaColor): void {
  const keys =
    color.kind === "default"
      ? (["kind"] as const)
      : color.kind === "indexed"
        ? (["index", "kind"] as const)
        : (["kind", "value"] as const);
  hash.ascii(`o${keys.length}:`);
  for (const key of keys) {
    hash.string(key);
    if (key === "kind") hash.string(color.kind);
    else
      hash.number(
        key === "index" && color.kind === "indexed"
          ? color.index
          : color.kind === "rgb"
            ? color.value
            : 0,
      );
  }
  hash.ascii(";");
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
  readonly #entries = new Map<
    string,
    Map<number, Map<number, Map<number, Map<number, PreparedCanonicalCell>>>>
  >();

  prepare(cell: TerminalReplicaRow["cells"][number]): {
    readonly prepared: PreparedCanonicalCell;
    readonly allocatedBytes: number;
    readonly cacheMiss: boolean;
  } {
    const widths = this.#entries.get(cell.grapheme) ?? new Map();
    this.#entries.set(cell.grapheme, widths);
    const foregroundKey = compactColorKey(cell.foreground);
    const foregrounds = widths.get(cell.width) ?? new Map();
    widths.set(cell.width, foregrounds);
    const backgroundKey = compactColorKey(cell.background);
    const backgrounds = foregrounds.get(foregroundKey) ?? new Map();
    foregrounds.set(foregroundKey, backgrounds);
    const attributes = backgrounds.get(backgroundKey) ?? new Map();
    backgrounds.set(backgroundKey, attributes);
    const cached = attributes.get(cell.attributes);
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
    attributes.set(cell.attributes, prepared);
    return { prepared, allocatedBytes: graphemeBytes.byteLength, cacheMiss: true };
  }
}

export function hashTerminalReplicaRowCached(row: TerminalReplicaRow, onMiss?: () => void): string {
  const cached = ROW_HASH_CACHE.get(row);
  if (cached) return cached;
  onMiss?.();
  const hash = new CanonicalFnv64();
  hash.array(2, () => {
    hash.boolean(row.wrapped);
    hash.array(row.cells.length, () => {
      for (const cell of row.cells) {
        hash.array(5, () => {
          hash.string(cell.grapheme);
          hash.number(cell.width);
          writeColor(hash, cell.foreground);
          writeColor(hash, cell.background);
          hash.number(cell.attributes);
        });
      }
    });
  });
  const digest = hash.digest();
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
  const hash = new CanonicalFnv64();
  hash.ascii("a2:");
  hash.boolean(wrapped);
  hash.ascii(`a${cellCount}:`);
  let cellsSinceYield = 0;
  for (const [count, cell] of runs) {
    const { prepared, allocatedBytes, cacheMiss } = encodingCache.prepare(cell);
    if (cacheMiss) onEncodedRun?.(allocatedBytes);
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
  return hash.digest();
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
