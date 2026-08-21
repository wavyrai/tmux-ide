import { describe, expect, it, vi } from "vitest";
import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import { createTerminalFrameReadiness } from "./terminal-frame-readiness.ts";

function snapshot(
  generation: string,
  rendererEpoch: number,
  state: { canonical: boolean; painted: boolean },
): OpenTuiGenerationHostSnapshot {
  return {
    status: "live",
    daemonGeneration: generation,
    rendererEpoch,
    adapter: {
      hasCanonicalSnapshot: () => state.canonical,
      hasPaintedCanonicalSnapshot: () => state.painted,
    },
  } as unknown as OpenTuiGenerationHostSnapshot;
}

describe("terminal frame readiness", () => {
  it("observes the published candidate and requests exactly one post-blit frame", () => {
    const scheduled: Array<() => void> = [];
    const requestRender = vi.fn();
    const markReady = vi.fn(() => true);
    const drainDetailed = vi.fn();
    const state = { canonical: true, painted: false };
    const published = snapshot("generation-a", 1, state);
    const readiness = createTerminalFrameReadiness({
      requestRender,
      markReady,
      drainDetailed,
      scheduleAfterFrame: (callback) => scheduled.push(callback),
    });

    readiness.adopt(published);
    readiness.observeFrame();
    readiness.observeFrame();
    expect(scheduled).toHaveLength(1);
    state.painted = true;
    scheduled[0]!();
    expect(requestRender).toHaveBeenCalledOnce();
    readiness.observeFrame();
    readiness.observeFrame();
    expect(markReady).toHaveBeenCalledOnce();
    expect(drainDetailed).toHaveBeenCalledTimes(2);
  });

  it("fences a queued follow-up across generation replacement and disposal", () => {
    const scheduled: Array<() => void> = [];
    const requestRender = vi.fn();
    const readiness = createTerminalFrameReadiness({
      requestRender,
      markReady: () => true,
      drainDetailed: () => undefined,
      scheduleAfterFrame: (callback) => scheduled.push(callback),
    });
    readiness.adopt(snapshot("generation-a", 1, { canonical: true, painted: false }));
    readiness.observeFrame();
    readiness.adopt(snapshot("generation-b", 2, { canonical: true, painted: false }));
    readiness.observeFrame();
    scheduled[0]!();
    expect(requestRender).not.toHaveBeenCalled();
    scheduled[1]!();
    expect(requestRender).toHaveBeenCalledOnce();
    readiness.dispose();
    expect(() => readiness.observeFrame()).not.toThrow();
  });

  it("requests one detailed drain frame only when the completed blit left an identity", () => {
    const scheduled: Array<() => void> = [];
    const requestRender = vi.fn();
    let pendingDetail = false;
    const readiness = createTerminalFrameReadiness({
      requestRender,
      markReady: () => true,
      drainDetailed: () => {
        pendingDetail = false;
      },
      needsDetailedDrain: () => pendingDetail,
      scheduleAfterFrame: (callback) => scheduled.push(callback),
    });
    readiness.adopt(snapshot("generation-a", 1, { canonical: true, painted: true }));
    readiness.observeFrame();
    pendingDetail = true;
    scheduled.shift()!();
    expect(requestRender).toHaveBeenCalledOnce();
    readiness.observeFrame();
    scheduled.shift()!();
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("does not consume readiness dedupe until the critical mark is retained", () => {
    const markReady = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const published = snapshot("generation-a", 1, { canonical: true, painted: true });
    const readiness = createTerminalFrameReadiness({
      requestRender: () => undefined,
      markReady,
      drainDetailed: () => undefined,
    });
    readiness.adopt(published);
    readiness.observeFrame();
    readiness.observeFrame();
    readiness.observeFrame();
    expect(markReady).toHaveBeenCalledTimes(2);
  });

  it("keeps rendering fail-open when readiness and detailed sinks throw", () => {
    const readiness = createTerminalFrameReadiness({
      requestRender: () => undefined,
      markReady: () => {
        throw new Error("critical sink failed");
      },
      drainDetailed: () => {
        throw new Error("detail sink failed");
      },
    });
    readiness.adopt(snapshot("generation-a", 1, { canonical: true, painted: true }));
    expect(() => readiness.observeFrame()).not.toThrow();
  });
});
