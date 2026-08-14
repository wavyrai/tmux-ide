import { describe, expect, it } from "vitest";

import {
  terminalInputForOpenTuiKey,
  terminalInputsForPaste,
} from "./terminal-input-adapter.ts";

const key = (name: string, overrides: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) => ({
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
});
