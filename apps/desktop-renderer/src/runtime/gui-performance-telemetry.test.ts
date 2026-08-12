import { describe, expect, it, vi } from "vitest";

import {
  GuiPerformanceTelemetry,
  guiPerformanceHudRequested,
} from "./gui-performance-telemetry.ts";

describe("GuiPerformanceTelemetry", () => {
  it("opts in only through the explicit performance HUD query", () => {
    expect(guiPerformanceHudRequested("?performanceHud=1")).toBe(true);
    expect(guiPerformanceHudRequested("?performanceHud=0")).toBe(false);
    expect(guiPerformanceHudRequested("?other=1")).toBe(false);
  });
  it("does no clock work or allocation-visible publication while disabled", () => {
    const now = vi.fn(() => 10);
    const telemetry = new GuiPerformanceTelemetry({ now, sampleCapacity: 2 });
    const listener = vi.fn();
    const unsubscribe = telemetry.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(null);
    expect(telemetry.beginParse()).toBeNull();
    expect(telemetry.beginPaint()).toBeNull();
    telemetry.recordQueueDepth(1, 2);
    telemetry.recordRevisionLag(1);
    telemetry.recordReseed();
    telemetry.recordRendered(12);
    expect(now).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("retargets authority without retaining metrics from another workspace", () => {
    const telemetry = new GuiPerformanceTelemetry({ scheduleIdle: () => () => undefined });
    telemetry.enable();
    telemetry.recordReseed();
    telemetry.setAuthority({
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      workspaceName: "workspace-b",
      generation: "44444444-4444-4444-8444-444444444444",
      incarnation: null,
    });
    expect(telemetry.snapshot()).toMatchObject({
      authority: {
        daemonInstanceId: "22222222-2222-4222-8222-222222222222",
        workspaceName: "workspace-b",
        generation: "44444444-4444-4444-8444-444444444444",
        incarnation: null,
      },
      reseeds: 0,
      activeFps: null,
    });
  });

  it("records only settled real events in bounded exact windows", () => {
    let now = 0;
    const idle: { current: (() => void) | null } = { current: null };
    const telemetry = new GuiPerformanceTelemetry({
      now: () => now,
      sampleCapacity: 2,
      scheduleIdle: (callback) => {
        idle.current = callback;
        return () => {
          idle.current = null;
        };
      },
    });
    telemetry.enable();
    const parse = telemetry.beginParse();
    now = 2;
    parse?.();
    now = 10;
    const firstPaint = telemetry.beginPaint();
    now = 14;
    firstPaint?.();
    telemetry.commitDelivery();
    now = 20;
    telemetry.recordRendered(4);
    now = 26;
    const secondPaint = telemetry.beginPaint();
    now = 30;
    secondPaint?.();
    telemetry.commitDelivery();
    now = 36;
    telemetry.recordRendered(8);
    telemetry.recordQueueDepth(2, 8);
    telemetry.recordQueueDepth(0, 8);
    telemetry.recordRevisionLag(3);
    telemetry.recordRevisionLag(0);
    telemetry.recordReseed();
    const snapshot = telemetry.snapshot()!;
    expect(snapshot.source).toBe("web");
    expect(snapshot.parseMs).toMatchObject({ count: 1, latest: 2, p95: 2 });
    expect(snapshot.paintMs).toMatchObject({ count: 2, latest: 4, p95: 4 });
    expect(snapshot.dirtyRows).toMatchObject({ count: 2, latest: 8, p95: 8 });
    expect(snapshot.activeFps).toBeCloseTo(62.5);
    expect(snapshot.queueDepth).toMatchObject({ current: 0, peak: 2 });
    expect(snapshot.revisionLag).toEqual({ current: 0, peak: 3 });
    expect(snapshot.reseeds).toBe(1);
    idle.current?.();
    expect(telemetry.snapshot()?.activeFps).toBeNull();
  });

  it("isolates observer failures from a delivery and publishes it once", () => {
    let now = 0;
    const telemetry = new GuiPerformanceTelemetry({
      now: () => now++,
      scheduleIdle: () => () => undefined,
    });
    telemetry.enable();
    telemetry.subscribe(() => {
      throw new Error("observer failed");
    });
    const listener = vi.fn();
    telemetry.subscribe(listener);
    const finishParse = telemetry.beginParse();
    const finishPaint = telemetry.beginPaint(2);
    finishParse?.();
    finishPaint?.();
    telemetry.commitDelivery();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(telemetry.snapshot()?.paintMs.count).toBe(1);
  });

  it("cleans listeners and ignores late completions after disposal", () => {
    let now = 0;
    const telemetry = new GuiPerformanceTelemetry({ now: () => now++ });
    telemetry.enable();
    const finish = telemetry.beginPaint();
    const listener = vi.fn();
    telemetry.subscribe(listener);
    telemetry.dispose();
    finish?.();
    telemetry.recordReseed();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.snapshot()).toBeNull();
  });
});
