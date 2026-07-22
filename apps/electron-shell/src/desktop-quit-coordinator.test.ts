import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { DesktopQuitCoordinator, type DesktopBeforeQuitEvent } from "./desktop-quit-coordinator.ts";

class FakeQuitApplication extends EventEmitter {
  readonly quit = vi.fn(() => {
    this.emit("before-quit", { preventDefault: vi.fn() } satisfies DesktopBeforeQuitEvent);
  });
}

describe("DesktopQuitCoordinator", () => {
  it("installs before startup and cancels a daemon start when quit races readiness", async () => {
    const app = new FakeQuitApplication();
    let releaseStart!: (value: string) => void;
    const pendingStart = new Promise<string>((resolve) => {
      releaseStart = resolve;
    });
    let releaseStop!: () => void;
    const pendingStop = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopOwned = vi.fn(() => pendingStop);
    const coordinator = new DesktopQuitCoordinator({
      app,
      shutdownTasks: () => [stopOwned],
      onShutdownError: vi.fn(),
    });
    const start = vi.fn(() => {
      expect(app.listenerCount("before-quit")).toBe(1);
      return pendingStart;
    });

    const result = coordinator.startUnlessQuitting(start);
    const event = { preventDefault: vi.fn() };
    app.emit("before-quit", event);
    await vi.waitFor(() => expect(stopOwned).toHaveBeenCalledOnce());

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    releaseStart("connected");
    await expect(result).resolves.toBeNull();
    releaseStop();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(stopOwned).toHaveBeenCalledOnce();
  });

  it("deduplicates repeated quit requests while the barrier is running", async () => {
    const app = new FakeQuitApplication();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shutdown = vi.fn(() => pending);
    const coordinator = new DesktopQuitCoordinator({
      app,
      shutdownTasks: () => [shutdown],
      onShutdownError: vi.fn(),
    });
    coordinator.install();
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };

    app.emit("before-quit", first);
    app.emit("before-quit", second);
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    release();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());

    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
