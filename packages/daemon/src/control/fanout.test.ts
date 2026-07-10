/**
 * Fan-out bookkeeping: delivery to every sink, idempotent unsubscribe, and
 * the 0→1 / 1→0 edges the server's event tick starts and stops on.
 */
import { describe, expect, it } from "vitest";
import { createFanout } from "./fanout.ts";

describe("createFanout", () => {
  it("delivers each event to every sink", () => {
    const fanout = createFanout<number>();
    const a: number[] = [];
    const b: number[] = [];
    fanout.add((n) => a.push(n));
    fanout.add((n) => b.push(n));
    fanout.emit(1);
    fanout.emit(2);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it("unsubscribe removes only that sink and is idempotent", () => {
    const fanout = createFanout<number>();
    const a: number[] = [];
    const b: number[] = [];
    const offA = fanout.add((n) => a.push(n));
    fanout.add((n) => b.push(n));
    offA();
    offA();
    fanout.emit(7);
    expect(a).toEqual([]);
    expect(b).toEqual([7]);
    expect(fanout.size()).toBe(1);
  });

  it("fires onFirst on 0→1 and onLast on 1→0 (and again on the next cycle)", () => {
    const edges: string[] = [];
    const fanout = createFanout<number>({
      onFirst: () => edges.push("first"),
      onLast: () => edges.push("last"),
    });
    const off1 = fanout.add(() => {});
    const off2 = fanout.add(() => {});
    off1();
    off2();
    const off3 = fanout.add(() => {});
    off3();
    expect(edges).toEqual(["first", "last", "first", "last"]);
  });

  it("drops a throwing sink instead of failing the emit", () => {
    const fanout = createFanout<number>();
    const good: number[] = [];
    fanout.add(() => {
      throw new Error("torn down");
    });
    fanout.add((n) => good.push(n));
    fanout.emit(1);
    fanout.emit(2);
    expect(good).toEqual([1, 2]);
    expect(fanout.size()).toBe(1);
  });
});
