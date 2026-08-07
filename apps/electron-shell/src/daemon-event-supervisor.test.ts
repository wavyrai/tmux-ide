import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

import {
  DaemonEventSupervisor,
  type DaemonEventSupervisorPolicy,
} from "./daemon-event-supervisor.ts";

const POLICY: DaemonEventSupervisorPolicy = {
  initialDelayMs: 10,
  maximumDelayMs: 40,
  maximumAttempts: 3,
  handshakeTimeoutMs: 100,
};

const ERROR = {
  code: "event-unavailable",
  reason: "The daemon event connection is unavailable.",
} as const;

interface Harness {
  supervisor: DaemonEventSupervisor;
  readonly states: DesktopDaemonTransportState[];
  readonly openSocket: ReturnType<typeof vi.fn>;
  readonly closeSocket: ReturnType<typeof vi.fn>;
  demand: boolean;
}

function createHarness(overrides: Partial<DaemonEventSupervisorPolicy> = {}): Harness {
  const states: DesktopDaemonTransportState[] = [];
  const openSocket = vi.fn();
  const closeSocket = vi.fn();
  const harness: Harness = {
    demand: true,
    states,
    openSocket,
    closeSocket,
    supervisor: undefined as unknown as DaemonEventSupervisor,
  };
  harness.supervisor = new DaemonEventSupervisor({
    policy: { ...POLICY, ...overrides },
    hooks: {
      demand: () => harness.demand,
      openSocket,
      closeSocket,
      onStateChanged: (state) => states.push(state),
    },
    now: () => Date.now(),
  });
  return harness;
}

