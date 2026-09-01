import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApplicationTerminalPaletteOwner,
  type ApplicationTerminalPaletteRenderer,
} from "./application-terminal-palette-owner.ts";

const colors = (background = "#101010", foreground = "#eeeeee") => ({
  palette: Array.from({ length: 16 }, (_, index) => `#${index.toString(16).padStart(6, "0")}`),
  defaultForeground: foreground,
  defaultBackground: background,
});

class Renderer extends EventEmitter implements ApplicationTerminalPaletteRenderer {
  themeMode: "dark" | "light" | null = "dark";
  capabilities: unknown = { rgb: true, ansi256: true };
  readonly clearPaletteCache = vi.fn();
  readonly getPalette = vi.fn<ApplicationTerminalPaletteRenderer["getPalette"]>(async () =>
    colors(),
  );
  readonly inputHandlers = new Set<(sequence: string) => boolean>();
  prependInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.add(handler);
  }
  removeInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.delete(handler);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("application terminal palette owner", () => {
  it("publishes an immutable unavailable fallback on first failure", async () => {
    const renderer = new Renderer();
    renderer.getPalette.mockRejectedValueOnce(new Error("unsupported"));
    const owner = createApplicationTerminalPaletteOwner(renderer, { queryTimeoutMs: 17 });
    await owner.ready;
    expect(owner.getSnapshot()).toMatchObject({
      availability: "unavailable",
      detectedMode: "dark",
      defaultForeground: null,
      defaultBackground: null,
    });
    expect(owner.getSnapshot().palette).toHaveLength(16);
    expect(Object.isFrozen(owner.getSnapshot())).toBe(true);
    expect(renderer.getPalette).toHaveBeenCalledWith({ size: 16, timeout: 17 });
    owner.dispose();
  });

  it("bounds unsupported palette detection to one startup query with no idle polling", async () => {
    vi.useFakeTimers();
    const renderer = new Renderer();
    renderer.getPalette.mockRejectedValue(new Error("palette queries unsupported"));
    const owner = createApplicationTerminalPaletteOwner(renderer, { queryTimeoutMs: 17 });

    await owner.ready;
    expect(owner.getSnapshot().availability).toBe("unavailable");
    expect(renderer.getPalette).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    expect(renderer.getPalette).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    owner.dispose();
  });

  it("treats a successful query with no reported colors as unavailable", async () => {
    const renderer = new Renderer();
    renderer.getPalette.mockResolvedValueOnce({ palette: [] });
    const owner = createApplicationTerminalPaletteOwner(renderer);
    await owner.ready;
    expect(owner.getSnapshot().availability).toBe("unavailable");
    owner.dispose();
  });

  it("retains a later valid result across failures and suppresses duplicate signatures", async () => {
    const renderer = new Renderer();
    const owner = createApplicationTerminalPaletteOwner(renderer);
    const listener = vi.fn();
    owner.subscribe(listener);
    await owner.ready;
    const valid = owner.getSnapshot();
    expect(valid.availability).toBe("available");
    expect(valid.detectedMode).toBe("dark");

    renderer.getPalette.mockResolvedValueOnce(colors());
    await owner.refresh();
    expect(owner.getSnapshot()).toBe(valid);
    expect(listener).toHaveBeenCalledTimes(1);

    renderer.getPalette.mockRejectedValueOnce(new Error("late failure"));
    await owner.refresh();
    expect(owner.getSnapshot()).toBe(valid);
    expect(listener).toHaveBeenCalledTimes(1);

    renderer.getPalette.mockResolvedValueOnce(colors("#fefefe", "#111111"));
    await owner.refresh();
    expect(owner.getSnapshot().signature).not.toBe(valid.signature);
    expect(owner.getSnapshot().detectedMode).toBe("light");
    expect(listener).toHaveBeenCalledTimes(2);
    owner.dispose();
  });

  it("coalesces concurrent requests into one active query and one queued refresh", async () => {
    const renderer = new Renderer();
    const first = deferred<ReturnType<typeof colors>>();
    const second = deferred<ReturnType<typeof colors>>();
    renderer.getPalette.mockImplementationOnce(() => first.promise);
    renderer.getPalette.mockImplementationOnce(() => second.promise);
    const owner = createApplicationTerminalPaletteOwner(renderer);
    await Promise.resolve();
    void owner.refresh();
    void owner.refresh();
    expect(renderer.getPalette).toHaveBeenCalledTimes(1);
    first.resolve(colors());
    await owner.ready;
    await Promise.resolve();
    expect(renderer.getPalette).toHaveBeenCalledTimes(2);
    second.resolve(colors("#202020"));
    await Promise.resolve();
    await Promise.resolve();
    expect(renderer.getPalette).toHaveBeenCalledTimes(2);
    owner.dispose();
  });

  it("observes OSC 997 without consuming input and removes every scheduled owner on dispose", async () => {
    vi.useFakeTimers();
    const renderer = new Renderer();
    const owner = createApplicationTerminalPaletteOwner(renderer);
    await owner.ready;
    const handler = [...renderer.inputHandlers][0]!;
    expect(handler("ordinary input")).toBe(false);
    expect(handler("\x1b[?997;1n")).toBe(false);
    await Promise.resolve();
    expect(renderer.getPalette).toHaveBeenCalledTimes(2);
    owner.dispose();
    expect(renderer.inputHandlers).toHaveLength(0);
    expect(renderer.listenerCount("theme_mode")).toBe(0);
    expect(renderer.listenerCount("capabilities")).toBe(0);
    await vi.runAllTimersAsync();
    expect(renderer.getPalette).toHaveBeenCalledTimes(2);
  });

  it("only refreshes renderer theme changes while system mode is unlocked", async () => {
    vi.useFakeTimers();
    const renderer = new Renderer();
    let unlocked = false;
    const owner = createApplicationTerminalPaletteOwner(renderer, {
      isThemeModeUnlocked: () => unlocked,
    });
    await owner.ready;
    renderer.emit("theme_mode", "light");
    await vi.runAllTimersAsync();
    expect(renderer.getPalette).toHaveBeenCalledTimes(1);
    unlocked = true;
    renderer.emit("theme_mode", "light");
    await vi.runAllTimersAsync();
    expect(renderer.getPalette).toHaveBeenCalledTimes(4);
    owner.dispose();
  });

  it("fences a palette result that settles after disposal", async () => {
    const renderer = new Renderer();
    const pending = deferred<ReturnType<typeof colors>>();
    renderer.getPalette.mockImplementationOnce(() => pending.promise);
    const owner = createApplicationTerminalPaletteOwner(renderer);
    const listener = vi.fn();
    owner.subscribe(listener);
    await Promise.resolve();
    owner.dispose();
    pending.resolve(colors("#fafafa"));
    await owner.ready;
    expect(listener).not.toHaveBeenCalled();
    expect(owner.getSnapshot().availability).toBe("pending");
  });
});
