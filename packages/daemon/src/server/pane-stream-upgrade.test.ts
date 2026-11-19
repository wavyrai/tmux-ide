import { createServer } from "node:http";
import { PANE_STREAM_WEBSOCKET_SUBPROTOCOL } from "@tmux-ide/contracts";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { attachPaneStreamWebSocket } from "./pane-stream-upgrade.ts";
import type { PaneStreamAdmissionCoordinator } from "../terminal/pane-stream/pane-stream-websocket.ts";

describe("pane stream protocol upgrade", () => {
  it("refuses an old v1 redemption route before admitting or opening a socket", async () => {
    const server = createServer();
    const reserveUpgrade = vi.fn();
    const coordinator = { reserveUpgrade, shutdown: async () => undefined };
    const boundary = attachPaneStreamWebSocket(
      server,
      coordinator as unknown as PaneStreamAdmissionCoordinator,
    );
    const socket = { end: vi.fn(), destroy: vi.fn() };
    try {
      server.emit(
        "upgrade",
        { url: "/v1/terminal/pane-streams/redeem", rawHeaders: [] },
        socket,
        Buffer.alloc(0),
      );
      expect(socket.end).toHaveBeenCalledWith(expect.stringContaining("426 Upgrade Required"));
      expect(reserveUpgrade).not.toHaveBeenCalled();
    } finally {
      await boundary.close();
    }
  });
});

describe("redeem frame carried by the upgrade request (attach-rtt)", () => {
  const PATH = "/v2/terminal/pane-streams/redeem";
  async function serve() {
    const server = createServer();
    const admission = {
      bind: vi.fn(),
      cancelBeforeBind: vi.fn(),
      redeemFromUpgrade: vi.fn(),
    };
    const reserveUpgrade = vi.fn(() => ({ accepted: true, admission }));
    const boundary = attachPaneStreamWebSocket(server, {
      reserveUpgrade,
      shutdown: async () => undefined,
    } as unknown as PaneStreamAdmissionCoordinator);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const open = (redeem: string[] = []) =>
      new Promise<{ status: number; echo: string | undefined }>((resolve, reject) => {
        const headers: Record<string, string | string[]> = {
          Origin: "tmux-ide://app",
          "Sec-WebSocket-Protocol": PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
        };
        if (redeem.length) headers["X-Tmux-Ide-Redeem"] = redeem;
        const client = new WebSocket(`ws://127.0.0.1:${port}${PATH}`, { headers });
        client.on("upgrade", (response) => {
          resolve({ status: 101, echo: response.headers["x-tmux-ide-redeem"] as string });
          client.terminate();
        });
        client.on("unexpected-response", (_request, response) => {
          resolve({ status: response.statusCode ?? 0, echo: undefined });
          client.terminate();
        });
        client.on("error", (error) => reject(error));
      });
    return {
      admission,
      reserveUpgrade,
      open,
      close: async () => {
        await boundary.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  const frame = JSON.stringify({ type: "redeem", ticket: "ps2_x" });
  const encoded = Buffer.from(frame).toString("base64url");

  it("hands the carried frame to the admission after binding and says so in the 101", async () => {
    const s = await serve();
    try {
      expect(await s.open([encoded])).toEqual({ status: 101, echo: "accepted" });
      await vi.waitFor(() => expect(s.admission.redeemFromUpgrade).toHaveBeenCalledOnce());
      expect(s.admission.bind.mock.invocationCallOrder[0]).toBeLessThan(
        s.admission.redeemFromUpgrade.mock.invocationCallOrder[0]!,
      );
      expect(s.admission.redeemFromUpgrade.mock.calls[0]![0].toString()).toBe(frame);
    } finally {
      await s.close();
    }
  });

  it("upgrades as before without the header: no echo, the frame comes on the socket", async () => {
    const s = await serve();
    try {
      expect(await s.open()).toEqual({ status: 101, echo: undefined });
      await vi.waitFor(() => expect(s.admission.bind).toHaveBeenCalledOnce());
      expect(s.admission.redeemFromUpgrade).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });

  it.each([
    ["two headers", [encoded, encoded]],
    ["a value that is not base64url", ["not base64!"]],
    ["an oversized frame", [Buffer.alloc(4 * 1024 + 1, 97).toString("base64url")]],
  ])("refuses %s before admitting", async (_why, values) => {
    const s = await serve();
    try {
      expect((await s.open(values)).status).toBe(403);
      expect(s.reserveUpgrade).not.toHaveBeenCalled();
    } finally {
      await s.close();
    }
  });
});