describe("daemon event supervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts idle and connects only when demand appears", () => {
    const harness = createHarness();
    expect(harness.supervisor.state()).toEqual({ phase: "idle" });

    harness.demand = false;
    harness.supervisor.ensure();
    expect(harness.openSocket).not.toHaveBeenCalled();
    expect(harness.supervisor.state()).toEqual({ phase: "idle" });

    harness.demand = true;
    harness.supervisor.ensure();
    expect(harness.openSocket).toHaveBeenCalledOnce();
    expect(harness.supervisor.state()).toEqual({ phase: "connecting" });
    // A second demand signal while connecting never opens a parallel socket.
    harness.supervisor.ensure();
    expect(harness.openSocket).toHaveBeenCalledOnce();
  });

  it("derives connected from the verified hello and resets the retry budget", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.supervisor.failed(ERROR);
    vi.advanceTimersByTime(10);
    harness.supervisor.verified();
    expect(harness.supervisor.state()).toEqual({ phase: "connected" });

    // The budget reset means the next failure schedules attempt 1 again.
    harness.supervisor.failed(ERROR);
    const reconnecting = harness.states.at(-1);
    expect(reconnecting).toMatchObject({ phase: "reconnecting", attempt: 1, maximumAttempts: 3 });
  });

  it("publishes degraded then a scheduled reconnecting state with the retry time", () => {
    vi.setSystemTime(1_753_000_000_000);
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.states.length = 0;
    harness.supervisor.failed(ERROR);
    expect(harness.states).toEqual([
      { phase: "degraded", error: ERROR },
      {
        phase: "reconnecting",
        attempt: 1,
        maximumAttempts: 3,
        nextRetryAt: 1_753_000_000_010,
        error: ERROR,
      },
    ]);
    expect(harness.openSocket).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(9);
    expect(harness.openSocket).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(harness.openSocket).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.state()).toEqual({ phase: "connecting" });
  });

  it("backs off exponentially up to the ceiling and then stops and surfaces", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    // Attempt 1 after 10ms, attempt 2 after 20ms, attempt 3 after 40ms.
    for (const delay of [10, 20, 40]) {
      harness.supervisor.failed(ERROR);
      const scheduled = harness.states.at(-1);
      expect(scheduled).toMatchObject({ phase: "reconnecting" });
      const before = harness.openSocket.mock.calls.length;
      vi.advanceTimersByTime(delay - 1);
      expect(harness.openSocket).toHaveBeenCalledTimes(before);
      vi.advanceTimersByTime(1);
      expect(harness.openSocket).toHaveBeenCalledTimes(before + 1);
    }
    harness.supervisor.failed(ERROR);
    expect(harness.supervisor.state()).toEqual({ phase: "stopped", error: ERROR });
    // A stopped machine schedules nothing on its own.
    const attempts = harness.openSocket.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(harness.openSocket).toHaveBeenCalledTimes(attempts);
  });

  it("interrupts a scheduled backoff on an explicit retry wakeup", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.supervisor.failed(ERROR);
    expect(harness.supervisor.state()).toMatchObject({ phase: "reconnecting" });
    harness.supervisor.retry();
    expect(harness.openSocket).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.state()).toEqual({ phase: "connecting" });
    // The interrupted backoff timer never fires a parallel attempt; only the
    // handshake deadline may fail this connection now.
    vi.advanceTimersByTime(99);
    expect(harness.openSocket).toHaveBeenCalledTimes(2);
    harness.supervisor.verified();
    vi.advanceTimersByTime(10_000);
    expect(harness.openSocket).toHaveBeenCalledTimes(2);
  });

  it("restarts a stopped machine with a fresh budget on an explicit retry", () => {
    const harness = createHarness({ maximumAttempts: 1 });
    harness.supervisor.ensure();
    harness.supervisor.failed(ERROR);
    vi.advanceTimersByTime(10);
    harness.supervisor.failed(ERROR);
    expect(harness.supervisor.state()).toEqual({ phase: "stopped", error: ERROR });

    harness.supervisor.retry();
    expect(harness.supervisor.state()).toEqual({ phase: "connecting" });
    harness.supervisor.failed(ERROR);
    expect(harness.states.at(-1)).toMatchObject({ phase: "reconnecting", attempt: 1 });
  });

  it("never retries while connected or connecting and ignores retry without demand", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.supervisor.retry();
    expect(harness.openSocket).toHaveBeenCalledOnce();
    harness.supervisor.verified();
    harness.supervisor.retry();
    expect(harness.openSocket).toHaveBeenCalledOnce();

    harness.supervisor.failed(ERROR);
    harness.demand = false;
    harness.supervisor.retry();
    expect(harness.openSocket).toHaveBeenCalledOnce();
  });

  it("treats a failure without demand as a return to idle", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.demand = false;
    harness.supervisor.failed(ERROR);
    expect(harness.supervisor.state()).toEqual({ phase: "idle" });
    vi.advanceTimersByTime(10_000);
    expect(harness.openSocket).toHaveBeenCalledOnce();
  });

  it("counts a throwing socket factory as a failed attempt", () => {
    const harness = createHarness({ maximumAttempts: 1 });
    harness.openSocket.mockImplementation(() => {
      throw new Error("no socket for this daemon");
    });
    harness.supervisor.ensure();
    expect(harness.supervisor.state()).toMatchObject({ phase: "reconnecting", attempt: 1 });
    vi.advanceTimersByTime(10);
    expect(harness.supervisor.state()).toEqual({
      phase: "stopped",
      error: { code: "event-unavailable", reason: ERROR.reason },
    });
  });

  it("closes an unverified socket at the handshake deadline and schedules a retry", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    vi.advanceTimersByTime(99);
    expect(harness.closeSocket).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.closeSocket).toHaveBeenCalledWith(1008, "event handshake timeout");
    expect(harness.supervisor.state()).toMatchObject({ phase: "reconnecting", attempt: 1 });
  });

  it("cancels the handshake deadline once verified", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.supervisor.verified();
    vi.advanceTimersByTime(10_000);
    expect(harness.closeSocket).not.toHaveBeenCalled();
    expect(harness.supervisor.state()).toEqual({ phase: "connected" });
  });

  it("release returns to idle, clears timers, and resets the budget", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.supervisor.failed(ERROR);
    harness.supervisor.release();
    expect(harness.supervisor.state()).toEqual({ phase: "idle" });
    vi.advanceTimersByTime(10_000);
    expect(harness.openSocket).toHaveBeenCalledOnce();

    harness.supervisor.ensure();
    harness.supervisor.failed(ERROR);
    expect(harness.states.at(-1)).toMatchObject({ phase: "reconnecting", attempt: 1 });
  });

  it("dispose is terminal for every entry point", () => {
    const harness = createHarness();
    harness.supervisor.ensure();
    harness.supervisor.failed(ERROR);
    harness.supervisor.dispose();
    expect(harness.supervisor.state()).toEqual({ phase: "idle" });
    harness.supervisor.ensure();
    harness.supervisor.retry();
    harness.supervisor.failed(ERROR);
    harness.supervisor.verified();
    vi.advanceTimersByTime(10_000);
    expect(harness.openSocket).toHaveBeenCalledOnce();
    expect(harness.supervisor.state()).toEqual({ phase: "idle" });
  });

  it("keeps publishing states through a throwing observer", () => {
    const states: string[] = [];
    let throwing = true;
    const supervisor = new DaemonEventSupervisor({
      policy: POLICY,
      hooks: {
        demand: () => true,
        openSocket: () => undefined,
        closeSocket: () => undefined,
        onStateChanged: (state) => {
          states.push(state.phase);
          if (throwing) throw new Error("observer failure");
        },
      },
    });
    supervisor.ensure();
    supervisor.verified();
    throwing = false;
    supervisor.failed(ERROR);
    expect(states).toEqual(["connecting", "connected", "degraded", "reconnecting"]);
  });
});
