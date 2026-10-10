import { test } from "node:test";
import assert from "node:assert/strict";
import { COHESION_FIXTURE_V1, ApplicationShellProjectionInputV2SchemaZ } from "@tmux-ide/contracts";
import { createHomeAgentObserver } from "./home-agents.ts";
const server = {
  serverId: "tmux-server." + "a".repeat(32),
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const session = (n: number) => ({
  id: String(n),
  name: `session-${n}`,
  workspaceName: `workspace-${n}`,
  liveSessionId: `live-session.${n.toString(16).padStart(20, "0")}`,
  server,
});
const shell = () => ({
  server,
  resource: ApplicationShellProjectionInputV2SchemaZ.parse({
    project: COHESION_FIXTURE_V1.project,
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      sidebar: {
        ...COHESION_FIXTURE_V1.workspace.sidebar,
        agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
          ...agent,
          paneId: null,
        })),
      },
    },
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: COHESION_FIXTURE_V1.connection,
    terminalInventory: { activeResourceId: null, resources: [] },
  }),
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("only registered sessions are observed; failures are partial and never invented empty success", async () => {
  const read: string[] = [];
  const owner = createHomeAgentObserver({
    publish() {},
    async readShell(s) {
      read.push(s.id);
      if (s.id === "2") throw Error("private failure");
      return shell();
    },
  });
  owner.refresh([session(1), session(2), { ...session(3), workspaceName: undefined }]);
  assert.equal(owner.getSnapshot().phase, "loading");
  await flush();
  assert.deepEqual(read, ["1", "2"]);
  assert.equal(owner.getSnapshot().phase, "partial");
  assert.equal(owner.getSnapshot().observedSessions, 1);
  assert.equal(owner.getSnapshot().unavailableSessions, 2);
  assert.ok(!JSON.stringify(owner.getSnapshot()).includes("private failure"));
  owner.dispose();
});
test("32 session bound and four actual reads persist across abort-ignoring refreshes", async () => {
  const pending: { resolve: (s: ReturnType<typeof shell>) => void; signal: AbortSignal }[] = [];
  const owner = createHomeAgentObserver({
    publish() {},
    readShell(_s, signal) {
      return new Promise((resolve) => pending.push({ resolve, signal }));
    },
  });
  owner.refresh(Array.from({ length: 35 }, (_, i) => session(i)));
  await flush();
  assert.equal(pending.length, 4);
  assert.equal(owner.getSnapshot().truncatedSessions, 3);
  owner.refresh([session(99)]);
  assert.ok(pending.every((p) => p.signal.aborted));
  await flush();
  assert.equal(pending.length, 4);
  for (const p of pending.slice()) p.resolve(shell());
  await flush();
  assert.equal(pending.length, 5);
  assert.equal(owner.getSnapshot().observedSessions, 0);
  pending[4]!.resolve(shell());
  await flush();
  assert.equal(owner.getSnapshot().observedSessions, 1);
  owner.dispose();
});
test("wrong generation is unavailable; dispose aborts and forbids late publication", async () => {
  let publications = 0;
  let resolve!: (s: ReturnType<typeof shell>) => void;
  let signal!: AbortSignal;
  const owner = createHomeAgentObserver({
    publish() {
      publications++;
    },
    readShell(_s, s) {
      signal = s;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  owner.refresh([session(1)]);
  await flush();
  resolve({
    ...shell(),
    server: { ...server, generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  });
  await flush();
  assert.equal(owner.getSnapshot().phase, "unavailable");
  owner.refresh([session(2)]);
  await flush();
  owner.dispose();
  const before = publications;
  assert.equal(signal.aborted, true);
  resolve(shell());
  await flush();
  assert.equal(publications, before);
  assert.deepEqual(owner.getSnapshot().rows, []);
});

test("refresh clears actual projected rows immediately and detached agents cannot be activated", async () => {
  const owner = createHomeAgentObserver({
    publish() {},
    async readShell() {
      return shell();
    },
  });
  owner.refresh([session(1)]);
  await flush();
  const rows = owner.getSnapshot().rows;
  assert.ok(rows.length > 0);
  assert.equal(rows[0]!.liveSessionId, session(1).liveSessionId);
  assert.equal(owner.isCurrentTarget(rows[0]!), false);
  owner.refresh([]);
  assert.deepEqual(owner.getSnapshot().rows, []);
  assert.equal(owner.getSnapshot().phase, "live");
  owner.dispose();
});

test("attached rows use canonical sorting and current incarnation, never a same-name replacement", async () => {
  const value = shell();
  value.resource.workspace.sidebar.agents = value.resource.workspace.sidebar.agents
    .slice(0, 3)
    .map((agent, index) => ({
      ...agent,
      attention: index === 0,
      activity: index === 0 ? "waiting" : index === 1 ? "running" : "complete",
    }));
  const agent = value.resource.workspace.sidebar.agents[0]!;
  agent.paneId = "pane.worker";
  value.resource.terminalInventory.resources.push({
    id: "pane.worker",
    title: "Worker",
    kind: "agent",
    active: false,
    attachability: { status: "available", semanticPaneId: "pane.worker" },
    interactionEndpoint: null,
    nativeIdentity: null,
  });
  ApplicationShellProjectionInputV2SchemaZ.parse(value.resource);
  const owner = createHomeAgentObserver({
    publish() {},
    async readShell() {
      return value;
    },
  });
  owner.refresh([session(1)]);
  await flush();
  const rows = owner.getSnapshot().rows;
  assert.equal(rows[0]!.activity, "waiting");
  assert.equal(rows[1]!.activity, "running");
  const target = rows.find((row) => row.paneId === "pane.worker")!;
  assert.equal(owner.isCurrentTarget(target), true);
  assert.equal(owner.isCurrentTarget({ ...target, daemonInstanceId: "other" }), false);
  owner.refresh([{ ...session(2), name: session(1).name }]);
  assert.equal(owner.isCurrentTarget(target), false);
  assert.deepEqual(owner.getSnapshot().rows, []);
  await flush();
  assert.equal(owner.isCurrentTarget(target), false);
  owner.dispose();
});
