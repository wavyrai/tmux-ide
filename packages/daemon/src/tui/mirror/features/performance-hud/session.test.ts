import { describe, expect, it, vi } from "vitest";

import type { TuiPerformanceEventSink } from "../../performance-events.ts";
import { createPerformanceHudSession } from "./session.ts";

const authority = {
  daemonInstanceId: "00000000-0000-4000-8000-000000000001",
  workspaceName: "workspace",
  generation: "00000000-0000-4000-8000-000000000001",
  incarnation: "pane-a:1",
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
    const installEventSink = vi.fn((value: TuiPerformanceEventSink) => {
      eventSink = value;
      return removeEvents;
    });
    const observeFrames = vi.fn((value: (intervalMs: number) => void) => {
      frame = value;
      return removeFrames;
    });
    const session = createPerformanceHudSession({
      authority: () => authority,
      installEventSink,
      observeFrames,
    });

    expect(session.snapshot()).toBeNull();
    expect(installEventSink).not.toHaveBeenCalled();
    session.show();
    session.show();
    expect(session.open()).toBe(true);
    expect(installEventSink).toHaveBeenCalledTimes(1);
    expect(observeFrames).toHaveBeenCalledTimes(1);
    frame!(20);
    eventSink!.terminalPaint(3, 2);
    // Paint/frame samples do not publish a Solid update from inside a frame.
    expect(session.snapshot()).toMatchObject({ activeFps: null, paintMs: { count: 0 } });
    eventSink!.terminalParse(1);
    expect(session.snapshot()).toMatchObject({
      activeFps: 50,
      dirtyRows: { latest: 3 },
      parseMs: { latest: 1 },
      paintMs: { latest: 2 },
    });
    session.hide();
    session.hide();
    expect(session.snapshot()).toBeNull();
    expect(removeEvents).toHaveBeenCalledTimes(1);
    expect(removeFrames).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it("publishes no post-dispose events and cannot be reopened", () => {
    let sink: TuiPerformanceEventSink | null = null;
    const session = createPerformanceHudSession({
      authority: () => authority,
      installEventSink: (next) => {
        sink = next;
        return () => {
          sink = null;
        };
      },
      observeFrames: () => () => undefined,
    });
    session.show();
    const retired = sink!;
    session.dispose();
    retired.terminalParse(5);
    session.show();
    expect(session.disposed()).toBe(true);
    expect(session.open()).toBe(false);
    expect(session.snapshot()).toBeNull();
  });
});
