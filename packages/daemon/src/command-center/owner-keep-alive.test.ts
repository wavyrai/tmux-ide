import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ownerKeepAlive } from "./owner-keep-alive.ts";

const token = "owner-token-for-keep-alive";
let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function serve(): Promise<number> {
  const app = new Hono();
  app.use("*", ownerKeepAlive(token, 4_000));
  app.get("/api/ping", (c) => c.text("pong"));
  server = createServer(getRequestListener(app.fetch));
  // Node closes an idle connection after keepAliveTimeout plus its 1 s buffer.
  server.keepAliveTimeout = 100;
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

/** One keep-alive request; resolves with the socket and when it closed. */
async function request(port: number, authorization: string | null) {
  const socket: Socket = connect(port, "127.0.0.1");
  let closedAt: number | null = null;
  socket.on("close", () => (closedAt = Date.now()));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const answered = new Promise<void>((resolve) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes("pong")) resolve();
    });
  });
  socket.write(
    `GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n${
      authorization ? `Authorization: ${authorization}\r\n` : ""
    }\r\n`,
  );
  await answered;
  return { socket, closed: () => closedAt };
}

describe("owner keep-alive", () => {
  it("keeps an idle owner connection open past Node's bound; others close as before", async () => {
    const port = await serve();
    const owner = await request(port, `Bearer ${token}`);
    const anonymous = await request(port, null);
    const wrong = await request(port, "Bearer not-the-owner");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(anonymous.closed()).not.toBeNull();
    expect(wrong.closed()).not.toBeNull();
    expect(owner.closed()).toBeNull();
    owner.socket.destroy();
  });

  it("lets the next request on the same owner connection succeed after the pause", async () => {
    const port = await serve();
    const owner = await request(port, `Bearer ${token}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const again = new Promise<void>((resolve) => {
      let text = "";
      owner.socket.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("pong")) resolve();
      });
    });
    owner.socket.write(
      `GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    await again;
    expect(owner.closed()).toBeNull();
    owner.socket.destroy();
  });
});
