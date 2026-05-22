import { describe, it, expect } from "bun:test";
import { shellEscape } from "./shell.ts";

describe("shellEscape", () => {
  it("wraps plain strings in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("don't")).toBe("'don'\\''t'");
  });

  it("handles empty string", () => {
    expect(shellEscape("")).toBe("''");
  });

  it("handles newlines and shell metacharacters literally inside quotes", () => {
    expect(shellEscape("a; rm -rf /")).toBe("'a; rm -rf /'");
  });
});
