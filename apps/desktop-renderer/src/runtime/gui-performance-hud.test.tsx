/* @vitest-environment happy-dom */
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";

import { GuiPerformanceHud } from "./gui-performance-hud.tsx";
import { GuiPerformanceTelemetry } from "./gui-performance-telemetry.ts";

const roots: Array<() => void> = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()?.();
  document.body.replaceChildren();
});

describe("GuiPerformanceHud", () => {
  it("renders a demand-only compactable overlay from the shared snapshot", () => {
    const telemetry = new GuiPerformanceTelemetry({ now: () => 1 });
    telemetry.enable();
    telemetry.recordQueueDepth(2, 8);
    telemetry.recordReseed();
    const host = document.createElement("div");
    document.body.append(host);
    roots.push(
      render(
        () => <GuiPerformanceHud telemetry={telemetry} open onClose={() => undefined} />,
        host,
      ),
    );
    expect(host.querySelector("[aria-label='Performance HUD']")?.getAttribute("data-open")).toBe(
      "true",
    );
    expect(host.textContent).toContain("Queue");
    expect(host.textContent).toContain("Reseeds");
    expect(host.textContent).toContain("F12");
  });

  it("unsubscribes on cleanup and does not require a scheduling primitive", () => {
    const telemetry = new GuiPerformanceTelemetry();
    telemetry.enable();
    const host = document.createElement("div");
    document.body.append(host);
    const dispose = render(
      () => <GuiPerformanceHud telemetry={telemetry} open={false} onClose={() => undefined} />,
      host,
    );
    expect(host.querySelector("aside")?.getAttribute("aria-hidden")).toBe("true");
    dispose();
    telemetry.recordReseed();
    expect(host.childElementCount).toBe(0);
  });
});
