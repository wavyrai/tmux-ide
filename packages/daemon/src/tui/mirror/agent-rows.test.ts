import { describe, it, expect } from "vitest";
import {
  sortAgentRows,
  agentRowLabel,
  agentsHeaderLabel,
  agentAgeLabel,
  sidebarHit,
  AGENTS_EMPTY_LINE,
  type AgentRowInput,
} from "./agent-rows.ts";

const mk = (over: Partial<AgentRowInput>): AgentRowInput => ({
  paneId: "%0",
  windowIndex: 0,
  session: "s",
  kind: "claude",
  state: "idle",
  since: null,
  ...over,
});

describe("sortAgentRows", () => {
  it("orders attention-first: blocked, working, done, idle, unknown", () => {
    const rows = [
      mk({ paneId: "%idle", state: "idle" }),
      mk({ paneId: "%done", state: "done" }),
      mk({ paneId: "%unknown", state: "unknown" }),
      mk({ paneId: "%blocked", state: "blocked" }),
      mk({ paneId: "%working", state: "working" }),
    ];
    expect(sortAgentRows(rows).map((r) => r.paneId)).toEqual([
      "%blocked",
      "%working",
      "%done",
      "%idle",
      "%unknown",
    ]);
  });

  it("is STABLE within a group (preserves input order for equal states)", () => {
    const rows = [
      mk({ paneId: "%w1", state: "working" }),
      mk({ paneId: "%b1", state: "blocked" }),
      mk({ paneId: "%w2", state: "working" }),
      mk({ paneId: "%b2", state: "blocked" }),
      mk({ paneId: "%w3", state: "working" }),
    ];
    expect(sortAgentRows(rows).map((r) => r.paneId)).toEqual(["%b1", "%b2", "%w1", "%w2", "%w3"]);
  });

  it("does not mutate the input array", () => {
    const rows = [mk({ state: "idle" }), mk({ state: "blocked" })];
    const before = rows.map((r) => r.state);
    sortAgentRows(rows);
    expect(rows.map((r) => r.state)).toEqual(before);
  });

  it("handles an empty list", () => {
    expect(sortAgentRows([])).toEqual([]);
  });
});

describe("agentRowLabel", () => {
  it("joins kind and session with a middle dot", () => {
    expect(agentRowLabel("claude", "new-name", 40)).toBe("claude · new-name");
  });

  it("truncates with a trailing ellipsis when over budget", () => {
    const out = agentRowLabel("claude", "very-long-session-name", 12);
    expect(out).toHaveLength(12);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toBe("claude · ve…");
  });

  it("returns the full label when it exactly fits", () => {
    const full = "claude · s";
    expect(agentRowLabel("claude", "s", full.length)).toBe(full);
  });

  it("degrades cleanly at tiny widths", () => {
    expect(agentRowLabel("claude", "s", 0)).toBe("");
    expect(agentRowLabel("claude", "s", -3)).toBe("");
    expect(agentRowLabel("claude", "s", 1)).toBe("…");
  });
});

describe("agentsHeaderLabel", () => {
  it("shows the count", () => {
    expect(agentsHeaderLabel(3, 40)).toBe("agents · 3");
    expect(agentsHeaderLabel(0, 40)).toBe("agents · 0");
  });

  it("truncates with ellipsis when the sidebar is narrow", () => {
    const out = agentsHeaderLabel(12, 6);
    expect(out).toHaveLength(6);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("agentAgeLabel", () => {
  it("returns null without a timestamp (scraped pane)", () => {
    expect(agentAgeLabel("blocked", null, 1000)).toBeNull();
  });

  it("formats seconds under a minute", () => {
    expect(agentAgeLabel("working", 1000, 1042)).toBe("working 42s");
  });

  it("formats minutes", () => {
    expect(agentAgeLabel("blocked", 1000, 1000 + 4 * 60 + 10)).toBe("blocked 4m");
  });

  it("formats hours", () => {
    expect(agentAgeLabel("idle", 1000, 1000 + 2 * 3600 + 5)).toBe("idle 2h");
  });

  it("clamps a future/equal stamp to 0s rather than going negative", () => {
    expect(agentAgeLabel("done", 2000, 1000)).toBe("done 0s");
  });
});

describe("sidebarHit", () => {
  // 2 sessions, 3 agents (AGENTS_GAP_ROWS === 1). Layout: gy0 title, gy1 rule,
  // gy2..3 sessions, gy4 GAP (inert), gy5 agents header, gy6..8 agent rows.
  it("maps the title/rule rows to null", () => {
    expect(sidebarHit(0, 2, 3)).toBeNull();
    expect(sidebarHit(1, 2, 3)).toBeNull();
  });

  it("maps session rows", () => {
    expect(sidebarHit(2, 2, 3)).toEqual({ kind: "session", index: 0 });
    expect(sidebarHit(3, 2, 3)).toEqual({ kind: "session", index: 1 });
  });

  it("treats the gap row between sessions and agents as inert", () => {
    expect(sidebarHit(4, 2, 3)).toBeNull();
  });

  it("maps the agents header row (inert)", () => {
    expect(sidebarHit(5, 2, 3)).toEqual({ kind: "agents-header" });
  });

  it("maps agent rows", () => {
    expect(sidebarHit(6, 2, 3)).toEqual({ kind: "agent", index: 0 });
    expect(sidebarHit(7, 2, 3)).toEqual({ kind: "agent", index: 1 });
    expect(sidebarHit(8, 2, 3)).toEqual({ kind: "agent", index: 2 });
  });

  it("returns null past the last agent row", () => {
    expect(sidebarHit(9, 2, 3)).toBeNull();
    expect(sidebarHit(20, 2, 3)).toBeNull();
  });

  it("treats the empty-state row (agentCount 0) as inert", () => {
    // gy2..3 sessions, gy4 gap, gy5 header, gy6 is the empty-state line → null.
    expect(sidebarHit(5, 2, 0)).toEqual({ kind: "agents-header" });
    expect(sidebarHit(6, 2, 0)).toBeNull();
  });

  it("works with zero sessions (gap then agents section after the rule)", () => {
    expect(sidebarHit(2, 0, 2)).toBeNull(); // gap row
    expect(sidebarHit(3, 0, 2)).toEqual({ kind: "agents-header" });
    expect(sidebarHit(4, 0, 2)).toEqual({ kind: "agent", index: 0 });
    expect(sidebarHit(5, 0, 2)).toEqual({ kind: "agent", index: 1 });
    expect(sidebarHit(6, 0, 2)).toBeNull();
  });
});

describe("AGENTS_EMPTY_LINE", () => {
  it("is plain-language and mentions the agents that qualify", () => {
    expect(AGENTS_EMPTY_LINE).toMatch(/no agents running/);
    expect(AGENTS_EMPTY_LINE).toMatch(/claude/);
  });
});
