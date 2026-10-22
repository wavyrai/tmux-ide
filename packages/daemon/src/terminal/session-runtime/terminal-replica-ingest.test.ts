import { describe, expect, it } from "vitest";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { createXtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";
import type { TerminalInterpreterBackendFactory } from "./terminal-interpreter-backend.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";
const cap = 256 * 1024;
const generation = "00000000-0000-4000-8000-000000000001";
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | string) =>
  typeof data === "string" ? data : new TextDecoder().decode(data);
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function rig(parse = true, controlledTimers = false) {
  let recover: (() => void) | null = null;
  const gate = deferred(),
    started = deferred();
  const writes: Uint8Array[] = [];
  const events: string[] = [];
  let blocked = true;
  let currentGate = gate,
    currentStarted = started;
  const backendFactory: TerminalInterpreterBackendFactory = (options) => {
    const delegate = createXtermTerminalInterpreterBackend(options);
    return new Proxy(delegate, {
      get(target, property) {
        if (property === "write")
          return async (data: Uint8Array | string) => {
            writes.push(typeof data === "string" ? bytes(data) : data.slice());
            events.push(`write:${text(data).slice(0, 20)}`);
            if (blocked) {
              blocked = false;
              currentStarted.resolve();
              await currentGate.promise;
            }
            if (parse) await target.write(data);
          };
        if (property === "resize")
          return (cols: number, rows: number) => {
            events.push(`resize:${cols}x${rows}`);
            target.resize(cols, rows);
          };
        if (property === "dispose")
          return () => {
            events.push("dispose");
            target.dispose();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const replica = new TerminalReplicaInterpreter({
    generation,
    workspaceName: "workspace",
    semanticPaneId: "pane-a",
    incarnation: `${generation}:0`,
    cols: 80,
    rows: 4,
    backendFactory,
    ...(controlledTimers
      ? {
          scheduler: {
            nowMs: () => 0,
            createId: () => "ingest-test",
            microtask: queueMicrotask,
            timer: (task: () => void) => {
              recover = task;
              return {
                cancel: () => {
                  if (recover === task) recover = null;
                },
              };
            },
          },
        }
      : {}),
  });
  const write = (data: string | Uint8Array, trace?: SessionRuntimeTraceContext) =>
    replica.enqueue({ type: "write", data: typeof data === "string" ? bytes(data) : data, trace });
  return {
    replica,
    write,
    writes,
    events,
    gate,
    started,
    recover: () => {
      if (!recover) throw new Error("No recovery scheduled");
      recover();
    },
    holdNext: () => {
      currentGate = deferred();
      currentStarted = deferred();
      blocked = true;
      return { gate: currentGate, started: currentStarted };
    },
  };
}
const close = (replica: TerminalReplicaInterpreter) =>
  replica.enqueue({ type: "close", reason: "runtime-disposed" });
describe("bounded in-flight terminal ingest", () => {
  it("coalesces different event-loop arrivals behind a blocked parser", async () => {
    const r = rig();
    const first = r.write("A");
    await r.started.promise;
    const later: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      later.push(r.write("b"));
      await Promise.resolve();
    }
    expect(r.writes).toHaveLength(1);
    const idle = r.replica.whenIdle();
    r.gate.resolve();
    await Promise.all([first, ...later, idle]);
    expect(r.writes.map(text)).toEqual(["A", "b".repeat(20)]);
    await close(r.replica);
  });
  it("caps batches including an oversized individual write without losing bytes", async () => {
    const r = rig(false);
    const input = bytes("x".repeat(cap * 2 + 19));
    const write = r.write(input);
    await r.started.promise;
    input.fill(121);
    r.gate.resolve();
    await write;
    await r.replica.whenIdle();
    expect(r.writes.map((x) => x.length)).toEqual([cap, cap, 19]);
    expect(Buffer.concat(r.writes).equals(Buffer.alloc(cap * 2 + 19, 120))).toBe(true);
    await close(r.replica);
  });
  it("seals trace, resize and idle boundaries while allowing later input", async () => {
    const r = rig();
    const trace = (traceId: string): SessionRuntimeTraceContext => ({
      traceId,
      scenario: "ingest",
      authority: { generation, incarnation: null },
    });
    const a = r.write("A", trace("a"));
    await r.started.promise;
    const b = r.write("B", trace("b"));
    await Promise.resolve();
    const c = r.write("C", trace("a"));
    const resize = r.replica.enqueue({ type: "resize", cols: 90, rows: 4 });
    const d = r.write("D");
    const idle = r.replica.whenIdle();
    const e = r.write("E");
    r.gate.resolve();
    await Promise.all([a, b, c, resize, d, idle, e]);
    expect(r.events.slice(0, 6)).toEqual([
      "write:A",
      "write:B",
      "write:C",
      "resize:90x4",
      "write:D",
      "write:E",
    ]);
    await close(r.replica);
  });
  it("rejects failed grouped writes, then drains reseed and retirement in order", async () => {
    const r = rig();
    const a = r.write("bad");
    await r.started.promise;
    const b = r.write("also bad");
    const settled = Promise.allSettled([a, b]);
    const reset = r.replica.enqueue({
      type: "reseed",
      cols: 80,
      rows: 4,
      chunks: [bytes("reset")],
      cursor: { x: 5, y: 0 },
      bootstrap: "authoritative-stream",
    });
    const after = r.write("!");
    const retired = close(r.replica);
    const late = r.write("discarded");
    r.gate.reject(new Error("parser failure"));
    expect((await settled).map((x) => x.status)).toEqual(["rejected", "rejected"]);
    await Promise.all([reset, after, retired, late, r.replica.whenIdle()]);
    expect(r.events).toEqual(["write:bad", "write:reset", "dispose", "write:!", "dispose"]);
    expect(
      r.replica
        .currentSnapshot()
        .grid[0]!.cells.slice(0, 6)
        .map((x) => x.grapheme)
        .join(""),
    ).toBe("reset!");
  });
  it("preserves UTF-8 graphemes and split escape sequences across the byte cap", async () => {
    const r = rig();
    const data = bytes("\x1b[0m".repeat(cap / 4 - 1) + "abc🙂e\u0301\x1b[31mZ");
    const pending = r.write(data);
    await r.started.promise;
    r.gate.resolve();
    await pending;
    expect(Math.max(...r.writes.map((x) => x.length))).toBeLessThanOrEqual(cap);
    const cells = r.replica.currentSnapshot().grid[0]!.cells;
    expect(cells.slice(0, 7).map((x) => x.grapheme)).toEqual(["a", "b", "c", "🙂", "", "é", "Z"]);
    expect(cells[6]!.foreground).toEqual({ kind: "indexed", index: 1 });
    await close(r.replica);
  });
  it("idle fences only earlier bytes and does not wait for future blocked writes", async () => {
    const r = rig();
    const first = r.write("A");
    await r.started.promise;
    const beforeIdle = r.write("B");
    let idleSettled = false;
    const idle = r.replica.whenIdle().then(() => {
      idleSettled = true;
    });
    const later = r.holdNext();
    const afterIdle = r.write("C");
    // B belongs to the first sealed group and is the next parser admission.
    r.gate.resolve();
    await later.started.promise;
    expect(idleSettled).toBe(false);
    const future = r.holdNext();
    later.gate.resolve();
    await Promise.all([first, beforeIdle, idle]);
    await future.started.promise;
    expect(idleSettled).toBe(true);
    future.gate.resolve();
    await afterIdle;
    expect(r.writes.map(text)).toEqual(["A", "B", "C"]);
    await close(r.replica);
  });

  it("coalesces split APC input without leaking payload and preserves reset after EOF", async () => {
    const r = rig();
    const first = r.write("start");
    await r.started.promise;
    const apc = bytes("\x1b_Ga=T,f=32,s=1,v=1,i=42,U=1;AAAA/w==\x1b\\done");
    const queued: Promise<void>[] = [];
    for (let i = 0; i < apc.length; i += 3) {
      queued.push(r.write(apc.subarray(i, i + 3)));
      await Promise.resolve();
    }
    const retired = close(r.replica);
    r.gate.resolve();
    await Promise.all([first, ...queued, retired]);
    expect(
      r.replica
        .currentSnapshot()
        .grid[0]!.cells.map((x) => x.grapheme)
        .join("")
        .trim(),
    ).toBe("startdone");
    expect(r.writes).toHaveLength(2);
    await r.write("after EOF");
    await r.replica.whenIdle();
    expect(r.writes).toHaveLength(2);
  });
  it("bounds forwarded parser bytes when the scanner prepends a held escape", async () => {
    const r = rig(false);
    const first = r.write("A\x1b");
    await r.started.promise;
    const next = r.write("[0m" + "x".repeat(cap - 3));
    r.gate.resolve();
    await Promise.all([first, next]);
    expect(Math.max(...r.writes.map((x) => x.length))).toBeLessThanOrEqual(cap);
    expect(Buffer.concat(r.writes).equals(bytes("A\x1b[0m" + "x".repeat(cap - 3)))).toBe(true);
    await close(r.replica);
  });

  it("does not resolve an oversized enqueue until its final fragment succeeds", async () => {
    const r = rig(false);
    let settled = false;
    const large = r.write("x".repeat(cap + 1));
    const observed = large.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await r.started.promise;
    const second = r.holdNext();
    r.gate.resolve();
    await second.started.promise;
    expect(settled).toBe(false);
    second.gate.reject(new Error("second fragment failed"));
    expect((await Promise.allSettled([large]))[0]!.status).toBe("rejected");
    await observed;
    await close(r.replica);
    await r.replica.whenIdle();
  });
  it("keeps synthetic synchronized-output recovery between earlier and later writes", async () => {
    const r = rig(true, true);
    const initial = r.write("\x1b[?2026hA");
    await r.started.promise;
    r.gate.resolve();
    await initial;
    const blocked = r.holdNext();
    const before = r.write("B");
    await blocked.started.promise;
    r.recover();
    const after = r.write("C");
    blocked.gate.resolve();
    await Promise.all([before, after, r.replica.whenIdle()]);
    expect(r.writes.map(text)).toEqual(["\x1b[?2026hA", "B", "\x1b[?2026l", "C"]);
    await close(r.replica);
  });
});
