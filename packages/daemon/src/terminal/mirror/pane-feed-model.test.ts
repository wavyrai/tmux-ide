import { describe, expect, it } from "vitest";
import type { MirrorPaneEvent } from "./events.ts";
import { PaneFeed } from "./pane-feed.ts";

type Action =
  | { type: "begin" | "capture" | "cursor"; ticket: number }
  | { type: "output"; text: string }
  | { type: "disconnect" };

/** A transcript oracle, not a second VT parser or copy of PaneFeed's states.
 * Output appends unique ASCII tokens. A successful checkpoint must expose
 * exactly the world's transcript; unpublished work must leave the view alone.
 * Captures use logical tickets independent of the implementation's epochs.
 */
function replay(
  actions: readonly Action[],
  corrupt?: (events: MirrorPaneEvent[]) => MirrorPaneEvent[],
) {
  const feed = new PaneFeed();
  const epochs = new Map<number, number>();
  const captures = new Map<number, string>();
  let ticket: number | null = null;
  let committed = true;
  let world = "";
  let expected = "";
  let actual = "";
  let resets = 0;
  let seeds = 0;
  for (const action of actions) {
    let events: MirrorPaneEvent[] = [];
    if (action.type === "begin") {
      ticket = action.ticket;
      committed = false;
      epochs.set(ticket, feed.beginReseed());
    } else if (action.type === "disconnect") {
      ticket = null;
      committed = false;
      feed.abortCurrent();
    } else if (action.type === "output") {
      world += action.text;
      if (committed) expected += action.text;
      events = feed.delta(Buffer.from(action.text));
    } else {
      const epoch = epochs.get(action.ticket);
      if (epoch === undefined) continue; // A reduced trace may omit the request.
      if (action.type === "capture") {
        if (!captures.has(action.ticket)) captures.set(action.ticket, world);
        feed.captureReply(epoch, [captures.get(action.ticket)!]);
      } else {
        const accepts = action.ticket === ticket && captures.has(action.ticket) && !committed;
        events = feed.cursorReply(epoch, "0 0 80 24");
        if (accepts) {
          expected = world;
          committed = true;
          expect(events.map((event) => event.type)).toEqual([
            "reset",
            "seed",
            ...events.filter((event) => event.type === "delta").map(() => "delta"),
            "cursor",
          ]);
        } else expect(events).toEqual([]);
      }
    }
    for (const event of corrupt ? corrupt(events) : events) {
      if (event.type === "reset") {
        actual = "";
        resets++;
      }
      if (event.type === "seed") {
        actual += Buffer.from(event.data).toString();
        seeds++;
      }
      if (event.type === "delta") actual += Buffer.from(event.data).toString();
    }
    expect(actual, JSON.stringify(action)).toBe(expected);
    expect(resets).toBe(seeds);
  }
}

/** Deletion reduction keeps a failing schedule replayable without dependencies. */
function minimize(
  actions: readonly Action[],
  fails: (actions: readonly Action[]) => boolean,
): Action[] {
  let result = [...actions];
  for (
    let size = Math.max(1, Math.floor(result.length / 2));
    size >= 1;
    size = Math.floor(size / 2)
  ) {
    for (let start = 0; start < result.length; ) {
      const candidate = [...result.slice(0, start), ...result.slice(start + size)];
      if (fails(candidate)) result = candidate;
      else start += size;
    }
  }
  return result;
}

function generated(seed: number): Action[] {
  let random = seed;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  let ticket = 0;
  const actions: Action[] = [{ type: "begin", ticket }];
  for (let step = 0; step < 80; step++) {
    const choice = next() % 7;
    if (choice === 0) actions.push({ type: "begin", ticket: ++ticket });
    else if (choice === 1) actions.push({ type: "disconnect" });
    else if (choice <= 3) actions.push({ type: "output", text: `[${seed}:${step}]` });
    else actions.push({ type: choice === 4 ? "capture" : "cursor", ticket: next() % (ticket + 1) });
  }
  actions.push(
    { type: "begin", ticket: ++ticket },
    { type: "capture", ticket },
    { type: "output", text: "[held]" },
    { type: "cursor", ticket },
    { type: "output", text: "[live]" },
  );
  return actions;
}

describe("pane boundary transcript model", () => {
  it.each(Array.from({ length: 64 }, (_, index) => index + 1))(
    "preserves checkpoints for schedule %i",
    (seed) => {
      const actions = generated(seed);
      try {
        replay(actions);
      } catch (error) {
        const minimal = minimize(actions, (candidate) => {
          try {
            replay(candidate);
            return false;
          } catch {
            return true;
          }
        });
        throw new Error(`Seed ${seed}; reduced schedule: ${JSON.stringify(minimal)}`, {
          cause: error,
        });
      }
    },
  );

  it("detects and reduces duplicated post-capture delivery (negative control)", () => {
    const actions: Action[] = [
      { type: "begin", ticket: 0 },
      { type: "output", text: "before" },
      { type: "capture", ticket: 0 },
      { type: "output", text: "after" },
      { type: "cursor", ticket: 0 },
    ];
    const fails = (candidate: readonly Action[]) => {
      try {
        replay(candidate, (events) =>
          events.flatMap((event) => (event.type === "delta" ? [event, event] : [event])),
        );
        return false;
      } catch {
        return true;
      }
    };
    expect(fails(actions)).toBe(true);
    const reduced = minimize(actions, fails);
    expect(reduced.length).toBeLessThan(actions.length);
    expect(fails(reduced)).toBe(true);
    replay(actions);
  });
});
