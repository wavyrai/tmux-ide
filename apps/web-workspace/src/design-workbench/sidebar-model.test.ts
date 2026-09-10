import { describe, expect, it } from "vitest";
import { groupSidebarWindows, selectedSidebarPane } from "./sidebar-model";

describe("sidebar identity", () => {
  const window = (id: string, machineId: string, sessionId: string) => ({
    id,
    machineId,
    sessionId,
    machine: "Build machine",
    session: "api",
  });

  it("keeps identically named machines and sessions independently selectable", () => {
    const groups = groupSidebarWindows([
      window("a", "machine.a", "session.a"),
      window("b", "machine.a", "session.b"),
      window("c", "machine.b", "session.a"),
    ]);
    expect(groups.map((m) => [m.id, m.sessions.map((s) => s.windows.map((w) => w.id))])).toEqual([
      ["machine.a", [["a"], ["b"]]],
      ["machine.b", [["c"]]],
    ]);
  });

  it("groups windows by stable IDs even when a display label changes", () => {
    const first = window("a", "machine.a", "session.a");
    const second = { ...first, id: "b", machine: "Renamed machine", session: "Renamed session" };
    const groups = groupSidebarWindows([first, second]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessions).toHaveLength(1);
    expect(groups[0]!.sessions[0]!.windows.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("never fabricates an agent selection for missing, shell, or another daemon focus", () => {
    const agents = ["daemon.a:agent.a", "daemon.a:agent.b"];
    for (const focused of ["", "daemon.a:shell", "daemon.b:agent.a"])
      expect(selectedSidebarPane(agents, focused)).toBe("");
    expect(selectedSidebarPane(agents, "daemon.a:agent.b")).toBe("daemon.a:agent.b");
  });
});
