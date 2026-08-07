import { describe, expect, it } from "vitest";

import {
  dockAppWindowIntent,
  floatAppWindowIntent,
  toggleAppWindowMaximizeIntent,
} from "./canvas-interaction-intents.ts";

describe("AppWindow command intents", () => {
  it("creates presenter-compatible float and dock invocations", () => {
    expect(
      floatAppWindowIntent("window.worker", "keyboard", {
        x: 20,
        y: 30,
        width: 400,
        height: 250,
      }),
    ).toEqual({
      command: {
        type: "window.float",
        windowId: "window.worker",
        rect: { x: 20, y: 30, width: 400, height: 250 },
      },
      source: "keyboard",
    });
    expect(
      dockAppWindowIntent("window.worker", "programmatic", { stackId: "stack.right", index: 2 }),
    ).toEqual({
      command: {
        type: "window.dock",
        windowId: "window.worker",
        stackId: "stack.right",
        index: 2,
      },
      source: "programmatic",
    });
  });

  it("maximizes and restores through one atomic full-rect command per transition", () => {
    const currentRect = { x: 80, y: 60, width: 500, height: 320 };
    const maximized = toggleAppWindowMaximizeIntent({
      windowId: "window.worker",
      currentRect,
      availableRect: { x: 0, y: 0, width: 1_200, height: 760 },
      state: { mode: "restored" },
      source: "mouse",
    });

    expect(maximized.state).toEqual({ mode: "maximized", restoreRect: currentRect });
    expect(maximized.commands).toEqual([
      {
        command: {
          type: "window.float",
          windowId: "window.worker",
          rect: { x: 0, y: 0, width: 1_200, height: 760 },
        },
        source: "mouse",
      },
    ]);

    const restored = toggleAppWindowMaximizeIntent({
      windowId: "window.worker",
      currentRect: maximized.rect,
      availableRect: { x: 0, y: 0, width: 1_200, height: 760 },
      state: maximized.state,
      source: "mouse",
    });
    expect(restored.rect).toEqual(currentRect);
    expect(restored.state).toEqual({ mode: "restored" });
    expect(restored.commands).toEqual([
      {
        command: { type: "window.float", windowId: "window.worker", rect: currentRect },
        source: "mouse",
      },
    ]);
  });

  it("makes inconsistent maximize states unrepresentable", () => {
    const restoredWithMemory: import("./canvas-interaction-intents.ts").AppWindowMaximizeState = {
      mode: "restored",
      // @ts-expect-error restored state must not retain stale restore geometry
      restoreRect: { x: 0, y: 0, width: 1, height: 1 },
    };
    // @ts-expect-error maximized state must always retain restore geometry
    const maximizedWithoutMemory: import("./canvas-interaction-intents.ts").AppWindowMaximizeState =
      {
        mode: "maximized",
      };

    expect(restoredWithMemory.mode).toBe("restored");
    expect(maximizedWithoutMemory.mode).toBe("maximized");
  });
});
