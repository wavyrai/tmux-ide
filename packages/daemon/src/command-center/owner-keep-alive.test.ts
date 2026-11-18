import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ownerKeepAlive } from "./owner-keep-alive.ts";

const token = "owner-token-for-keep-alive";
const OWNER_IDLE = 30_000;
let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/** A server whose accepted sockets are kept, in order, for their idle bound. */
async function serve(): Promise<{ port: number; accepted: Socket[] }> {
  const app = new Hono();
  app.use("*", ownerKeepAlive(token, OWNER_IDLE));
  app.get("/api/ping", (c) => c.text("pong"));
  server = createServer(getRequestListener(app.fetch));
  // Node closes an idle connection after keepAliveTimeout plus its buffer.
  server.keepAliveTimeout = 100;
  const accepted: Socket[] = [];
  server.on("connection", (socket) => accepted.push(socket));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { port: address.port, accepted };
}

/** One keep-alive request; resolves once the answer arrived. */
async function request(port: number, authorization: string | null, socket?: Socket) {
  const client = socket ?? connect(port, "127.0.0.1");
  if (!socket) await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  const answered = new Promise<void>((resolve) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("pong")) {
        client.off("data", onData);
        resolve();
      }
    };
    client.on("data", onData);
  });
  client.write(
    `GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n${
      authorization ? `Authorization: ${authorization}\r\n` : ""
    }\r\n`,
  );
  await answered;
  // The server's own finish handlers run before the bytes reach the client.
  await new Promise((resolve) => setImmediate(resolve));
  return client;
}

describe("owner keep-alive", () => {
  it("gives an idle owner connection the long bound and every other one Node's", async () => {
    const { port, accepted } = await serve();
    const owner = await request(port, `Bearer ${token}`);
    const anonymous = await request(port, null);
    const wrong = await request(port, "Bearer not-the-owner");
    expect(accepted.map((socket) => socket.timeout)).toEqual([
      OWNER_IDLE,
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(accepted[1]!.timeout).toBeLessThan(5_000);
    expect(accepted[2]!.timeout).toBe(accepted[1]!.timeout);
    for (const socket of [owner, anonymous, wrong]) socket.destroy();
  });

  it("keeps the owner bound for each later owner request on the same connection", async () => {
    const { port, accepted } = await serve();
    const owner = await request(port, `Bearer ${token}`);
    await request(port, `Bearer ${token}`, owner);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.timeout).toBe(OWNER_IDLE);
    owner.destroy();
  });

  it("closes an idle anonymous connection while an owner connection stays open", async () => {
    const { port } = await serve();
    const owner = await request(port, `Bearer ${token}`);
    const anonymous = await request(port, null);
    let ownerClosed = false;
    owner.on("close", () => (ownerClosed = true));
    await new Promise<void>((resolve) => anonymous.once("close", () => resolve()));
    expect(ownerClosed).toBe(false);
    owner.destroy();
  });
});
