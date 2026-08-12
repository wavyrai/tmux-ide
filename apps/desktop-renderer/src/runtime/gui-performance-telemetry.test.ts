import { describe, expect, it, vi } from "vitest";

import {
  GuiPerformanceTelemetry,
  guiPerformanceHudRequested,
} from "./gui-performance-telemetry.ts";

class FrameHarness {
  callback: ((atMs: number) => void) | null = null;
  requests = 0;
  readonly schedule = (callback: (atMs: number) => void): (() => void) => {
    this.requests += 1;
    this.callback = callback;
    return () => {
      if (this.callback === callback) this.callback = null;
    };
  };
  flush(atMs: number): void {
    const callback = this.callback;
    this.callback = null;
    callback?.(atMs);
  }
}

describe("GuiPerformanceTelemetry", () => {
  it("opts in only through the explicit performance HUD query", () => {
    expect(guiPerformanceHudRequested("?performanceHud=1")).toBe(true);
    expect(guiPerformanceHudRequested("?performanceHud=0")).toBe(false);
    expect(guiPerformanceHudRequested("?other=1")).toBe(false);
  });

  it("does no clock or frame work while disabled", () => {
    const now = vi.fn(() => 10);
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({ now, scheduleFrame: frames.schedule });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    expect(telemetry.beginParse()).toBeNull();
    expect(telemetry.beginPaint()).toBeNull();
    telemetry.recordQueueDepth(1, 2);
    telemetry.recordRevisionLag(1);
    telemetry.recordReseed();
    telemetry.recordRendered(12);
    expect(now).not.toHaveBeenCalled();
    expect(frames.requests).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("coalesces multiple panes into one browser-frame FPS and publication", () => {
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({ scheduleFrame: frames.schedule });
    const listener = vi.fn();
    telemetry.enable();
    telemetry.subscribe(listener);
    telemetry.recordRendered(3);
    telemetry.recordRendered(4);
    expect(frames.requests).toBe(1);
    frames.flush(16);
    expect(telemetry.snapshot()?.dirtyRows.latest).toBe(7);
    expect(telemetry.snapshot()?.activeFps).toBeNull();
    telemetry.recordRendered(5);
    telemetry.recordRendered(6);
    frames.flush(32);
    expect(telemetry.snapshot()?.dirtyRows.latest).toBe(11);
    expect(telemetry.snapshot()?.activeFps).toBeCloseTo(62.5);
    expect(listener).toHaveBeenCalledTimes(3); // initial null + two browser frames
  });

  it("resets the FPS baseline after idle so the first resumed frame has no stale rate", () => {
    const frames = new FrameHarness();
    const idle: { current: (() => void) | null } = { current: null };
    const telemetry = new GuiPerformanceTelemetry({
      scheduleFrame: frames.schedule,
      scheduleIdle: (callback) => {
        idle.current = callback;
        return () => {
          idle.current = null;
        };
      },
    });
    telemetry.enable();
    telemetry.recordRendered(1);
    frames.flush(10);
    telemetry.recordRendered(1);
    frames.flush(20);
    expect(telemetry.snapshot()?.activeFps).toBe(100);
    idle.current?.();
    frames.flush(30);
    expect(telemetry.snapshot()?.activeFps).toBeNull();
    telemetry.recordRendered(1);
    frames.flush(100);
    expect(telemetry.snapshot()?.activeFps).toBeNull();
  });

  it("separates parse completion from paint settlement at a real render", () => {
    let now = 5;
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({
      now: () => now,
      scheduleFrame: frames.schedule,
      scheduleIdle: () => () => undefined,
    });
    telemetry.enable();
    frames.flush(0);
    const parse = telemetry.beginParse();
    const paint = telemetry.beginPaint();
    now = 8;
    parse?.();
    paint?.commit();
    frames.flush(9);
    expect(telemetry.snapshot()?.parseMs.latest).toBe(3);
    expect(telemetry.snapshot()?.paintMs.count).toBe(0);
    telemetry.recordRendered(2);
    frames.flush(17);
    expect(telemetry.snapshot()?.paintMs.latest).toBe(12);
  });

  it("publishes one snapshot for a delivery burst and isolates listener failures", () => {
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({ scheduleFrame: frames.schedule });
    telemetry.enable();
    frames.flush(0);
    telemetry.subscribe(() => {
      throw new Error("observer failed");
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.recordQueueDepth(2, 8);
    telemetry.recordRevisionLag(3);
    telemetry.recordReseed();
    telemetry.recordRendered(4);
    telemetry.commitDelivery();
    expect(frames.requests).toBe(2);
    frames.flush(16);
    expect(listener).toHaveBeenCalledTimes(2); // initial null + one burst snapshot
  });

  it("discards stale parse and paint completions across authority epochs", () => {
    let now = 1;
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({
      now: () => now,
      scheduleFrame: frames.schedule,
    });
    telemetry.enable();
    const parse = telemetry.beginParse();
    const paint = telemetry.beginPaint();
    telemetry.setAuthority({
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "workspace-b",
      generation: "44444444-4444-4444-8444-444444444444",
      incarnation: null,
    });
    now = 10;
    parse?.();
    paint?.commit();
    telemetry.recordRendered(1);
    frames.flush(16);
    expect(telemetry.snapshot()).toMatchObject({
      authority: { workspaceName: "workspace-b" },
      parseMs: { count: 0 },
      paintMs: { count: 0 },
    });
  });

  it("cancels pending work and listeners on disposal", () => {
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({ scheduleFrame: frames.schedule });
    telemetry.enable();
    const listener = vi.fn();
    telemetry.subscribe(listener);
    const paint = telemetry.beginPaint();
    telemetry.dispose();
    paint?.commit();
    frames.flush(16);
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.snapshot()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });
});
