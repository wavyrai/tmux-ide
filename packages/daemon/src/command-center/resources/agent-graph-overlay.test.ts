import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GRAPH_MAX_GROUPS,
  AgentGraphOverlaySchemaZ,
  type MissionActor,
} from "@tmux-ide/contracts";
import { MissionRepository, type MissionRepositorySnapshot } from "../../lib/mission-repository.ts";
import {
  initialApplicationShellAppWindows,
  reconcileApplicationShellAppWindows,
} from "../../lib/application-shell-app-windows.ts";
import { stableAppWindowInstanceId } from "../../lib/app-window-state.ts";
import { projectApplicationShellAgentGraphOverlay } from "./agent-graph-overlay.ts";
import type { ApplicationShellSessionFacts } from "./application-shell.ts";

const NOW = 1_000_000;
const UPDATED_AT = "2026-07-22T10:00:00.000Z";
const SESSION_NAME = "product\nworkspace";
const SESSION_DIR = "/Users/example/Product Workspace";
const WORKTREE_PATH = "/Users/example/worktrees/mission-x";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zz-agent-graph-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeAgent {
  readonly runtimePaneId: string;
  readonly semanticPaneId: string;
  readonly name: string;
  readonly state: "working" | "blocked" | "done" | "idle";
  /** Durable `@ide_role` stamp; defaults to "teammate" when unset. */
  readonly role?: string;
  /** Durable `@tmux_ide_mission` stamp; omitted (unstamped) by default. */
  readonly missionStamp?: string;
}

function agentPane(agent: FakeAgent, index: number) {
  return {
    runtimePaneId: agent.runtimePaneId,
    semanticPaneId: agent.semanticPaneId,
    index,
    title: agent.name,
    currentCommand: "claude",
    active: index === 0,
    windowPaneCount: 1,
    role: agent.role ?? "teammate",
    name: agent.name,
    type: "agent" as const,
    missionStamp: agent.missionStamp ?? null,
    agentStateRaw: `${agent.state}:${NOW}`,
    agentScrapeState: null,
  };
}

function fakeSession(agents: readonly FakeAgent[]): ApplicationShellSessionFacts {
  return {
    name: SESSION_NAME,
    runtimeSessionId: "$7",
    dir: SESSION_DIR,
    catalogIssue: null,
    panes: agents.map((agent, index) => agentPane(agent, index)),
  };
}

function appWindowsFor(agents: readonly FakeAgent[]) {
  return initialApplicationShellAppWindows(
    agents.map((agent) => agent.semanticPaneId),
    agents[0]?.semanticPaneId ?? null,
    UPDATED_AT,
  );
}

function windowIdFor(semanticPaneId: string): string {
  return stableAppWindowInstanceId({ kind: "terminal", terminalSourceId: semanticPaneId });
}

/** Build one mission through the real store, one task+attempt per member. */
async function missionWithAttempts(
  members: readonly {
    readonly agent: string;
    readonly terminal: string;
    readonly actor: MissionActor;
  }[],
  title = "Ship the agent graph",
): Promise<MissionRepositorySnapshot> {
  const repository = await MissionRepository.open(scratchDir());
  const user: MissionActor = { type: "user" };
  const mission = repository.create({ title, objective: "objective", actor: user });
  members.forEach((member, index) => {
    const task = repository.addTask({
      missionId: mission.id,
      title: `Task ${index + 1}`,
      actor: user,
    });
    repository.claimTask(mission.id, task.id, member.agent, user);
    repository.startAttempt({
      missionId: mission.id,
      taskId: task.id,
      agent: member.agent,
      harness: "claude-code",
      terminal: member.terminal,
      worktree: WORKTREE_PATH,
      actor: member.actor,
    });
  });
  return repository.snapshot();
}

