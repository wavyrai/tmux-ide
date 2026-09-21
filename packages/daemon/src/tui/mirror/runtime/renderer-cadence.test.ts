import { describe, expect, it } from "vitest";

import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";

describe("OpenTUI renderer cadence", () => {
  it("keeps animation pacing while imposing no interval on requested terminal frames", () => {
    expect(1_000 / TUI_RENDERER_CADENCE.targetFps).toBeLessThanOrEqual(16.67);
    expect(1_000 / TUI_RENDERER_CADENCE.maxFps).toBe(0);
  });
});
