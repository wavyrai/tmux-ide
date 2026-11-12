import { describe, expect, it } from "vitest";
import type { CanonicalTerminalReplicaUpdate, CausalCellProbeV1 } from "@tmux-ide/contracts";
import {
  COALESCED_COMMIT_MAX_REST_MS,
  COALESCED_COMMIT_REST_FACTOR,
  TerminalReplicaInterpreter,
} from "./terminal-replica-interpreter.ts";
import type { TerminalInterpreterBackendFactory } from "./terminal-interpreter-backend.ts";
import type { SessionRuntimeScheduler } from "./runtime-scheduler.ts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const encoder = new TextEncoder();

/**
 * A flood: tmux keeps sending while the parser is busy. Every backend write is
 * held until the test releases it, so the next chunks are already queued when
 * the current one finishes parsing.
 */
function flood(clock: { now: number }, commitCostMs = 0) {
  const gates: (() => void)[] = [];
  const gating = { on: false };
  const backendFactory: TerminalInterpreterBackendFactory = (options) => {
    const delegate = createXtermTerminalInterpreterBackend(options);
    return new Proxy(delegate, {
      get(target, property, receiver) {
        if (property === "write")
          return async (data: Uint8Array | string) => {
            await target.write(data);
            if (gating.on) await new Promise<void>((resolve) => gates.push(resolve));
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const scheduler: SessionRuntimeScheduler = {
    nowMs: () => clock.now,
    createId: () => "id",
    microtask: (task) => queueMicrotask(task),
    timer: (task, delayMs) => {
      const handle = setTimeout(task, delayMs);
      return { cancel: () => clearTimeout(handle) };
    },
  };
  const updates: CanonicalTerminalReplicaUpdate[] = [];
  const interpreter = new TerminalReplicaInterpreter({
    generation,
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    incarnation: `${generation}:0`,
    cols: 20,
    rows: 4,
    scrollback: 100,
    backendFactory,
    scheduler,
    onUpdate: (update) => {
      updates.push(update);
      // Publishing happens inside the commit, so this is the commit's own cost.
      clock.now += commitCostMs;
    },
  });
  const releaseNext = async () => {
    for (let turn = 0; turn < 1000 && gates.length === 0; turn++)
      await new Promise((resolve) => setImmediate(resolve));
    // A cold parser (the very first write) can take longer than those turns.
    for (let turn = 0; turn < 400 && gates.length === 0; turn++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    gates.shift()?.();
  };
  /** Release every held write, including ones that reach their gate later, until all settle. */
  const releaseAll = async (pending: readonly Promise<unknown>[]) => {
    let settled = false;
    void Promise.allSettled(pending).then(() => (settled = true));
    while (!settled) {
      gates.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const text = () =>
    [...interpreter.currentSnapshot().history, ...interpreter.currentSnapshot().grid]
      .map((row) =>
        row.cells
          .map((cell) => cell.grapheme || " ")
          .join("")
          .trimEnd(),
      )
      .filter(Boolean);
  return { interpreter, updates, gates, gating, releaseNext, releaseAll, text };
}

const settleAfterSeed = async (f: ReturnType<typeof flood>) => {
  await f.interpreter.enqueue({
    type: "reseed",
    cols: 20,
    rows: 4,
    chunks: [encoder.encode("")],
    cursor: { x: 0, y: 0 },
    bootstrap: "authoritative-stream",
  });
  f.gating.on = true;
};

describe("TerminalReplicaInterpreter commit coalescing (daemon perf F1)", () => {
  it("commits a flood once per display interval, not once per parsed chunk", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const before = f.updates.length;
    const writes: Promise<void>[] = [];
    // The first chunk starts parsing; 30 more arrive while it is busy.
    writes.push(f.interpreter.enqueue({ type: "write", data: encoder.encode("line 0\r\n") }));
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 1; i <= 30; i++) {
      writes.push(f.interpreter.enqueue({ type: "write", data: encoder.encode(`line ${i}\r\n`) }));
      // Each chunk is its own %output: let the group seal between arrivals.
      await new Promise((resolve) => setImmediate(resolve));
      await f.releaseNext();
    }
    await f.releaseAll(writes);
    await Promise.all(writes);
    await f.interpreter.whenIdle();
    const commits = f.updates.length - before;
    // The clock never advanced, so the whole burst is one display interval.
    expect(commits).toBeLessThanOrEqual(2);
    // Nothing is lost: the final state holds every line.
    expect(f.text().at(-1)).toBe("line 30");
    expect(f.text()).toContain("line 15");
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("still publishes at least once per interval while a flood lasts", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const before = f.updates.length;
    const writes: Promise<void>[] = [];
    writes.push(f.interpreter.enqueue({ type: "write", data: encoder.encode("line 0\r\n") }));
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 1; i <= 30; i++) {
      writes.push(f.interpreter.enqueue({ type: "write", data: encoder.encode(`line ${i}\r\n`) }));
      await new Promise((resolve) => setImmediate(resolve));
      clock.now += 20; // longer than a display interval between chunks
      await f.releaseNext();
    }
    await f.releaseAll(writes);
    await Promise.all(writes);
    await f.interpreter.whenIdle();
    expect(f.updates.length - before).toBeGreaterThanOrEqual(10);
    expect(f.text().at(-1)).toBe("line 30");
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("commits a lone keystroke echo at once", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const before = f.updates.length;
    const write = f.interpreter.enqueue({ type: "write", data: encoder.encode("x") });
    await f.releaseNext();
    await write;
    // No whenIdle: the echo must already be published when its write settles.
    expect(f.updates.length - before).toBe(1);
    expect(f.text()).toEqual(["x"]);
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  /** One chunk starts parsing, `count` more arrive `gapMs` apart while it is busy. */
  const pour = async (
    f: ReturnType<typeof flood>,
    clock: { now: number },
    count: number,
    gapMs: number,
  ) => {
    const writes: Promise<void>[] = [];
    writes.push(f.interpreter.enqueue({ type: "write", data: encoder.encode("line 0\r\n") }));
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 1; i <= count; i++) {
      writes.push(f.interpreter.enqueue({ type: "write", data: encoder.encode(`line ${i}\r\n`) }));
      await new Promise((resolve) => setImmediate(resolve));
      clock.now += gapMs;
      await f.releaseNext();
    }
    await f.releaseAll(writes);
    await Promise.all(writes);
    await f.interpreter.whenIdle();
  };

  it("rests for the cost of the last commit before it commits a flood again", async () => {
    // A commit that costs 40 ms, chunks 20 ms apart: counted from the commit's
    // start alone, every chunk would be "late" and commit (the measured flood).
    const clock = { now: 1_000 };
    const f = flood(clock, 40);
    await settleAfterSeed(f);
    const before = f.updates.length;
    await pour(f, clock, 30, 20);
    const commits = f.updates.length - before;
    // 600 ms of output; each commit takes 40 ms and is followed by a rest of
    // 40 ms × the factor, so the commits are far fewer than the 31 chunks.
    const cycleMs = 40 + 40 * COALESCED_COMMIT_REST_FACTOR;
    expect(commits).toBeLessThanOrEqual(Math.ceil((600 + 31 * 40) / cycleMs) + 1);
    expect(commits).toBeLessThanOrEqual(20);
    expect(commits).toBeGreaterThanOrEqual(5);
    expect(f.text().at(-1)).toBe("line 30");
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("never rests longer than the cap, however slow a commit was", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock, 2_000);
    await settleAfterSeed(f);
    const before = f.updates.length;
    // 60 chunks, 20 ms apart: an uncapped rest of 2 s would leave one commit.
    await pour(f, clock, 60, 20);
    const commits = f.updates.length - before;
    expect(COALESCED_COMMIT_MAX_REST_MS).toBe(100);
    expect(COALESCED_COMMIT_REST_FACTOR).toBe(1);
    expect(commits).toBeGreaterThanOrEqual(8);
    expect(f.text().at(-1)).toBe("line 60");
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("commits at once while a causal-cell probe is armed, even with output queued", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const seed = f.interpreter.currentSeed()!;
    const blank = seed.snapshot.grid[0]!.cells[0]!;
    const probe: CausalCellProbeV1 = {
      version: 1,
      capability: "causal-cell-v1",
      traceId: "00000000-0000-4000-8000-000000000099",
      clientId: "client:test",
      transportNonce: "00000000-0000-4000-8000-000000000010",
      deliveryNonce: "00000000-0000-4000-8000-000000000011",
      inputSequence: 1,
      semanticPaneId: "pane-a",
      generation,
      incarnation: `${generation}:0`,
      baselineRevision: seed.revision,
      baselineStateHash: seed.stateHash,
      geometry: { cols: 20, rows: 4, row: 0, column: 0 },
      before: blank,
      after: { ...blank, grapheme: "x" },
    };
    const results: { status: string }[] = [];
    f.interpreter.armCausalCellProbe(probe, (result) => results.push(result));
    const before = f.updates.length;
    // The echo the probe is timing, with more output already queued behind it
    // and the seed's commit under one display interval old.
    const echo = f.interpreter.enqueue({ type: "write", data: encoder.encode("x") });
    await new Promise((resolve) => setImmediate(resolve));
    const later = [
      f.interpreter.enqueue({ type: "write", data: encoder.encode("y") }),
      f.interpreter.enqueue({ type: "write", data: encoder.encode("z") }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    await f.releaseNext();
    await echo;
    // Published on the echo's own write: the probe saw its commit.
    expect(f.updates.length - before).toBe(1);
    expect(results).toHaveLength(1);
    await f.releaseAll(later);
    await Promise.all(later);
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("publishes the bootstrap seed on the first write, even with output queued", async () => {
    // The clock stands at 0: only "no commit has run yet" makes this write due.
    const clock = { now: 0 };
    const f = flood(clock);
    f.gating.on = true;
    const first = f.interpreter.enqueue({ type: "write", data: encoder.encode("first\r\n") });
    await new Promise((resolve) => setImmediate(resolve));
    const later = [
      f.interpreter.enqueue({ type: "write", data: encoder.encode("second\r\n") }),
      f.interpreter.enqueue({ type: "write", data: encoder.encode("third\r\n") }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    await f.releaseNext();
    await first;
    expect(f.updates.map((update) => update.type)).toEqual(["terminal.seed"]);
    await f.releaseAll(later);
    await Promise.all(later);
    await f.interpreter.whenIdle();
    expect(f.text()).toEqual(["first", "second", "third"]);
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("publishes a skipped commit when the queued write behind it is all image payload", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const before = f.updates.length;
    // "seen" and the start of a kitty image; the next chunk is payload only,
    // so the parser is never called for it and nothing else is queued.
    const text = f.interpreter.enqueue({
      type: "write",
      data: encoder.encode("seen\u001b_Ga=T,f=100,m=1;AAAA"),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const payload = f.interpreter.enqueue({ type: "write", data: encoder.encode("BBBB") });
    await new Promise((resolve) => setImmediate(resolve));
    await f.releaseNext();
    await Promise.all([text, payload]);
    await f.interpreter.whenIdle();
    expect(f.updates.length - before).toBe(1);
    expect(f.text()).toEqual(["seen"]);
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("does not publish a half-drawn synchronized update from the image-payload path", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const before = f.updates.length;
    const first = f.interpreter.enqueue({ type: "write", data: encoder.encode("seen\r\n") });
    await new Promise((resolve) => setImmediate(resolve));
    // Queued behind it: a synchronized update opens, draws part of its frame
    // and starts an image. The first write's commit is skipped for this one.
    const partial = f.interpreter.enqueue({
      type: "write",
      data: encoder.encode("\u001b[?2026hPARTIAL\u001b_Ga=T,f=100,m=1;AAAA"),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await f.releaseNext();
    await first;
    // Payload only, nothing queued behind it, and the update is still open.
    const payload = f.interpreter.enqueue({ type: "write", data: encoder.encode("BBBB") });
    await new Promise((resolve) => setImmediate(resolve));
    await f.releaseNext();
    await Promise.all([partial, payload]);
    expect(f.updates.length - before).toBe(0);
    expect(f.text()).toEqual([]);
    // The end of the update publishes the skipped commit with the whole frame.
    f.gating.on = false;
    await f.interpreter.enqueue({
      type: "write",
      data: encoder.encode("\u001b\\ DONE\u001b[?2026l"),
    });
    await f.interpreter.whenIdle();
    expect(f.updates.length - before).toBe(1);
    expect(f.text()[0]).toBe("seen");
    expect(f.text()[1]).toContain("PARTIAL");
    expect(f.text()[1]).toContain("DONE");
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });

  it("counts a newer untraced group waiting behind a finished one as queued output", async () => {
    const clock = { now: 1_000 };
    const f = flood(clock);
    await settleAfterSeed(f);
    const before = f.updates.length;
    const first = f.interpreter.enqueue({ type: "write", data: encoder.encode("one\r\n") });
    await new Promise((resolve) => setImmediate(resolve));
    // Seal the running group: the next write starts a new group behind it.
    const idle = f.interpreter.whenIdle();
    const second = f.interpreter.enqueue({ type: "write", data: encoder.encode("two\r\n") });
    await new Promise((resolve) => setImmediate(resolve));
    await f.releaseNext();
    await first;
    // The first group is empty, but output waits in the next: no commit yet.
    expect(f.updates.length - before).toBe(0);
    await f.releaseAll([second]);
    await Promise.all([second, idle]);
    await f.interpreter.whenIdle();
    expect(f.updates.length - before).toBe(1);
    expect(f.text()).toEqual(["one", "two"]);
    await f.interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
  });
});
