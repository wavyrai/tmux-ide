import { afterEach, expect, it, vi } from "vitest";
import { createBufferedFnv64 } from "./terminal-fnv64-wasm.ts";

const reference = (bytes: Uint8Array): string => {
  let state = 0xcbf29ce484222325n;
  for (const byte of bytes) state = BigInt.asUintN(64, (state ^ BigInt(byte)) * 0x100000001b3n);
  return state.toString(16).padStart(16, "0");
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("matches exact FNV across scratch boundaries, UTF-8 and every byte value", () => {
  for (const length of [0, 1, 4095, 4096, 4097, 16385]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
    const writer = createBufferedFnv64();
    expect(writer).not.toBeNull();
    writer!.bytes(bytes);
    expect(writer!.digest()).toBe(reference(bytes));
    expect(writer!.digest()).toBe(reference(bytes));
  }
  for (const text of ["é", "😀", "\ud800", "a\udc00z"]) {
    const writer = createBufferedFnv64()!;
    const bytes = new TextEncoder().encode(text);
    writer.ascii("prefix");
    writer.bytes(bytes);
    writer.boolean(true);
    expect(writer.digest()).toBe(reference(new TextEncoder().encode(`prefix${text}b1;`)));
  }
});

it("keeps concurrent partially buffered writers independent across async yields", async () => {
  await Promise.all(
    Array.from({ length: 16 }, async (_, index) => {
      const writer = createBufferedFnv64()!;
      const parts = Array.from({ length: 20 }, (_, part) => `${index}:${part}:`.repeat(150));
      for (const part of parts) {
        expect(writer.ascii(part)).toBe(part.length);
        await Promise.resolve();
      }
      expect(writer.digest()).toBe(reference(new TextEncoder().encode(parts.join(""))));
    }),
  );
});

it("returns the JS-fallback signal when WASM is unavailable or initialization is blocked", async () => {
  vi.stubGlobal("WebAssembly", undefined);
  vi.resetModules();
  expect((await import("./terminal-fnv64-wasm.ts")).createBufferedFnv64()).toBeNull();
  const blocked = vi.fn(function () {
    throw new Error("WASM blocked");
  });
  vi.stubGlobal("WebAssembly", { Module: blocked });
  vi.resetModules();
  const module = await import("./terminal-fnv64-wasm.ts");
  expect(module.createBufferedFnv64()).toBeNull();
  expect(module.createBufferedFnv64()).toBeNull();
  expect(blocked).toHaveBeenCalledTimes(1);
});
