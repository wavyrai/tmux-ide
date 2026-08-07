/**
 * Unit tests for the input fast path's pure core: the ORDERING PROPERTY
 * (buffered literals always leave before a named key or a cross-pane literal)
 * and the flush/chunk behavior.
 */
import { describe, expect, it } from "vitest";
import { InputCoalescer, type InputAction } from "./input-coalescer.ts";

/** A coalescer with a hand-cranked scheduler and a recorded action log. */
function harness(maxChunkBytes?: number) {
  const actions: InputAction[] = [];
  const flushes: Array<() => void> = [];
  const c = new InputCoalescer(
    (a) => actions.push(a),
    (flush) => flushes.push(flush),
    maxChunkBytes,
  );
  /** Run every scheduled flush, as the microtask queue would. */
  const drain = () => {
    while (flushes.length > 0) flushes.shift()!();
  };
  return { c, actions, drain };
}

describe("InputCoalescer", () => {
  it("coalesces burst literals into one action per flush", () => {
    const { c, actions, drain } = harness();
    for (const ch of "hello") c.literal("%1", ch);
    expect(actions).toEqual([]); // nothing leaves until the scheduled flush
    drain();
    expect(actions).toEqual([{ kind: "literal", pane: "%1", text: "hello" }]);
  });

  it("ORDERING: a pending literal batch flushes before a named key", () => {
    const { c, actions } = harness();
    c.literal("%1", "a");
    c.literal("%1", "b");
    c.key("%1", "Enter"); // arrives before the scheduled flush ran
    expect(actions).toEqual([
      { kind: "literal", pane: "%1", text: "ab" },
      { kind: "key", pane: "%1", key: "Enter" },
    ]);
  });

  it("ORDERING: no reordering under literal/key interleaving", () => {
    const { c, actions, drain } = harness();
    c.literal("%1", "l");
    c.literal("%1", "s");
    c.key("%1", "Enter");
    c.key("%1", "C-c");
    c.literal("%1", "x");
    c.key("%1", "Up");
    drain(); // any still-scheduled flushes fire last and must be no-ops or in-order
    expect(actions).toEqual([
      { kind: "literal", pane: "%1", text: "ls" },
      { kind: "key", pane: "%1", key: "Enter" },
      { kind: "key", pane: "%1", key: "C-c" },
      { kind: "literal", pane: "%1", text: "x" },
      { kind: "key", pane: "%1", key: "Up" },
    ]);
  });

  it("ORDERING: a literal for another pane flushes the pending run first", () => {
    const { c, actions, drain } = harness();
    c.literal("%1", "aa");
    c.literal("%2", "bb");
    drain();
    expect(actions).toEqual([
      { kind: "literal", pane: "%1", text: "aa" },
      { kind: "literal", pane: "%2", text: "bb" },
    ]);
  });

  it("a drained scheduled flush after a key-forced flush is a no-op", () => {
    const { c, actions, drain } = harness();
    c.literal("%1", "a");
    c.key("%1", "Enter"); // flushes "a" synchronously
    drain(); // the earlier scheduled flush now runs on an empty buffer
    expect(actions).toEqual([
      { kind: "literal", pane: "%1", text: "a" },
      { kind: "key", pane: "%1", key: "Enter" },
    ]);
    expect(c.pending()).toBe(0);
  });

  it("schedules exactly once per pending run, again for a new run", () => {
    const flushes: Array<() => void> = [];
    const actions: InputAction[] = [];
    const c = new InputCoalescer(
      (a) => actions.push(a),
      (f) => flushes.push(f),
    );
    c.literal("%1", "a");
    c.literal("%1", "b");
    expect(flushes.length).toBe(1);
    flushes.shift()!();
    c.literal("%1", "c");
    expect(flushes.length).toBe(1); // a fresh run re-schedules
    flushes.shift()!();
    expect(actions.map((a) => (a.kind === "literal" ? a.text : ""))).toEqual(["ab", "c"]);
  });

  it("flush re-chunks a large buffered run under the byte cap", () => {
    const { c, actions, drain } = harness(4);
    c.literal("%1", "abcdefghij"); // 10 ASCII bytes, cap 4
    drain();
    expect(actions).toEqual([
      { kind: "literal", pane: "%1", text: "abcd" },
      { kind: "literal", pane: "%1", text: "efgh" },
      { kind: "literal", pane: "%1", text: "ij" },
    ]);
  });

  it("chunking never splits a multibyte character", () => {
    const { c, actions, drain } = harness(4);
    c.literal("%1", "aé漢b"); // 1 + 2 + 3 + 1 UTF-8 bytes
    drain();
    const texts = actions.map((a) => (a.kind === "literal" ? a.text : ""));
    expect(texts.join("")).toBe("aé漢b");
    for (const t of texts) expect(new TextEncoder().encode(t).length).toBeLessThanOrEqual(4);
  });

  it("ignores empty pane or empty text", () => {
    const { c, actions, drain } = harness();
    c.literal("", "a");
    c.literal("%1", "");
    c.key("%1", "");
    c.key("", "Enter");
    drain();
    expect(actions).toEqual([]);
  });
});
