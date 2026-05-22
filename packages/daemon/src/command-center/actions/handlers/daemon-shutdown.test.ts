import { describe, expect, it } from "bun:test";
import { daemonShutdownHandler, setDaemonShutdownBackend } from "./daemon-shutdown.ts";

describe("daemonShutdownHandler", () => {
  it("queues a shutdown and returns immediately", async () => {
    setDaemonShutdownBackend(null);
    let reason: string | null = null;

    const result = daemonShutdownHandler(
      { reason: "takeover" },
      {
        shutdown: (value) => {
          reason = value;
        },
      },
    );

    expect(result).toEqual({ stopping: true });
    await new Promise((resolve) => process.nextTick(resolve));
    expect(reason).toBe("takeover");
    setDaemonShutdownBackend(null);
  });

  it("rejects duplicate shutdown requests while one is pending", () => {
    setDaemonShutdownBackend(() => {});
    daemonShutdownHandler({ reason: "first" });

    expect(() => daemonShutdownHandler({ reason: "second" })).toThrow(
      "Daemon shutdown is already in progress",
    );
    setDaemonShutdownBackend(null);
  });
});
