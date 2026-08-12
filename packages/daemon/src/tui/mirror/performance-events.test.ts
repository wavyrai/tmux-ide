import { describe, expect, it, vi } from "vitest";

import {
  currentTuiPerformanceEventSink,
  installTuiPerformanceEventSink,
  type TuiPerformanceEventSink,
} from "./performance-events.ts";

const sink = (): TuiPerformanceEventSink => ({
  frame: vi.fn(),
  terminalPaint: vi.fn(),
  terminalDelivery: vi.fn(),
});

describe("OpenTUI performance event bridge", () => {
  it("shares the observer across independently evaluated lazy module copies", async () => {
    const observer = sink();
    const dispose = installTuiPerformanceEventSink(observer);
    vi.resetModules();
    const duplicate = await import("./performance-events.ts");

    expect(duplicate.currentTuiPerformanceEventSink()).toBe(observer);
    expect(() => duplicate.installTuiPerformanceEventSink(sink())).toThrow(/already active/u);
    dispose();
    expect(duplicate.currentTuiPerformanceEventSink()).toBeNull();
  });

  it("is a null branch until installed and detaches idempotently", () => {
    expect(currentTuiPerformanceEventSink()).toBeNull();
    const observer = sink();
    const dispose = installTuiPerformanceEventSink(observer);
    expect(currentTuiPerformanceEventSink()).toBe(observer);
    dispose();
    dispose();
    expect(currentTuiPerformanceEventSink()).toBeNull();
  });

  it("rejects competing observers instead of cross-publishing", () => {
    const dispose = installTuiPerformanceEventSink(sink());
    expect(() => installTuiPerformanceEventSink(sink())).toThrow(/already active/u);
    dispose();
  });
});