describe("projectApplicationShellAgentGraphOverlay", () => {
  const PM: FakeAgent = {
    runtimePaneId: "%11",
    semanticPaneId: "pane.pm",
    name: "Fable",
    state: "working",
  };
  const SUB: FakeAgent = {
    runtimePaneId: "%12",
    semanticPaneId: "pane.sub",
    name: "Codex",
    state: "blocked",
  };

  it("keys nodes by durable window ids with the same ground-truth statuses", () => {
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([PM, SUB]),
      appWindows: appWindowsFor([PM, SUB]),
      missionSnapshot: null,
      nowSec: NOW,
    });
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay).success).toBe(true);
    const pmWindow = windowIdFor("pane.pm");
    const subWindow = windowIdFor("pane.sub");
    expect(Object.keys(overlay.nodes).sort()).toEqual([pmWindow, subWindow].sort());
    expect(overlay.nodes[pmWindow]).toMatchObject({
      status: "working",
      statusSource: "authority",
      attention: false,
      label: "Fable",
    });
    expect(overlay.nodes[subWindow]).toMatchObject({
      status: "blocked",
      statusSource: "authority",
      attention: true,
    });
    // No missions -> nodes-only overlay: no groups, no edges.
    expect(overlay.groups).toEqual([]);
    expect(overlay.edges).toEqual([]);
  });

  it("derives one mission group and a spawned edge from two correlated attempts", async () => {
    const snapshot = await missionWithAttempts([
      { agent: "fable", terminal: "%11", actor: { type: "user" } },
      { agent: "codex", terminal: "%12", actor: { type: "agent", id: "fable" } },
    ]);
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([PM, SUB]),
      appWindows: appWindowsFor([PM, SUB]),
      missionSnapshot: snapshot,
      nowSec: NOW,
    });
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay).success).toBe(true);

    const pmWindow = windowIdFor("pane.pm");
    const subWindow = windowIdFor("pane.sub");
    expect(overlay.groups).toHaveLength(1);
    expect(overlay.groups[0]!.label).toBe("Ship the agent graph");
    expect(overlay.groups[0]!.id).toMatch(/^group\.[0-9a-f]{32}$/u);
    expect([...overlay.groups[0]!.memberWindowIds].sort()).toEqual([pmWindow, subWindow].sort());

    // fable ran attempt A; codex's attempt was started by actor agent "fable" -> A spawned B.
    expect(overlay.edges).toEqual([{ from: pmWindow, to: subWindow, kind: "spawned" }]);
  });

  it("falls back to mission co-membership edges when no spawner is derivable", async () => {
    const snapshot = await missionWithAttempts([
      { agent: "fable", terminal: "%11", actor: { type: "user" } },
      { agent: "codex", terminal: "%12", actor: { type: "user" } },
    ]);
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([PM, SUB]),
      appWindows: appWindowsFor([PM, SUB]),
      missionSnapshot: snapshot,
      nowSec: NOW,
    });
    expect(overlay.groups).toHaveLength(1);
    expect(overlay.edges).toHaveLength(1);
    expect(overlay.edges[0]!.kind).toBe("mission");
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay).success).toBe(true);
  });

  it("degrades an uncorrelated attempt to a node without leaking a pane id, session, or path", async () => {
    const snapshot = await missionWithAttempts([
      // Terminal target that matches no discovered pane at all.
      { agent: "ghost", terminal: "%99", actor: { type: "agent", id: "fable" } },
    ]);
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([PM, SUB]),
      appWindows: appWindowsFor([PM, SUB]),
      missionSnapshot: snapshot,
      nowSec: NOW,
    });
    // The attempt correlates to nothing: nodes survive, but no group/edge forms.
    expect(Object.keys(overlay.nodes)).toHaveLength(2);
    expect(overlay.groups).toEqual([]);
    expect(overlay.edges).toEqual([]);

    const wire = JSON.stringify(overlay);
    expect(wire).not.toMatch(/%\d+/u); // no raw tmux pane ids
    expect(wire).not.toContain("product"); // no session name fragment
    expect(wire).not.toContain("workspace");
    expect(wire).not.toContain("/Users/example"); // no path
    expect(wire).not.toContain("mission-x"); // no worktree basename
  });

  it("only correlates AGENT windows, never a plain terminal window", async () => {
    const shellPane = {
      ...agentPane({ ...PM, semanticPaneId: "pane.shell", runtimePaneId: "%30", name: "zsh" }, 0),
      currentCommand: "zsh",
      role: "shell" as const,
      type: null,
      agentStateRaw: null,
    };
    const session: ApplicationShellSessionFacts = {
      name: SESSION_NAME,
      runtimeSessionId: "$7",
      dir: SESSION_DIR,
      catalogIssue: null,
      panes: [shellPane],
    };
    const appWindows = initialApplicationShellAppWindows(["pane.shell"], "pane.shell", UPDATED_AT);
    const snapshot = await missionWithAttempts([
      { agent: "ghost", terminal: "%30", actor: { type: "user" } },
    ]);
    const overlay = projectApplicationShellAgentGraphOverlay({
      session,
      appWindows,
      missionSnapshot: snapshot,
      nowSec: NOW,
    });
    // The shell pane is not an agent -> no node -> the attempt cannot form a group.
    expect(Object.keys(overlay.nodes)).toHaveLength(0);
    expect(overlay.groups).toEqual([]);
  });

  it("derives inferred-role edges from a session lead to each subordinate role", () => {
    const LEAD: FakeAgent = {
      runtimePaneId: "%20",
      semanticPaneId: "pane.lead",
      name: "Lead",
      state: "working",
      role: "lead",
    };
    const PLANNER: FakeAgent = {
      runtimePaneId: "%21",
      semanticPaneId: "pane.planner",
      name: "Planner",
      state: "working",
      role: "planner",
    };
    const TEAMMATE: FakeAgent = {
      runtimePaneId: "%22",
      semanticPaneId: "pane.mate",
      name: "Mate",
      state: "working",
      role: "teammate",
    };
    const agents = [LEAD, PLANNER, TEAMMATE];
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession(agents),
      appWindows: appWindowsFor(agents),
      missionSnapshot: null,
      nowSec: NOW,
    });
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay).success).toBe(true);
    const leadWindow = windowIdFor("pane.lead");
    // No mission -> no groups, but role stamps yield dashed inferred edges.
    expect(overlay.groups).toEqual([]);
    expect(overlay.edges.every((edge) => edge.kind === "inferred-role")).toBe(true);
    expect(overlay.edges.every((edge) => edge.from === leadWindow)).toBe(true);
    expect(overlay.edges.map((edge) => edge.to).sort()).toEqual(
      [windowIdFor("pane.planner"), windowIdFor("pane.mate")].sort(),
    );
  });

  it("infers no edges for a hand-made session with a lead but no subordinates", () => {
    const LEAD: FakeAgent = {
      runtimePaneId: "%20",
      semanticPaneId: "pane.lead",
      name: "Lead",
      state: "working",
      role: "lead",
    };
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([LEAD]),
      appWindows: appWindowsFor([LEAD]),
      missionSnapshot: null,
      nowSec: NOW,
    });
    expect(Object.keys(overlay.nodes)).toHaveLength(1);
    expect(overlay.edges).toEqual([]);
    expect(overlay.groups).toEqual([]);
  });

  it("derives inferred-mission edges from a shared mission stamp without a mission resource", () => {
    const A: FakeAgent = {
      runtimePaneId: "%20",
      semanticPaneId: "pane.a",
      name: "Alpha",
      state: "working",
      role: "teammate",
      missionStamp: "mission.secret-token",
    };
    const B: FakeAgent = {
      runtimePaneId: "%21",
      semanticPaneId: "pane.b",
      name: "Bravo",
      state: "working",
      role: "teammate",
      missionStamp: "mission.secret-token",
    };
    const agents = [A, B];
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession(agents),
      appWindows: appWindowsFor(agents),
      missionSnapshot: null,
      nowSec: NOW,
    });
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay).success).toBe(true);
    // No lead -> no role edges; the shared stamp links the co-members.
    expect(overlay.edges).toHaveLength(1);
    expect(overlay.edges[0]!.kind).toBe("inferred-mission");
    const [aWindow, bWindow] = [windowIdFor("pane.a"), windowIdFor("pane.b")];
    expect([overlay.edges[0]!.from, overlay.edges[0]!.to].sort()).toEqual(
      [aWindow, bWindow].sort(),
    );
    // The opaque stamp value is derivation-only and never crosses the wire.
    expect(JSON.stringify(overlay)).not.toContain("secret-token");
  });

  it("suppresses an inferred-role edge that a ground-truth mission edge already draws", async () => {
    const LEAD: FakeAgent = {
      runtimePaneId: "%11",
      semanticPaneId: "pane.pm",
      name: "Fable",
      state: "working",
      role: "lead",
    };
    const SUBORDINATE: FakeAgent = {
      runtimePaneId: "%12",
      semanticPaneId: "pane.sub",
      name: "Codex",
      state: "working",
      role: "teammate",
    };
    // A real mission whose spawned edge is exactly lead -> subordinate.
    const snapshot = await missionWithAttempts([
      { agent: "fable", terminal: "%11", actor: { type: "user" } },
      { agent: "codex", terminal: "%12", actor: { type: "agent", id: "fable" } },
    ]);
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([LEAD, SUBORDINATE]),
      appWindows: appWindowsFor([LEAD, SUBORDINATE]),
      missionSnapshot: snapshot,
      nowSec: NOW,
    });
    // Ground truth wins: the pair carries only the spawned edge, no inferred twin.
    expect(overlay.edges).toEqual([
      { from: windowIdFor("pane.pm"), to: windowIdFor("pane.sub"), kind: "spawned" },
    ]);
  });

  it("drops an inferred mission already represented by a ground-truth mission group", async () => {
    const A: FakeAgent = {
      runtimePaneId: "%11",
      semanticPaneId: "pane.pm",
      name: "Fable",
      state: "working",
      role: "teammate",
      missionStamp: "mission.shared",
    };
    const B: FakeAgent = {
      runtimePaneId: "%12",
      semanticPaneId: "pane.sub",
      name: "Codex",
      state: "working",
      role: "teammate",
      missionStamp: "mission.shared",
    };
    // Both correlate into one real mission (co-membership, no spawner).
    const snapshot = await missionWithAttempts([
      { agent: "fable", terminal: "%11", actor: { type: "user" } },
      { agent: "codex", terminal: "%12", actor: { type: "user" } },
    ]);
    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession([A, B]),
      appWindows: appWindowsFor([A, B]),
      missionSnapshot: snapshot,
      nowSec: NOW,
    });
    // The ground-truth group covers both windows, so the inferred mission is
    // dropped entirely: exactly one co-membership edge, of the ground-truth kind.
    expect(overlay.groups).toHaveLength(1);
    expect(overlay.edges).toHaveLength(1);
    expect(overlay.edges[0]!.kind).toBe("mission");
  });

  it("caps mission groups with honest truncation", async () => {
    const missionCount = AGENT_GRAPH_MAX_GROUPS + 3;
    const agents: FakeAgent[] = Array.from({ length: missionCount }, (_, i) => ({
      runtimePaneId: `%${100 + i}`,
      semanticPaneId: `pane.n${i}`,
      name: `Agent ${i}`,
      state: "working",
    }));
    // One window per agent, admitting beyond the first-run cap via reconcile.
    let appWindows = initialApplicationShellAppWindows(
      agents.slice(0, 1).map((a) => a.semanticPaneId),
      agents[0]!.semanticPaneId,
      UPDATED_AT,
    );
    appWindows = reconcileApplicationShellAppWindows(
      appWindows,
      agents.map((a) => a.semanticPaneId),
      agents[0]!.semanticPaneId,
      UPDATED_AT,
    );

    // One mission per agent, each with a single correlated attempt.
    const repository = await MissionRepository.open(scratchDir());
    const user: MissionActor = { type: "user" };
    for (let i = 0; i < missionCount; i += 1) {
      const mission = repository.create({ title: `Mission ${i}`, objective: "o", actor: user });
      const task = repository.addTask({ missionId: mission.id, title: "t", actor: user });
      repository.claimTask(mission.id, task.id, `agent-${i}`, user);
      repository.startAttempt({
        missionId: mission.id,
        taskId: task.id,
        agent: `agent-${i}`,
        harness: "claude-code",
        terminal: agents[i]!.runtimePaneId,
        actor: user,
      });
    }

    const overlay = projectApplicationShellAgentGraphOverlay({
      session: fakeSession(agents),
      appWindows,
      missionSnapshot: repository.snapshot(),
      nowSec: NOW,
    });
    expect(overlay.groups).toHaveLength(AGENT_GRAPH_MAX_GROUPS);
    expect(AgentGraphOverlaySchemaZ.safeParse(overlay).success).toBe(true);
  });
});
