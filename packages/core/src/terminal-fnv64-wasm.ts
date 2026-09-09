import { TERMINAL_FNV64_WASM_BYTES } from "./terminal-fnv64-wasm-bytes.ts";

const SCRATCH_BYTES = 4096;
const OFFSET_BASIS = 0xcbf29ce484222325n;

export interface BufferedFnv64 {
  ascii(value: string): number;
  bytes(value: Uint8Array): void;
  boolean(value: boolean): void;
  digest(): string;
}

interface NativeHasher {
  readonly scratch: Uint8Array;
  readonly update: (state: bigint, length: number) => bigint;
}

let initialized = false;
let native: NativeHasher | null = null;

function initialize(): NativeHasher | null {
  if (initialized) return native;
  initialized = true;
  try {
    if (typeof WebAssembly === "undefined") return null;
    const exports = new WebAssembly.Instance(new WebAssembly.Module(TERMINAL_FNV64_WASM_BYTES))
      .exports;
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.scratch_ptr !== "function" ||
      typeof exports.update !== "function"
    )
      return null;
    const pointer = exports.scratch_ptr() as unknown;
    if (
      typeof pointer !== "number" ||
      !Number.isInteger(pointer) ||
      pointer < 0 ||
      exports.memory.buffer.byteLength > 128 * 1024 ||
      pointer + SCRATCH_BYTES > exports.memory.buffer.byteLength
    )
      return null;
    const update = exports.update as (state: bigint, length: number) => bigint;
    if (BigInt.asUintN(64, update(OFFSET_BASIS, 0)) !== OFFSET_BASIS) return null;
    native = { scratch: new Uint8Array(exports.memory.buffer, pointer, SCRATCH_BYTES), update };
  } catch {
    // Unsupported runtimes and blocked compilation keep the existing JS path.
  }
  return native;
}

/** Internal optional accelerator. Canonical serialization remains the caller's responsibility. */
export function createBufferedFnv64(): BufferedFnv64 | null {
  const hasher = initialize();
  return hasher ? new BufferedHasher(hasher) : null;
}

class BufferedHasher implements BufferedFnv64 {
  readonly #native: NativeHasher;
  readonly #buffer = new Uint8Array(SCRATCH_BYTES);
  #length = 0;
  #state = OFFSET_BASIS;

  constructor(hasher: NativeHasher) {
    this.#native = hasher;
  }

  #flush(): void {
    if (this.#length === 0) return;
    // No callback or await can occur between copying and consuming scratch.
    // Each caller owns its buffered bytes and hash state across cooperative yields.
    this.#native.scratch.set(this.#buffer.subarray(0, this.#length));
    this.#state = BigInt.asUintN(64, this.#native.update(this.#state, this.#length));
    this.#length = 0;
  }

  ascii(value: string): number {
    let offset = 0;
    while (offset < value.length) {
      const count = Math.min(SCRATCH_BYTES - this.#length, value.length - offset);
      const start = this.#length;
      for (let index = 0; index < count; index++)
        this.#buffer[start + index] = value.charCodeAt(offset + index);
      this.#length += count;
      offset += count;
      if (this.#length === SCRATCH_BYTES) this.#flush();
    }
    return value.length;
  }

  bytes(value: Uint8Array): void {
    let offset = 0;
    while (offset < value.length) {
      const count = Math.min(SCRATCH_BYTES - this.#length, value.length - offset);
      this.#buffer.set(value.subarray(offset, offset + count), this.#length);
      this.#length += count;
      offset += count;
      if (this.#length === SCRATCH_BYTES) this.#flush();
    }
  }

  boolean(value: boolean): void {
    this.ascii(value ? "b1;" : "b0;");
  }

  digest(): string {
    this.#flush();
    return this.#state.toString(16).padStart(16, "0");
  }
}
