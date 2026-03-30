import { describe, it, expect } from "bun:test";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { AuthService } from "../auth/auth-service.ts";
import {
  decodeWsV3Frame,
  encodeWsV3Frame,
  encodeWsV3SubscribePayload,
  WsV3MessageType,
  WsV3SubscribeFlags,
} from "./protocol.ts";
import { WsV3Hub, type WsV3HubDeps } from "./hub.ts";

const utf8 = new TextEncoder();

function createMockDeps(initial = "line1\n"): {
  deps: WsV3HubDeps;
  setCapture: (s: string) => void;
} {
  let capture = initial;
  return {
    deps: {
      capturePane: () => capture,
      paneExists: () => true,
      sendLiteral: () => {},
      resizePane: () => {},
    },
    setCapture: (s: string) => {
      capture = s;
    },
  };
}

async function withServer(
  hub: WsV3Hub,
  handler: (port: number) => Promise<void>,
  session = "proj",
  paneId = "%1",
): Promise<void> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => hub.handleConnection(ws, session, paneId));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as { port: number }).port;
  try {
    await handler(port);
  } finally {
    hub.stopAll();
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  }
}

describe("WsV3Hub", { timeout: 30_000 }, () => {
  function helloFrame(token?: string) {
    return encodeWsV3Frame({
      type: WsV3MessageType.HELLO,
      payload: utf8.encode(JSON.stringify(token ? { token } : {})),
    });
  }

  function subscribeFrame(flags: number) {
    return encodeWsV3Frame({
      type: WsV3MessageType.SUBSCRIBE,
      sessionId: "proj:%1",
      payload: encodeWsV3SubscribePayload({ flags }),
    });
  }

  it("unsubscribe stops STDOUT after UNSUBSCRIBE", async () => {
    const m = createMockDeps();
    const hub = new WsV3Hub(
      new AuthService("hub-test-secret"),
      { method: "none", token_expiry: 86400 },
      m.deps,
      {
        pollIntervalMs: 15,
      },
    );

    await withServer(hub, async (port) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      let stdoutCount = 0;
      client.on("message", (data: Buffer) => {
        const d = decodeWsV3Frame(new Uint8Array(data));
        if (d?.type === WsV3MessageType.STDOUT) stdoutCount += 1;
      });

      client.send(helloFrame());
      await new Promise((r) => setTimeout(r, 25));
      client.send(subscribeFrame(WsV3SubscribeFlags.Stdout));
      await new Promise((r) => setTimeout(r, 60));
      const n1 = stdoutCount;

      client.send(
        encodeWsV3Frame({
          type: WsV3MessageType.UNSUBSCRIBE,
          sessionId: "proj:%1",
          payload: new Uint8Array(),
        }),
      );
      await new Promise((r) => setTimeout(r, 30));
      m.setCapture("changed-after-unsub\n");
      await new Promise((r) => setTimeout(r, 100));

      expect(stdoutCount).toBe(n1);
      client.close();
    });
  });

  it("subscribe receives STDOUT data frames when capture changes", async () => {
    const m = createMockDeps();
    const hub = new WsV3Hub(
      new AuthService("hub-test-secret"),
      { method: "none", token_expiry: 86400 },
      m.deps,
      {
        pollIntervalMs: 15,
      },
    );

    await withServer(hub, async (port) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      let stdoutCount = 0;
      client.on("message", (data: Buffer) => {
        const d = decodeWsV3Frame(new Uint8Array(data));
        if (d?.type === WsV3MessageType.STDOUT) stdoutCount += 1;
      });

      client.send(helloFrame());
      await new Promise((r) => setTimeout(r, 25));
      client.send(subscribeFrame(WsV3SubscribeFlags.Stdout));
      await new Promise((r) => setTimeout(r, 60));
      const before = stdoutCount;

      m.setCapture("line2-changed\n");
      await new Promise((r) => setTimeout(r, 120));

      expect(stdoutCount).toBeGreaterThan(before);
      client.close();
    });
  });

  it("rejects unauthenticated client when auth method is ssh", async () => {
    const m = createMockDeps();
    const strictHub = new WsV3Hub(
      new AuthService("hub-test-secret"),
      { method: "ssh", token_expiry: 86400 },
      m.deps,
      { pollIntervalMs: 50 },
    );

    await withServer(strictHub, async (port) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });

      let sawError = false;
      client.on("message", (data: Buffer) => {
        const d = decodeWsV3Frame(new Uint8Array(data));
        if (d?.type === WsV3MessageType.ERROR) sawError = true;
      });

      client.send(helloFrame("not-a-valid-jwt"));
      await new Promise((r) => setTimeout(r, 150));
      expect(sawError).toBe(true);
      client.close();
    });
  });

  it("broadcast delivers frame to all subscribers", async () => {
    const m = createMockDeps();
    const hub = new WsV3Hub(
      new AuthService("hub-test-secret"),
      { method: "none", token_expiry: 86400 },
      m.deps,
      {
        pollIntervalMs: 500,
      },
    );

    await withServer(hub, async (port) => {
      const c1 = new WebSocket(`ws://127.0.0.1:${port}/`);
      const c2 = new WebSocket(`ws://127.0.0.1:${port}/`);
      await Promise.all([
        new Promise<void>((r) => c1.on("open", () => r())),
        new Promise<void>((r) => c2.on("open", () => r())),
      ]);

      const got: string[] = [];
      const onMsg = (data: Buffer) => {
        const d = decodeWsV3Frame(new Uint8Array(data));
        if (d?.type === WsV3MessageType.STDOUT) {
          got.push(new TextDecoder().decode(d.payload));
        }
      };
      c1.on("message", onMsg);
      c2.on("message", onMsg);

      c1.send(helloFrame());
      c2.send(helloFrame());
      await new Promise((r) => setTimeout(r, 20));
      c1.send(subscribeFrame(WsV3SubscribeFlags.Stdout));
      c2.send(subscribeFrame(WsV3SubscribeFlags.Stdout));
      await new Promise((r) => setTimeout(r, 50));

      hub.broadcast(
        "proj",
        "%1",
        encodeWsV3Frame({
          type: WsV3MessageType.STDOUT,
          sessionId: "proj:%1",
          payload: utf8.encode("broadcast-test"),
        }),
      );

      await new Promise((r) => setTimeout(r, 80));
      expect(got.filter((p) => p === "broadcast-test").length).toBe(2);

      c1.close();
      c2.close();
    });
  });

  it("pane not found returns ERROR frame", async () => {
    const m = createMockDeps();
    const badDeps: WsV3HubDeps = { ...m.deps, paneExists: () => false };
    const h = new WsV3Hub(new AuthService("x"), { method: "none", token_expiry: 86400 }, badDeps);

    await withServer(
      h,
      async (port) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/`);
        await new Promise<void>((resolve) => client.on("open", resolve));

        let errMsg = "";
        client.on("message", (data: Buffer) => {
          const d = decodeWsV3Frame(new Uint8Array(data));
          if (d?.type === WsV3MessageType.ERROR) {
            errMsg = new TextDecoder().decode(d.payload);
          }
        });

        client.send(helloFrame());
        await new Promise((r) => setTimeout(r, 30));
        client.send(subscribeFrame(WsV3SubscribeFlags.Stdout));
        await new Promise((r) => setTimeout(r, 100));

        expect(errMsg).toContain("Pane not found");
        client.close();
      },
      "proj",
      "%99",
    );
  });
});
