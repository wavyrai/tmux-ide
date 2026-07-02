import { describe, expect, it } from "vitest";
import { groupSessions, type ProjectInput } from "./projects.ts";
import type { TeamSession } from "./sessions.ts";
import type { AgentStatus } from "../detect/classify.ts";

function session(name: string, status: AgentStatus = "idle"): TeamSession {
  return { name, attached: false, windows: 1, panes: 1, status, windowList: [] };
}

/** Build a `sessionCwd` resolver from a plain map (unknown → null). */
function cwdMap(map: Record<string, string>): (name: string) => string | null {
  return (name) => map[name] ?? null;
}

describe("groupSessions", () => {
  it("nests a name-matched session under its registered project", () => {
    const projects: ProjectInput[] = [{ name: "web", dir: "/repos/web" }];
    const result = groupSessions(projects, [session("web", "working")], cwdMap({}));

    expect(result).toHaveLength(1);
    const web = result[0]!;
    expect(web.registered).toBe(true);
    expect(web.running).toBe(true);
    expect(web.sessions.map((s) => s.name)).toEqual(["web"]);
    expect(web.status).toBe("working");
  });

  it("keeps a registered project with no session (running:false, empty)", () => {
    const projects: ProjectInput[] = [{ name: "web", dir: "/repos/web" }];
    const result = groupSessions(projects, [], cwdMap({}));

    expect(result).toHaveLength(1);
    const web = result[0]!;
    expect(web.registered).toBe(true);
    expect(web.running).toBe(false);
    expect(web.sessions).toEqual([]);
    expect(web.status).toBe("idle");
  });

  it("matches a session by cwd inside project.dir when the name differs", () => {
    const projects: ProjectInput[] = [{ name: "web", dir: "/repos/web" }];
    const result = groupSessions(
      projects,
      [session("scratch")],
      cwdMap({ scratch: "/repos/web/apps/site" }),
    );

    expect(result).toHaveLength(1);
    const web = result[0]!;
    expect(web.running).toBe(true);
    expect(web.sessions.map((s) => s.name)).toEqual(["scratch"]);
  });

  it("hides `_`-prefixed internal projects and scratch sessions", () => {
    const projects: ProjectInput[] = [
      { name: "web", dir: "/repos/web" },
      { name: "_tmux-ide", dir: "/repos/host" },
    ];
    const result = groupSessions(
      projects,
      [session("web"), session("_bar-x"), session("_tmux-ide")],
      cwdMap({ "_bar-x": "/tmp/scratch" }),
    );

    const names = result.map((p) => p.name);
    expect(names).toContain("web");
    expect(names).not.toContain("_tmux-ide");
    expect(names).not.toContain("_bar-x");
  });

  it("turns an unmatched live session into an ad-hoc project", () => {
    const result = groupSessions([], [session("loose", "blocked")], cwdMap({ loose: "/tmp/x" }));

    expect(result).toHaveLength(1);
    const adhoc = result[0]!;
    expect(adhoc.name).toBe("loose");
    expect(adhoc.registered).toBe(false);
    expect(adhoc.running).toBe(true);
    expect(adhoc.dir).toBe("/tmp/x");
    expect(adhoc.status).toBe("blocked");
  });

  it("assigns a session to the longest matching project.dir", () => {
    const projects: ProjectInput[] = [
      { name: "outer", dir: "/repos" },
      { name: "inner", dir: "/repos/web" },
    ];
    const result = groupSessions(
      projects,
      [session("s")],
      cwdMap({ s: "/repos/web/src" }),
    );

    const inner = result.find((p) => p.name === "inner")!;
    const outer = result.find((p) => p.name === "outer")!;
    expect(inner.sessions.map((x) => x.name)).toEqual(["s"]);
    expect(outer.sessions).toEqual([]);
    expect(outer.running).toBe(false);
  });

  it("rolls a blocked session up to a blocked project status", () => {
    const projects: ProjectInput[] = [{ name: "web", dir: "/repos/web" }];
    const result = groupSessions(
      projects,
      [session("web", "idle"), session("web", "blocked")],
      cwdMap({}),
    );
    // Both sessions are name-matched into the same project.
    expect(result[0]!.status).toBe("blocked");
    expect(result[0]!.sessions).toHaveLength(2);
  });

  it("sorts registered projects alphabetically before ad-hoc sessions", () => {
    const projects: ProjectInput[] = [
      { name: "zeta", dir: "/repos/zeta" },
      { name: "alpha", dir: "/repos/alpha" },
    ];
    const result = groupSessions(projects, [session("wild")], cwdMap({ wild: "/elsewhere" }));
    expect(result.map((p) => p.name)).toEqual(["alpha", "zeta", "wild"]);
  });

  it("does not treat a sibling dir with a shared prefix as inside", () => {
    const projects: ProjectInput[] = [{ name: "b", dir: "/a/b" }];
    const result = groupSessions(projects, [session("s")], cwdMap({ s: "/a/bee" }));
    // /a/bee is NOT inside /a/b → session becomes ad-hoc.
    expect(result.find((p) => p.name === "b")!.running).toBe(false);
    expect(result.find((p) => p.name === "s")!.registered).toBe(false);
  });
});
