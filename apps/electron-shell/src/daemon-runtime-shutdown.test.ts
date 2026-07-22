import { describe, expect, it, vi } from "vitest";

import { shutdownDesktopDaemonRuntime } from "./daemon-runtime-shutdown.ts";

describe("desktop daemon quit ordering", () => {
  it("retires renderer and broker authority before stopping the owned daemon", async () => {
    const order: string[] = [];

    await shutdownDesktopDaemonRuntime({
      disposeHostIpc: () => order.push("renderer"),
      disposeDaemonResources: () => order.push("broker"),
      stopOwnedDaemon: async () => {
        order.push("daemon");
      },
    });

    expect(order).toEqual(["renderer", "broker", "daemon"]);
  });

  it("still attempts every ordered teardown and reports combined failures", async () => {
    const order: string[] = [];
    const stopOwnedDaemon = vi.fn(async () => {
      order.push("daemon");
      throw new Error("stop failed");
    });

    await expect(
      shutdownDesktopDaemonRuntime({
        disposeHostIpc: () => {
          order.push("renderer");
          throw new Error("renderer failed");
        },
        disposeDaemonResources: () => order.push("broker"),
        stopOwnedDaemon,
      }),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(order).toEqual(["renderer", "broker", "daemon"]);
    expect(stopOwnedDaemon).toHaveBeenCalledOnce();
  });
});
