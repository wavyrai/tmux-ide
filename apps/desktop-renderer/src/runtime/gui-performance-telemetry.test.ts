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
    const channel = telemetry.createRenderChannel();
    const listener = vi.fn();
    telemetry.subscribe(listener);
    expect(telemetry.beginParse()).toBeNull();
    expect(telemetry.beginPaint(channel)).toBeNull();
    telemetry.recordQueueDepth(1, 2);
    telemetry.recordRevisionLag(1);
    telemetry.recordReseed();
    telemetry.recordRendered(channel, 12);
    expect(now).not.toHaveBeenCalled();
    expect(frames.requests).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("coalesces multiple panes into one browser-frame FPS and publication", () => {
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({ scheduleFrame: frames.schedule });
    const listener = vi.fn();
    telemetry.enable();
    const paneA = telemetry.createRenderChannel();
    const paneB = telemetry.createRenderChannel();
    telemetry.subscribe(listener);
    telemetry.recordRendered(paneA, 3);
    telemetry.recordRendered(paneB, 4);
    expect(frames.requests).toBe(1);
    frames.flush(16);
    expect(telemetry.snapshot()?.dirtyRows.latest).toBe(7);
    expect(telemetry.snapshot()?.activeFps).toBeNull();
    telemetry.recordRendered(paneA, 5);
    telemetry.recordRendered(paneB, 6);
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
    const channel = telemetry.createRenderChannel();
    telemetry.recordRendered(channel, 1);
    frames.flush(10);
    telemetry.recordRendered(channel, 1);
    frames.flush(20);
    expect(telemetry.snapshot()?.activeFps).toBe(100);
    idle.current?.();
    frames.flush(30);
    expect(telemetry.snapshot()?.activeFps).toBeNull();
    telemetry.recordRendered(channel, 1);
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
    const channel = telemetry.createRenderChannel();
    frames.flush(0);
    const parse = telemetry.beginParse();
    const paint = telemetry.beginPaint(channel);
    now = 8;
    parse?.();
    paint?.commit();
    frames.flush(9);
    expect(telemetry.snapshot()?.parseMs.latest).toBe(3);
    expect(telemetry.snapshot()?.paintMs.count).toBe(0);
    telemetry.recordRendered(channel, 2);
    frames.flush(17);
    expect(telemetry.snapshot()?.paintMs.latest).toBe(12);
  });

  it("does not let an unrelated pane render settle another renderer's paint", () => {
    let now = 2;
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({
      now: () => now,
      scheduleFrame: frames.schedule,
    });
    const paneA = telemetry.createRenderChannel();
    const paneB = telemetry.createRenderChannel();
    telemetry.enable();
    const activeA = telemetry.refreshRenderChannel(paneA)!;
    const activeB = telemetry.refreshRenderChannel(paneB)!;
    frames.flush(0);
    const paintA = telemetry.beginPaint(activeA);
    paintA?.commit();
    telemetry.recordRendered(activeB, 4);
    frames.flush(10);
    expect(telemetry.snapshot()?.paintMs.count).toBe(0);
    now = 12;
    telemetry.recordRendered(activeA, 3);
    frames.flush(16);
    expect(telemetry.snapshot()?.paintMs.latest).toBe(14);
  });

  it("ignores late renders from a retired renderer channel", () => {
    let now = 1;
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({
      now: () => now,
      scheduleFrame: frames.schedule,
    });
    telemetry.enable();
    frames.flush(0);
    const retired = telemetry.createRenderChannel();
    const current = telemetry.createRenderChannel();
    telemetry.retireRenderChannel(retired);
    const paint = telemetry.beginPaint(current);
    paint?.commit();
    telemetry.recordRendered(retired, 9);
    frames.flush(8);
    expect(telemetry.snapshot()?.paintMs.count).toBe(0);
    now = 10;
    telemetry.recordRendered(current, 2);
    frames.flush(12);
    expect(telemetry.snapshot()?.paintMs.latest).toBe(11);
  });

  it("keeps channel ownership bounded across refresh and renderer retirement", () => {
    const counts: number[] = [];
    const telemetry = new GuiPerformanceTelemetry({
      scheduleFrame: () => () => undefined,
      onChannelCountChanged: (count) => counts.push(count),
    });
    const initial = telemetry.createRenderChannel();
    expect(counts.at(-1)).toBe(1);
    telemetry.enable();
    const refreshed = telemetry.refreshRenderChannel(initial)!;
    expect(refreshed).not.toBe(initial);
    expect(counts.slice(-2)).toEqual([0, 1]);
    telemetry.retireRenderChannel(refreshed);
    expect(counts.at(-1)).toBe(0);
  });

  it("publishes one snapshot for a delivery burst and isolates listener failures", () => {
    const frames = new FrameHarness();
    const telemetry = new GuiPerformanceTelemetry({ scheduleFrame: frames.schedule });
    telemetry.enable();
    const channel = telemetry.createRenderChannel();
    frames.flush(0);
    telemetry.subscribe(() => {
      throw new Error("observer failed");
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.recordQueueDepth(2, 8);
    telemetry.recordRevisionLag(3);
    telemetry.recordReseed();
    telemetry.recordRendered(channel, 4);
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
    const channel = telemetry.createRenderChannel();
    const parse = telemetry.beginParse();
    const paint = telemetry.beginPaint(channel);
    telemetry.setAuthority({
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "workspace-b",
      generation: "44444444-4444-4444-8444-444444444444",
      incarnation: null,
    });
    now = 10;
    parse?.();
    paint?.commit();
    telemetry.recordRendered(telemetry.refreshRenderChannel(channel), 1);
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
    const channel = telemetry.createRenderChannel();
    const listener = vi.fn();
    telemetry.subscribe(listener);
    const paint = telemetry.beginPaint(channel);
    telemetry.dispose();
    paint?.commit();
    frames.flush(16);
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.snapshot()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  });
});
