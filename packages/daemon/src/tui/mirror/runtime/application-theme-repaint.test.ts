import { describe, expect, it } from "bun:test";

import { requestApplicationThemeRepaint } from "./application-theme-repaint.ts";

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
});
