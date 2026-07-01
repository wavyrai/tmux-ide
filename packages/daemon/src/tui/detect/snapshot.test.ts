/**
 * Unit tests for the pure snapshot parser.
 *
 * Covers `parseSnapshot` only — `readPaneSnapshot` shells out to tmux and is
 * exercised via integration paths, not here.
 */
import { describe, expect, it } from "vitest";
import { parseSnapshot } from "./snapshot.ts";

const ESC = "\u001B";
const BEL = "\u0007";

describe("parseSnapshot", () => {
  it("strips ANSI/SGR sequences", () => {
    const raw = `${ESC}[31mred${ESC}[0m ${ESC}[1mbold${ESC}[0m`;
    const snap = parseSnapshot(raw);
    expect(snap.text).toBe("red bold");
    expect(snap.text).not.toContain(ESC);
    expect(snap.bottomNonEmpty).toEqual(["red bold"]);
    expect(snap.raw).toBe(raw);
  });

  it("strips OSC (title) sequences", () => {
    const raw = `${ESC}]0;my-title${BEL}prompt$`;
    const snap = parseSnapshot(raw);
    expect(snap.text).not.toContain(ESC);
    expect(snap.text).toBe("prompt$");
  });

  it("returns the last N non-empty lines, dropping blanks", () => {
    const raw = ["a", "", "b", "   ", "c", "", "d"].join("\n");
    const snap = parseSnapshot(raw);
    expect(snap.bottomNonEmpty).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps only the last 20 non-empty lines by default", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const snap = parseSnapshot(raw);
    expect(snap.bottomNonEmpty).toHaveLength(20);
    expect(snap.bottomNonEmpty[0]).toBe("line10");
    expect(snap.bottomNonEmpty.at(-1)).toBe("line29");
  });

  it("respects a custom lines option", () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const snap = parseSnapshot(raw, { lines: 3 });
    expect(snap.bottomNonEmpty).toEqual(["line7", "line8", "line9"]);
  });

  it("trims trailing whitespace from each retained line", () => {
    const raw = "hello   \nworld\t";
    const snap = parseSnapshot(raw);
    expect(snap.bottomNonEmpty).toEqual(["hello", "world"]);
  });

  it("handles empty string without throwing", () => {
    const snap = parseSnapshot("");
    expect(snap.bottomNonEmpty).toEqual([]);
    expect(snap.text).toBe("");
    expect(snap.raw).toBe("");
  });

  it("handles whitespace-only input without throwing", () => {
    const snap = parseSnapshot("   \n\t\n   ");
    expect(snap.bottomNonEmpty).toEqual([]);
    expect(snap.text).toBe("   \n\t\n   ");
  });

  it("returns no lines when lines option is zero", () => {
    const snap = parseSnapshot("a\nb\nc", { lines: 0 });
    expect(snap.bottomNonEmpty).toEqual([]);
  });
});
