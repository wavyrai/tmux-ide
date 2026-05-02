import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __clearToastsForTests, useToasts } from "./useToasts";

beforeEach(() => {
  vi.useFakeTimers();
  __clearToastsForTests();
});

afterEach(() => {
  __clearToastsForTests();
  vi.useRealTimers();
});

describe("useToasts", () => {
  it("pushes newest-first toasts and dismisses by id", () => {
    const { result } = renderHook(() => useToasts());

    let first = "";
    let second = "";
    act(() => {
      first = result.current.push({ kind: "info", title: "First" });
      second = result.current.push({ kind: "success", title: "Second" });
    });

    expect(first).toBe("toast:1");
    expect(second).toBe("toast:2");
    expect(result.current.toasts.map((toast) => toast.title)).toEqual(["Second", "First"]);

    act(() => {
      result.current.dismiss(second);
    });

    expect(result.current.toasts.map((toast) => toast.id)).toEqual([first]);
  });

  it("auto-dismisses non-error toasts after the default duration", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.push({ kind: "warning", title: "Heads up" });
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toasts).toEqual([]);
  });

  it("keeps error toasts sticky unless durationMs is provided", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.push({ kind: "error", title: "Sticky" });
      result.current.push({ kind: "error", title: "Timed", durationMs: 1000 });
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.toasts.map((toast) => toast.title)).toEqual(["Sticky"]);
  });

  it("supports clear", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.push({ kind: "info", title: "One" });
      result.current.push({ kind: "success", title: "Two" });
      result.current.clear();
    });

    expect(result.current.toasts).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.toasts).toEqual([]);
  });

  it("caps the queue at 50 and drops the oldest", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      for (let index = 1; index <= 55; index += 1) {
        result.current.push({ kind: "info", title: `Toast ${index}` });
      }
    });

    expect(result.current.toasts).toHaveLength(50);
    expect(result.current.toasts[0]?.title).toBe("Toast 55");
    expect(result.current.toasts.at(-1)?.title).toBe("Toast 6");
  });

  it("replaces an existing id and keeps the replacement timer", () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.push({ id: "stable", kind: "info", title: "First", durationMs: 1000 });
      vi.advanceTimersByTime(500);
      result.current.push({ id: "stable", kind: "success", title: "Second", durationMs: 1000 });
    });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]?.title).toBe("Second");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.toasts).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.toasts).toEqual([]);
  });
});
