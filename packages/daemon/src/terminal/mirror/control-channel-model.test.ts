import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ControlChannelCore } from "./control-channel.ts";

type Action =
  | { type: "output"; pane: string; text: string }
  | { type: "hook"; text: string }
  | { type: "command"; id: number; count: number; error: boolean; overflow: boolean };
type Observation =
  | { type: "output"; pane: string; text: string }
  | { type: "reply"; id: number; ok: boolean; lines: readonly string[] };
type Mutation = "duplicate-output" | "lost-output" | "misrouted-reply";

class BoundaryInvariant extends Error {}

function random(seed: number) {
  let state = seed;
  // Avoid the LCG's correlated low bits when selecting small alternatives.
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 8;
}

/** Whole protocol operations are the reduction unit: removing one never leaves
 * unmatched guards or a reply without its command. Output is legal only between
 * reply blocks here. Malformed wire and stale callbacks are separate fault tests.
 */
function generate(seed: number): Action[] {
  const next = random(seed);
  return Array.from({ length: 48 }, (_, id): Action => {
    const kind = next() % 5;
    if (kind < 2)
      return { type: "output", pane: `%${next() % 3}`, text: `[${seed}:${id}]\n\\\x00` };
    if (kind === 2) return { type: "hook", text: `hook-${seed}-${id}` };
    const error = next() % 4 === 0;
    return {
      type: "command",
      id,
      count: 1 + (next() % 4),
      error,
      overflow: !error && next() % 4 === 0,
    };
  });
}

