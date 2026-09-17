import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { diagnosePackedHome } from "./packed-home-diagnostics.mjs";
const daemon = {
  pid: 123,
  port: 4567,
  bindHostname: "127.0.0.1",
  authToken: "never-print-this",
  protocolVersion: 1,
  productVersion: "2.9.0-beta.18",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-09-17T00:00:00.000Z",
};
const peer = Object.fromEntries(
  ["protocolVersion", "productVersion", "instanceId", "startedAt"].map((key) => [key, daemon[key]]),
);
const catalog = {
  version: 3,
  daemon: peer,
  intents: [
    {
      workspaceName: "different-workspace",
      sessionName: "session",
      source: "workspace",
      availability: "live",
    },
  ],
  liveSessions: [
    {
      sessionName: "session",
      paneCount: 1,
      fleetSessionId: "session.11111111111111111111",
      liveSessionId: "live-session.11111111111111111111",
    },
  ],
};
class Socket extends EventEmitter {
  constructor(unavailable = []) {
    super();
    this.unavailable = unavailable;
    queueMicrotask(() =>
      this.emit(
        "message",
        JSON.stringify({ type: "hello", daemon: peer, sessions: [], eventSequence: 0 }),
      ),
    );
  }
  send(value) {
    this.sent = JSON.parse(value);
    queueMicrotask(() =>
      this.emit(
        "message",
        JSON.stringify({
          type: "resource.interests-ack",
          interestRevision: 1,
          sequence: 0,
          unavailableInterests: this.unavailable,
        }),
      ),
    );
  }
  terminate() {
    this.terminated = true;
    this.emit("close");
  }
}
test("reports exact session routing, HTTP/schema failure and independent interest acknowledgement", async () => {
  const paths = [];
  let socket;
  const unavailable = [{ resource: "application-shell", workspaceName: "different-workspace" }];
  const result = await diagnosePackedHome(daemon, "session", {
    createSocket: () => (socket = new Socket(unavailable)),
    fetch: async (url, init) => {
      paths.push(new URL(url).pathname + new URL(url).search);
      if (paths.length === 1) {
        assert.equal(init.headers.Authorization, undefined);
        return Response.json({ ...peer, pid: daemon.pid });
      }
      assert.equal(init.headers.Authorization, `Bearer ${daemon.authToken}`);
      return url.includes("application-shell")
        ? Response.json({ error: "private-data-never-print" }, { status: 503 })
        : Response.json(catalog);
    },
  });
  assert.equal(result.identityMatch, true);
  assert.equal(result.catalog.matchingIntents, 1);
  assert.equal(result.shell.status, 503);
  assert.equal(result.shell.valid, false);
  assert.equal(result.catalogAfter.sameIncarnation, true);
  assert.deepEqual(result.events, { outcome: "ack", unavailableResources: ["application-shell"] });
  assert.equal(result.socketClosed, true);
  assert.equal(socket.terminated, true);
  assert.ok(paths.includes("/api/project/session/application-shell?version=2"));
  assert.equal(JSON.stringify(result).includes("private-data"), false);
  assert.equal(JSON.stringify(result).includes(daemon.authToken), false);
});
test("identity mismatch never sends owner credentials or opens an event socket", async () => {
  let reads = 0;
  const result = await diagnosePackedHome(daemon, "session", {
    createSocket: () => {
      throw Error("must not connect");
    },
    fetch: async (_url, init) => {
      reads++;
      assert.equal(init.headers.Authorization, undefined);
      return Response.json({ ...peer, pid: 999 });
    },
  });
  assert.equal(result.identityMatch, false);
  assert.equal(reads, 1);
});
test("same-name replacement is distinguished from schema errors", async () => {
  let catalogs = 0;
  const result = await diagnosePackedHome(daemon, "session", {
    createSocket: () => new Socket(),
    fetch: async (url) =>
      Response.json(
        url.endsWith("/identity")
          ? { ...peer, pid: 123 }
          : url.includes("application-shell")
            ? {}
            : {
                ...catalog,
                liveSessions: catalog.liveSessions.map((row) => ({
                  ...row,
                  liveSessionId:
                    ++catalogs === 1 ? row.liveSessionId : "live-session.22222222222222222222",
                })),
              },
      ),
  });
  assert.equal(result.catalogAfter.sameIncarnation, false);
});

test("counts duplicate session intents and settles a rejected subscription send", async () => {
  class RefusedSocket extends Socket {
    send() {
      throw new Error("private-transport-error");
    }
  }
  const result = await diagnosePackedHome(daemon, "session", {
    createSocket: () => new RefusedSocket(),
    fetch: async (url) =>
      Response.json(
        url.endsWith("/identity")
          ? { ...peer, pid: 123 }
          : url.includes("application-shell")
            ? {}
            : {
                ...catalog,
                intents: [
                  ...catalog.intents,
                  { ...catalog.intents[0], workspaceName: "second-private-name" },
                ],
              },
      ),
  });
  assert.equal(result.catalog.matchingIntents, 2);
  assert.equal(result.events.outcome, "send-error");
  assert.equal(result.socketClosed, true);
  assert.equal(JSON.stringify(result).includes("second-private-name"), false);
});
