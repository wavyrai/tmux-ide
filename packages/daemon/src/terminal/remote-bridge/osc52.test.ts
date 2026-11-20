import { describe, expect, it } from "vitest";
import { REMOTE_CLIPBOARD_MAX_BYTES } from "@tmux-ide/contracts";
import { parseOsc52 } from "./osc52.ts";

const b64 = (text: string | Buffer) => Buffer.from(text).toString("base64");

describe("parseOsc52", () => {
  it("decodes a clipboard write", () => {
    expect(parseOsc52(`c;${b64("hi")}`)).toEqual({ kind: "text", text: "hi", bytes: 2 });
  });

  it("treats the empty (default) selection as the clipboard", () => {
    expect(parseOsc52(`;${b64("hi")}`)).toEqual({ kind: "text", text: "hi", bytes: 2 });
  });

  it("accepts a selection list that names the clipboard", () => {
    expect(parseOsc52(`pc;${b64("hi")}`)).toEqual({ kind: "text", text: "hi", bytes: 2 });
  });

  it("ignores primary, secondary and cut-buffer selections", () => {
    for (const selection of ["p", "s", "q", "0", "7", "ps"])
      expect(parseOsc52(`${selection};${b64("hi")}`)).toEqual({ kind: "ignored" });
  });

  it("ignores an unknown selection character even next to c", () => {
    expect(parseOsc52(`cx;${b64("hi")}`)).toEqual({ kind: "ignored" });
  });

  it("swallows a query and never decodes it", () => {
    expect(parseOsc52("c;?")).toEqual({ kind: "query" });
    expect(parseOsc52(";?")).toEqual({ kind: "query" });
    expect(parseOsc52("p;?")).toEqual({ kind: "query" });
  });

  it("ignores a clear (empty payload) and a missing separator", () => {
    expect(parseOsc52("c;")).toEqual({ kind: "ignored" });
    expect(parseOsc52("c")).toEqual({ kind: "ignored" });
    expect(parseOsc52("")).toEqual({ kind: "ignored" });
  });

  it("keeps multi-byte UTF-8 and counts bytes, not characters", () => {
    expect(parseOsc52(`c;${b64("héllo ✓")}`)).toEqual({
      kind: "text",
      text: "héllo ✓",
      bytes: Buffer.byteLength("héllo ✓"),
    });
  });

  it("refuses invalid UTF-8", () => {
    expect(parseOsc52(`c;${b64(Buffer.from([0x68, 0xff, 0x69]))}`)).toEqual({ kind: "invalid" });
    // A lone continuation byte and a truncated sequence.
    expect(parseOsc52(`c;${b64(Buffer.from([0x80]))}`)).toEqual({ kind: "invalid" });
    expect(parseOsc52(`c;${b64(Buffer.from([0xe2, 0x9c]))}`)).toEqual({ kind: "invalid" });
  });

  it("refuses payloads that are not base64", () => {
    for (const payload of [
      "aGk=x",
      "a",
      "aG=k",
      "a b=",
      "aGk=\n",
      "é",
      "aGk===",
      "aGk=aGk=",
      "aG=",
      "aGk==",
      "aG===",
    ])
      expect(parseOsc52(`c;${payload}`), payload).toEqual({ kind: "invalid" });
  });

  it("accepts unpadded base64", () => {
    expect(parseOsc52("c;aGk")).toEqual({ kind: "text", text: "hi", bytes: 2 });
    expect(parseOsc52("c;aGVsbG8")).toEqual({ kind: "text", text: "hello", bytes: 5 });
    expect(parseOsc52("c;aA")).toEqual({ kind: "text", text: "h", bytes: 1 });
  });

  it("strips NUL bytes and counts what remains", () => {
    expect(parseOsc52(`c;${b64("a\0b\0")}`)).toEqual({ kind: "text", text: "ab", bytes: 2 });
    expect(parseOsc52(`c;${b64("\0\0")}`)).toEqual({ kind: "ignored" });
  });

  it("accepts exactly the byte cap and refuses one byte more without decoding", () => {
    const atCap = "x".repeat(REMOTE_CLIPBOARD_MAX_BYTES);
    const accepted = parseOsc52(`c;${b64(atCap)}`);
    expect(accepted.kind).toBe("text");
    expect(accepted.kind === "text" && accepted.bytes).toBe(REMOTE_CLIPBOARD_MAX_BYTES);
    expect(parseOsc52(`c;${b64(atCap + "x")}`)).toEqual({
      kind: "too-large",
      bytes: REMOTE_CLIPBOARD_MAX_BYTES + 1,
    });
  });

  it("refuses a huge payload by its length alone", () => {
    const payload = "A".repeat(8_000_000);
    expect(parseOsc52(`c;${payload}`)).toEqual({ kind: "too-large", bytes: 6_000_000 });
  });
});
