/**
 * Pure tab-keybind predicate tests (G20-P3). Drives every modifier
 * permutation against:
 *   - shouldOpenNewTab        (Cmd/Ctrl+T)
 *   - shouldCloseCurrentTab   (Cmd/Ctrl+W)
 *   - resolveTabIndexShortcut (Cmd/Ctrl+1..9)
 */

import { describe, expect, it } from "vitest";
import {
  resolveTabIndexShortcut,
  shouldCloseCurrentTab,
  shouldOpenNewTab,
} from "@/lib/pty/tabKeybindings";

const down = { type: "keydown" } as const;

describe("shouldOpenNewTab", () => {
  it("Cmd+T on mac matches", () => {
    expect(shouldOpenNewTab({ ...down, key: "t", metaKey: true }, true)).toBe(true);
  });
  it("Ctrl+T on linux matches", () => {
    expect(shouldOpenNewTab({ ...down, key: "T", ctrlKey: true }, false)).toBe(true);
  });
  it("rejects plain T", () => {
    expect(shouldOpenNewTab({ ...down, key: "t" }, true)).toBe(false);
  });
  it("rejects Cmd+Shift+T", () => {
    expect(shouldOpenNewTab({ ...down, key: "t", metaKey: true, shiftKey: true }, true)).toBe(
      false,
    );
  });
  it("rejects on keyup", () => {
    expect(shouldOpenNewTab({ type: "keyup", key: "t", metaKey: true }, true)).toBe(false);
  });
  it("rejects Ctrl+T on mac (must be Cmd)", () => {
    expect(shouldOpenNewTab({ ...down, key: "t", ctrlKey: true }, true)).toBe(false);
  });
});

describe("shouldCloseCurrentTab", () => {
  it("Cmd+W on mac matches", () => {
    expect(shouldCloseCurrentTab({ ...down, key: "w", metaKey: true }, true)).toBe(true);
  });
  it("Ctrl+W on linux matches", () => {
    expect(shouldCloseCurrentTab({ ...down, key: "w", ctrlKey: true }, false)).toBe(true);
  });
  it("rejects Cmd+Shift+W", () => {
    expect(shouldCloseCurrentTab({ ...down, key: "w", metaKey: true, shiftKey: true }, true)).toBe(
      false,
    );
  });
});

describe("resolveTabIndexShortcut", () => {
  it("maps Cmd+1..9 to zero-based index 0..8 on mac", () => {
    for (let i = 1; i <= 9; i += 1) {
      expect(resolveTabIndexShortcut({ ...down, key: String(i), metaKey: true }, true)).toBe(i - 1);
    }
  });
  it("maps Ctrl+1..9 on linux", () => {
    expect(resolveTabIndexShortcut({ ...down, key: "3", ctrlKey: true }, false)).toBe(2);
  });
  it("returns null for Cmd+0 (intentionally unbound)", () => {
    expect(resolveTabIndexShortcut({ ...down, key: "0", metaKey: true }, true)).toBeNull();
  });
  it("returns null for plain 1", () => {
    expect(resolveTabIndexShortcut({ ...down, key: "1" }, true)).toBeNull();
  });
  it("returns null when Shift / Alt are pressed", () => {
    expect(
      resolveTabIndexShortcut({ ...down, key: "1", metaKey: true, shiftKey: true }, true),
    ).toBeNull();
    expect(
      resolveTabIndexShortcut({ ...down, key: "1", metaKey: true, altKey: true }, true),
    ).toBeNull();
  });
  it("returns null on keyup", () => {
    expect(resolveTabIndexShortcut({ type: "keyup", key: "1", metaKey: true }, true)).toBeNull();
  });
});
