/**
 * Unit tests for the pure parts of the transition event log — the fleet diff,
 * the human-readable line formatter, and the rotation-size predicate.
 */
import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../detect/classify.ts";
import {
  diffFleet,
  EVENTS_MAX_BYTES,
  formatEventLine,
  shouldRotate,
  type AgentEvent,
} from "./events.ts";

function fleet(
  ...entries: Array<[string, AgentStatus]>
): Array<{ name: string; status: AgentStatus }> {
  return entries.map(([name, status]) => ({ name, status }));
}

describe("diffFleet", () => {
  it("emits a first-sight event (from=null) for every newly seen session", () => {
    const { events, state } = diffFleet(new Map(), fleet(["web", "working"], ["api", "idle"]));
    expect(events).toEqual([
      { session: "web", from: null, to: "working" },
      { session: "api", from: null, to: "idle" },
    ]);
    expect(state.get("web")).toBe("working");
    expect(state.get("api")).toBe("idle");
  });

  it("emits a transition when a session's status changes", () => {
    const prev = new Map<string, AgentStatus>([["web", "working"]]);
    const { events, state } = diffFleet(prev, fleet(["web", "done"]));
    expect(events).toEqual([{ session: "web", from: "working", to: "done" }]);
    expect(state.get("web")).toBe("done");
  });

  it("emits nothing when a session's status is unchanged", () => {
    const prev = new Map<string, AgentStatus>([
      ["web", "idle"],
      ["api", "working"],
    ]);
    const { events } = diffFleet(prev, fleet(["web", "idle"], ["api", "working"]));
    expect(events).toEqual([]);
  });

  it("emits nothing for a session that disappears, and drops it from state", () => {
    const prev = new Map<string, AgentStatus>([
      ["web", "working"],
      ["gone", "done"],
    ]);
    const { events, state } = diffFleet(prev, fleet(["web", "working"]));
    expect(events).toEqual([]);
    expect(state.has("gone")).toBe(false);
    expect(state.get("web")).toBe("working");
  });

  it("handles a mix of new, changed, unchanged and gone in one diff", () => {
    const prev = new Map<string, AgentStatus>([
      ["web", "working"], // changes
      ["api", "idle"], // unchanged
      ["gone", "done"], // disappears
    ]);
    const { events } = diffFleet(prev, fleet(["web", "done"], ["api", "idle"], ["new", "working"]));
    expect(events).toEqual([
      { session: "web", from: "working", to: "done" },
      { session: "new", from: null, to: "working" },
    ]);
  });
});

describe("formatEventLine", () => {
  const ev: AgentEvent = {
    ts: "2026-07-01T12:31:07.512Z",
    session: "prototyper-platform",
    from: "working",
    to: "done",
  };

  it("renders time, session and the from → to transition", () => {
    expect(formatEventLine(ev)).toBe("12:31:07 prototyper-platform working → done");
  });

  it("renders a first-sight event with · as the origin", () => {
    expect(formatEventLine({ ...ev, from: null, to: "idle" })).toBe(
      "12:31:07 prototyper-platform · → idle",
    );
  });

  it("applies the painter to the status tokens", () => {
    const paint = (_s: AgentStatus | null, t: string) => `<${t}>`;
    expect(formatEventLine(ev, paint)).toBe("12:31:07 prototyper-platform <working> → <done>");
  });
});

describe("shouldRotate", () => {
  it("is false at or below the max and true past it", () => {
    expect(shouldRotate(0)).toBe(false);
    expect(shouldRotate(EVENTS_MAX_BYTES)).toBe(false);
    expect(shouldRotate(EVENTS_MAX_BYTES + 1)).toBe(true);
  });
});

describe("eventsPath", () => {
  it("honors TMUX_IDE_HOME (the state-home override), falling back to ~/.tmux-ide", async () => {
    const { eventsPath } = await import("./events.ts");
    const prev = process.env.TMUX_IDE_HOME;
    try {
      process.env.TMUX_IDE_HOME = "/tmp/zz-events-home";
      expect(eventsPath()).toBe("/tmp/zz-events-home/events.jsonl");
      delete process.env.TMUX_IDE_HOME;
      expect(eventsPath().endsWith("/.tmux-ide/events.jsonl")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TMUX_IDE_HOME;
      else process.env.TMUX_IDE_HOME = prev;
    }
  });
});
