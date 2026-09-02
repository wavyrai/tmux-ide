import { describe, expect, it, vi } from "vitest";

import type { LocalPerformanceAuthorityV1 } from "@tmux-ide/contracts";
import type { TuiPerformanceEventSink } from "../../performance-events.ts";
import { createPerformanceHudSession } from "./session.ts";

const authorityA: LocalPerformanceAuthorityV1 = {
  daemonInstanceId: "00000000-0000-4000-8000-000000000001",
  workspaceName: "workspace",
  generation: "00000000-0000-4000-8000-000000000001",
  incarnation: null,
};
const delivery = {
  parseMs: 1,
  queuePeak: 1,
  queueCapacity: 1,
  settledQueueDepth: 0,
  revisionLagPeak: 1,
  reseed: false,
} as const;

describe("OpenTUI performance HUD session", () => {
  it("does no work before demand and pairs observers exactly across toggles", () => {
    let eventSink: TuiPerformanceEventSink | null = null;
    let frame: ((intervalMs: number) => void) | null = null;
    const removeEvents = vi.fn(() => {
      eventSink = null;
    });
    const removeFrames = vi.fn(() => {
      frame = null;
    });
    const removeIdle = vi.fn();
    const installEventSink = vi.fn((value: TuiPerformanceEventSink) => {
      eventSink = value;
      return removeEvents;
    });
    const observeFrames = vi.fn((value: (intervalMs: number) => void) => {
      frame = value;
      return removeFrames;
    });
    const session = createPerformanceHudSession({
      authority: () => authorityA,
      installEventSink,
      observeFrames,
      scheduleIdle: () => removeIdle,
    });

    expect(session.snapshot()).toBeNull();
    expect(installEventSink).not.toHaveBeenCalled();
    session.show();
    session.show();
    expect(session.open()).toBe(true);
    expect(installEventSink).toHaveBeenCalledTimes(1);
    expect(observeFrames).toHaveBeenCalledTimes(1);
    frame!(16); // HUD's initial publication frame establishes the baseline.
    frame!(20);
    eventSink!.terminalPaint(3, 2);
    // Paint/frame samples do not publish a Solid update from inside a frame.
    expect(session.snapshot()).toMatchObject({ activeFps: null, paintMs: { count: 0 } });
    eventSink!.terminalDelivery(delivery);
    expect(session.snapshot()).toMatchObject({
      activeFps: 50,
      dirtyRows: { latest: 3 },
      parseMs: { latest: 1 },
      paintMs: { latest: 2 },
      queueDepth: { current: 0, peak: 1 },
      revisionLag: { current: 0, peak: 1 },
    });
    session.hide();
    session.hide();
    expect(session.snapshot()).toBeNull();
    expect(removeEvents).toHaveBeenCalledTimes(1);
    expect(removeFrames).toHaveBeenCalledTimes(1);
    expect(removeIdle).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("filters invalid intervals, ignores the first frame, and retires active FPS at idle", () => {
    let sink!: TuiPerformanceEventSink;
    let frame!: (intervalMs: number) => void;
    let idle!: () => void;
    const scheduleIdle = vi.fn((callback: () => void) => {
      idle = callback;
      return vi.fn();
    });
    const session = createPerformanceHudSession({
      authority: () => authorityA,
      installEventSink: (next) => {
        sink = next;
        return () => undefined;
      },
      observeFrames: (next) => {
        frame = next;
        return () => undefined;
      },
      scheduleIdle,
    });
    session.show();
    frame(16); // initial HUD frame establishes the baseline
    frame(0);
    frame(Number.NaN);
    expect(scheduleIdle).not.toHaveBeenCalled();
    frame(25);
    expect(scheduleIdle).toHaveBeenCalledTimes(1);
    sink.terminalDelivery(delivery);
    expect(session.snapshot()?.activeFps).toBe(40);
    idle();
    expect(session.snapshot()?.activeFps).toBeNull();
    frame(16); // retirement-induced render is diagnostic, not renewed activity
    expect(scheduleIdle).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("recreates its bounded aggregator when runtime authority rolls over", () => {
    let authority: LocalPerformanceAuthorityV1 = authorityA;
    let sink!: TuiPerformanceEventSink;
    let frame!: (intervalMs: number) => void;
    const scheduleIdle = vi.fn(() => () => undefined);
    const session = createPerformanceHudSession({
      authority: () => authority,
      installEventSink: (next) => {
        sink = next;
        return () => undefined;
      },
      observeFrames: (next) => {
        frame = next;
        return () => undefined;
      },
      scheduleIdle,
    });
    session.show();
    sink.terminalDelivery(delivery);
    expect(session.snapshot()).toMatchObject({ authority: authorityA, parseMs: { count: 1 } });
    authority = {
      ...authorityA,
      daemonInstanceId: "00000000-0000-4000-8000-000000000002",
      generation: "00000000-0000-4000-8000-000000000002",
    };
    frame(20); // first frame in the replacement authority is baseline-only
    expect(scheduleIdle).not.toHaveBeenCalled();
    frame(20);
    expect(scheduleIdle).toHaveBeenCalledOnce();
    sink.terminalDelivery({ ...delivery, parseMs: 4 });
    expect(session.snapshot()).toMatchObject({
      authority,
      parseMs: { count: 1, latest: 4 },
      reseeds: 0,
    });
    session.dispose();
  });

  it("publishes no post-dispose events and cannot be reopened", () => {
    let sink: TuiPerformanceEventSink | null = null;
    const session = createPerformanceHudSession({
      authority: () => authorityA,
      installEventSink: (next) => {
        sink = next;
        return () => {
          sink = null;
        };
      },
      observeFrames: () => () => undefined,
      scheduleIdle: () => () => undefined,
    });
    session.show();
    const retired = sink!;
    session.dispose();
    retired.terminalDelivery(delivery);
    session.show();
    expect(session.disposed()).toBe(true);
    expect(session.open()).toBe(false);
    expect(session.snapshot()).toBeNull();
  });
});
