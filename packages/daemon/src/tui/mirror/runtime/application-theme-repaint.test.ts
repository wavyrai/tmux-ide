import { describe, expect, it } from "vitest";

import { createSemanticThemeSnapshot } from "../theme.ts";
import {
  applyApplicationAppearanceToRenderer,
  requestApplicationThemeRepaint,
} from "./application-theme-repaint.ts";

describe("application theme repaint", () => {
  it("requests OpenTUI's full-frame damage path when available", () => {
    const calls: string[] = [];
    const renderer = {
      forceFullRepaintRequested: false,
      requestRender: () => calls.push("render"),
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    };

    requestApplicationThemeRepaint(renderer as never);

    expect(renderer.forceFullRepaintRequested).toBe(true);
    expect(calls).toEqual(["render"]);
  });

  it("falls back to the public renderer lifecycle when the damage flag is unavailable", () => {
    const calls: string[] = [];
    const renderer = {
      requestRender: () => calls.push("render"),
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    };

    requestApplicationThemeRepaint(renderer as never);

    expect(calls).toEqual(["suspend", "resume"]);
  });

  it("sets the new canvas before requesting exactly one full repaint", () => {
    const calls: string[] = [];
    const renderer = {
      forceFullRepaintRequested: false,
      setBackgroundColor: () => calls.push("background"),
      requestRender: () => calls.push("repaint"),
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
    };
    const theme = createSemanticThemeSnapshot({ mode: "light" });

    let generation = applyApplicationAppearanceToRenderer(renderer as never, theme, 0, null);
    expect(calls).toEqual(["background"]);
    calls.length = 0;
    generation = applyApplicationAppearanceToRenderer(renderer as never, theme, 1, generation);
    expect(calls).toEqual(["background", "repaint"]);
    calls.length = 0;
    applyApplicationAppearanceToRenderer(renderer as never, theme, 1, generation);
    expect(calls).toEqual(["background"]);
  });
});
