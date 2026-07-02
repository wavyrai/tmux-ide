/**
 * Unit tests for the pure restore planner — skip/launch/rebuild decisions,
 * create order, and pane accounting.
 */
import { describe, expect, it } from "vitest";
import { buildRestorePlan } from "./restore.ts";
import type { FleetSnapshot, SessionSnapshot } from "./tui/chrome/snapshot.ts";

function session(name: string, windows = 1, panesPerWindow = 1): SessionSnapshot {
  return {
    name,
    cwd: `/p/${name}`,
    adopted: false,
    windows: Array.from({ length: windows }, (_, w) => ({
      index: w,
      name: `w${w}`,
      active: w === 0,
      layout: "abcd,80x24,0,0,0",
      panes: Array.from({ length: panesPerWindow }, (_, p) => ({
        index: p,
        cwd: `/p/${name}/${w}/${p}`,
        command: null,
        agent: null,
        agentSessionId: null,
        agentState: null,
        title: `${name}-${w}-${p}`,
      })),
    })),
  };
}

function snapshot(sessions: SessionSnapshot[]): FleetSnapshot {
  return { version: 1, savedAt: "2026-07-02T00:00:00.000Z", sessions };
}

describe("buildRestorePlan", () => {
  it("skips sessions that are already live (never clobber)", () => {
    const plan = buildRestorePlan(snapshot([session("web"), session("api")]), ["web"]);
    expect(plan.actions).toEqual([
      { kind: "skip", session: "web" },
      { kind: "rebuild", session: expect.objectContaining({ name: "api" }) },
    ]);
  });

  it("prefers a launch when the session maps to an ide.yml project", () => {
    const plan = buildRestorePlan(
      snapshot([session("web")]),
      [],
      new Map([["web", "/Users/x/web"]]),
    );
    expect(plan.actions).toEqual([{ kind: "launch", session: "web", dir: "/Users/x/web" }]);
  });

  it("live sessions win over the ide.yml launch preference", () => {
    const plan = buildRestorePlan(
      snapshot([session("web")]),
      ["web"],
      new Map([["web", "/Users/x/web"]]),
    );
    expect(plan.actions).toEqual([{ kind: "skip", session: "web" }]);
  });

  it("raw-rebuilds sessions with no ide.yml, preserving snapshot order", () => {
    const plan = buildRestorePlan(snapshot([session("a"), session("b")]), []);
    expect(plan.actions.map((x) => x.kind)).toEqual(["rebuild", "rebuild"]);
    expect(plan.actions.map((x) => (x.kind === "rebuild" ? x.session.name : null))).toEqual([
      "a",
      "b",
    ]);
  });

  it("counts panes only across rebuild actions", () => {
    const plan = buildRestorePlan(
      snapshot([session("a", 2, 3), session("b", 1, 1)]),
      ["b"], // skipped — its pane doesn't count
    );
    expect(plan.paneCount).toBe(6); // a: 2 windows × 3 panes
  });
});
