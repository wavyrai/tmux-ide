/**
 * Unit tests for the pure restore planner — skip/launch/rebuild decisions,
 * create order, and pane accounting.
 */
import { describe, expect, it } from "vitest";
import {
  buildRestorePlan,
  countResumableAgents,
  DEFAULT_RESTORE_PREFS,
  paneResumeCommand,
  restorePrefs,
} from "./restore.ts";
import type { FleetSnapshot, PaneSnapshot, SessionSnapshot } from "./tui/chrome/snapshot.ts";

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

function pane(overrides: Partial<PaneSnapshot> = {}): PaneSnapshot {
  return {
    index: 0,
    cwd: "/p",
    command: null,
    agent: null,
    agentSessionId: null,
    agentState: null,
    title: "p",
    ...overrides,
  };
}

describe("paneResumeCommand", () => {
  const id = "0199aa1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";
  const cases: Array<{
    name: string;
    pane: PaneSnapshot;
    resumeAgents: boolean;
    want: string | null;
  }> = [
    {
      name: "claude + session id → claude --resume <id>",
      pane: pane({ agent: "claude", agentSessionId: id }),
      resumeAgents: true,
      want: `claude --resume ${id}`,
    },
    {
      name: "claude with no session id → null (no --continue guessing)",
      pane: pane({ agent: "claude", agentSessionId: null }),
      resumeAgents: true,
      want: null,
    },
    // The M24.1 table extensions — each spelling VERIFIED against the CLI's
    // own --help (codex/opencode/cursor) or the official docs (copilot).
    {
      name: "codex + session id → codex resume <id>",
      pane: pane({ agent: "codex", agentSessionId: id }),
      resumeAgents: true,
      want: `codex resume ${id}`,
    },
    {
      name: "opencode + its ses_… id → opencode --session <id> (underscore is safe)",
      pane: pane({ agent: "opencode", agentSessionId: "ses_8f2ab91ccd" }),
      resumeAgents: true,
      want: "opencode --session ses_8f2ab91ccd",
    },
    {
      name: "cursor + chat id → cursor-agent --resume <id> (launch binary, not the kind)",
      pane: pane({ agent: "cursor", agentSessionId: id }),
      resumeAgents: true,
      want: `cursor-agent --resume ${id}`,
    },
    {
      name: "copilot + session id → copilot --resume=<id> (the optional-value = form)",
      pane: pane({ agent: "copilot", agentSessionId: id }),
      resumeAgents: true,
      want: `copilot --resume=${id}`,
    },
    {
      name: "unverified agent (gemini) + session id → null (no VERIFIED resume story)",
      pane: pane({ agent: "gemini", agentSessionId: id }),
      resumeAgents: true,
      want: null,
    },
    {
      name: "codex id with shell metacharacters → null (same guard as claude)",
      pane: pane({ agent: "codex", agentSessionId: "abc;rm -rf" }),
      resumeAgents: true,
      want: null,
    },
    {
      name: "session id with shell metacharacters → null",
      pane: pane({ agent: "claude", agentSessionId: "$(rm -rf ~); echo" }),
      resumeAgents: true,
      want: null,
    },
    {
      name: "session id with a space → null",
      pane: pane({ agent: "claude", agentSessionId: "abc def" }),
      resumeAgents: true,
      want: null,
    },
    {
      name: "resumeAgents off → null even for a valid claude pane",
      pane: pane({ agent: "claude", agentSessionId: id }),
      resumeAgents: false,
      want: null,
    },
    {
      name: "non-agent (plain shell) pane → null",
      pane: pane({ agent: null, agentSessionId: null }),
      resumeAgents: true,
      want: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(paneResumeCommand(c.pane, { resumeAgents: c.resumeAgents })).toBe(c.want);
    });
  }
});

describe("countResumableAgents", () => {
  const id = "0199aa1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";

  it("counts only resumable claude panes across all windows", () => {
    const s: SessionSnapshot = {
      name: "x",
      cwd: "/p",
      adopted: false,
      windows: [
        {
          index: 0,
          name: "w0",
          active: true,
          layout: "l",
          panes: [
            pane({ agent: "claude", agentSessionId: id }),
            pane({ agent: "claude", agentSessionId: null }), // no id → not counted
            pane({ agent: null }), // shell → not counted
          ],
        },
        {
          index: 1,
          name: "w1",
          active: false,
          layout: "l",
          panes: [pane({ agent: "claude", agentSessionId: id })],
        },
      ],
    };
    expect(countResumableAgents(s, true)).toBe(2);
    expect(countResumableAgents(s, false)).toBe(0);
  });
});

describe("restorePrefs", () => {
  it("defaults to resumeAgents false for missing/invalid config", () => {
    expect(restorePrefs(undefined)).toEqual(DEFAULT_RESTORE_PREFS);
    expect(restorePrefs(null)).toEqual(DEFAULT_RESTORE_PREFS);
    expect(restorePrefs(42)).toEqual(DEFAULT_RESTORE_PREFS);
    expect(restorePrefs({})).toEqual(DEFAULT_RESTORE_PREFS);
    expect(restorePrefs({ restore: {} })).toEqual(DEFAULT_RESTORE_PREFS);
    expect(restorePrefs({ restore: { resumeAgents: "yes" } })).toEqual(DEFAULT_RESTORE_PREFS);
    expect(restorePrefs({ restore: null })).toEqual(DEFAULT_RESTORE_PREFS);
  });

  it("reads restore.resumeAgents when it's a boolean", () => {
    expect(restorePrefs({ restore: { resumeAgents: true } })).toEqual({ resumeAgents: true });
    expect(restorePrefs({ restore: { resumeAgents: false } })).toEqual({ resumeAgents: false });
  });
});
