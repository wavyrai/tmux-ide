import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_BRIDGE_PATH,
  REMOTE_BRIDGE_SUBPROTOCOL,
  RemoteBridgeServerFrameSchemaZ,
  type RemoteClipboardEvent,
} from "@tmux-ide/contracts";
import { RemoteClipboardHub } from "../terminal/remote-bridge/clipboard-hub.ts";
import { attachRemoteBridge } from "./remote-bridge-upgrade.ts";

const OWNER = "owner-token";
const write = (paneId: string, text: string): RemoteClipboardEvent => ({
  type: "clipboard.write",
  session: "s",
  paneId,
  incarnation: "g:0",
  bytes: Buffer.byteLength(text),
  text,
});

interface Fixture {
  server: Server;
  port: number;
  hub: RemoteClipboardHub;
  boundary: ReturnType<typeof attachRemoteBridge>;
  current: { value: boolean };
}

const fixtures: Fixture[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const fixture of fixtures.splice(0)) {
    fixture.boundary.close();
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

async function start(
  options: { ownerToken?: string | null; helloTimeoutMs?: number } = {},
): Promise<Fixture> {
  const server = createServer();
  const hub = new RemoteClipboardHub();
  const current = { value: true };
  const boundary = attachRemoteBridge(server, {
    ownerToken: options.ownerToken === undefined ? OWNER : options.ownerToken,
    hub,
    isCurrent: () => current.value,
    ...(options.helloTimeoutMs ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const fixture = { server, port: address.port, hub, boundary, current };
  fixtures.push(fixture);
  return fixture;
}

/** Raw upgrade request: the status line the daemon answers before any WebSocket exists. */
function upgradeStatus(
  port: number,
  headers: Record<string, string | string[]>,
  path = REMOTE_BRIDGE_PATH,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
        ...headers,
      },
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

const good = {
  Authorization: `Bearer ${OWNER}`,
  "Sec-WebSocket-Protocol": REMOTE_BRIDGE_SUBPROTOCOL,
};

async function connect(fixture: Fixture): Promise<{ ws: WebSocket; frames: unknown[] }> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${fixture.port}${REMOTE_BRIDGE_PATH}`,
    REMOTE_BRIDGE_SUBPROTOCOL,
    {
      headers: { Authorization: `Bearer ${OWNER}` },
    },
  );
  sockets.push(ws);
  const frames: unknown[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await once(ws, "open");
  return { ws, frames };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function closeCode(ws: WebSocket): Promise<number> {
  const [code] = (await once(ws, "close")) as [number];
  return code;
}

describe("remote bridge upgrade", () => {
  it("refuses missing, wrong and repeated owner credentials before any WebSocket", async () => {
    const { port } = await start();
    const protocol = { "Sec-WebSocket-Protocol": REMOTE_BRIDGE_SUBPROTOCOL };
    expect(await upgradeStatus(port, protocol)).toBe(403);
    expect(await upgradeStatus(port, { ...protocol, Authorization: "Bearer other" })).toBe(403);
    expect(await upgradeStatus(port, { ...protocol, Authorization: OWNER })).toBe(403);
    expect(
      await upgradeStatus(port, {
        ...protocol,
        Authorization: [`Bearer ${OWNER}`, `Bearer ${OWNER}`],
      }),
    ).toBe(403);
  });

  it("refuses everyone when the daemon holds no owner token", async () => {
    const { port } = await start({ ownerToken: null });
    expect(await upgradeStatus(port, good)).toBe(403);
    expect(await upgradeStatus(port, { ...good, Authorization: "Bearer null" })).toBe(403);
  });

  it("refuses a missing or wrong subprotocol, a query string and a retired generation", async () => {
    const fixture = await start();
    const auth = { Authorization: `Bearer ${OWNER}` };
    expect(await upgradeStatus(fixture.port, auth)).toBe(400);
    expect(await upgradeStatus(fixture.port, { ...auth, "Sec-WebSocket-Protocol": "other" })).toBe(
      400,
    );
    expect(await upgradeStatus(fixture.port, good, `${REMOTE_BRIDGE_PATH}?x=1`)).toBe(400);
    fixture.current.value = false;
    expect(await upgradeStatus(fixture.port, good)).toBe(410);
  });

  it("leaves other paths to their own routes", async () => {
    const { port, server } = await start();
    const seen: string[] = [];
    server.on("upgrade", (req, socket) => {
      if (socket.writable) {
        seen.push(req.url ?? "");
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    });
    expect(await upgradeStatus(port, good, `${REMOTE_BRIDGE_PATH}x`)).toBe(404);
    expect(await upgradeStatus(port, good, "/ws/events")).toBe(404);
    expect(seen).toEqual([`${REMOTE_BRIDGE_PATH}x`, "/ws/events"]);
  });

  it("answers hello with ready and then reports clipboard writes", async () => {
    const fixture = await start();
    const { ws, frames } = await connect(fixture);
    expect(ws.protocol).toBe(REMOTE_BRIDGE_SUBPROTOCOL);
    ws.send(JSON.stringify({ type: "hello", version: 1 }));
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toEqual({ type: "ready", version: 1, features: ["clipboard-write"] });
    fixture.hub.publish(write("p1", "hi"));
    await waitFor(() => frames.length === 2);
    expect(frames[1]).toEqual(write("p1", "hi"));
    for (const frame of frames) expect(RemoteBridgeServerFrameSchemaZ.parse(frame)).toEqual(frame);
  });

  it("sends nothing before hello and does not listen until then", async () => {
    const fixture = await start();
    const { ws, frames } = await connect(fixture);
    fixture.hub.publish(write("p1", "early"));
    expect(fixture.hub.trackedPanes()).toBe(0);
    ws.send(JSON.stringify({ type: "hello", version: 1 }));
    await waitFor(() => frames.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([{ type: "ready", version: 1, features: ["clipboard-write"] }]);
  });

  it("closes with a policy error on a bad first frame, a binary frame or a second hello", async () => {
    const fixture = await start();
    for (const send of [
      (ws: WebSocket) => ws.send("{}"),
      (ws: WebSocket) => ws.send("not json"),
      (ws: WebSocket) => ws.send(JSON.stringify({ type: "hello", version: 2 })),
      (ws: WebSocket) => ws.send(Buffer.from([1, 2]), { binary: true }),
      (ws: WebSocket) => {
        ws.send(JSON.stringify({ type: "hello", version: 1 }));
        ws.send(JSON.stringify({ type: "hello", version: 1 }));
      },
    ]) {
      const { ws } = await connect(fixture);
      const closed = closeCode(ws);
      send(ws);
      expect(await closed).toBe(1008);
    }
  });

  it("closes an oversized client frame", async () => {
    const fixture = await start();
    const { ws } = await connect(fixture);
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ type: "hello", version: 1, pad: "x".repeat(8192) }));
    expect(await closed).toBe(1009);
  });

  it("closes a connection that never says hello", async () => {
    const fixture = await start({ helloTimeoutMs: 50 });
    const { ws } = await connect(fixture);
    expect(await closeCode(ws)).toBe(1008);
  });

  it("stops listening when the app goes away", async () => {
    const fixture = await start();
    const { ws, frames } = await connect(fixture);
    ws.send(JSON.stringify({ type: "hello", version: 1 }));
    await waitFor(() => frames.length === 1);
    fixture.hub.publish(write("p1", "a"));
    expect(fixture.hub.trackedPanes()).toBe(1);
    ws.close();
    await once(ws, "close");
    await waitFor(() => {
      fixture.hub.publish(write("p2", "b"));
      return fixture.hub.trackedPanes() === 0;
    });
  });

  it("reports to every connected app", async () => {
    const fixture = await start();
    const a = await connect(fixture);
    const b = await connect(fixture);
    for (const { ws } of [a, b]) ws.send(JSON.stringify({ type: "hello", version: 1 }));
    await waitFor(() => a.frames.length === 1 && b.frames.length === 1);
    fixture.hub.publish(write("p1", "both"));
    await waitFor(() => a.frames.length === 2 && b.frames.length === 2);
  });

  it("closes open bridges as going away when the daemon closes the boundary", async () => {
    const fixture = await start();
    const { ws, frames } = await connect(fixture);
    ws.send(JSON.stringify({ type: "hello", version: 1 }));
    await waitFor(() => frames.length === 1);
    const closed = closeCode(ws);
    fixture.boundary.close();
    expect(await closed).toBe(1001);
  });

  it("drops a report rather than queue past the send budget", async () => {
    const fixture = await start();
    const { ws, frames } = await connect(fixture);
    ws.send(JSON.stringify({ type: "hello", version: 1 }));
    await waitFor(() => frames.length === 1);
    ws.pause();
    const big = "y".repeat(1024 * 1024);
    for (let i = 0; i < 64; i += 1) fixture.hub.publish(write(`p${i}`, big));
    expect(fixture.boundary.stats().dropped).toBeGreaterThan(0);
    ws.resume();
  });
});
