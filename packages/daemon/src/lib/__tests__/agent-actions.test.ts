import { describe, expect, it } from "vitest";
import type { AgentRecord } from "@tmux-ide/contracts";
import { AgentListSchemaZ } from "@tmux-ide/contracts";
import {
  aggregateHqAgents,
  ExternalAgentRegistry,
  mergeLocalAgents,
  type RemoteAgentSource,
} from "../agent-registry.ts";
import {
  agentHeartbeatHandler,
  agentRegisterHandler,
  agentUnregisterHandler,
} from "../../command-center/actions/handlers/agent-actions.ts";

// ---------------------------------------------------------------------------
// Action handlers — mutate the injected ExternalAgentRegistry.
// ---------------------------------------------------------------------------

describe("agent action handlers", () => {
  it("register adds an agent observable via list()", () => {
    const registry = new ExternalAgentRegistry();
    const result = agentRegisterHandler(
      { id: "sess-1", tool: "claude", name: "Laptop", cwd: "/w" },
      { registry },
    );
    expect(result).toEqual({ ok: true });
    expect(registry.list().map((a) => a.id)).toEqual(["sess-1"]);
  });

  it("heartbeat reports known=true for a registered agent, false otherwise", () => {
    const registry = new ExternalAgentRegistry();
    agentRegisterHandler({ id: "sess-1", tool: "claude" }, { registry });

    expect(agentHeartbeatHandler({ id: "sess-1", status: "busy" }, { registry })).toEqual({
      ok: true,
      known: true,
    });
    expect(registry.list()[0]!.status).toBe("busy");

    expect(agentHeartbeatHandler({ id: "ghost" }, { registry })).toEqual({
      ok: true,
      known: false,
    });
  });

  it("unregister removes the agent and reports removed", () => {
    const registry = new ExternalAgentRegistry();
    agentRegisterHandler({ id: "sess-1", tool: "claude" }, { registry });

    expect(agentUnregisterHandler({ id: "sess-1" }, { registry })).toEqual({
      ok: true,
      removed: true,
    });
    expect(registry.list()).toHaveLength(0);
    expect(agentUnregisterHandler({ id: "sess-1" }, { registry })).toEqual({
      ok: true,
      removed: false,
    });
  });
});

// ---------------------------------------------------------------------------
// HQ aggregation — the pure stamping/namespacing the /api/hq/agents route
// applies after fanning out to remotes (the route owns fetch/timeout/skip;
// errored machines simply never appear in `remotes`).
// ---------------------------------------------------------------------------

function makeAgent(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    kind: "external",
    tool: "claude",
    name: id,
    status: "idle",
    session: null,
    paneId: null,
    paneTitle: null,
    cwd: null,
    taskId: null,
    taskTitle: null,
    pid: null,
    lastActivity: new Date(0).toISOString(),
    machineId: null,
    machineName: null,
    ...overrides,
  };
}

describe("aggregateHqAgents", () => {
  it("stamps local agents with the self machine name and null machineId", () => {
    const out = aggregateHqAgents([makeAgent("local-1")], "this-host", []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "local-1", machineId: null, machineName: "this-host" });
  });

  it("namespaces remote ids and stamps remote machine id + name", () => {
    const remotes: RemoteAgentSource[] = [
      {
        machineId: "machine-A",
        machineName: "build-box",
        agents: [makeAgent("remote-x"), makeAgent("remote-y")],
      },
    ];
    const out = aggregateHqAgents([makeAgent("local-1")], "this-host", remotes);

    expect(out.map((a) => a.id)).toEqual(["local-1", "machine-A:remote-x", "machine-A:remote-y"]);
    const remote = out.find((a) => a.id === "machine-A:remote-x")!;
    expect(remote).toMatchObject({ machineId: "machine-A", machineName: "build-box" });
    // Output conforms to the shared contract.
    expect(AgentListSchemaZ.safeParse({ agents: out }).success).toBe(true);
  });

  it("returns only local agents when no remotes are reachable", () => {
    const out = aggregateHqAgents([makeAgent("local-1")], "this-host", []);
    expect(out.map((a) => a.id)).toEqual(["local-1"]);
  });
});

// ---------------------------------------------------------------------------
// mergeLocalAgents — what GET /api/agents returns (tmux + external, pid-dedup).
// ---------------------------------------------------------------------------

describe("mergeLocalAgents in the GET /api/agents path", () => {
  it("drops an external agent whose pid is already visible as a tmux pane", () => {
    const tmux = [makeAgent("sess:%1", { kind: "managed", pid: 1234 })];
    const external = [
      makeAgent("hook-a", { pid: 1234 }), // duplicate of the tmux pane
      makeAgent("hook-b", { pid: 5678 }), // genuinely external
    ];
    const merged = mergeLocalAgents(tmux, external);
    expect(merged.map((a) => a.id)).toEqual(["sess:%1", "hook-b"]);
    expect(AgentListSchemaZ.safeParse({ agents: merged }).success).toBe(true);
  });
});
