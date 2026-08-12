import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");

describe("performance HUD optional feature wiring", () => {
  it("loads only through a user-triggered optional-feature request", () => {
    expect(source).toContain('optionalFeatures.request("performanceHud")');
    expect(source).toContain("const togglePerformanceHud = () =>");
    expect(source).toContain("performanceHudRequestedOpen = !performanceHudRequestedOpen");
  });

  it("uses the renderer frame event and the local sink without a polling loop", () => {
    expect(source).toContain('appRenderer.on("frame", onFrame)');
    expect(source).toContain("installEventSink: installTuiPerformanceEventSink");
    const hudBlock = source.slice(
      source.indexOf("const ensurePerformanceHud"),
      source.indexOf("const rendererCommandExecutor"),
    );
    expect(hudBlock).not.toContain("requestLive");
    expect(hudBlock).not.toContain("setInterval");
    expect(hudBlock).not.toContain("setTimeout");
    expect(hudBlock).not.toContain("requestAnimationFrame");
  });

  it("removes the legacy synchronous performance log path", () => {
    expect(source).not.toContain("/tmp/zz-perf.log");
    expect(source).not.toContain("TMUX_IDE_ZZ_PERF");
  });
});
