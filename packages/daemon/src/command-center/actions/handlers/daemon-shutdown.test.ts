import { describe, expect, it } from "bun:test";
import { daemonShutdownHandler, setDaemonShutdownBackend } from "./daemon-shutdown.ts";

describe("daemonShutdownHandler", () => {
  const instanceId = "9bcf33b0-c837-4a94-b5e8-c0977f54464f";

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

  it("accepts a shutdown pinned to the current daemon generation", async () => {
    let called = false;
    setDaemonShutdownBackend(() => {
      called = true;
    }, instanceId);

    expect(daemonShutdownHandler({ reason: "takeover", expectedInstanceId: instanceId })).toEqual({
      stopping: true,
    });
    await new Promise((resolve) => process.nextTick(resolve));
    expect(called).toBe(true);
    setDaemonShutdownBackend(null);
  });

  it("refuses a shutdown pinned to another daemon generation", () => {
    setDaemonShutdownBackend(() => {}, instanceId);

    expect(() =>
      daemonShutdownHandler({
        reason: "takeover",
        expectedInstanceId: "76088827-c1f1-4451-bc2e-0a3ae7747434",
      }),
    ).toThrow("Daemon instance changed before shutdown");
    setDaemonShutdownBackend(null);
  });
});
