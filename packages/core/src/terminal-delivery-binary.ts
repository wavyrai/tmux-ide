/** TCB1 typed RLE tuples. No JSON cell encoding; shape validation belongs to semantic delivery. */
const MAX_BYTES = 16 * 1024 * 1024,
  MAX_STRING = 4096,
  MAX_NODES = 8_000_000,
  MAX_ARRAY = 1_000_000;
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export class BinaryTerminalLimitError extends RangeError {}
export class BinaryTerminalWriter {
  private data = new Uint8Array(4096);
  private length = 0;
  private nodes = 0;
  private reserve(size: number) {
    if (size > MAX_BYTES - this.length)
      throw new BinaryTerminalLimitError("Binary terminal representation exceeds bound");
    if (this.length + size > this.data.length) {
      const next = new Uint8Array(
        Math.min(MAX_BYTES, Math.max(this.length + size, this.data.length * 2)),
      );
      next.set(this.data);
      this.data = next;
    }
  }
  byte(value: number) {
    this.reserve(1);
    this.data[this.length++] = value;
  }
  uint(value: number) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid binary integer");
    do {
      const low = value % 128;
      value = Math.floor(value / 128);
      this.byte(low + (value ? 128 : 0));
    } while (value);
  }
  array(length: number) {
    if (length > MAX_ARRAY) throw new BinaryTerminalLimitError("Binary array bound");
    this.byte(3);
    this.uint(length);
  }
  value(value: unknown, depth = 0): void {
    if (depth > 16 || ++this.nodes > MAX_NODES)
      throw new BinaryTerminalLimitError("Binary node bound");
    if (value === null) {
      this.byte(0);
      return;
    }
    if (typeof value === "number") {
      this.byte(1);
      this.uint(value);
      return;
    }
    if (typeof value === "string") {
      const bytes = encoder.encode(value);
      if (bytes.length > MAX_STRING) throw new BinaryTerminalLimitError("Binary string bound");
      if (decoder.decode(bytes) !== value)
        throw new TypeError("Binary strings require well-formed Unicode");
      this.byte(2);
      this.uint(bytes.length);
      this.reserve(bytes.length);
      this.data.set(bytes, this.length);
      this.length += bytes.length;
      return;
    }
    if (Array.isArray(value)) {
      this.array(value.length);
      for (const child of value) this.value(child, depth + 1);
      return;
    }
    throw new TypeError("Invalid binary tuple value");
  }
  header(
    frame: "seed" | "patch" | "tombstone",
    revision: number,
    base?: number,
    magic: "TCB1" | "TCP1" = "TCB1",
  ) {
    for (const b of magic === "TCP1" ? [84, 67, 80, 49] : [84, 67, 66, 49]) this.byte(b);
    this.byte(frame === "seed" ? 0 : frame === "patch" ? 1 : 2);
    this.uint(revision);
    if (frame !== "seed") this.uint(base!);
  }
  get byteLength(): number {
    return this.length;
  }
  finish() {
    return this.data.slice(0, this.length);
  }
}
export function decodeBinaryTerminalTuple(
  bytes: Uint8Array,
  magic: "TCB1" | "TCP1" = "TCB1",
): {
  frame: "seed" | "patch" | "tombstone";
  revision: number;
  baseRevision?: number;
  value: unknown;
} {
  if (
    bytes.length > MAX_BYTES ||
    bytes.length < 7 ||
    bytes[0] !== 84 ||
    bytes[1] !== 67 ||
    bytes[2] !== (magic === "TCP1" ? 80 : 66) ||
    bytes[3] !== 49
  )
    throw new TypeError("Invalid binary terminal header");
  let offset = 4,
    nodes = 0;
  const byte = () => {
    if (offset >= bytes.length) throw new TypeError("Truncated binary terminal payload");
    return bytes[offset++]!;
  };
  const uint = () => {
    let value = 0,
      scale = 1;
    for (let index = 0; index < 8; index++) {
      const b = byte();
      value += (b & 127) * scale;
      if (!Number.isSafeInteger(value)) throw new TypeError("Binary integer exceeds safe bound");
      if (b < 128) {
        if (index > 0 && b === 0) throw new TypeError("Noncanonical binary integer");
        return value;
      }
      scale *= 128;
    }
    throw new TypeError("Binary integer is too long");
  };
  const read = (depth = 0): unknown => {
    if (depth > 16 || ++nodes > MAX_NODES) throw new TypeError("Binary structure bound");
    const tag = byte();
    if (tag === 0) return null;
    if (tag === 1) return uint();
    if (tag === 2) {
      const length = uint();
      if (length > MAX_STRING || length > bytes.length - offset)
        throw new TypeError("Binary string bound");
      const result = decoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      return result;
    }
    if (tag === 3) {
      const length = uint();
      if (length > MAX_ARRAY || length > bytes.length - offset)
        throw new TypeError("Binary array bound");
      const result: unknown[] = [];
      for (let i = 0; i < length; i++) result.push(read(depth + 1));
      return result;
    }
    throw new TypeError("Unknown binary value tag");
  };
  const kind = byte();
  if (kind > 2) throw new TypeError("Unknown binary frame");
  const frame = kind === 0 ? "seed" : kind === 1 ? "patch" : "tombstone";
  const revision = uint();
  const baseRevision = kind === 0 ? undefined : uint();
  const value = read();
  if (offset !== bytes.length) throw new TypeError("Trailing binary data");
  return { frame, revision, ...(baseRevision === undefined ? {} : { baseRevision }), value };
}