function replay(actions: readonly Action[], seed: number, mutation?: Mutation): void {
  const actual: Observation[] = [];
  const expected: Observation[] = [];
  const observe = (event: Observation) => {
    if (event.type === "output" && mutation === "lost-output") return;
    actual.push(
      event.type === "reply" && mutation === "misrouted-reply"
        ? { ...event, id: event.id + 1 }
        : event,
    );
    if (event.type === "output" && mutation === "duplicate-output") actual.push(event);
  };
  const core = new ControlChannelCore({
    onOutput: (pane, bytes) =>
      observe({ type: "output", pane, text: Buffer.from(bytes).toString() }),
    onNotify: () => {},
    onExit: () => {
      throw new BoundaryInvariant("legal schedule disconnected");
    },
  });
  // Attach has one unsolicited flags=0 reply. It must be consumed before hooks
  // can be distinguished from command replies by their flags.
  core.pushCommandList(1, 0, () => {});
  let number = 0;
  const block = (flags: number, lines: string[], error = false) =>
    [
      `%begin 100 ${++number} ${flags}`,
      ...lines,
      `%${error ? "error" : "end"} 100 ${number} ${flags}`,
      "",
    ].join("\n");
  let wire = block(0, []);
  for (const action of actions) {
    if (action.type === "output") {
      expected.push(action);
      const encoded = [...Buffer.from(action.text)]
        .map((byte) =>
          byte < 32 || byte === 92
            ? `\\${byte.toString(8).padStart(3, "0")}`
            : String.fromCharCode(byte),
        )
        .join("");
      wire += `%output ${action.pane} ${encoded}\n`;
    } else if (action.type === "hook") {
      wire += block(0, [action.text]);
    } else {
      const lines = action.error
        ? [`error-${action.id}`]
        : action.overflow
          ? [`reply-${action.id}`, "exceeds-line-budget"]
          : [`reply-${action.id}`];
      core.pushBoundedCommandList(
        action.count,
        action.count - 1,
        { maxBytes: 1024, maxLines: 1 },
        (reply) => observe({ type: "reply", id: action.id, ...reply }),
      );
      // A first-command error aborts the remaining commands in that parsed
      // group. Later independently queued groups still have their own replies.
      if (action.error) wire += block(1, lines, true);
      else
        for (let index = 0; index < action.count; index++)
          wire += block(1, index === action.count - 1 ? lines : []);
      expected.push({
        type: "reply",
        id: action.id,
        ok: !action.error && !action.overflow,
        lines: action.overflow ? [] : lines,
      });
    }
  }
  const next = random(seed ^ 0xabcdef);
  for (let offset = 0; offset < wire.length; ) {
    // Includes one-byte fragmentation and coalescing across several blocks.
    const length = next() % 7 === 0 ? 1 : 1 + (next() % 1024);
    core.feed(wire.slice(offset, offset + length));
    offset += length;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new BoundaryInvariant(`delivery mismatch: ${JSON.stringify({ expected, actual })}`);
  if (core.pendingCount !== 0)
    throw new BoundaryInvariant(`unspent reply slots: ${core.pendingCount}`);
}

function reduce(actions: readonly Action[], fails: (candidate: readonly Action[]) => boolean) {
  let reduced = [...actions];
  for (
    let size = Math.max(1, Math.floor(reduced.length / 2));
    size >= 1;
    size = Math.floor(size / 2)
  ) {
    for (let start = 0; start < reduced.length; ) {
      const candidate = [...reduced.slice(0, start), ...reduced.slice(start + size)];
      if (fails(candidate)) reduced = candidate;
      else start += size;
    }
  }
  return reduced;
}

function invariantFails(actions: readonly Action[], seed: number, mutation?: Mutation) {
  try {
    replay(actions, seed, mutation);
    return false;
  } catch (error) {
    if (error instanceof BoundaryInvariant) return true;
    throw error;
  }
}

function verify(seed: number) {
  const original = generate(seed);
  try {
    replay(original, seed);
  } catch (error) {
    if (!(error instanceof BoundaryInvariant)) throw error;
    const reduced = reduce(original, (candidate) => invariantFails(candidate, seed));
    const receipt = join(mkdtempSync(join(tmpdir(), "tmux-control-model-")), "failure.json");
    writeFileSync(
      receipt,
      JSON.stringify({ seed, original, reduced, failure: error.message }, null, 2),
    );
    throw new Error(`Control model failure retained at ${receipt}`, { cause: error });
  }
}

describe("generated legal control reply schedules", () => {
  it("covers every group size with success, error and overflow", () => {
    const covered = new Set<string>();
    for (let seed = 1; seed <= 1152; seed++)
      for (const action of generate(seed))
        if (action.type === "command")
          covered.add(
            `${action.count}:${action.error ? "error" : action.overflow ? "overflow" : "success"}`,
          );
    expect([...covered].sort()).toEqual(
      [1, 2, 3, 4]
        .flatMap((count) => ["success", "error", "overflow"].map((result) => `${count}:${result}`))
        .sort(),
    );
  });
  it.each(Array.from({ length: 128 }, (_, index) => index + 1))(
    "preserves wire ownership for seed %i",
    verify,
  );

  it("preserves ownership across a bounded wider campaign of 1024 seeds", () => {
    for (let seed = 129; seed <= 1152; seed++) verify(seed);
  });

  it.each<Mutation>(["duplicate-output", "lost-output", "misrouted-reply"])(
    "detects and reduces %s without changing the invariant",
    (mutation) => {
      const seed = 73;
      const original = generate(seed);
      expect(invariantFails(original, seed, mutation)).toBe(true);
      const reduced = reduce(original, (candidate) => invariantFails(candidate, seed, mutation));
      expect(reduced.length).toBeLessThan(original.length);
      expect(reduced).toHaveLength(1);
      expect(invariantFails(reduced, seed, mutation)).toBe(true);
      replay(original, seed);
      replay(reduced, seed);
      const receipt = join(mkdtempSync(join(tmpdir(), "tmux-control-model-")), "negative.json");
      writeFileSync(receipt, JSON.stringify({ seed, mutation, original, reduced }, null, 2));
      console.info(`Verified negative control retained at ${receipt}`);
    },
  );
});
