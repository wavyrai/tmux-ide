import { describe, expect, it } from "vitest";

import { InputCoalescer } from "../../../terminal/protocol/input-coalescer.ts";

import { terminalInputForOpenTuiKey, terminalInputsForPaste } from "./terminal-input-adapter.ts";

const key = (
  name: string,
  overrides: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {},
) => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...overrides,
});

describe("OpenTUI terminal input adapter", () => {
  it("keeps Enter, Up and C-c as named keys rather than escape/text bytes", () => {
    expect(terminalInputForOpenTuiKey(key("return"))).toEqual({ kind: "key", data: "Enter" });
    expect(terminalInputForOpenTuiKey(key("up"))).toEqual({ kind: "key", data: "Up" });
    expect(terminalInputForOpenTuiKey(key("c", { ctrl: true }))).toEqual({
      kind: "key",
      data: "C-c",
    });
    expect(terminalInputForOpenTuiKey(key("a"))).toEqual({ kind: "text", data: "a" });
  });

  it("chunks one bracketed paste in exact order and rejects NUL", () => {
    const inputs = terminalInputsForPaste("x".repeat(2_100));
    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => input.data).join("")).toBe(
      `\u001b[200~${"x".repeat(2_100)}\u001b[201~`,
    );
    expect(() => terminalInputsForPaste("a\0b")).toThrow(/NUL/u);
  });
  it.each([1016, 1017, 1018, 2040, 2041, 2042])(
    "preserves supplementary paste bytes across independently delivered messages at offset %i",
    async (prefixLength) => {
      const text = "a".repeat(prefixLength) + "😀" + "界e\u0301" + "z".repeat(1100);
      const inputs = terminalInputsForPaste(text);
      const received: Buffer[] = [];
      const coalescer = new InputCoalescer((action) => {
        if (action.kind !== "literal") throw new Error("unexpected non-text paste action");
        received.push(Buffer.from(action.text, "utf8"));
      }, queueMicrotask);
      for (const input of inputs) {
        expect(input.data.length).toBeLessThanOrEqual(1024);
        // Separate transport deliveries may flush independently; adjacent messages
        // must not depend on one microtask rejoining a split surrogate pair.
        coalescer.literal("%1", JSON.parse(JSON.stringify(input)).data);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const expectedHex =
        "1b5b3230307e" + Buffer.from(text, "utf8").toString("hex") + "1b5b3230317e";
      expect(Buffer.concat(received).toString("hex")).toBe(expectedHex);
    },
  );
});
