import { describe, expect, it } from "vitest";

import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";

describe("OpenTUI renderer cadence", () => {
  it("keeps steady rendering at 60 Hz while admitting input invalidations at 120 Hz", () => {
    expect(TUI_RENDERER_CADENCE).toEqual({ targetFps: 60, maxFps: 120 });
    expect(1_000 / TUI_RENDERER_CADENCE.targetFps).toBeLessThanOrEqual(16.67);
    expect(1_000 / TUI_RENDERER_CADENCE.maxFps).toBeLessThanOrEqual(8.34);
    expect(TUI_RENDERER_CADENCE.maxFps).toBeGreaterThanOrEqual(TUI_RENDERER_CADENCE.targetFps);
  });
});
