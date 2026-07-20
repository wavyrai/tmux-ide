import { describe, expect, it } from "vitest";
import {
  agentTerminalCanvasHitTest,
  agentTerminalCanvasPointerPolicy,
  agentTerminalCanvasRouteX,
  projectAgentTerminalCanvas,
} from "./agent-terminal-canvas.ts";

describe("agent terminal canvas geometry", () => {
  it.each([
    [79, 14, false, 79, 12],
    [119, 25, false, 119, 23],
    [199, 39, false, 199, 37],
    [119, 25, true, 119, 23],
  ] as const)(
    "maps %sx%s search=%s to an exact %sx%s tmux framebuffer",
    (width, height, searchOpen, cols, rows) => {
      const projection = projectAgentTerminalCanvas({
        width,
        height,
        chromeRows: 2,
        footerRows: searchOpen ? 1 : 0,
      });
      expect(projection.tmuxSize).toEqual({ cols, rows });
      expect(projection.chrome.height + projection.framebuffer.height).toBe(height);
      expect(projection.framebuffer.y).toBe(2);
      expect(projection.footer.y).toBe(searchOpen ? height - 1 : height);
    },
  );

  it("keeps regions bounded and local with footer precedence", () => {
    const projection = projectAgentTerminalCanvas({
      width: 80,
      height: 24,
      chromeRows: 2,
      footerRows: 1,
    });
    expect(agentTerminalCanvasHitTest(projection, 7, 1)).toEqual({
      kind: "chrome",
      localX: 7,
      localY: 1,
    });
    expect(agentTerminalCanvasHitTest(projection, 7, 2)).toEqual({
      kind: "framebuffer",
      localX: 7,
      localY: 0,
    });
    expect(agentTerminalCanvasHitTest(projection, 79, 22)).toEqual({
      kind: "framebuffer",
      localX: 79,
      localY: 20,
    });
    expect(agentTerminalCanvasHitTest(projection, 7, 23)).toEqual({
      kind: "footer",
      localX: 7,
      localY: 0,
    });
    expect(agentTerminalCanvasHitTest(projection, 80, 23)).toBeNull();
  });

  it("withholds a pin while a maximized dock leaves no canvas", () => {
    const projection = projectAgentTerminalCanvas({ width: 0, height: 0 });
    expect(projection.framebuffer).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(projection.tmuxSize).toBeNull();
    expect(agentTerminalCanvasHitTest(projection, 0, 0)).toBeNull();
  });

  it("bounds shell rows instead of producing negative framebuffer geometry", () => {
    const projection = projectAgentTerminalCanvas({
      width: 20.9,
      height: 2.9,
      chromeRows: 9,
      footerRows: 9,
    });
    expect(projection).toMatchObject({
      width: 20,
      height: 2,
      chrome: { height: 2 },
      framebuffer: { y: 2, height: 0 },
      footer: { y: 2, height: 0 },
      tmuxSize: null,
    });
  });

  it("routes terminal wheel focus by the pointer surface and settles footer releases", () => {
    const projection = projectAgentTerminalCanvas({
      width: 80,
      height: 24,
      chromeRows: 2,
      footerRows: 1,
    });
    expect(agentTerminalCanvasPointerPolicy(projection, 4, 8, "scroll")).toBe("focus-route");
    expect(agentTerminalCanvasPointerPolicy(projection, 4, 23, "drag")).toBe("consume");
    for (const eventType of ["up", "drag-end", "drop", "out"]) {
      expect(agentTerminalCanvasPointerPolicy(projection, 4, 23, eventType)).toBe(
        "settle-boundary",
      );
    }
  });

  it("removes the focus rail once for releases anywhere on screen", () => {
    expect(agentTerminalCanvasRouteX(37, 1)).toBe(36);
    expect(agentTerminalCanvasRouteX(0, 1)).toBe(-1);
  });
});
