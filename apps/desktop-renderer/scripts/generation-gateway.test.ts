import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { createServer, get, type RequestListener, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startGenerationGateway } from "./generation-gateway.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function daemon(instanceId: string, listener?: RequestListener) {
  const server = createServer(
    listener ??
      ((request, response) => {
        if (request.headers.authorization !== `Bearer token-${instanceId}`) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ instanceId }));
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("daemon did not bind");
  return { port: address.port, instanceId, server };
}

describe("generation gateway", () => {
  it("keeps one browser authority while rebinding owner credentials by canonical generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmi-generation-gateway-"));
    chmodSync(root, 0o700);
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const path = join(root, "daemon.json");
    const first = await daemon("11111111-1111-4111-8111-111111111111");
    publish(path, first);
    const gateway = await startGenerationGateway(path, {
      protocolVersion: 1,
      productVersion: "2.8.0",
    });
    cleanup.push(gateway.stop);

    expect(await read(gateway.origin, gateway.bearer)).toEqual({ instanceId: first.instanceId });
    const second = await daemon("22222222-2222-4222-8222-222222222222");
    publish(path, second);
    expect(await read(gateway.origin, gateway.bearer)).toEqual({ instanceId: second.instanceId });
    expect((await fetch(gateway.origin)).status).toBe(401);
  });
});

function publish(path: string, daemon: { port: number; instanceId: string }): void {
  writeFileSync(
    path,
    JSON.stringify({
      pid: process.pid,
      port: daemon.port,
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: daemon.instanceId,
      startedAt: "2026-08-13T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: `token-${daemon.instanceId}`,
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

async function read(origin: string, bearer: string): Promise<unknown> {
  const response = await fetch(origin, { headers: { Authorization: `Bearer ${bearer}` } });
  expect(response.status).toBe(200);
  return response.json();
}

it.each(["upstream", "downstream"] as const)(
  "retires an unfinished event stream when %s disconnects",
  async (side) => {
    const root = await mkdtemp(join(tmpdir(), "tmi-generation-gateway-"));
    chmodSync(root, 0o700);
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    let source: ServerResponse | undefined;
    const target = await daemon("44444444-4444-4444-8444-444444444444", (_request, response) => {
      source = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: ready\n\n");
    });
    const path = join(root, "daemon.json");
    publish(path, target);
    const gateway = await startGenerationGateway(path, {
      protocolVersion: 1,
      productVersion: "2.8.0",
    });
    cleanup.push(gateway.stop);
    const request = get(gateway.origin, {
      headers: { Authorization: `Bearer ${gateway.bearer}` },
    });
    request.on("error", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [response] = await once(request, "response");
      response.on("error", () => {});
      response.resume();
      const peer = source!;
      const bothClosed = Promise.all([
        new Promise<void>((resolve) => response.once("close", resolve)),
        new Promise<void>((resolve) => peer.once("close", resolve)),
      ]);
      if (side === "upstream") peer.destroy();
      else response.destroy();
      await Promise.race([
        bothClosed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("event stream did not retire")), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      request.destroy();
      source?.destroy();
    }
  },
);

it.each(["upstream", "downstream", "gateway"] as const)(
  "retires both upgraded sockets when %s closes",
  async (side) => {
    const root = await mkdtemp(join(tmpdir(), "tmi-generation-gateway-"));
    chmodSync(root, 0o700);
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const target = await daemon("33333333-3333-4333-8333-333333333333");
    const path = join(root, "daemon.json");
    publish(path, target);
    const gateway = await startGenerationGateway(path, {
      protocolVersion: 1,
      productVersion: "2.8.0",
    });
    cleanup.push(gateway.stop);
    let upstream: Duplex | undefined;
    const upgraded = new Promise<Duplex>((resolve) =>
      target.server.once("upgrade", (_request, socket) => {
        upstream = socket;
        socket.on("error", () => {});
        socket.resume();
        socket.once("end", () => socket.end());
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
        );
        resolve(socket);
      }),
    );
    const downstream = connect(Number(new URL(gateway.origin).port), "127.0.0.1");
    downstream.on("error", () => {});
    downstream.resume();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await once(downstream, "connect");
      downstream.write(
        `GET /test HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\nAuthorization: Bearer ${gateway.bearer}\r\n\r\n`,
      );
      const peer = await upgraded;
      const bothClosed = Promise.all(
        [downstream, peer].map(
          (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
        ),
      );
      let stopped: Promise<void> = Promise.resolve();
      if (side === "upstream") peer.destroy();
      else if (side === "downstream") downstream.destroy();
      else stopped = gateway.stop();
      await Promise.race([
        Promise.all([bothClosed, stopped]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("socket pair did not retire")), 1000);
        }),
      ]);
      await gateway.stop();
      await gateway.stop();
    } finally {
      clearTimeout(timer);
      downstream.destroy();
      upstream?.destroy();
    }
  },
);
