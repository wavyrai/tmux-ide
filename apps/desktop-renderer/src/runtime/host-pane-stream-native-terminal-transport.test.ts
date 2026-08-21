import { PANE_STREAM_MAX_INPUT_TEXT_CHARS } from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";

import { createPaneStreamInputDecoder } from "./host-pane-stream-native-terminal-transport.ts";

describe("pane-stream terminal input decoder", () => {
  it("reassembles a UTF-8 code point split across terminal write callbacks", () => {
    const decoder = createPaneStreamInputDecoder();
    const bytes = new TextEncoder().encode("€");
    expect(decoder.push(bytes.subarray(0, 1))).toEqual([]);
    expect(decoder.push(bytes.subarray(1))).toEqual(["€"]);
  });

  it("keeps decoder state private to each terminal attachment", () => {
    const first = createPaneStreamInputDecoder();
    const second = createPaneStreamInputDecoder();
    const euro = new TextEncoder().encode("€");
    expect(first.push(euro.subarray(0, 1))).toEqual([]);
    expect(second.push(new TextEncoder().encode("x"))).toEqual(["x"]);
    expect(first.push(euro.subarray(1))).toEqual(["€"]);
  });

  it("bounds pane-stream text frames without splitting surrogate pairs", () => {
    const decoder = createPaneStreamInputDecoder();
    const source = "🙂".repeat(PANE_STREAM_MAX_INPUT_TEXT_CHARS + 1);
    const chunks = decoder.push(new TextEncoder().encode(source));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= PANE_STREAM_MAX_INPUT_TEXT_CHARS)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });
});
