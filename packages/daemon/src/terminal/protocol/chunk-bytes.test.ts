import { describe, expect, it } from "vitest";
import { chunkByBytes } from "./chunk-bytes.ts";

describe("chunkByBytes", () => {
  it("returns one chunk when it fits", () => {
    expect(chunkByBytes("hello", 100)).toEqual(["hello"]);
  });
  it("splits on the byte budget", () => {
    expect(chunkByBytes("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });
  it("never breaks a multi-byte code point", () => {
    // "é" is 2 bytes; with a 3-byte budget each chunk holds one "é".
    const chunks = chunkByBytes("ééé", 3);
    expect(chunks).toEqual(["é", "é", "é"]);
    for (const c of chunks) expect(Buffer.byteLength(c, "utf8")).toBeLessThanOrEqual(3);
  });
  it("reassembles to the original", () => {
    const s = "the quick brown fox — jumped over 42 lazy dogs";
    expect(chunkByBytes(s, 5).join("")).toBe(s);
  });
});
