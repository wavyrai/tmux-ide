import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosePackedEmpty } from "./packed-empty-diagnostics.mjs";
const daemon = {
  pid: 123,
  port: 4567,
  bindHostname: "127.0.0.1",
  authToken: "private-token",
  protocolVersion: 1,
  productVersion: "2.9.0-beta.18",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-09-17T00:00:00.000Z",
};
const peer = Object.fromEntries(
  ["protocolVersion", "productVersion", "instanceId", "startedAt"].map((k) => [k, daemon[k]]),
);
const state = { version: 1, favorites: [], collapsed: [], recent: [], catalog: [] };
test("reports healthy empty catalog and actual private preference write without payload disclosure", async () => {
  const calls = [];
  const result = await diagnosePackedEmpty(daemon, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "error");
      if (url.endsWith("/identity")) {
        assert.equal(init.headers.Authorization, undefined);
        return Response.json({ ...peer, pid: 123 });
      }
      if (url.includes("workspace-catalog"))
        return Response.json({ version: 3, daemon: peer, intents: [], liveSessions: [] });
      return Response.json({ daemon: peer, state });
    },
  });
  assert.equal(result.empty, true);
  assert.equal(result.preferencesWrite, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(calls[3].init.body).change, {
    type: "favorite",
    key: "packed-diagnostic",
    enabled: false,
  });
  assert.equal(JSON.stringify(result).includes("private-token"), false);
});
test("identity mismatch never sends credentials or writes", async () => {
  let calls = 0;
  const result = await diagnosePackedEmpty(daemon, {
    fetch: async (_url, init) => {
      calls++;
      assert.equal(init.headers.Authorization, undefined);
      return Response.json({ ...peer, pid: 999 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.identityMatch, false);
  assert.equal(result.preferencesWrite, false);
});
test("failed persistence is retained as a status rather than mistaken for recovery", async () => {
  const result = await diagnosePackedEmpty(daemon, {
    fetch: async (url, init) => {
      if (url.endsWith("/identity")) return Response.json({ ...peer, pid: 123 });
      if (url.includes("workspace-catalog"))
        return Response.json({ version: 3, daemon: peer, intents: [], liveSessions: [] });
      return init.method === "POST"
        ? Response.json({ secret: "must-not-escape" }, { status: 400 })
        : Response.json({ daemon: peer, state });
    },
  });
  assert.equal(result.preferencesRead, true);
  assert.equal(result.preferencesWrite, false);
  assert.equal(result.preferencesWriteStatus, 400);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
});
