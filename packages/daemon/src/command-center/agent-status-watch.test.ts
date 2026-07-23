import { describe, expect, it } from "vitest";
import {
  AgentStatusWatcher,
  agentStateWord,
  diffChangedSessions,
  diffTurnCompletions,
  type AgentStateReading,
  type AgentTurnCompletion,
} from "./agent-status-watch.ts";

/** Compact reading builder: `"state"` or `"state|paneStamp"` per pane. */
function reading(entries: Record<string, Record<string, string>>): AgentStateReading {
  return new Map(
    Object.entries(entries).map(([session, panes]) => [
      session,
      new Map(
        Object.entries(panes).map(([paneId, value]) => {
          const separator = value.indexOf("|");
          return [
            paneId,
            separator < 0
              ? { state: value, paneStamp: null }
              : { state: value.slice(0, separator), paneStamp: value.slice(separator + 1) },
          ];
        }),
      ),
    ]),
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

describe("diffTurnCompletions", () => {
  it("reports working -> done and working -> idle, carrying the durable stamp", () => {
    const prev = reading({
      s1: { "%1": "working:1|pane.a1", "%2": "working:1" },
    });
    const next = reading({
      s1: { "%1": "done:2|pane.a1", "%2": "idle:2" },
    });
    expect(diffTurnCompletions(prev, next)).toEqual([
      { sessionName: "s1", paneStamp: "pane.a1", fromStatus: "working", toStatus: "done" },
      { sessionName: "s1", paneStamp: null, fromStatus: "working", toStatus: "idle" },
    ] satisfies AgentTurnCompletion[]);
  });

  it("ignores non-completion transitions and epoch-only re-stamps", () => {
    const prev = reading({
      s1: { "%1": "working:1", "%2": "working:1", "%3": "done:1", "%4": "idle:1" },
    });
    const next = reading({
      s1: { "%1": "blocked:2", "%2": "working:9999", "%3": "working:2", "%4": "done:2" },
    });
    // blocked is not a completion; re-stamp is nothing; done->working starts a
    // turn; idle->done never passed through an observed working state.
    expect(diffTurnCompletions(prev, next)).toEqual([]);
  });

  it("reports nothing for a pane that vanished mid-turn or appeared already done", () => {
    const prev = reading({ s1: { "%1": "working:1" } });
    const next = reading({ s1: { "%2": "done:2" }, s2: { "%3": "done:2" } });
    expect(diffTurnCompletions(prev, next)).toEqual([]);
  });

  it("orders completions deterministically across sessions and panes", () => {
    const prev = reading({
      zz: { "%2": "working:1", "%1": "working:1" },
      aa: { "%9": "working:1" },
    });
    const next = reading({
      zz: { "%2": "done:2", "%1": "idle:2" },
      aa: { "%9": "done:2" },
    });
    expect(diffTurnCompletions(prev, next).map((c) => `${c.sessionName}:${c.toStatus}`)).toEqual([
      "aa:done",
      "zz:idle",
      "zz:done",
    ]);
  });
});

describe("AgentStatusWatcher", () => {
  function harness(reads: (AgentStateReading | null)[]) {
    let cursor = 0;
    const emitted: string[] = [];
    const completions: AgentTurnCompletion[] = [];
    const watcher = new AgentStatusWatcher({
      read: () => reads[Math.min(cursor++, reads.length - 1)] ?? null,
      emit: (sessionName) => emitted.push(sessionName),
      emitTurnCompleted: (completion) => completions.push(completion),
      // Deterministic: never actually schedule; tests drive tick() by hand.
      setTimer: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearTimer: () => undefined,
    });
    return { watcher, emitted, completions };
  }

  it("baselines on the first read and emits only on a later transition", () => {
    const { watcher, emitted, completions } = harness([
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
    expect(completions).toEqual([
      { sessionName: "s1", paneStamp: null, fromStatus: "working", toStatus: "done" },
    ]);
  });

  it("emits no receipt on baseline even when the fleet is already done", () => {
    const { watcher, completions } = harness([
      reading({ s1: { "%1": "done:1" } }),
      reading({ s1: { "%1": "done:1" } }),
    ]);
    watcher.start();
    watcher.tick();
    expect(completions).toEqual([]);
  });

  it("holds the baseline through a transient null read and emits nothing for it", () => {
    const { watcher, emitted, completions } = harness([
      reading({ s1: { "%1": "working:1" } }),
      null, // tmux hiccup — must not look like the pane vanished
      reading({ s1: { "%1": "working:1" } }),
    ]);
    watcher.start();
    watcher.tick(); // null
    watcher.tick(); // back to the same state as the baseline
    expect(emitted).toEqual([]);
    expect(completions).toEqual([]);
  });

  it("still completes a turn across a transient null read", () => {
    const { watcher, completions } = harness([
      reading({ s1: { "%1": "working:1|pane.x" } }),
      null,
      reading({ s1: { "%1": "done:2|pane.x" } }),
    ]);
    watcher.start();
    watcher.tick(); // null — baseline (working) held
    watcher.tick(); // done, diffed against the held working baseline
    expect(completions).toEqual([
      { sessionName: "s1", paneStamp: "pane.x", fromStatus: "working", toStatus: "done" },
    ]);
  });

  it("re-baselines after stop so a restart does not replay old state", () => {
    const { watcher, emitted, completions } = harness([
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
    expect(completions).toEqual([]);
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
