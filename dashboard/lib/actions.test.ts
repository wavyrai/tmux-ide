import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __clearActionsForTests, registerAction, runAction, useActions } from "./actions";

beforeEach(() => {
  __clearActionsForTests();
});

afterEach(() => {
  __clearActionsForTests();
});

describe("actions registry", () => {
  it("registers, sorts, and unregisters actions", () => {
    const { result } = renderHook(() => useActions());

    let cleanupB = () => undefined;
    let cleanupA = () => undefined;
    act(() => {
      cleanupB = registerAction({
        id: "beta",
        label: "Beta",
        scope: { category: "two" },
        run: vi.fn(),
      });
      cleanupA = registerAction({
        id: "alpha",
        label: "Alpha",
        scope: { category: "one" },
        run: vi.fn(),
      });
    });

    expect(result.current.map((action) => action.id)).toEqual(["alpha", "beta"]);

    act(() => cleanupA());
    expect(result.current.map((action) => action.id)).toEqual(["beta"]);

    act(() => cleanupB());
    expect(result.current).toEqual([]);
  });

  it("filters by section with global as the default section", () => {
    const { result: globalResult } = renderHook(() => useActions({ section: "global" }));
    const { result: terminalResult } = renderHook(() => useActions({ section: "terminal" }));

    act(() => {
      registerAction({ id: "global-action", label: "Global", run: vi.fn() });
      registerAction({
        id: "terminal-action",
        label: "Terminal",
        scope: { section: "terminal" },
        run: vi.fn(),
      });
    });

    expect(globalResult.current.map((action) => action.id)).toEqual(["global-action"]);
    expect(terminalResult.current.map((action) => action.id)).toEqual(["terminal-action"]);
  });

  it("hides unavailable actions and refuses to run them", () => {
    const availableRun = vi.fn();
    const unavailableRun = vi.fn();
    const { result } = renderHook(() => useActions());

    act(() => {
      registerAction({
        id: "available",
        label: "Available",
        run: availableRun,
        isAvailable: () => true,
      });
      registerAction({
        id: "unavailable",
        label: "Unavailable",
        run: unavailableRun,
        isAvailable: () => false,
      });
    });

    expect(result.current.map((action) => action.id)).toEqual(["available"]);

    runAction("available");
    runAction("unavailable");

    expect(availableRun).toHaveBeenCalledOnce();
    expect(unavailableRun).not.toHaveBeenCalled();
  });

  it("deduplicates by id with last write winning and cleanup preserving replacements", () => {
    const firstRun = vi.fn();
    const secondRun = vi.fn();
    const { result } = renderHook(() => useActions());

    let cleanupFirst = () => undefined;
    let cleanupSecond = () => undefined;
    act(() => {
      cleanupFirst = registerAction({ id: "duplicate", label: "First", run: firstRun });
      cleanupSecond = registerAction({ id: "duplicate", label: "Second", run: secondRun });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0]?.label).toBe("Second");

    runAction("duplicate");
    expect(firstRun).not.toHaveBeenCalled();
    expect(secondRun).toHaveBeenCalledOnce();

    act(() => cleanupFirst());
    expect(result.current[0]?.label).toBe("Second");

    act(() => cleanupSecond());
    expect(result.current).toEqual([]);
  });
});
