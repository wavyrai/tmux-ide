/**
 * Keybind registry — unit tests.
 *
 * Verifies that `registerKeybinds` declares + de-dupes bindings, that
 * `dispatchKey` routes a synthetic event to the matching `run`
 * handler, and that the editable-target guard suppresses dispatch when
 * the user is typing in a form field (so `Cmd+B` etc. don't fire from
 * inside an input).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetKeybindsForTests,
  allKeybinds,
  dispatchKey,
  formatCombo,
  registerKeybinds,
} from "@/lib/keybinds";

beforeEach(() => {
  __resetKeybindsForTests();
});

afterEach(() => {
  __resetKeybindsForTests();
});

function key(combo: {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  target?: EventTarget | null;
}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: combo.key,
    metaKey: combo.meta ?? false,
    ctrlKey: combo.ctrl ?? false,
    shiftKey: combo.shift ?? false,
    altKey: combo.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (combo.target !== undefined) {
    Object.defineProperty(event, "target", { value: combo.target });
  }
  return event;
}

describe("keybind registry", () => {
  it("registers a binding and exposes it via allKeybinds()", () => {
    registerKeybinds({
      id: "test.alpha",
      label: "Alpha",
      group: "Global",
      scope: "global",
      combo: { key: "a" },
      run: () => undefined,
    });
    expect(allKeybinds().map((b) => b.id)).toEqual(["test.alpha"]);
  });

  it("re-registering with the same id replaces, never duplicates", () => {
    const run1 = vi.fn();
    const run2 = vi.fn();
    registerKeybinds({
      id: "test.dup",
      label: "v1",
      group: "Global",
      scope: "global",
      combo: { key: "x" },
      run: run1,
    });
    registerKeybinds({
      id: "test.dup",
      label: "v2",
      group: "Global",
      scope: "global",
      combo: { key: "x" },
      run: run2,
    });
    const entries = allKeybinds().filter((b) => b.id === "test.dup");
    expect(entries.length).toBe(1);
    expect(entries[0]?.label).toBe("v2");
  });

  it("dispatchKey fires the matching global binding (Mac Cmd) and returns true", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      get: () => "MacIntel",
    });
    const handler = vi.fn();
    registerKeybinds({
      id: "test.cmdk",
      label: "Open palette",
      group: "Global",
      scope: "global",
      combo: { key: "k" },
      run: handler,
    });
    const fired = dispatchKey(key({ key: "k", meta: true }));
    expect(fired).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("dispatchKey suppresses bindings while the user is typing in an input", () => {
    const handler = vi.fn();
    registerKeybinds({
      id: "test.cmdb",
      label: "Toggle sidebar",
      group: "Global",
      scope: "global",
      combo: { key: "b" },
      run: handler,
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    const fired = dispatchKey(key({ key: "b", meta: true, target: input }));
    expect(fired).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("dispatchKey skips bindings whose scope is not 'global'", () => {
    const handler = vi.fn();
    registerKeybinds({
      id: "test.terminal-only",
      label: "Terminal-only",
      group: "Terminal",
      scope: "terminal",
      combo: { key: "t" },
      run: handler,
    });
    const fired = dispatchKey(key({ key: "t", meta: true }));
    expect(fired).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("altCombo matches when the primary combo doesn't (VS-Code-style Cmd+Shift+P)", () => {
    const handler = vi.fn();
    registerKeybinds({
      id: "test.palette",
      label: "Palette",
      group: "Global",
      scope: "global",
      combo: { key: "k" },
      altCombo: { key: "p", shift: true },
      run: handler,
    });
    expect(dispatchKey(key({ key: "p", meta: true, shift: true }))).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("respects the `when` predicate", () => {
    const handler = vi.fn();
    let enabled = false;
    registerKeybinds({
      id: "test.gated",
      label: "Gated",
      group: "Global",
      scope: "global",
      combo: { key: "g" },
      when: () => enabled,
      run: handler,
    });
    dispatchKey(key({ key: "g", meta: true }));
    expect(handler).not.toHaveBeenCalled();
    enabled = true;
    dispatchKey(key({ key: "g", meta: true }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("registerKeybinds returns a disposer that removes just its bindings", () => {
    registerKeybinds({
      id: "test.permanent",
      label: "perm",
      group: "Global",
      scope: "global",
      combo: { key: "p" },
      run: () => undefined,
    });
    const dispose = registerKeybinds({
      id: "test.transient",
      label: "trans",
      group: "Global",
      scope: "global",
      combo: { key: "t" },
      run: () => undefined,
    });
    dispose();
    expect(allKeybinds().map((b) => b.id)).toEqual(["test.permanent"]);
  });

  it("formatCombo renders Mac symbols when on a Mac platform", () => {
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      get: () => "MacIntel",
    });
    expect(formatCombo({ key: "k" })).toBe("⌘K");
    expect(formatCombo({ key: "p", shift: true })).toBe("⌘⇧P");
    expect(formatCombo({ key: "/", alt: true })).toBe("⌘⌥/");
  });
});
