import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHostedLiveSession } from "./hosted-live-session.ts";
import { createHostedCommandQueue } from "./hosted-command-queue.ts";
import type { HostedLiveEvent } from "./hosted-live-types.ts";

const config = {
  baseUrl: "http://127.0.0.1:1/",
  ownerToken: "private-fixture",
  scope: {
    serverId: "tmux-server." + "a".repeat(32),
    generation: "12345678-1234-4123-8123-123456789abc",
  },
  workspaceName: "fixture",
  liveSessionId: "fixture-session",
  semanticPaneId: "pane",
};
test("bounded typed command queue drains orderly EOF and cancels blocked admission", async () => {
  const queue = createHostedCommandQueue(2, 100);
  queue.send({ n: 1 });
  queue.send({ n: 2 });
  let admitted = false;
  const third = queue.admit({ n: 3 }).then(() => {
    admitted = true;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, { n: 1 });
  await third;
  queue.end();
  const rest = [];
  for await (const value of iterator) rest.push(value);
  assert.deepEqual(rest, [{ n: 2 }, { n: 3 }]);
  assert.equal(queue.pendingBytes, 0);
  assert.throws(() => queue.send({ n: 4 }), /closed/);
  const blocked = createHostedCommandQueue(1, 100);
  blocked.send(1);
  const pending = assert.rejects(blocked.admit(2), /closed/);
  blocked.close();
  await pending;
  assert.equal((await blocked[Symbol.asyncIterator]().next()).done, true);
});
test("retiring during actual capability HTTP issuance cancels only the owned session", async () => {
  const requests: Promise<void>[] = [];
  const server = createServer((request, _response) => {
    requests.push(new Promise((resolve) => request.socket.once("close", () => resolve())));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const signals = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  const events: HostedLiveEvent[] = [];
  let closed = 0;
  const requested = once(server, "request");
  const session = createHostedLiveSession({
    config: { ...config, baseUrl: `http://127.0.0.1:${address.port}/` },
    mode: "interactive",
    emit: (event) => {
      events.push(event);
    },
    close: () => {
      closed++;
    },
  });
  try {
    await requested;
    await session.dispose();
    await Promise.race([
      Promise.all(requests),
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("HTTP cancellation deadline")), 1000).unref(),
      ),
    ]);
    assert.equal(closed, 1);
    assert.equal(events.length, 1);
    assert.ok(events[0] && "connection" in events[0]);
    assert.equal(events[0].inputReady, false);
    assert.equal(events[0].snapshot, null);
    assert.throws(() => session.send({ kind: "key", key: "x" }), /retired/);
    await session.dispose();
    assert.equal(closed, 1);
    assert.deepEqual([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")], signals);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
test("pre-aborted sessions do not connect; throw in publication is contained", async () => {
  const abort = new AbortController();
  abort.abort();
  let closed = 0;
  const session = createHostedLiveSession({
    config,
    mode: "interactive",
    signal: abort.signal,
    emit: () => {
      throw Error("renderer failure");
    },
    close: () => {
      closed++;
    },
  });
  await session.done;
  assert.equal(session.failed, true);
  assert.equal(closed, 1);
  assert.throws(() => session.send({}), /retired/);
  const other = createHostedLiveSession({
    config,
    mode: "interactive",
    signal: abort.signal,
    emit: () => {},
  });
  await other.done;
  assert.equal(other.failed, false);
});
