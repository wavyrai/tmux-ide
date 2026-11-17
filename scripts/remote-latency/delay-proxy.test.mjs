import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startDelayProxy } from "./delay-proxy.mjs";

async function echoServer(t) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  );
  return server.address().port;
}

async function connect(t, port) {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.destroy());
  return socket;
}

// Sends `payload` and resolves with the ms until all of it has come back.
function roundTrip(socket, payload) {
  return new Promise((resolve) => {
    const started = performance.now();
    const chunks = [];
    let received = 0;
    const onData = (data) => {
      chunks.push(data);
      received += data.length;
      if (received >= payload.length) {
        socket.off("data", onData);
        resolve({ ms: performance.now() - started, data: Buffer.concat(chunks) });
      }
    };
    socket.on("data", onData);
    socket.write(payload);
  });
}

test("a round trip through the proxy takes twice its one-way delay", async (t) => {
  const proxy = await startDelayProxy({ targetPort: await echoServer(t), oneWayDelayMs: 40 });
  t.after(() => proxy.close());
  const socket = await connect(t, proxy.port);
  const times = [];
  for (let i = 0; i < 5; i++) times.push((await roundTrip(socket, Buffer.from(`key ${i}`))).ms);
  for (const ms of times) {
    assert.ok(ms >= 78, `round trip ${ms} ms is at least 2 × 40 ms`);
    assert.ok(ms < 80 + 60, `round trip ${ms} ms adds little beyond the delay`);
  }
  assert.equal(proxy.bytes.up, proxy.bytes.down);
});

test("a bandwidth limit serialises a large transfer at the link rate, in order", async (t) => {
  // 400 KB at 8 Mbit/s is 400 ms on the wire. The echo flows back while the
  // upload is still serialising, so the whole trip costs about one of those.
  const proxy = await startDelayProxy({
    targetPort: await echoServer(t),
    oneWayDelayMs: 5,
    mbit: 8,
  });
  t.after(() => proxy.close());
  const socket = await connect(t, proxy.port);
  const payload = Buffer.alloc(400_000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7919) % 251;
  const { ms, data } = await roundTrip(socket, payload);
  assert.ok(ms >= 390, `400 KB at 8 Mbit/s took ${ms} ms`);
  assert.ok(ms < 1_500, `and not much more (${ms} ms)`);
  assert.ok(data.equals(payload), "bytes arrive complete and in order");
});

test("without a delay the proxy passes data straight through", async (t) => {
  const proxy = await startDelayProxy({ targetPort: await echoServer(t), oneWayDelayMs: 0 });
  t.after(() => proxy.close());
  const socket = await connect(t, proxy.port);
  const { ms, data } = await roundTrip(socket, Buffer.from("hello"));
  assert.equal(data.toString(), "hello");
  assert.ok(ms < 50, `round trip ${ms} ms`);
});
