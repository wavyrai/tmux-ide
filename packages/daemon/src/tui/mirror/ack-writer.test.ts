/**
 * Unit tests for the ack-paced xterm writer: never more than one sink write
 * outstanding, order/content preserved, coalescing while in flight.
 */
import { describe, expect, it } from "vitest";
import { AckWriter, concatBytes } from "./ack-writer.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A sink that records writes and lets the test ack them by hand. */
function asyncSink() {
  const writes: Uint8Array[] = [];
  const acks: Array<() => void> = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  const sink = (data: Uint8Array, done: () => void) => {
    writes.push(data);
    outstanding++;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    acks.push(() => {
      outstanding--;
      done();
    });
  };
  return {
    sink,
    writes,
    ack: () => acks.shift()?.(),
    get maxOutstanding() {
      return maxOutstanding;
    },
  };
}

describe("AckWriter", () => {
  it("writes through immediately when idle", () => {
    const s = asyncSink();
    const w = new AckWriter(s.sink);
    w.write(enc.encode("abc"));
    expect(s.writes.length).toBe(1);
    expect(dec.decode(s.writes[0]!)).toBe("abc");
  });

  it("never overlaps writes: chunks during flight wait for the ack", () => {
    const s = asyncSink();
    const w = new AckWriter(s.sink);
    w.write(enc.encode("a"));
    w.write(enc.encode("b"));
    w.write(enc.encode("c"));
    expect(s.writes.length).toBe(1); // b and c buffered behind the unacked write
    expect(w.pendingBytes()).toBe(2);
    s.ack();
    expect(s.writes.length).toBe(2); // one joined follow-up, not two
    expect(dec.decode(s.writes[1]!)).toBe("bc");
    s.ack();
    expect(s.writes.length).toBe(2);
    expect(s.maxOutstanding).toBe(1);
    expect(w.busy()).toBe(false);
  });

  it("preserves byte order and content across an arbitrary burst", () => {
    const s = asyncSink();
    const w = new AckWriter(s.sink);
    const parts = ["one ", "two ", "three ", "four ", "five"];
    w.write(enc.encode(parts[0]!));
    w.write(enc.encode(parts[1]!));
    s.ack();
    w.write(enc.encode(parts[2]!));
    w.write(enc.encode(parts[3]!));
    w.write(enc.encode(parts[4]!));
    s.ack();
    s.ack();
    const all = dec.decode(concatBytes(s.writes));
    expect(all).toBe(parts.join(""));
    expect(s.maxOutstanding).toBe(1);
  });

  it("tolerates a synchronously-acking sink without overlap or loss", () => {
    const writes: string[] = [];
    let depth = 0;
    let maxDepth = 0;
    const w = new AckWriter((data, done) => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      writes.push(dec.decode(data));
      done(); // ack inline, like a fully-drained parser
      depth--;
    });
    w.write(enc.encode("a"));
    w.write(enc.encode("b"));
    expect(writes).toEqual(["a", "b"]);
    expect(maxDepth).toBe(1);
  });

  it("a double-fired sink callback does not double-release the pump", () => {
    const writes: string[] = [];
    const dones: Array<() => void> = [];
    const w = new AckWriter((data, done) => {
      writes.push(dec.decode(data));
      dones.push(done);
    });
    w.write(enc.encode("a"));
    w.write(enc.encode("b")); // buffered behind the unacked "a"
    const doneA = dones[0]!;
    doneA(); // releases the joined follow-up ("b")
    doneA(); // a buggy replay — must NOT release anything else
    expect(writes).toEqual(["a", "b"]);
    expect(w.busy()).toBe(true); // "b" is legitimately still unacked
    dones[1]!();
    expect(w.busy()).toBe(false);
  });

  it("ignores empty writes", () => {
    const s = asyncSink();
    const w = new AckWriter(s.sink);
    w.write(new Uint8Array(0));
    expect(s.writes.length).toBe(0);
    expect(w.busy()).toBe(false);
  });

  it("fires onAck once per completed sink write — the parse-time dirty signal", () => {
    const s = asyncSink();
    let acks = 0;
    const w = new AckWriter(s.sink, () => acks++);
    w.write(enc.encode("a"));
    w.write(enc.encode("b")); // buffers behind the in-flight "a"
    expect(acks).toBe(0); // enqueue alone must not signal
    s.ack(); // "a" parsed → one signal, and "b" pumps
    expect(acks).toBe(1);
    s.ack(); // the joined follow-up parsed
    expect(acks).toBe(2);
    expect(s.writes.length).toBe(2);
  });
});

describe("concatBytes", () => {
  it("joins chunks in order", () => {
    expect(dec.decode(concatBytes([enc.encode("ab"), enc.encode(""), enc.encode("cd")]))).toBe(
      "abcd",
    );
  });
  it("handles the empty list", () => {
    expect(concatBytes([]).length).toBe(0);
  });
});
