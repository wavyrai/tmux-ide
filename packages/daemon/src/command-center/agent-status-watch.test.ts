import { describe, expect, it } from "vitest";
import {
  AgentStatusWatcher,
  agentStateWord,
  diffChangedSessions,
  type AgentStateReading,
} from "./agent-status-watch.ts";

function reading(entries: Record<string, Record<string, string>>): AgentStateReading {
  return new Map(
    Object.entries(entries).map(([session, panes]) => [session, new Map(Object.entries(panes))]),
  );
}

describe("agentStateWord", () => {
  it("strips the epoch suffix and tolerates a bare word", () => {
    expect(agentStateWord("working:1737600000")).toBe("working");
    expect(agentStateWord("done:0")).toBe("done");
    expect(agentStateWord("idle")).toBe("idle");
    expect(agentStateWord("")).toBe("");
  });
});

describe("diffChangedSessions", () => {
  it("detects a state-word transition on an existing pane", () => {
    const prev = reading({ s1: { "%1": "working:1" } });
    const next = reading({ s1: { "%1": "done:2" } });
    expect(diffChangedSessions(prev, next)).toEqual(["s1"]);
  });

  it("ignores an epoch-only re-stamp when the word is unchanged", () => {
    const prev = reading({ s1: { "%1": "working:1" } });
    const next = reading({ s1: { "%1": "working:9999" } });
    expect(diffChangedSessions(prev, next)).toEqual([]);
  });

  it("coalesces many pane flips in one session into a single entry", () => {
    const prev = reading({ s1: { "%1": "idle:1", "%2": "idle:1", "%3": "idle:1" } });
    const next = reading({ s1: { "%1": "working:2", "%2": "blocked:2", "%3": "done:2" } });
    expect(diffChangedSessions(prev, next)).toEqual(["s1"]);
  });

  it("reports appeared and disappeared panes and sorts session names", () => {
    const prev = reading({ s2: { "%9": "idle:1" }, s1: { "%1": "idle:1", "%2": "idle:1" } });
    const next = reading({ s2: {}, s1: { "%1": "idle:1" }, s3: { "%7": "working:1" } });
    // s1 lost a pane, s2 lost its pane, s3 appeared. Sorted.
    expect(diffChangedSessions(prev, next)).toEqual(["s1", "s2", "s3"]);
  });

  it("returns nothing when readings are equivalent", () => {
    const prev = reading({ s1: { "%1": "working:1" }, s2: { "%2": "idle:5" } });
    const next = reading({ s1: { "%1": "working:1" }, s2: { "%2": "idle:5" } });
    expect(diffChangedSessions(prev, next)).toEqual([]);
  });
});

describe("AgentStatusWatcher", () => {
  function harness(reads: (AgentStateReading | null)[]) {
    let cursor = 0;
    const emitted: string[] = [];
    const watcher = new AgentStatusWatcher({
      read: () => reads[Math.min(cursor++, reads.length - 1)] ?? null,
      emit: (sessionName) => emitted.push(sessionName),
      // Deterministic: never actually schedule; tests drive tick() by hand.
      setTimer: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearTimer: () => undefined,
    });
    return { watcher, emitted };
  }

  it("baselines on the first read and emits only on a later transition", () => {
    const { watcher, emitted } = harness([
      reading({ s1: { "%1": "working:1" } }),
      reading({ s1: { "%1": "working:1" } }),
      reading({ s1: { "%1": "done:2" } }),
    ]);
    watcher.start(); // primes baseline
    expect(emitted).toEqual([]);
    watcher.tick(); // unchanged
    expect(emitted).toEqual([]);
    watcher.tick(); // working -> done
    expect(emitted).toEqual(["s1"]);
  });

  it("holds the baseline through a transient null read and emits nothing for it", () => {
    const { watcher, emitted } = harness([
      reading({ s1: { "%1": "working:1" } }),
      null, // tmux hiccup — must not look like the pane vanished
      reading({ s1: { "%1": "working:1" } }),
    ]);
    watcher.start();
    watcher.tick(); // null
    watcher.tick(); // back to the same state as the baseline
    expect(emitted).toEqual([]);
  });

  it("re-baselines after stop so a restart does not replay old state", () => {
    const { watcher, emitted } = harness([
      reading({ s1: { "%1": "working:1" } }),
      reading({ s1: { "%1": "done:2" } }),
      reading({ s1: { "%1": "done:2" } }),
    ]);
    watcher.start(); // baseline = working
    expect(watcher.running).toBe(true);
    watcher.stop();
    expect(watcher.running).toBe(false);
    watcher.start(); // fresh baseline = done (read #2), emits nothing
    expect(emitted).toEqual([]);
    watcher.tick(); // read #3 == baseline
    expect(emitted).toEqual([]);
  });

  it("start and stop are idempotent", () => {
    const { watcher } = harness([reading({})]);
    watcher.start();
    watcher.start();
    expect(watcher.running).toBe(true);
    watcher.stop();
    watcher.stop();
    expect(watcher.running).toBe(false);
  });
});
