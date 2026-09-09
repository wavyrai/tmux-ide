import { describe, expect, it } from "bun:test";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer, ManualClock } from "@opentui/core/testing";

async function drainTasks() {
  await new Promise<void>((resolve) => process.nextTick(resolve));
  await Promise.resolve();
}
async function fixture(maxFps = Infinity) {
  const clock = new ManualClock();
  const setup = await createTestRenderer({
    width: 40,
    height: 4,
    clock,
    targetFps: 60,
    maxFps,
    useThread: false,
  });
  const text = new TextRenderable(setup.renderer, { id: "demand", content: "BEFORE" });
  setup.renderer.root.add(text);
  await setup.renderOnce();
  await drainTasks();
  return { ...setup, clock, text };
}

describe("actual OpenTUI demand scheduling", () => {
  it("preempts the animation deadline for live demand without leaving duplicate timers", async () => {
    const test = await fixture();
    const { renderer, clock, text } = test;
    try {
      renderer.requestLive();
      await drainTasks();
      clock.advance(1);
      text.content = "AFTER";
      renderer.requestRender();
      renderer.requestRender();
      const before = renderer.frameId;
      clock.advance(0);
      await drainTasks();
      expect(test.captureCharFrame()).toContain("AFTER");
      expect(renderer.frameId).toBe(before + 1);
      const demandFrame = renderer.frameId;
      clock.advance(100);
      await drainTasks();
      // A demand is a one-shot acceleration, not a permanent uncapped live loop.
      expect(renderer.frameId - demandFrame).toBeLessThanOrEqual(8);
      renderer.dropLive();
      await drainTasks();
      const settled = renderer.frameId;
      clock.advance(100);
      await drainTasks();
      expect(renderer.frameId).toBe(settled);
      expect(renderer.getSchedulerState().hasScheduledRender).toBe(false);
    } finally {
      renderer.destroy();
    }
  });

  it("preserves a finite requested frame-rate ceiling while live", async () => {
    const test = await fixture(100);
    const { renderer, clock, text } = test;
    try {
      renderer.requestLive();
      await drainTasks();
      clock.advance(1);
      text.content = "AFTER";
      renderer.requestRender();
      clock.advance(8);
      await drainTasks();
      expect(test.captureCharFrame()).toContain("BEFORE");
      clock.advance(1);
      await drainTasks();
      expect(test.captureCharFrame()).toContain("AFTER");
    } finally {
      renderer.destroy();
    }
  });

  it("retains a demand that arrives during an asynchronous live frame", async () => {
    const test = await fixture();
    const { renderer, clock } = test;
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const callback = () => held;
      renderer.setFrameCallback(callback);
      renderer.requestLive();
      expect(renderer.getSchedulerState().isRendering).toBe(true);
      const activeFrame = renderer.frameId;
      renderer.requestRender();
      renderer.removeFrameCallback(callback);
      release();
      await drainTasks();
      clock.advance(1);
      await drainTasks();
      expect(renderer.frameId).toBe(activeFrame + 1);
      clock.advance(10);
      await drainTasks();
      expect(renderer.frameId).toBe(activeFrame + 1);
    } finally {
      renderer.destroy();
    }
  });

  it("keeps idle demand immediate and does not start polling", async () => {
    const test = await fixture();
    try {
      test.clock.advance(1);
      test.text.content = "AFTER";
      await drainTasks();
      expect(test.captureCharFrame()).toContain("AFTER");
      const settled = test.renderer.frameId;
      test.clock.advance(100);
      await drainTasks();
      expect(test.renderer.frameId).toBe(settled);
      expect(test.renderer.getSchedulerState().isRunning).toBe(false);
    } finally {
      test.renderer.destroy();
    }
  });

  it("does not bypass suspended or outstanding-feed scheduling guards", async () => {
    const test = await fixture();
    const { renderer, clock } = test;
    // Simulate the existing feed-wait scheduler state without replacing the native renderer.
    const state = renderer as unknown as {
      ordinaryFrameWaitingForFeed: boolean;
      feedIdleRenderScheduled: boolean;
    };
    try {
      const before = renderer.frameId;
      for (const key of ["ordinaryFrameWaitingForFeed", "feedIdleRenderScheduled"] as const) {
        state[key] = true;
        renderer.requestRender();
        clock.advance(20);
        await drainTasks();
        expect(renderer.frameId).toBe(before);
        state[key] = false;
      }
      renderer.suspend();
      renderer.requestRender();
      clock.advance(20);
      await drainTasks();
      expect(renderer.frameId).toBe(before);
    } finally {
      state.ordinaryFrameWaitingForFeed = false;
      state.feedIdleRenderScheduled = false;
      renderer.destroy();
    }
  });
});
