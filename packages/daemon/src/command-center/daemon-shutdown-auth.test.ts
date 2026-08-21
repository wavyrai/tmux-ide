import { afterEach, describe, expect, it, vi } from "vitest";

import { setDaemonShutdownBackend } from "./actions/handlers/daemon-shutdown.ts";
import { createApp } from "./server.ts";

const OWNER = "daemon-owner-secret";

afterEach(() => {
  setDaemonShutdownBackend(null);
});

describe("daemon shutdown owner authority", () => {
  it("rejects loopback shutdown without the private owner capability", async () => {
    const shutdown = vi.fn();
    setDaemonShutdownBackend(shutdown);
    const app = createApp({ remoteAccess: { ownerToken: OWNER } });

    const response = await app.request("http://127.0.0.1/api/v2/action/daemon.shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "unauthorized" }),
    });

    expect(response.status).toBe(401);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("accepts shutdown with the exact owner capability", async () => {
    const shutdown = vi.fn();
    setDaemonShutdownBackend(shutdown);
    const app = createApp({ remoteAccess: { ownerToken: OWNER } });

    const response = await app.request("http://127.0.0.1/api/v2/action/daemon.shutdown", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "wire-protocol-upgrade" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: { stopping: true } });
    await new Promise<void>((resolve) => process.nextTick(resolve));
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
