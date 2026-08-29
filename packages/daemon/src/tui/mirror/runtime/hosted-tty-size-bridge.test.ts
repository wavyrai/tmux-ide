import { describe, expect, it, vi } from "vitest";

import {
  installHostedSizeBridge,
  parseSttySize,
  type HostedTtySize,
} from "./hosted-tty-size-bridge.ts";

describe("hosted TTY size bridge", () => {
  it("parses stty's rows-cols format and rejects invalid geometry", () => {
    expect(parseSttySize("41 132\n")).toEqual({ width: 132, height: 41 });
    for (const value of ["", "132 41 extra", "0 80", "24 0", "-1 80", "x y"])
      expect(parseSttySize(value)).toBeNull();
  });

  it("coalesces SIGWINCH and applies one authoritative hosted resize", () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      const signalTarget = {
        on: (_signal: "SIGWINCH", listener: () => void) => listeners.add(listener),
        off: (_signal: "SIGWINCH", listener: () => void) => listeners.delete(listener),
      };
      let size: HostedTtySize = { width: 80, height: 24 };
      const resizeListeners = new Set<(width: number, height: number) => void>();
      const renderer = {
        width: 80,
        height: 24,
        resize: vi.fn((width: number, height: number) => {
          renderer.width = width;
          renderer.height = height;
        }),
        requestRender: vi.fn(),
        on: (_event: "resize", listener: (width: number, height: number) => void) =>
          resizeListeners.add(listener),
        off: (_event: "resize", listener: (width: number, height: number) => void) =>
          resizeListeners.delete(listener),
        emit: vi.fn((_event: "resize", width: number, height: number) => {
          for (const listener of resizeListeners) listener(width, height);
          return true;
        }),
      };
      const queuedRenders: Array<() => void> = [];
      const bridge = installHostedSizeBridge({
        hosted: true,
        renderer,
        readSize: () => size,
        signalTarget,
        settleMs: 125,
        queueRender: (callback) => {
          queuedRenders.push(callback);
          return 17;
        },
      });
      expect(listeners.size).toBe(1);
      expect(renderer.resize).not.toHaveBeenCalled();

      size = { width: 132, height: 41 };
      for (const listener of listeners) listener();
      for (const listener of listeners) listener();
      vi.advanceTimersByTime(124);
      expect(renderer.resize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(renderer.resize).toHaveBeenCalledOnce();
      expect(renderer.resize).toHaveBeenCalledWith(132, 41);
      expect(renderer.emit).toHaveBeenCalledOnce();
      expect(renderer.emit).toHaveBeenCalledWith("resize", 132, 41);
      expect(renderer.requestRender).not.toHaveBeenCalled();
      queuedRenders.shift()!();
      expect(renderer.requestRender).toHaveBeenCalledOnce();

      for (const listener of listeners) listener();
      vi.advanceTimersByTime(125);
      expect(renderer.resize).toHaveBeenCalledOnce();
      bridge.dispose();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does no reads, listeners, timers, or resize work outside hosted mode", () => {
    const readSize = vi.fn(() => ({ width: 132, height: 41 }));
    const signalTarget = { on: vi.fn(), off: vi.fn() };
    const setTimer = vi.fn(setTimeout);
    const queueRender = vi.fn(() => 19);
    const renderer = {
      width: 80,
      height: 24,
      resize: vi.fn(),
      requestRender: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(() => true),
    };
    const bridge = installHostedSizeBridge({
      hosted: false,
      renderer,
      readSize,
      signalTarget,
      setTimer,
      queueRender,
    });
    expect(bridge.reconcile()).toBe(false);
    bridge.dispose();
    expect(readSize).not.toHaveBeenCalled();
    expect(signalTarget.on).not.toHaveBeenCalled();
    expect(signalTarget.off).not.toHaveBeenCalled();
    expect(setTimer).not.toHaveBeenCalled();
    expect(queueRender).not.toHaveBeenCalled();
    expect(renderer.resize).not.toHaveBeenCalled();
  });

  it("does not republish or queue a frame when renderer.resize publishes the edge", () => {
    let size: HostedTtySize = { width: 80, height: 24 };
    const resizeListeners = new Set<(width: number, height: number) => void>();
    const queueRender = vi.fn(() => 23);
    const renderer = {
      width: 80,
      height: 24,
      resize: vi.fn((width: number, height: number) => {
        renderer.width = width;
        renderer.height = height;
        for (const listener of resizeListeners) listener(width, height);
      }),
      requestRender: vi.fn(),
      on: (_event: "resize", listener: (width: number, height: number) => void) =>
        resizeListeners.add(listener),
      off: (_event: "resize", listener: (width: number, height: number) => void) =>
        resizeListeners.delete(listener),
      emit: vi.fn(() => true),
    };
    const bridge = installHostedSizeBridge({
      hosted: true,
      renderer,
      readSize: () => size,
      signalTarget: { on: vi.fn(), off: vi.fn() },
      queueRender,
    });
    size = { width: 132, height: 41 };
    expect(bridge.reconcile()).toBe(true);
    expect(renderer.resize).toHaveBeenCalledWith(132, 41);
    expect(renderer.emit).not.toHaveBeenCalled();
    expect(queueRender).not.toHaveBeenCalled();
    bridge.dispose();
    expect(resizeListeners.size).toBe(0);
  });

  it("cancels a fallback render task and keeps a late callback inert after disposal", () => {
    let size: HostedTtySize = { width: 80, height: 24 };
    let queuedRender: (() => void) | null = null;
    const cancelQueuedRender = vi.fn();
    const resizeListeners = new Set<(width: number, height: number) => void>();
    const renderer = {
      width: 80,
      height: 24,
      resize: vi.fn((width: number, height: number) => {
        renderer.width = width;
        renderer.height = height;
      }),
      requestRender: vi.fn(),
      on: (_event: "resize", listener: (width: number, height: number) => void) =>
        resizeListeners.add(listener),
      off: (_event: "resize", listener: (width: number, height: number) => void) =>
        resizeListeners.delete(listener),
      emit: vi.fn((_event: "resize", width: number, height: number) => {
        for (const listener of resizeListeners) listener(width, height);
        return true;
      }),
    };
    const bridge = installHostedSizeBridge({
      hosted: true,
      renderer,
      readSize: () => size,
      signalTarget: { on: vi.fn(), off: vi.fn() },
      queueRender: (callback) => {
        queuedRender = callback;
        return 29;
      },
      cancelQueuedRender,
    });
    size = { width: 132, height: 41 };
    expect(bridge.reconcile()).toBe(true);
    expect(queuedRender).not.toBeNull();
    expect(renderer.requestRender).not.toHaveBeenCalled();

    bridge.dispose();
    expect(cancelQueuedRender).toHaveBeenCalledOnce();
    expect(cancelQueuedRender).toHaveBeenCalledWith(29);
    queuedRender!();
    expect(renderer.requestRender).not.toHaveBeenCalled();
    expect(resizeListeners.size).toBe(0);
  });

  it("fails open and cancels a pending resize during disposal", () => {
    vi.useFakeTimers();
    try {
      const listeners = new Set<() => void>();
      const renderer = {
        width: 80,
        height: 24,
        resize: vi.fn(),
        requestRender: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn(() => true),
      };
      const bridge = installHostedSizeBridge({
        hosted: true,
        renderer,
        readSize: () => {
          throw new Error("no controlling tty");
        },
        signalTarget: {
          on: (_signal, listener) => listeners.add(listener),
          off: (_signal, listener) => listeners.delete(listener),
        },
      });
      for (const listener of listeners) listener();
      bridge.dispose();
      vi.runAllTimers();
      expect(renderer.resize).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
