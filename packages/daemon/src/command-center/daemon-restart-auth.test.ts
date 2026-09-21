import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionContractsZ } from "@tmux-ide/contracts";
import { createApp } from "./server.ts";
import {
  daemonRestartHandler,
  daemonShutdownHandler,
  setDaemonRestartBackend,
  setDaemonShutdownBackend,
} from "./actions/handlers/daemon-shutdown.ts";
const INSTANCE = "10000000-0000-4000-8000-000000000001";
const OWNER = "private-owner";
afterEach(() => {
  setDaemonShutdownBackend(null);
  setDaemonRestartBackend(null);
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("daemon runtime restart", () => {
  it("requires a generation fence in the action contract", () => {
    expect(ActionContractsZ["daemon.restart"].input.safeParse({}).success).toBe(false);
  });
  it.each([undefined, "shared-remote-token"])(
    "rejects %s without private owner authority",
    async (token) => {
      const restart = vi.fn();
      setDaemonRestartBackend(restart, INSTANCE);
      const app = createApp({
        remoteAccess: { ownerToken: OWNER, token: "shared-remote-token", localBypassToken: OWNER },
      });
      const response = await app.request("http://localhost/api/v2/action/daemon.restart", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ expectedInstanceId: INSTANCE }),
      });
      expect(response.status).toBe(401);
      await flush();
      expect(restart).not.toHaveBeenCalled();
    },
  );
  it("accepts one authorized restart and shares admission with shutdown", async () => {
    const restart = vi.fn();
    setDaemonRestartBackend(restart, INSTANCE);
    const app = createApp({ remoteAccess: { ownerToken: OWNER } });
    const response = await app.request("http://localhost/api/v2/action/daemon.restart", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ expectedInstanceId: INSTANCE }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: { restarting: true, instanceId: INSTANCE },
    });
    expect(() => daemonRestartHandler({ expectedInstanceId: INSTANCE })).toThrow(
      "already in progress",
    );
    expect(() => daemonShutdownHandler({})).toThrow("already in progress");
    await flush();
    expect(restart).toHaveBeenCalledTimes(1);
  });
  it("does not accept restart after ordinary shutdown admission", async () => {
    const restart = vi.fn();
    const shutdown = vi.fn();
    setDaemonShutdownBackend(shutdown, INSTANCE);
    setDaemonRestartBackend(restart, INSTANCE);
    daemonShutdownHandler({ expectedInstanceId: INSTANCE });
    expect(() => daemonRestartHandler({ expectedInstanceId: INSTANCE })).toThrow(
      "already in progress",
    );
    await flush();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });
  it("refuses unsupported or stale owners without consuming admission", async () => {
    expect(() => daemonRestartHandler({ expectedInstanceId: INSTANCE })).toThrow(
      "does not support",
    );
    const restart = vi.fn();
    setDaemonRestartBackend(restart, INSTANCE);
    expect(() =>
      daemonRestartHandler({ expectedInstanceId: "20000000-0000-4000-8000-000000000002" }),
    ).toThrow("instance changed");
    expect(daemonRestartHandler({ expectedInstanceId: INSTANCE })).toEqual({
      restarting: true,
      instanceId: INSTANCE,
    });
    await flush();
    expect(restart).toHaveBeenCalledOnce();
  });
});
