import { describe, expect, it, vi } from "vitest";
import { createComputed, createRoot } from "solid-js";
import { clampTerminalViewportOrigin } from "../terminal-viewport.ts";
import { createTerminalScrollback, createTerminalWheelGesture } from "./terminal-scrollback.ts";
import type { PaneScopedTerminalAdapter } from "../runtime/pane-scoped-terminal-surface.tsx";

describe("terminal wheel cadence", () => {
  it("matches native tmux wheel distance and accumulates fractional rows without acceleration", () => {
    const wheel = createTerminalWheelGesture();
    expect(wheel.consume("a", 1, 1, 0).lines).toBe(5);
    for (let index = 0; index < 3; index++)
      expect(wheel.consume("a", 1, 0.05, index + 1).lines).toBe(0);
    expect(wheel.consume("a", 1, 0.05, 4).lines).toBe(1);
    expect(wheel.consume("a", -1, 0.1, 5).lines).toBe(0);
    expect(wheel.consume("a", 1, 0.1, 6).lines).toBe(0);
    expect(wheel.consume("a", 1, NaN, 7).lines).toBe(0);
  });
  it("keeps momentum local at the live edge until an idle gap or explicit reset", () => {
    const wheel = createTerminalWheelGesture();
    expect(wheel.consume("a", 1, 1, 0).local).toBe(false);
    wheel.retainLocal();
    expect(wheel.consume("a", -1, 1, 20).local).toBe(true);
    expect(wheel.consume("a", -1, 1, 40).local).toBe(true);
    expect(wheel.consume("a", -1, 1, 250).local).toBe(false);
    wheel.retainLocal();
    wheel.reset();
    expect(wheel.consume("a", -1, 1, 260).local).toBe(false);
  });
  it("does not carry fractional movement or routing into another pane/incarnation", () => {
    const wheel = createTerminalWheelGesture();
    wheel.consume("a:old", 1, 0.15, 0);
    wheel.retainLocal();
    expect(wheel.consume("b", 1, 0.05, 1)).toEqual({ lines: 0, local: false });
    wheel.retainLocal();
    expect(wheel.consume("a:new", 1, 0.05, 2)).toEqual({ lines: 0, local: false });
  });
});

describe("local terminal scrollback", () => {
  it("publishes only the final viewport for one wheel movement or seek", () => {
    createRoot((dispose) => {
      const owner = createTerminalScrollback({
        renderSource: {
          scrollbackDepth: () => 100,
          paneCanonicalIdentity: () => ({ historyTrim: 0 }),
        },
        subscribePaneVersion: () => () => {},
      });
      const positions: Array<number | null> = [];
      createComputed(() => positions.push(owner.origin("a")?.y ?? null));
      owner.move("a", 1);
      positions.length = 0;
      owner.move("a", 1);
      expect(positions).toEqual([-2]);
      positions.length = 0;
      owner.seek("a", { x: 0, y: -20 });
      expect(positions).toEqual([-20]);
      owner.dispose();
      dispose();
    });
  });

  it("keeps wheel movement local and anchors history during append and trim", () => {
    let depth = 100;
    let trim = 0;
    let notify = () => {};
    const release = vi.fn();
    const subscribe = vi.fn((_id, listener) => {
      notify = listener;
      return release;
    });
    const owner = createTerminalScrollback({
      renderSource: {
        scrollbackDepth: () => depth,
        paneCanonicalIdentity: () => ({ historyTrim: trim }),
      },
      subscribePaneVersion: subscribe,
    } as unknown as PaneScopedTerminalAdapter);
    expect(owner.offset("a")).toBe(0);
    expect(subscribe).not.toHaveBeenCalled();
    owner.move("a", 3);
    owner.move("a", 3);
    expect(owner.offset("a")).toBe(6);
    expect(subscribe).toHaveBeenCalledTimes(1);
    depth += 2;
    notify();
    expect(owner.offset("a")).toBe(8);
    trim += 3;
    notify();
    expect(owner.offset("a")).toBe(11);
    expect(owner.offset("b")).toBe(0);
    owner.move("a", 1e6);
    expect(owner.offset("a")).toBe(depth);
    owner.live("a");
    expect(owner.offset("a")).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    owner.move("a", 1);
    owner.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });
});

