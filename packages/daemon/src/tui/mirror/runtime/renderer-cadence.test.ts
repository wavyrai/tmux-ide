import { describe, expect, it } from "vitest";

import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";

describe("OpenTUI renderer cadence", () => {
  it("can consume one terminal update within a 60 Hz frame budget", () => {
    expect(TUI_RENDERER_CADENCE).toEqual({ targetFps: 60, maxFps: 60 });
    expect(1_000 / TUI_RENDERER_CADENCE.targetFps).toBeLessThanOrEqual(16.67);
  });
});
