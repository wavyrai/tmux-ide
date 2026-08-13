import { describe, expect, it, vi } from "vitest";

import { PaneScopedTerminalOwner } from "./pane-scoped-terminal-owner.ts";

describe("PaneScopedTerminalOwner", () => {
  it("publishes only to the addressed pane", () => {
    const owner = new PaneScopedTerminalOwner();
    const generation = owner.beginGeneration();
    const editor = vi.fn();
    const tests = vi.fn();
    owner.subscribe("editor", editor);
    owner.subscribe("tests", tests);

    expect(owner.publish(generation, "editor", 1)).toBe(true);
    expect(editor).toHaveBeenCalledWith(1);
    expect(tests).not.toHaveBeenCalled();
    expect(owner.version("tests")).toBe(0);
  });

  it("retires old generation delivery without disturbing current listeners", () => {
    const owner = new PaneScopedTerminalOwner();
    const oldGeneration = owner.beginGeneration();
    const listener = vi.fn();
    owner.subscribe("editor", listener);
    owner.publish(oldGeneration, "editor", 1);

    const replacement = owner.beginGeneration();
    expect(owner.publish(oldGeneration, "editor", 2)).toBe(false);
    expect(owner.publish(replacement, "editor", 1)).toBe(true);
    expect(listener.mock.calls).toEqual([[1], [2]]);
  });

  it("unsubscribes and disposes cleanly", () => {
    const owner = new PaneScopedTerminalOwner();
    const generation = owner.beginGeneration();
    const listener = vi.fn();
    const unsubscribe = owner.subscribe("editor", listener);
    unsubscribe();
    owner.publish(generation, "editor", 1);
    expect(listener).not.toHaveBeenCalled();

    const late = owner.subscribe("editor", listener);
    owner.dispose();
    expect(owner.publish(generation, "editor", 2)).toBe(false);
    late();
    expect(listener).not.toHaveBeenCalled();
  });
});