function historySource() {
  let depth = 100;
  let identity = {
    historyTrim: 0,
    sourceEpoch: 1,
    generation: "daemon-a",
    incarnation: "pane-a",
    cols: 40,
    rows: 8,
  };
  const listeners = new Set<() => void>();
  return {
    renderSource: {
      scrollbackDepth: () => depth,
      paneCanonicalIdentity: () => identity,
    },
    subscribePaneVersion: (_id: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update: (nextDepth: number, nextIdentity: Partial<typeof identity> = {}) => {
      depth = nextDepth;
      identity = { ...identity, ...nextIdentity };
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

it("anchors a smaller viewport through cursor movement, append and history trim", () => {
  const source = historySource();
  let live = { x: 24, y: 9 };
  const owner = createTerminalScrollback(source, () => live);
  owner.move("a", 3);
  expect(owner.origin("a")).toEqual({ x: 24, y: 6 });
  expect(owner.offset("a")).toBe(3);
  live = { x: 0, y: 0 };
  source.update(100);
  expect(owner.origin("a")).toEqual({ x: 24, y: 6 });
  expect(owner.offset("a")).toBeGreaterThan(0);
  source.update(105);
  expect(owner.origin("a")).toEqual({ x: 24, y: 1 });
  source.update(105, { historyTrim: 4 });
  expect(owner.origin("a")).toEqual({ x: 24, y: -3 });
  owner.live("a");
  expect(owner.origin("a")).toBeNull();
  expect(source.listenerCount()).toBe(0);
  owner.dispose();
});

it("can scroll within a cropped live grid before tmux has any history", () => {
  const source = historySource();
  source.update(0);
  const owner = createTerminalScrollback(source, () => ({ x: 0, y: 9 }));
  owner.move("a", 3);
  expect(owner.origin("a")).toEqual({ x: 0, y: 6 });
  owner.move("a", 100);
  expect(owner.origin("a")).toEqual({ x: 0, y: 0 });
  expect(owner.offset("a")).toBe(9);
  owner.move("a", -9);
  expect(owner.origin("a")).toBeNull();
  owner.dispose();
});

it("does not carry offsets across a replaced pane or daemon in the same renderer", () => {
  const source = historySource();
  const owner = createTerminalScrollback(source);
  for (const replacement of [{ incarnation: "pane-b" }, { generation: "daemon-b" }]) {
    owner.move("a", 8);
    expect(owner.offset("a")).toBe(8);
    source.update(100, replacement);
    expect(owner.offset("a")).toBe(0);
    expect(source.listenerCount()).toBe(0);
  }
  owner.dispose();
});

it("starts scrolling from the current epoch after an unsubscribed live interval", () => {
  const source = historySource();
  const owner = createTerminalScrollback(source);
  owner.move("a", 5);
  owner.live("a");
  source.update(150, { sourceEpoch: 2 });
  owner.move("a", 7);
  source.update(152);
  expect(owner.offset("a")).toBe(9);
  owner.dispose();
});

it("anchors each client independently as history appends, trims and is cleared", () => {
  const source = historySource();
  const first = createTerminalScrollback(source);
  const second = createTerminalScrollback(source);
  first.move("a", 10);
  second.move("a", 30);
  source.update(105);
  expect([first.offset("a"), second.offset("a")]).toEqual([15, 35]);
  source.update(105, { historyTrim: 20 });
  expect([first.offset("a"), second.offset("a")]).toEqual([35, 55]);
  first.live("a");
  source.update(105, { historyTrim: 25 });
  expect([first.offset("a"), second.offset("a")]).toEqual([0, 60]);
  expect(source.listenerCount()).toBe(1);
  source.update(0);
  expect(second.offset("a")).toBe(0);
  expect(source.listenerCount()).toBe(0);
  first.dispose();
  second.dispose();
});

it("releases a subscription when its synchronous initial publication clears history", () => {
  const source = historySource();
  const owner = createTerminalScrollback({
    ...source,
    subscribePaneVersion: (id, listener) => {
      const release = source.subscribePaneVersion(id, listener);
      source.update(0);
      return release;
    },
  });
  owner.move("a", 3);
  expect(owner.offset("a")).toBe(0);
  expect(source.listenerCount()).toBe(0);
  owner.dispose();
});

it("uses current viewport bounds for a retained horizontal and vertical reading position", () => {
  const source = historySource();
  let grid = { cols: 100, rows: 50 };
  let viewport = { cols: 50, rows: 40 };
  const owner = createTerminalScrollback(
    source,
    () => ({ x: 24, y: 9 }),
    (_id, origin) => clampTerminalViewportOrigin(grid, viewport, origin, 100),
  );
  owner.move("a", 3);
  expect(owner.origin("a")).toEqual({ x: 24, y: 6 });
  grid = { cols: 60, rows: 42 };
  expect(owner.origin("a")).toEqual({ x: 10, y: 2 });
  viewport = { cols: 70, rows: 45 };
  expect(owner.origin("a")).toEqual({ x: 0, y: 0 });
  expect(owner.offset("a")).toBeGreaterThan(0);
  owner.live("a");
  expect(owner.origin("a")).toBeNull();
  owner.dispose();
});

it("keeps a cropped reading position when a history-free application's cursor returns home", () => {
  const source = historySource();
  source.update(0);
  let live = { x: 24, y: 9 };
  const owner = createTerminalScrollback(source, () => live);
  owner.move("a", 3);
  expect(owner.origin("a")).toEqual({ x: 24, y: 6 });
  live = { x: 0, y: 0 };
  source.update(0);
  expect(owner.origin("a")).toEqual({ x: 24, y: 6 });
  expect(source.listenerCount()).toBe(1);
  source.update(0);
  expect(owner.origin("a")).toEqual({ x: 24, y: 6 });
  live = { x: 12, y: 9 };
  source.update(2);
  expect(owner.origin("a")).toEqual({ x: 24, y: 4 });
  owner.live("a");
  expect(owner.origin("a")).toBeNull();
  expect(source.listenerCount()).toBe(0);
  owner.dispose();
});

it.each(["cols", "rows"])("remaps %s changes and releases an unresolvable reader", (dimension) => {
  const source = historySource();
  const resolve = vi.fn((): { x: number; y: number } | null => ({ x: 2, y: -20 }));
  const capture = vi.fn(() => resolve);
  const owner = createTerminalScrollback({
    ...source,
    renderSource: { ...source.renderSource, captureReadPosition: capture },
  });
  owner.move("a", 8);
  expect(capture).toHaveBeenLastCalledWith("a", { x: 0, y: -8 });
  source.update(200, { [dimension]: 20 });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(owner.origin("a")).toEqual({ x: 2, y: -20 });
  source.update(205);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(owner.origin("a")).toEqual({ x: 2, y: -25 });
  resolve.mockReturnValue(null);
  source.update(205, { [dimension]: 10 });
  expect(owner.offset("a")).toBe(0);
  expect(source.listenerCount()).toBe(0);
  owner.move("a", 3);
  source.update(205, { generation: "daemon-b", cols: 30 });
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(owner.offset("a")).toBe(0);
  expect(source.listenerCount()).toBe(0);
  owner.dispose();
});

it("anchors a frozen history-free view through resize and scrolling to its live edge", () => {
  const source = historySource();
  source.update(0);
  let viewCols = 40;
  const resolve = vi.fn(() => ({ x: 0, y: -4 }));
  const capture = vi.fn(() => resolve);
  const owner = createTerminalScrollback({
    ...source,
    renderSource: {
      ...source.renderSource,
      paneCanonicalIdentity: () => ({
        ...source.renderSource.paneCanonicalIdentity(),
        viewCols,
        viewRows: 8,
      }),
      captureReadPosition: capture,
    },
  });
  owner.move("a", 0);
  expect(owner.origin("a")).toEqual({ x: 0, y: 0 });
  expect(capture).toHaveBeenLastCalledWith("a", { x: 0, y: 0 });
  expect(source.listenerCount()).toBe(1);
  viewCols = 8;
  source.update(4);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(owner.origin("a")).toEqual({ x: 0, y: -4 });
  owner.move("a", -100);
  expect(owner.origin("a")).toEqual({ x: 0, y: 0 });
  expect(source.listenerCount()).toBe(1);
  owner.move("a", -Infinity);
  expect(owner.origin("a")).toEqual({ x: 0, y: 0 });
  expect(source.listenerCount()).toBe(1);
  owner.live("a");
  expect(owner.origin("a")).toBeNull();
  expect(source.listenerCount()).toBe(0);
  owner.dispose();
});

it("retains wheel-entered views per pane and releases them at the live edge or retirement", () => {
  const source = historySource();
  const released: string[] = [];
  const acquire = vi.fn((id: string) => () => {
    released.push(id);
  });
  const owner = createTerminalScrollback(source, undefined, undefined, acquire);
  owner.move("a", -3);
  expect(acquire).not.toHaveBeenCalled();
  owner.move("a", 3);
  owner.move("a", 3);
  owner.move("b", 4);
  expect(acquire.mock.calls).toEqual([["a"], ["b"]]);
  owner.move("a", -6);
  expect(owner.origin("a")).toBeNull();
  expect(released).toEqual(["a"]);
  expect(owner.origin("b")).not.toBeNull();
  owner.retain(new Set(["a"]));
  expect(released).toEqual(["a", "b"]);
  owner.move("a", 2);
  source.update(100, { generation: "replacement" });
  expect(owner.origin("a")).toBeNull();
  expect(released).toEqual(["a", "b", "a"]);
  owner.move("a", 2);
  owner.dispose();
  expect(released).toEqual(["a", "b", "a", "a"]);
  expect(source.listenerCount()).toBe(0);
});

it("seeks a retained viewport with one subscription and fences replacement", () => {
  const source = historySource();
  const owner = createTerminalScrollback(
    source,
    () => ({ x: 0, y: 0 }),
    (_id, origin) => ({
      x: Math.max(0, Math.min(10, origin.x)),
      y: Math.max(-100, Math.min(0, origin.y)),
    }),
  );
  owner.seek("a", { x: 30, y: -150 });
  expect(owner.origin("a")).toEqual({ x: 10, y: -100 });
  expect(source.listenerCount()).toBe(1);
  owner.seek("a", { x: 3, y: -12 });
  expect(owner.origin("a")).toEqual({ x: 3, y: -12 });
  expect(source.listenerCount()).toBe(1);
  expect(owner.origin("b")).toBeNull();
  source.update(100, { generation: "daemon-b" });
  expect(owner.origin("a")).toBeNull();
  expect(source.listenerCount()).toBe(0);
  owner.dispose();
});
