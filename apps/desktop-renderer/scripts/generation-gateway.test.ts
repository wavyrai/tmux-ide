import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { startGenerationGateway } from "./generation-gateway.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function daemon(instanceId: string) {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer token-${instanceId}`) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ instanceId }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("daemon did not bind");
  return { port: address.port, instanceId };
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
