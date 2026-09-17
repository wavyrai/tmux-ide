import { afterEach, describe, expect, it } from "vitest";
import { Agent, createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { createSshDaemonRelay, type SshDaemonRelay } from "./ssh-daemon-relay.ts";

const identity = {
  ok: true as const,
  pid: 12345,
  protocolVersion: 2 as const,
  productVersion: "2.9.0-beta.18",
  instanceId: "12345678-1234-4234-8234-123456789abc",
  startedAt: "2026-09-17T12:00:00.000Z",
};
const cleanups: Array<() => Promise<void>> = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("test deadline")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
};
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  expect(results.every((result) => result.status === "fulfilled")).toBe(true);
});
async function peer(
  options: {
    port?: number;
    identity?: typeof identity;
    onIdentity?: (req: IncomingMessage, res: ServerResponse) => void;
  } = {},
) {
  const sockets = new Set<Socket>();
  const facts = { identity: 0, credentials: 0, requests: 0, upgrades: 0, bodies: [] as string[] };
  const ws = new WebSocketServer({ noServer: true });
  const hasCredential = (req: IncomingMessage) =>
    !!(req.headers.authorization || req.headers.cookie || req.url?.includes("token="));
  const server = createServer((req, res) => {
    if (hasCredential(req)) facts.credentials++;
    if (req.url === "/identity") {
      facts.identity++;
      if (options.onIdentity) options.onIdentity(req, res);
      else res.end(JSON.stringify(options.identity ?? identity));
      return;
    }
    facts.requests++;
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: alive\n\n");
      return;
    }
    let body = "";
    req.on("data", (bytes) => (body += bytes.toString()));
    req.on("end", () => {
      facts.bodies.push(body);
      res.end("ready");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("upgrade", (req, socket, head) => {
    facts.upgrades++;
    if (hasCredential(req)) facts.credentials++;
    ws.handleUpgrade(req, socket, head, (client) => {
      client.on("message", (bytes, binary) => client.send(bytes, { binary }));
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("invalid fixture");
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const gone = [...sockets].map((socket) => once(socket, "close"));
      for (const socket of sockets) socket.destroy();
      await bounded(
        Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), ...gone]),
      );
    })());
  cleanups.push(close);
  return { port: address.port, facts, close };
}
async function relay(
  port: number,
  extra: Partial<Parameters<typeof createSshDaemonRelay>[0]> = {},
) {
  const result = await createSshDaemonRelay({ upstreamPort: port, expected: identity, ...extra });
  cleanups.push(async () => {
    result.dispose();
    await bounded(result.closed);
  });
  return result;
}
async function call(
  target: SshDaemonRelay,
  path = "/body",
  agent: Agent | false = false,
  body = "payload",
) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      target.baseUrl + path,
      {
        method: "POST",
        agent,
        headers: { Authorization: "Bearer synthetic-secret", Cookie: "owner=synthetic-cookie" },
        signal: AbortSignal.timeout(1500),
      },
      (res) => {
        let text = "";
        res.on("data", (bytes) => (text += bytes.toString()));
        res.on("error", reject);
        res.once("end", () => resolve({ status: res.statusCode!, body: text }));
      },
    );
    req.once("error", reject);
    req.write(body.slice(0, 2));
    req.end(body.slice(2));
  });
}

