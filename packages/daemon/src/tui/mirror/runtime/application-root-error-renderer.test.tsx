import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";

describe("root renderer error containment", () => {
  it.each(["uncaughtException", "unhandledRejection"])(
    "frames %s diagnostics without writing a raw Bun error over the terminal",
    (event) => {
      // Use a separate real Bun renderer: emitting a process error in the test
      // runner would exercise its handlers instead of the application's owner.
      const entry = new URL("./application-root-renderer.ts", import.meta.url).href;
      const source = `
        const originalConsole = globalThis.console;
        const listenersBefore = process.listenerCount(${JSON.stringify(event)});
        const { createApplicationRootRenderer } = await import(${JSON.stringify(entry)});
        const renderer = await createApplicationRootRenderer(false);
        const initiallyVisible = renderer.console.visible;
        const captured = globalThis.console !== originalConsole;
        process.emit(${JSON.stringify(event)}, new Error("OWNED_DIAGNOSTIC"));
        await new Promise(resolve => setTimeout(resolve, 60));
        const visibleAfterError = renderer.console.visible;
        renderer.console.hide();
        console.log("OWNED_RETAINED_DIAGNOSTIC");
        const retainedBeforeDestroy = renderer.console.getCachedLogs().includes("OWNED_RETAINED_DIAGNOSTIC");
        renderer.destroy();
        await new Promise(resolve => setTimeout(resolve, 20));
        process.stdout.write("\\nRENDERER_RECEIPT " + JSON.stringify({
          initiallyVisible, captured, visibleAfterError, retainedBeforeDestroy,
          cacheCleared: renderer.console.getCachedLogs() === "",
          restored: globalThis.console === originalConsole,
          listenersRestored: process.listenerCount(${JSON.stringify(event)}) === listenersBefore,
        }) + "\\n");
      `;
      const child = spawnSync(process.execPath, ["--eval", source], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          TMUX: "",
          TMUX_IDE_FRAME_OUTPUT: "0",
          TMUX_IDE_MIRROR_DEBUG: "",
          OTUI_DUMP_CAPTURES: "0",
          SHOW_CONSOLE: "0",
        },
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      expect(child.stdout).toContain("OWNED_DIAGNOSTIC");
      const receipt = child.stdout.split("RENDERER_RECEIPT ").at(-1)!;
      expect(JSON.parse(receipt)).toEqual({
        initiallyVisible: false,
        captured: true,
        visibleAfterError: true,
        retainedBeforeDestroy: true,
        cacheCleared: true,
        restored: true,
        listenersRestored: true,
      });
    },
  );
});
