import { describe, expect, it } from "vitest";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { isTerminalLinkClick, terminalLinkAt } from "./terminal-links.ts";

function snapshot(
  lines: readonly string[],
  cols = 40,
  wrapped: readonly number[] = [],
  history = 0,
): TerminalReplicaSnapshot {
  const rows = lines.map((line, index) => ({
    wrapped: wrapped.includes(index),
    cells: Array.from(line.padEnd(cols), (grapheme) => ({
      grapheme,
      width: 1,
      foreground: { kind: "default" },
      background: { kind: "default" },
      attributes: 0,
    })),
  }));
  return {
    cols,
    history: rows.slice(0, history),
    grid: rows.slice(history),
  } as unknown as TerminalReplicaSnapshot;
}

describe("deliberate terminal links", () => {
  it("requires unambiguous modifier primary-down and ignores hover, release, shift selection", () => {
    expect(isTerminalLinkClick({ type: "down", button: 0, modifiers: { ctrl: true } })).toBe(true);
    expect(isTerminalLinkClick({ type: "down", button: 0, modifiers: { meta: true } })).toBe(true);
    for (const type of ["up", "move", "drag", "scroll"])
      expect(isTerminalLinkClick({ type, button: 0, modifiers: { ctrl: true } })).toBe(false);
    expect(isTerminalLinkClick({ type: "down", button: 0 })).toBe(false);
    expect(isTerminalLinkClick({ type: "down", button: 2, modifiers: { ctrl: true } })).toBe(false);
    expect(
      isTerminalLinkClick({ type: "down", button: 0, modifiers: { ctrl: true, shift: true } }),
    ).toBe(false);
  });
  it("resolves only the clicked URL, trimming prose punctuation and preserving balanced URL parentheses", () => {
    const state = snapshot(["See https://example.com/a(b). done"]);
    expect(terminalLinkAt(state, { row: 0, col: 10 })).toBe("https://example.com/a(b)");
    expect(terminalLinkAt(state, { row: 0, col: 28 })).toBeNull();
    expect(terminalLinkAt(state, { row: 0, col: 0 })).toBeNull();
    expect(terminalLinkAt(snapshot(["(https://example.com/path)."]), { row: 0, col: 10 })).toBe(
      "https://example.com/path",
    );
  });
  it("joins soft wraps across history/live boundary but never hard newlines", () => {
    expect(
      terminalLinkAt(snapshot(["https://exam", "ple.com/a"], 12, [1], 1), { row: 1, col: 3 }),
    ).toBe("https://example.com/a");
    expect(
      terminalLinkAt(snapshot(["https://exam", "ple.com/a"], 12, [], 1), { row: 1, col: 3 }),
    ).toBeNull();
  });
  it("uses cell columns rather than Unicode string offsets", () => {
    const state = snapshot(["界 https://example.com"]);
    state.grid[0]!.cells.splice(1, 0, { ...state.grid[0]!.cells[0]!, grapheme: "", width: 0 });
    state.grid[0]!.cells[0]!.width = 2;
    expect(terminalLinkAt(state, { row: 0, col: 5 })).toBe("https://example.com/");
    expect(terminalLinkAt(state, { row: 0, col: 1 })).toBeNull();
  });
  it("rejects non-web schemes, invalid coordinates, and excessive wrapped scans", () => {
    expect(
      terminalLinkAt(snapshot(["file:///etc/passwd javascript:alert(1)"]), { row: 0, col: 5 }),
    ).toBeNull();
    expect(terminalLinkAt(snapshot(["https://example.com"]), { row: -1, col: 4 })).toBeNull();
    expect(
      terminalLinkAt(
        snapshot(
          Array(1000).fill("x"),
          40,
          Array.from({ length: 1000 }, (_, i) => i),
        ),
        { row: 999, col: 4 },
      ),
    ).toBeNull();
  });
});
