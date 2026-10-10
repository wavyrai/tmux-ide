import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  HomeAgentRow,
  HomeAgentSnapshot,
} from "../../../packages/presentation/src/home-agent-roster.ts";
import { homeAgentPublication, agentAvailable, openAgentSchema } from "./home-agent-publication.ts";
const row: HomeAgentRow = {
  key: "session\0agent",
  sessionKey: "session",
  sessionName: "Session",
  liveSessionId: "live-session.aaaaaaaaaaaaaaaaaaaa",
  daemonInstanceId: "generation",
  agentId: "agent",
  paneId: "pane.agent",
  name: "Agent",
  harness: "codex",
  activity: "running",
  attention: false,
  projectName: "Project",
  nativeIdentity: null,
  interactionEndpoint: null,
};
function snapshot(rows: HomeAgentRow[]): HomeAgentSnapshot {
  return {
    phase: "live",
    rows,
    observedSessions: 1,
    totalSessions: 1,
    loadingSessions: 0,
    unavailableSessions: 0,
    truncatedSessions: 0,
    refreshingSessionKeys: [],
    unavailableSessionKeys: [],
    note: null,
  };
}
test("semantic IDs remain exact; paneId alone never grants available navigation", () => {
  const value = homeAgentPublication(snapshot([row]), 1);
  assert.equal(value.rows[0]!.key, row.key);
  assert.equal(value.rows[0]!.available, false);
  assert.equal(value.rows[0]!.status, "WORKING");
  assert.equal(agentAvailable({ ...row, paneId: null }), false);
  assert.throws(() => homeAgentPublication(snapshot([]), 0));
});
test("display controls removed and Unicode truncation preserves codepoints; private fields never published", () => {
  const value = homeAgentPublication(
    {
      ...snapshot([
        { ...row, name: "\u001b" + "😀".repeat(170), sessionName: "\n" + "界".repeat(170) },
      ]),
      note: "\u0000" + "x".repeat(300),
    },
    2,
  );
  assert.equal(Array.from(value.rows[0]!.name).length, 160);
  assert.equal(Array.from(value.rows[0]!.sessionLabel).length, 160);
  assert.equal(value.note!.length, 240);
  assert.equal("nativeIdentity" in value.rows[0]!, false);
  assert.equal("daemonInstanceId" in value.rows[0]!, false);
});
test("bounded ordered rows never sanitize oversized identities into another target", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ ...row, key: String(i) }));
  rows[0] = { ...row, key: "x".repeat(513) };
  const value = homeAgentPublication(snapshot(rows), 3);
  assert.equal(value.rows.length, 256);
  assert.equal(value.rows[0]!.key, "1");
  assert.equal(value.truncatedRows, 44);
  assert.equal(value.rows[255]!.key, "256");
});
test("click wire binds both old request and exact observed revision", () => {
  const command = {
    type: "open-agent",
    request: 2,
    fromRequest: 1,
    rosterRevision: 3,
    key: row.key,
  };
  assert.deepEqual(openAgentSchema.parse(command), command);
  for (const change of [
    { rosterRevision: 0 },
    { fromRequest: -1 },
    { request: 0 },
    { key: "x".repeat(513) },
    { id: "injected" },
  ])
    assert.equal(openAgentSchema.safeParse({ ...command, ...change }).success, false);
});