describe("identity-bound SSH relay", () => {
  it("streams keepalive bodies and real WebSocket frames with one identity exchange per TCP", async () => {
    const upstream = await peer(),
      owned = await relay(upstream.port);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(async () => agent.destroy());
    expect((await call(owned, "/body", agent, "first-body")).body).toBe("ready");
    expect((await call(owned, "/body", agent, "second-body")).body).toBe("ready");
    expect(upstream.facts.identity).toBe(1);
    const client = new WebSocket(owned.baseUrl.replace("http:", "ws:") + "/ws", {
      headers: { Authorization: "Bearer synthetic-secret", Cookie: "owner=synthetic-cookie" },
    });
    cleanups.push(async () => {
      if (client.readyState !== WebSocket.CLOSED) {
        const closed = once(client, "close");
        client.terminate();
        await bounded(closed);
      }
    });
    await bounded(once(client, "open"));
    for (const marker of ["first-frame", "second-frame"]) {
      const response = once(client, "message");
      client.send(marker);
      expect((await bounded(response))[0].toString()).toBe(marker);
    }
    expect(upstream.facts.identity).toBe(2);
    expect(upstream.facts.credentials).toBe(3);
    expect(upstream.facts.bodies).toEqual(["first-body", "second-body"]);
  });

  it.each(["http", "websocket"] as const)(
    "never forwards retained credentials when %s first reaches a rebound upstream port",
    async (kind) => {
      const original = await peer(),
        owned = await relay(original.port);
      expect((await call(owned)).status).toBe(200);
      await original.close();
      const trap = await peer({
        port: original.port,
        identity: { ...identity, instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      });
      if (kind === "http") {
        await call(
          owned,
          "/issue?token=synthetic-stream-token",
          false,
          "ownerToken=synthetic-body-token",
        ).catch(() => null);
      } else {
        const client = new WebSocket(
          owned.baseUrl.replace("http:", "ws:") + "/ws?token=synthetic-stream-token",
          {
            headers: { Authorization: "Bearer synthetic-secret", Cookie: "owner=synthetic-cookie" },
            handshakeTimeout: 1500,
          },
        );
        client.on("error", () => {});
        const gone = new Promise<void>((resolve) => client.once("close", () => resolve()));
        cleanups.push(async () => {
          if (client.readyState !== WebSocket.CLOSED) client.terminate();
          await bounded(gone);
        });
        await bounded(gone);
      }
      await bounded(owned.closed);
      expect(trap.facts.identity).toBe(1);
      expect(trap.facts.credentials).toBe(0);
      expect(trap.facts.requests).toBe(0);
      expect(trap.facts.upgrades).toBe(0);
      expect(trap.facts.bodies).toEqual([]);
    },
  );

  it("does not redial between a successful public response and the authenticated request", async () => {
    let ended!: () => void;
    const responseSent = new Promise<void>((resolve) => (ended = resolve));
    const original = await peer({
      onIdentity(req, res) {
        res.once("finish", () => {
          req.socket.destroy();
          ended();
        });
        res.end(JSON.stringify(identity));
      },
    });
    const owned = await relay(original.port);
    const pending = call(owned).catch(() => null);
    await bounded(responseSent);
    await original.close();
    const trap = await peer({ port: original.port });
    await pending;
    expect(original.facts.credentials).toBe(0);
    expect(trap.facts.credentials).toBe(0);
    expect(trap.facts.requests).toBe(0);
  });

  for (const mode of ["close", "extra", "oversize", "invalid"] as const) {
    it(`rejects ${mode} identity responses without forwarding headers or request bodies`, async () => {
      const upstream = await peer({
        onIdentity(req, res) {
          const body = JSON.stringify(identity);
          if (mode === "close") {
            res.setHeader("connection", "close");
            res.end(body);
          } else if (mode === "extra")
            req.socket.write(
              `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}EXTRA`,
            );
          else res.end(mode === "oversize" ? "x".repeat(33000) : "{}");
        },
      });
      const owned = await relay(upstream.port);
      await call(owned).catch(() => null);
      expect(upstream.facts.credentials).toBe(0);
      expect(upstream.facts.bodies).toEqual([]);
    });
  }

  it("streams SSE and cancels a downstream consumer without retiring the healthy authority", async () => {
    const upstream = await peer(),
      owned = await relay(upstream.port);
    const abort = new AbortController();
    const response = await fetch(owned.baseUrl + "/events", {
      headers: { Authorization: "Bearer synthetic-secret", Cookie: "owner=synthetic-cookie" },
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: alive\n\n");
    abort.abort();
    await reader.cancel().catch(() => {});
    expect((await call(owned)).status).toBe(200);
  });

  it("caps pending identity admissions separately and disposes stalled sockets", async () => {
    const upstream = await peer({ onIdentity() {} }),
      owned = await relay(upstream.port, { maxPending: 1, probeTimeoutMs: 1000 });
    const first = call(owned).catch(() => null);
    for (let n = 0; n < 100 && upstream.facts.identity === 0; n++) await delay(5);
    expect((await call(owned)).status).toBe(503);
    expect(upstream.facts.identity).toBe(1);
    owned.dispose();
    await bounded(owned.closed);
    await first;
  });

  it("rejects cancellation before and during listener initialization", async () => {
    const upstream = await peer();
    const aborted = AbortSignal.abort();
    await expect(
      createSshDaemonRelay({ upstreamPort: upstream.port, expected: identity, signal: aborted }),
    ).rejects.toThrow();
    const controller = new AbortController();
    const starting = createSshDaemonRelay({
      upstreamPort: upstream.port,
      expected: identity,
      signal: controller.signal,
    });
    controller.abort();
    await expect(bounded(starting)).rejects.toThrow("SSH daemon relay unavailable");
    expect(upstream.facts.identity).toBe(0);
  });

  it("bounds pipelined requests before a stalled identity settles", async () => {
    const upstream = await peer({ onIdentity: () => {} });
    const owned = await relay(upstream.port, { probeTimeoutMs: 15000 });
    const socket = connect(Number(new URL(owned.baseUrl).port), "127.0.0.1");
    socket.on("error", () => {});
    cleanups.push(async () => socket.destroy());
    await bounded(once(socket, "connect"));
    const gone = once(socket, "close");
    socket.write(
      "GET /private HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer fixture\r\n\r\n".repeat(
        64,
      ),
    );
    await bounded(gone);
    expect(upstream.facts.credentials).toBe(0);
    expect(upstream.facts.requests).toBe(0);
    // This finishes before the 15s probe timeout; socket closure cancels the waiting admission.
    owned.dispose();
    await bounded(owned.closed);
  });

  it("keeps a healthy sibling relay responsive after another generation mismatches", async () => {
    const badPeer = await peer({ identity: { ...identity, pid: identity.pid + 1 } }),
      goodPeer = await peer();
    const bad = await relay(badPeer.port),
      good = await relay(goodPeer.port);
    await call(bad).catch(() => null);
    await bounded(bad.closed);
    expect((await call(good)).body).toBe("ready");
    expect(badPeer.facts.credentials).toBe(0);
  });

  it("bounds idle downstream sockets without requiring upstream work", async () => {
    const upstream = await peer(),
      owned = await relay(upstream.port, { maxConnections: 1 });
    const first = connect(
      new URL(owned.baseUrl).port ? Number(new URL(owned.baseUrl).port) : 0,
      "127.0.0.1",
    );
    first.on("error", () => {});
    cleanups.push(async () => first.destroy());
    await once(first, "connect");
    const second = connect(Number(new URL(owned.baseUrl).port), "127.0.0.1");
    second.on("error", () => {});
    cleanups.push(async () => second.destroy());
    await bounded(once(second, "close"));
    expect(upstream.facts.identity).toBe(0);
  });
});
