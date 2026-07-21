import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { loadHiddenWindow } from "./window-loader.ts";

class FakeWindow extends EventEmitter {
  destroyed = false;
  show = vi.fn();

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

describe("loadHiddenWindow", () => {
  it("waits for loading and ready-to-show before revealing", async () => {
    const window = new FakeWindow();
    let finishLoad: (() => void) | undefined;
    const loading = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });

    const result = loadHiddenWindow(window, { load: async () => loading });
    window.emit("ready-to-show");
    await Promise.resolve();
    expect(window.show).not.toHaveBeenCalled();

    finishLoad?.();
    await result;
    expect(window.show).toHaveBeenCalledOnce();
  });

  it("destroys a window that does not become ready in time", async () => {
    vi.useFakeTimers();
    const window = new FakeWindow();
    const result = loadHiddenWindow(window, { load: async () => undefined, timeoutMs: 10 });
    const rejection = expect(result).rejects.toThrow("within 10ms");

    await vi.advanceTimersByTimeAsync(10);
    await rejection;
    expect(window.destroyed).toBe(true);
    vi.useRealTimers();
  });

  it("supports a hidden smoke load", async () => {
    const window = new FakeWindow();
    const result = loadHiddenWindow(window, { load: async () => undefined, reveal: false });
    window.emit("ready-to-show");
    await result;
    expect(window.show).not.toHaveBeenCalled();
  });

  it("waits for the renderer bootstrap handshake", async () => {
    const window = new FakeWindow();
    let markRendererReady: (() => void) | undefined;
    const rendererReady = new Promise<void>((resolve) => {
      markRendererReady = resolve;
    });
    const result = loadHiddenWindow(window, {
      load: async () => undefined,
      rendererReady,
    });

    window.emit("ready-to-show");
    await Promise.resolve();
    expect(window.show).not.toHaveBeenCalled();
    markRendererReady?.();
    await result;
    expect(window.show).toHaveBeenCalledOnce();
  });
});
