import { describe, expect, it, vi } from "vitest";

import {
  DaemonFleetFactsObserver,
  parseAgentStateFacts,
  parseSessionCompositionFacts,
  type SessionCompositionFacts,
} from "./daemon-fleet-facts-observer.ts";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function emptySessions(): SessionCompositionFacts {
  return { sessions: [], adopted: [] };
}

function callbacks() {
  return {
    onSessionsChanged: vi.fn(),
    onAdoptedChanged: vi.fn(),
    onAgentSessionsChanged: vi.fn(),
    onAgentTurnCompleted: vi.fn(),
  };
}

describe("DaemonFleetFactsObserver", () => {
  it("parses one session inventory for ordinary and adopted demand", () => {
    expect(parseSessionCompositionFacts("work\t0\nmanaged\t1\n__tmux_ide_preview\t1")).toEqual({
      sessions: ["__tmux_ide_preview", "managed", "work"],
      adopted: ["managed"],
    });
    expect(parseAgentStateFacts("work\t%1\tpane.editor\tworking:1").get("work")?.get("%1")).toEqual(
      { paneStamp: "pane.editor", state: "working:1" },
    );
  });

  it("unions demand and never overlaps observation cycles", async () => {
    const sessions = deferred<SessionCompositionFacts | null>();
    const agents = deferred<ReturnType<typeof parseAgentStateFacts> | null>();
    const readSessions = vi.fn(() => sessions.promise);
    const readAgents = vi.fn(() => agents.promise);
    const observer = new DaemonFleetFactsObserver({
      readSessions,
      readAgents,
      ...callbacks(),
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    });
    const handle = observer.acquire(["sessions", "adopted", "agents"]);
    const sameCycle = observer.runOnce();
    expect(readSessions).toHaveBeenCalledTimes(1);
    expect(readAgents).toHaveBeenCalledTimes(1);
    sessions.resolve(emptySessions());
    agents.resolve(new Map());
    await Promise.all([handle.ready, sameCycle]);
    handle.release();
  });

  it("immediately baselines demand acquired during an in-flight cycle", async () => {
    const firstSessions = deferred<SessionCompositionFacts | null>();
    const readSessions = vi.fn(() => firstSessions.promise);
    const readAgents = vi.fn(async () => new Map());
    const setTimer = vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>);
    const observer = new DaemonFleetFactsObserver({
      readSessions,
      readAgents,
      ...callbacks(),
      intervalMs: 20_000,
      setTimer,
      clearTimer: vi.fn(),
    });
    const sessionHandle = observer.acquire(["sessions"]);
    await Promise.resolve(); // the sessions-only cycle is now in flight
    const agentHandle = observer.acquire(["agents"]);
    firstSessions.resolve(emptySessions());
    await sessionHandle.ready;
    await agentHandle.ready;
    expect(readSessions).toHaveBeenCalledTimes(1);
    expect(readAgents).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(setTimer).toHaveBeenCalledTimes(1);
    sessionHandle.release();
    agentHandle.release();
  });

  it("does not claim readiness after a transient read failure", async () => {
    let succeeds = false;
    const observer = new DaemonFleetFactsObserver({
      readSessions: vi.fn(async () => (succeeds ? emptySessions() : null)),
      readAgents: vi.fn(async () => new Map()),
      ...callbacks(),
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    });
    const handle = observer.acquire(["sessions"]);
    let settled = false;
    void handle.ready.then(() => {
      settled = true;
    });
    await observer.runOnce();
    await Promise.resolve();
    expect(settled).toBe(false);
    succeeds = true;
    await observer.runOnce();
    await handle.ready;
    expect(settled).toBe(true);
    handle.release();
  });

  it("resolves a released pending acquisition and ignores its late result", async () => {
    const sessions = deferred<SessionCompositionFacts | null>();
    const changed = callbacks();
    const observer = new DaemonFleetFactsObserver({
      readSessions: () => sessions.promise,
      readAgents: async () => new Map(),
      ...changed,
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    });
    const handle = observer.acquire(["sessions"]);
    handle.release();
    await handle.ready;
    sessions.resolve({ sessions: ["late"], adopted: [] });
    await observer.runOnce();
    expect(changed.onSessionsChanged).not.toHaveBeenCalled();
  });

  it("does not let a released demand accept a late result after reacquisition", async () => {
    const first = deferred<SessionCompositionFacts | null>();
    const second = deferred<SessionCompositionFacts | null>();
    const readSessions = vi
      .fn<() => Promise<SessionCompositionFacts | null>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const observer = new DaemonFleetFactsObserver({
      readSessions,
      readAgents: async () => new Map(),
      ...callbacks(),
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    });
    const retained = observer.acquire(["agents"]);
    const released = observer.acquire(["sessions"]);
    await Promise.resolve();
    released.release();
    const reacquired = observer.acquire(["sessions"]);
    first.resolve({ sessions: ["stale"], adopted: [] });
    await Promise.resolve();
    let ready = false;
    void reacquired.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    second.resolve({ sessions: ["current"], adopted: [] });
    await reacquired.ready;
    expect(readSessions).toHaveBeenCalledTimes(2);
    reacquired.release();
    retained.release();
  });

  it.each([
    ["sessions", "adopted"],
    ["adopted", "sessions"],
  ] as const)(
    "expires the %s baseline independently while %s demand remains",
    async (releasedDemand, retainedDemand) => {
      const reads = [
        { sessions: ["first"], adopted: ["first"] },
        { sessions: ["second"], adopted: ["second"] },
      ];
      const observer = new DaemonFleetFactsObserver({
        readSessions: vi.fn(async () => reads.shift() ?? null),
        readAgents: async () => new Map(),
        ...callbacks(),
        setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
        clearTimer: vi.fn(),
      });
      const retained = observer.acquire([retainedDemand]);
      const released = observer.acquire([releasedDemand]);
      await Promise.all([retained.ready, released.ready]);
      released.release();

      const reacquired = observer.acquire([releasedDemand]);
      let ready = false;
      void reacquired.ready.then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false);
      await reacquired.ready;
      expect(ready).toBe(true);

      reacquired.release();
      retained.release();
    },
  );
});
