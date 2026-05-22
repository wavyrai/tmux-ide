/**
 * Pure-module tests for the pty primitives (G20-P1).
 *
 * Covers the eight keybinding predicates + bracketed-paste payload
 * builder. The dimensions helper isn't covered here — it needs a real
 * computed style, exercised end-to-end once FrontendPty lands.
 */

import { describe, expect, it } from "vitest";
import {
  shouldCopySelectionFromTerminal,
  shouldHandleInterruptFromTerminal,
  shouldKillLineFromTerminal,
  shouldMapShiftEnterToCtrlJ,
  shouldPasteToTerminal,
} from "@/lib/pty/keybindings";
import { buildPromptInjectionPayload } from "@/lib/pty/promptInjection";

const baseDown = { type: "keydown" } as const;

describe("keybindings — Shift-Enter → Ctrl-J", () => {
  it("matches Shift+Enter on keydown only", () => {
    expect(shouldMapShiftEnterToCtrlJ({ ...baseDown, key: "Enter", shiftKey: true })).toBe(true);
    expect(shouldMapShiftEnterToCtrlJ({ ...baseDown, key: "Enter" })).toBe(false);
    expect(shouldMapShiftEnterToCtrlJ({ type: "keyup", key: "Enter", shiftKey: true })).toBe(false);
    expect(
      shouldMapShiftEnterToCtrlJ({ ...baseDown, key: "Enter", shiftKey: true, ctrlKey: true }),
    ).toBe(false);
  });
});

describe("keybindings — interrupt", () => {
  it("intercepts plain Escape only", () => {
    expect(shouldHandleInterruptFromTerminal({ ...baseDown, key: "Escape" })).toBe(true);
    expect(shouldHandleInterruptFromTerminal({ ...baseDown, key: "Escape", metaKey: true })).toBe(
      false,
    );
  });
});

describe("keybindings — copy selection", () => {
  it("requires a selection", () => {
    expect(
      shouldCopySelectionFromTerminal({ ...baseDown, key: "c", metaKey: true }, true, false),
    ).toBe(false);
  });
  it("Cmd+C on mac copies", () => {
    expect(
      shouldCopySelectionFromTerminal({ ...baseDown, key: "c", metaKey: true }, true, true),
    ).toBe(true);
  });
  it("Ctrl+C on linux copies", () => {
    expect(
      shouldCopySelectionFromTerminal({ ...baseDown, key: "c", ctrlKey: true }, false, true),
    ).toBe(true);
  });
  it("Ctrl+Shift+C copies on both platforms", () => {
    expect(
      shouldCopySelectionFromTerminal(
        { ...baseDown, key: "C", ctrlKey: true, shiftKey: true },
        true,
        true,
      ),
    ).toBe(true);
    expect(
      shouldCopySelectionFromTerminal(
        { ...baseDown, key: "C", ctrlKey: true, shiftKey: true },
        false,
        true,
      ),
    ).toBe(true);
  });
});

describe("keybindings — Cmd-Backspace kill-line on mac only", () => {
  it("matches the mac-only path", () => {
    expect(shouldKillLineFromTerminal({ ...baseDown, key: "Backspace", metaKey: true }, true)).toBe(
      true,
    );
    expect(
      shouldKillLineFromTerminal({ ...baseDown, key: "Backspace", metaKey: true }, false),
    ).toBe(false);
    expect(shouldKillLineFromTerminal({ ...baseDown, key: "Backspace" }, true)).toBe(false);
  });
});

describe("keybindings — paste shortcut", () => {
  it("Ctrl+Shift+V triggers the Linux paste path", () => {
    expect(
      shouldPasteToTerminal({ ...baseDown, key: "v", ctrlKey: true, shiftKey: true }, false),
    ).toBe(true);
  });
  it("does NOT trigger on mac (browser default handles Cmd-V)", () => {
    expect(
      shouldPasteToTerminal({ ...baseDown, key: "v", ctrlKey: true, shiftKey: true }, true),
    ).toBe(false);
  });
  it("does NOT trigger for plain Ctrl-V (the readline shortcut)", () => {
    expect(shouldPasteToTerminal({ ...baseDown, key: "v", ctrlKey: true }, false)).toBe(false);
  });
});

describe("promptInjection — bracketed paste payload", () => {
  it("returns plain text for single-line input", () => {
    expect(buildPromptInjectionPayload({ providerId: "openai", text: "hello" })).toBe("hello");
  });

  it("wraps multiline input in bracketed-paste escapes for non-claude providers", () => {
    const wrapped = buildPromptInjectionPayload({
      providerId: "openai",
      text: "line one\nline two",
    });
    expect(wrapped.startsWith("\x1b[200~")).toBe(true);
    expect(wrapped.endsWith("\x1b[201~")).toBe(true);
    expect(wrapped).toContain("line one\nline two");
  });

  it("passes through plain text for claude — its CLI does its own paste handling", () => {
    const text = "line one\nline two";
    expect(buildPromptInjectionPayload({ providerId: "claude", text })).toBe(text);
  });

  it("trims leading + trailing whitespace before checking for newlines", () => {
    expect(buildPromptInjectionPayload({ providerId: "openai", text: "   hello   " })).toBe(
      "hello",
    );
  });
});
