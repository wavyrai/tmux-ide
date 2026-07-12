import { describe, expect, it } from "vitest";
import { agentsByPane, chipLabel, stateAge, type ChipAgent } from "./agent-chip.ts";

const entry = (over: Partial<ChipAgent> = {}): ChipAgent => ({
  paneId: "%1",
  kind: "claude",
  state: "working",
  since: null,
  ...over,
});

describe("agentsByPane", () => {
  it("flattens projects → sessions → agents into a paneId map", () => {
    const map = agentsByPane([
      { sessions: [{ agents: [entry({ paneId: "%1" }), entry({ paneId: "%4", kind: "codex" })] }] },
      { sessions: [{ agents: [entry({ paneId: "%9" })] }] },
    ]);
    expect([...map.keys()].sort()).toEqual(["%1", "%4", "%9"]);
    expect(map.get("%4")?.kind).toBe("codex");
  });

  it("tolerates sessions without an agents field (older payloads)", () => {
    const map = agentsByPane([{ sessions: [{}, { agents: [entry()] }] }]);
    expect(map.size).toBe(1);
  });

  it("first entry wins on a duplicate paneId (session under two projects)", () => {
    const map = agentsByPane([
      { sessions: [{ agents: [entry({ paneId: "%2", state: "working" })] }] },
      { sessions: [{ agents: [entry({ paneId: "%2", state: "idle" })] }] },
    ]);
    expect(map.get("%2")?.state).toBe("working");
  });

  it("empty fleet yields an empty map", () => {
    expect(agentsByPane([]).size).toBe(0);
  });
});

describe("stateAge", () => {
  const now = 1_000_000_000_000; // ms

  it("null stamp (scraped pane) yields null", () => {
    expect(stateAge(null, now)).toBeNull();
  });

  it("formats seconds / minutes / hours / days", () => {
    const nowSec = now / 1000;
    expect(stateAge(nowSec - 32, now)).toBe("32s");
    expect(stateAge(nowSec - 4 * 60, now)).toBe("4m");
    expect(stateAge(nowSec - 2 * 3600, now)).toBe("2h");
    expect(stateAge(nowSec - 3 * 86400, now)).toBe("3d");
  });

  it("clamps clock skew to 0s instead of going negative", () => {
    expect(stateAge(now / 1000 + 99, now)).toBe("0s");
  });
});

describe("chipLabel", () => {
  const now = 1_000_000_000_000;

  it("non-blocked states are glyph + kind (color carries the state)", () => {
    expect(chipLabel(entry({ state: "working" }), "●", now, 40)).toBe("● claude");
    expect(chipLabel(entry({ state: "done" }), "●", now, 40)).toBe("● claude");
    expect(chipLabel(entry({ state: "idle" }), "○", now, 40)).toBe("○ claude");
  });

  it("blocked spells the state and appends the authority age", () => {
    const e = entry({ state: "blocked", since: now / 1000 - 4 * 60 });
    expect(chipLabel(e, "●", now, 40)).toBe("● claude · blocked 4m");
  });

  it("blocked without a stamp (scraped) drops the age, keeps the word", () => {
    expect(chipLabel(entry({ state: "blocked" }), "●", now, 40)).toBe("● claude · blocked");
  });

  it("degrades in steps as the budget shrinks", () => {
    const e = entry({ state: "blocked", since: now / 1000 - 240 });
    expect(chipLabel(e, "●", now, 21)).toBe("● claude · blocked 4m"); // exact fit
    expect(chipLabel(e, "●", now, 20)).toBe("● claude · blocked");
    expect(chipLabel(e, "●", now, 17)).toBe("● claude");
    expect(chipLabel(e, "●", now, 5)).toBe("●");
    expect(chipLabel(e, "●", now, 0)).toBeNull();
  });

  it("long kinds fall back to the bare glyph on narrow panes", () => {
    expect(chipLabel(entry({ kind: "copilot-workspace" }), "●", now, 10)).toBe("●");
  });
});

describe("chipLabel — display metadata (M25.4)", () => {
  const now = 1_000_000_000_000;

  it("appends the self-reported status text", () => {
    const e = entry({ statusText: "refactoring auth" });
    expect(chipLabel(e, "●", now, 44)).toBe("● claude · refactoring auth");
  });

  it("displayName replaces the kind in the label", () => {
    const e = entry({ displayName: "reviewer", statusText: "checking PR" });
    expect(chipLabel(e, "●", now, 44)).toBe("● reviewer · checking PR");
    expect(chipLabel(entry({ displayName: "reviewer" }), "●", now, 44)).toBe("● reviewer");
  });

  it("blocked keeps its spelled state FIRST, status text riding after", () => {
    const e = entry({ state: "blocked", since: now / 1000 - 240, statusText: "needs approval" });
    expect(chipLabel(e, "●", now, 60)).toBe("● claude · blocked 4m · needs approval");
  });

  it("an overflowing status text is truncated with an ellipsis, not dropped mid-step", () => {
    const e = entry({ statusText: "refactoring auth" });
    // "● claude · " is 11 cells; budget 20 leaves 9 for the text → 8 + "…".
    expect(chipLabel(e, "●", now, 20)).toBe("● claude · refactor…");
  });

  it("with no room for readable text the suffix drops to the base label, then the glyph", () => {
    const e = entry({ statusText: "refactoring auth" });
    expect(chipLabel(e, "●", now, 13)).toBe("● claude");
    expect(chipLabel(e, "●", now, 3)).toBe("●");
  });

  it("blocked degradation still walks blocked-age → blocked → base when the text can't fit", () => {
    const e = entry({ state: "blocked", since: now / 1000 - 240, statusText: "needs approval" });
    expect(chipLabel(e, "●", now, 21)).toBe("● claude · blocked 4m");
    expect(chipLabel(e, "●", now, 18)).toBe("● claude · blocked");
  });
});
