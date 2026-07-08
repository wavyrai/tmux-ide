import { describe, expect, it } from "vitest";
import { findSessionStatus, toFleetJson } from "./report.ts";
import type { TeamProject } from "./projects.ts";
import type { TeamSession } from "./sessions.ts";

function session(over: Partial<TeamSession> = {}): TeamSession {
  return {
    name: "s",
    attached: false,
    windows: 1,
    panes: 1,
    status: "idle",
    windowList: [],
    ...over,
  };
}

function project(over: Partial<TeamProject> = {}): TeamProject {
  return {
    name: "proj",
    dir: "/workspace/proj",
    hasIdeYml: false,
    gitBranch: null,
    registered: true,
    running: false,
    status: "idle",
    sessions: [],
    ...over,
  };
}

describe("toFleetJson", () => {
  it("maps projects + sessions to the plain shape", () => {
    const projects: TeamProject[] = [
      project({
        name: "web",
        dir: "/workspace/web",
        registered: true,
        running: true,
        status: "working",
        sessions: [
          session({ name: "web", status: "working", panes: 3, attached: true }),
          session({ name: "web-2", status: "idle", panes: 1, attached: false }),
        ],
      }),
    ];

    expect(toFleetJson(projects)).toEqual({
      projects: [
        {
          name: "web",
          dir: "/workspace/web",
          registered: true,
          running: true,
          status: "working",
          sessions: [
            { name: "web", status: "working", panes: 3, attached: true, windows: [], agents: [] },
            { name: "web-2", status: "idle", panes: 1, attached: false, windows: [], agents: [] },
          ],
        },
      ],
    });
  });

  it("surfaces a session's per-pane agents array in the JSON", () => {
    const projects: TeamProject[] = [
      project({
        name: "web",
        running: true,
        sessions: [
          session({
            name: "web",
            status: "working",
            agents: [
              {
                paneId: "%3",
                windowIndex: 0,
                session: "web",
                kind: "claude",
                state: "working",
                confidence: "tuned",
                since: 1700000000,
                title: "Editor",
                command: "node",
                dir: "/workspace/web",
              },
            ],
          }),
        ],
      }),
    ];

    expect(toFleetJson(projects).projects[0]!.sessions[0]!.agents).toEqual([
      {
        paneId: "%3",
        windowIndex: 0,
        session: "web",
        kind: "claude",
        state: "working",
        confidence: "tuned",
        since: 1700000000,
        title: "Editor",
        command: "node",
        dir: "/workspace/web",
      },
    ]);
  });

  it("ADDITIVITY: a pre-agents session (no agents field) still maps to agents: []", () => {
    const out = toFleetJson([
      project({ name: "web", running: true, sessions: [session({ name: "web" })] }),
    ]);
    expect(out.projects[0]!.sessions[0]!.agents).toEqual([]);
  });

  it("maps a session's windowList to the JSON windows array", () => {
    const projects: TeamProject[] = [
      project({
        name: "web",
        running: true,
        sessions: [
          session({
            name: "web",
            status: "working",
            panes: 3,
            windowList: [
              { index: 0, name: "editor", active: true, panes: 2, status: "working" },
              { index: 2, name: "server", active: false, panes: 1, status: "idle" },
            ],
          }),
        ],
      }),
    ];

    expect(toFleetJson(projects).projects[0]!.sessions[0]!.windows).toEqual([
      { index: 0, name: "editor", active: true, panes: 2, status: "working" },
      { index: 2, name: "server", active: false, panes: 1, status: "idle" },
    ]);
  });

  it("preserves a null dir", () => {
    const out = toFleetJson([project({ name: "adhoc", dir: null, registered: false })]);
    expect(out.projects[0]!.dir).toBeNull();
  });

  it("empty projects → { projects: [] }", () => {
    expect(toFleetJson([])).toEqual({ projects: [] });
  });
});

describe("findSessionStatus", () => {
  it("returns the status of the matching session", () => {
    const sessions = [session({ name: "a", status: "working" })];
    expect(findSessionStatus(sessions, "a")).toBe("working");
  });

  it("returns null when no session by that name is present", () => {
    expect(findSessionStatus([session({ name: "a" })], "missing")).toBeNull();
  });

  it("picks the right one among several", () => {
    const sessions = [
      session({ name: "a", status: "idle" }),
      session({ name: "b", status: "blocked" }),
      session({ name: "c", status: "done" }),
    ];
    expect(findSessionStatus(sessions, "b")).toBe("blocked");
  });
});
