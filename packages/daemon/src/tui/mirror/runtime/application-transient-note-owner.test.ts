import { describe, expect, it, vi } from "vitest";

import { createApplicationTransientNoteOwner } from "./application-transient-note-owner.ts";

describe("createApplicationTransientNoteOwner", () => {
  it("retires a success note after one second", () => {
    vi.useFakeTimers();
    let note: string | null = null;
    const owner = createApplicationTransientNoteOwner({
      read: () => note,
      write: (next) => (note = next),
    });
    owner.publish("split pane right");
    expect(note).toBe("split pane right");
    vi.advanceTimersByTime(999);
    expect(note).toBe("split pane right");
    vi.advanceTimersByTime(1);
    expect(note).toBeNull();
    owner.dispose();
    vi.useRealTimers();
  });

  it("does not erase a newer persistent status", () => {
    vi.useFakeTimers();
    let note: string | null = null;
    const owner = createApplicationTransientNoteOwner({
      read: () => note,
      write: (next) => (note = next),
    });
    owner.publish("new window");
    note = "Reconnecting to daemon";
    vi.advanceTimersByTime(1_000);
    expect(note).toBe("Reconnecting to daemon");
    owner.dispose();
    vi.useRealTimers();
  });
});
