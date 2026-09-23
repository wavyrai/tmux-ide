import { createServer } from "node:http";
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
