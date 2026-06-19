import { describe, it, expect } from "vitest";
import type { AgentRecord } from "@tmux-ide/contracts";
import { ExternalAgentRegistry, aggregateHqAgents, mergeLocalAgents } from "../agent-registry.ts";

describe("ExternalAgentRegistry", () => {
  it("registers and lists an external agent as idle", () => {
    const reg = new ExternalAgentRegistry();
    reg.register({ id: "sess-1", tool: "claude", name: "Laptop Claude", cwd: "/w" }, 1000);
    const agents = reg.list(1000);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: "sess-1", kind: "external", status: "idle", cwd: "/w" });
  });

  it("heartbeat updates status and refreshes lastSeen", () => {
    const reg = new ExternalAgentRegistry({ offlineAfterMs: 1000 });
    reg.register({ id: "a", tool: "claude" }, 0);
    expect(reg.heartbeat({ id: "a", status: "busy" }, 1500)).toBe(true);
    expect(reg.list(1500)[0]!.status).toBe("busy");
  });

  it("heartbeat for unknown id returns false", () => {
    const reg = new ExternalAgentRegistry();
    expect(reg.heartbeat({ id: "ghost" }, 0)).toBe(false);
  });

  it("marks agents offline past the offline window", () => {
    const reg = new ExternalAgentRegistry({ offlineAfterMs: 1000 });
    reg.register({ id: "a", tool: "claude", status: "busy" }, 0);
    expect(reg.list(500)[0]!.status).toBe("busy");
    expect(reg.list(2000)[0]!.status).toBe("offline");
  });

  it("evicts agents past the eviction window", () => {
    const reg = new ExternalAgentRegistry({ evictAfterMs: 1000 });
    reg.register({ id: "a", tool: "claude" }, 0);
    expect(reg.list(2000)).toHaveLength(0);
  });

  it("unregister removes an agent", () => {
    const reg = new ExternalAgentRegistry();
    reg.register({ id: "a", tool: "claude" }, 0);
    expect(reg.unregister("a")).toBe(true);
    expect(reg.list(0)).toHaveLength(0);
  });
});

describe("mergeLocalAgents", () => {
  const tmuxAgent: AgentRecord = {
    id: "s:%1",
    kind: "managed",
    tool: "claude",
    name: "François",
    status: "idle",
    session: "s",
    paneId: "%1",
    paneTitle: "Claude Code",
    cwd: "/w",
    taskId: null,
    taskTitle: null,
    pid: 4242,
    lastActivity: "2026-01-01T00:00:00.000Z",
    machineId: null,
    machineName: null,
  };
  const externalDupe: AgentRecord = { ...tmuxAgent, id: "ext", kind: "external", paneId: null };
  const externalOther: AgentRecord = { ...externalDupe, id: "ext2", pid: 9999 };

  it("drops external agents that share a pid with a tmux pane", () => {
    const merged = mergeLocalAgents([tmuxAgent], [externalDupe]);
    expect(merged.map((a) => a.id)).toEqual(["s:%1"]);
  });

  it("keeps external agents with distinct or null pids", () => {
    const merged = mergeLocalAgents([tmuxAgent], [externalOther, { ...externalDupe, pid: null }]);
    expect(merged).toHaveLength(3);
  });
});

describe("ExternalAgentRegistry maxEntries cap", () => {
  it("evicts the least-recently-seen entry when full", () => {
    const reg = new ExternalAgentRegistry({ maxEntries: 2 });
    reg.register({ id: "a", tool: "claude" }, 100);
    reg.register({ id: "b", tool: "claude" }, 200);
    reg.register({ id: "c", tool: "claude" }, 300); // overflow → evicts "a"
    const ids = reg
      .list(300)
      .map((x) => x.id)
      .sort();
    expect(ids).toEqual(["b", "c"]);
  });

  it("re-registering an existing id does not trigger eviction", () => {
    const reg = new ExternalAgentRegistry({ maxEntries: 2 });
    reg.register({ id: "a", tool: "claude" }, 100);
    reg.register({ id: "b", tool: "claude" }, 200);
    reg.register({ id: "a", tool: "claude", status: "busy" }, 300); // update, not new
    expect(reg.list(300)).toHaveLength(2);
  });
});

describe("aggregateHqAgents", () => {
  const remoteAgent: AgentRecord = {
    id: "proj:%1",
    kind: "managed",
    tool: "claude",
    name: "René",
    status: "busy",
    session: "proj",
    paneId: "%1",
    paneTitle: "Claude Code",
    cwd: "/srv/proj",
    taskId: null,
    taskTitle: null,
    pid: 7,
    lastActivity: "2026-01-01T00:00:00.000Z",
    machineId: null,
    machineName: null,
  };
  const localAgent: AgentRecord = { ...remoteAgent, id: "local:%9", name: "François" };

  it("stamps local agents with self name and namespaces remote ids", () => {
    const out = aggregateHqAgents([localAgent], "laptop", [
      { machineId: "m1", machineName: "box-a", agents: [remoteAgent] },
    ]);
    expect(out[0]).toMatchObject({ machineName: "laptop", machineId: null, id: "local:%9" });
    expect(out[1]).toMatchObject({ machineName: "box-a", machineId: "m1", id: "m1:proj:%1" });
  });

  it("strips control chars from untrusted remote display fields", () => {
    const esc = String.fromCharCode(27); // ESC (terminal escape lead-in)
    const del = String.fromCharCode(127); // DEL
    const hostile: AgentRecord = {
      ...remoteAgent,
      name: `evil${esc}[2Jname`,
      cwd: `/x${del}/y`,
    };
    const out = aggregateHqAgents([], "laptop", [
      { machineId: "m1", machineName: "box-a", agents: [hostile] },
    ]);
    expect(out[0]!.name).toBe("evil[2Jname");
    expect(out[0]!.cwd).toBe("/x/y");
  });
});
