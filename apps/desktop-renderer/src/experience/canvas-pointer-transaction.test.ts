import { describe, expect, it } from "vitest";

import {
  beginCanvasMove,
  beginCanvasResize,
  cancelCanvasPointerTransaction,
  commitCanvasPointerTransaction,
  updateCanvasPointerTransaction,
} from "./canvas-pointer-transaction.ts";

const BASE = {
  pointer: { pointerId: 7, x: 200, y: 100 },
  windowId: "window.lead",
  rect: { x: 40, y: 30, width: 320, height: 240 },
  transform: { x: 50, y: -30, scale: 2 },
  constraints: { minWidth: 160, minHeight: 120 },
};

describe("canvas pointer transactions", () => {
  it("converts drag deltas through the transaction's zoom snapshot", () => {
    const transaction = beginCanvasMove(BASE);
    const update = updateCanvasPointerTransaction(transaction, {
      pointerId: 7,
      x: 300,
      y: 60,
    });

    expect(update.frame).toEqual({
      phase: "transient",
      rect: { x: 90, y: 10, width: 320, height: 240 },
      persist: false,
      commands: [],
    });
  });

  it("resizes north-west under zoom and commits one atomic full-rect command", () => {
    let transaction = beginCanvasResize({ ...BASE, edge: "north-west" });
    ({ transaction } = updateCanvasPointerTransaction(transaction, {
      pointerId: 7,
      x: 160,
      y: 60,
    }));

    expect(transaction.currentRect).toEqual({ x: 20, y: 10, width: 340, height: 260 });
    expect(commitCanvasPointerTransaction(transaction)).toEqual({
      phase: "committed",
      rect: { x: 20, y: 10, width: 340, height: 260 },
      persist: true,
      commands: [
        {
          command: {
            type: "window.float",
            windowId: "window.lead",
            rect: { x: 20, y: 10, width: 340, height: 260 },
          },
          source: "mouse",
        },
      ],
    });
  });

  it("never emits persistence or commands during live updates", () => {
    let transaction = beginCanvasMove(BASE);
    for (const [x, y] of [
      [220, 110],
      [260, 130],
      [300, 160],
    ] as const) {
      const update = updateCanvasPointerTransaction(transaction, { pointerId: 7, x, y });
      transaction = update.transaction;
      expect(update.frame.persist).toBe(false);
      expect(update.frame.commands).toEqual([]);
    }
    expect(commitCanvasPointerTransaction(transaction).persist).toBe(true);
  });

  it("cancels back to the original rect with no durable command", () => {
    const started = beginCanvasMove(BASE);
    const { transaction } = updateCanvasPointerTransaction(started, {
      pointerId: 7,
      x: 400,
      y: 300,
    });
    expect(cancelCanvasPointerTransaction(transaction)).toEqual({
      phase: "cancelled",
      rect: BASE.rect,
      persist: false,
      commands: [],
    });
  });

  it("ignores updates from a different pointer", () => {
    const started = beginCanvasMove(BASE);
    const update = updateCanvasPointerTransaction(started, { pointerId: 8, x: 600, y: 600 });
    expect(update.transaction).toBe(started);
    expect(update.frame.rect).toBe(BASE.rect);
  });

  it("does not persist a click without geometry change", () => {
    expect(commitCanvasPointerTransaction(beginCanvasMove(BASE))).toEqual({
      phase: "committed",
      rect: BASE.rect,
      persist: false,
      commands: [],
    });
  });

  it("has identical semantics for full and reduced motion presentation", () => {
    const full = beginCanvasResize({
      ...BASE,
      edge: "south-east",
      presentation: { reducedMotion: false },
    });
    const reduced = beginCanvasResize({
      ...BASE,
      edge: "south-east",
      presentation: { reducedMotion: true },
    });
    const pointer = { pointerId: 7, x: 240, y: 140 };

    expect(updateCanvasPointerTransaction(reduced, pointer)).toEqual(
      updateCanvasPointerTransaction(full, pointer),
    );
  });

  it("uses the caller's custom zoom range for pointer deltas", () => {
    const started = beginCanvasMove({
      ...BASE,
      transform: { x: 0, y: 0, scale: 0.1 },
      scaleRange: { min: 0.05, max: 0.2 },
    });
    const update = updateCanvasPointerTransaction(started, {
      pointerId: 7,
      x: 220,
      y: 110,
    });
    expect(update.frame.rect).toEqual({ x: 240, y: 130, width: 320, height: 240 });
  });
});
