import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { NativeSurfaceProviderRegistry } from "../terminal/graphics/native-surface-provider.ts";
import {
  attachNativeSurfaceProvider,
  NATIVE_SURFACE_PROVIDER_PATH,
} from "./native-surface-provider-upgrade.ts";
const generation = "e01ce8ee-74d8-40d0-9a59-a096050a6ade";
const protocol = "tmux-ide-native-surface-provider-v1";

describe("native provider authenticated boundary", () => {
  it("rejects missing, wrong and repeated credentials before websocket admission", () => {
    const server = createServer();
    const registry = new NativeSurfaceProviderRegistry(generation);
    const boundary = attachNativeSurfaceProvider(server, registry, "owner", () => true);
    try {
      for (const [headers, rawHeaders] of [
        [{}, []],
        [{ authorization: "Bearer other" }, ["Authorization", "Bearer other"]],
        [
          { authorization: "Bearer owner" },
          ["Authorization", "Bearer owner", "Authorization", "Bearer owner"],
        ],
      ] as const) {
        const socket = { end: vi.fn() };
        server.emit(
          "upgrade",
          { url: NATIVE_SURFACE_PROVIDER_PATH, headers, rawHeaders },
          socket,
          Buffer.alloc(0),
        );
        expect(socket.end).toHaveBeenCalledWith(expect.stringContaining("403"));
        expect(registry.available).toBe(false);
      }
    } finally {
      boundary.close();
    }
  });
  it("routes real socket offers and retirement, then revokes on provider disconnect", async () => {
    const server = createServer();
    const registry = new NativeSurfaceProviderRegistry(generation);
    const boundary = attachNativeSurfaceProvider(server, registry, "owner", () => true);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}${NATIVE_SURFACE_PROVIDER_PATH}`,
      protocol,
      {
        headers: { Authorization: "Bearer owner" },
      },
    );
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    try {
      await once(ws, "open");
      ws.send(
        JSON.stringify({
          type: "register",
          version: 1,
          generation,
          auditToken: [1, 2, 3, 4, 5, 6, 7, 8],
        }),
      );
      await vi.waitFor(() => expect(messages[0]?.type).toBe("registered"));
      const controls: unknown[] = [];
      const session = registry.open(
        {
          type: "terminal-surface-receiver",
          version: 1,
          generation,
          connectionNonce: randomUUID(),
          challenge: randomUUID(),
          pid: 123,
          slot: 0,
          auditToken: [8, 7, 6, 5, 4, 3, 2, 1],
        },
        ["pane.editor"],
        (frame) => {
          controls.push(frame);
          return true;
        },
      );
      await vi.waitFor(() => expect(messages[1]?.type).toBe("start"));
      const connection = messages[1]!.connection;
      ws.send(
        JSON.stringify({
          type: "offer",
          connection,
          offer: {
            type: "terminal-surface-offer",
            version: 1,
            generation,
            pane: "pane.editor",
            incarnation: "pane:1",
            deliveryNonce: randomUUID(),
            canonicalRevision: 1,
            canonicalStateHash: "0000000000000001",
            sequence: 1,
            surfaceId: randomUUID(),
            storageTicket: randomUUID(),
            placement: { row: 0, column: 0, rows: 1, columns: 1 },
            format: "bgra8-straight",
            width: 16,
            height: 16,
            stride: 64,
            allocationBytes: 1024,
          },
        }),
      );
      await vi.waitFor(() =>
        expect(messages[2]).toMatchObject({
          type: "offered",
          connection,
          sequence: 1,
          accepted: true,
        }),
      );
      expect(controls).toHaveLength(2);
      expect(session?.retire(1)).toBe(true);
      await vi.waitFor(() =>
        expect(messages[3]).toMatchObject({ type: "retired", connection, sequence: 1 }),
      );
      const closed = once(ws, "close");
      ws.close();
      await closed;
      await vi.waitFor(() => expect(registry.available).toBe(false));
      expect(controls[2]).toMatchObject({
        type: "terminal-surface-fallback",
        reason: "unsupported",
      });
      session?.close();
    } finally {
      ws.terminate();
      boundary.close();
      registry.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
