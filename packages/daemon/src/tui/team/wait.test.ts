/**
 * The extracted wait loops (`tmux-ide wait` + the socket's `wait` verb):
 * deps-injected polling, so success, timeout, and the matching rules pin
 * down without a tmux server.
 */
import { describe, expect, it } from "vitest";
import { createStatusTracker, type AgentStatus } from "../detect/classify.ts";
import type { TeamSession } from "./sessions.ts";
import { matchOutput, waitForAgentStatus, waitForOutputMatch } from "./wait.ts";

const session = (name: string, status: AgentStatus): TeamSession => ({
  name,
  attached: false,
  windows: 1,
  panes: 1,
  status,
  windowList: [],
});

/** A fake clock + instant sleep: each sleep advances time by the slept ms. */
function fakeTime() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

describe("matchOutput", () => {
  it("reports the first matching LINE", () => {
    expect(matchOutput("alpha\nbeta ok\ngamma", "ok")).toBe("beta ok");
  });

  it("falls back to whole-text matching (multi-line patterns)", () => {
    expect(matchOutput("one\ntwo", "one[\\s\\S]two")).toBe("two");
  });

  it("returns null when nothing matches", () => {
    expect(matchOutput("nothing here", "absent")).toBeNull();
  });

  it("a /g-style sticky pattern cannot carry lastIndex between calls", () => {
    expect(matchOutput("ok ok", "ok")).toBe("ok ok");
    expect(matchOutput("ok ok", "ok")).toBe("ok ok");
  });
});

describe("waitForAgentStatus", () => {
  it("resolves ok once the session reaches the wanted status", async () => {
    const t = fakeTime();
    let polls = 0;
    const result = await waitForAgentStatus("s1", "done", {
      tracker: createStatusTracker(),
      listSessions: () => [session("s1", ++polls >= 3 ? "done" : "working")],
      now: t.now,
      sleep: t.sleep,
    });
    expect(result).toMatchObject({ ok: true, session: "s1", status: "done" });
    expect(polls).toBe(3);
  });

  it("times out with the last observed status (null when absent)", async () => {
    const t = fakeTime();
    const result = await waitForAgentStatus("ghost", "done", {
      timeoutMs: 3000,
      tracker: createStatusTracker(),
      listSessions: () => [session("other", "idle")],
      now: t.now,
      sleep: t.sleep,
    });
    expect(result).toMatchObject({ ok: false, status: null, timedOutAfterMs: 3000 });
  });
});

describe("waitForOutputMatch", () => {
  it("resolves with the matching line, tolerating capture failures", async () => {
    const t = fakeTime();
    let calls = 0;
    const result = await waitForOutputMatch("%9", "ready", {
      capture: () => {
        calls++;
        if (calls === 1) throw new Error("pane not up yet");
        return calls < 3 ? "booting" : "server ready on :3000";
      },
      now: t.now,
      sleep: t.sleep,
    });
    expect(result).toMatchObject({ ok: true, matched: "server ready on :3000" });
  });

  it("times out when nothing ever matches", async () => {
    const t = fakeTime();
    const result = await waitForOutputMatch("%9", "never", {
      timeoutMs: 2000,
      capture: () => "still nothing",
      now: t.now,
      sleep: t.sleep,
    });
    expect(result).toMatchObject({ ok: false, matched: null, timedOutAfterMs: 2000 });
  });

  it("throws up front on an invalid regex", async () => {
    await expect(waitForOutputMatch("%9", "([", { capture: () => "" })).rejects.toThrow();
  });
});
