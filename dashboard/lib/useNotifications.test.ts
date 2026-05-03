import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __clearNotificationsForTests,
  __resetNotificationsForTests,
  useNotifications,
} from "./useNotifications";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-02T12:00:00Z"));
  window.localStorage.clear();
  __clearNotificationsForTests();
});

afterEach(() => {
  __clearNotificationsForTests();
  vi.useRealTimers();
});

describe("useNotifications", () => {
  it("pushes notifications, tracks unread, and marks read", () => {
    const { result } = renderHook(() => useNotifications());

    let id = "";
    act(() => {
      id = result.current.push({ kind: "info", title: "Dispatched task" });
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      id,
      kind: "info",
      title: "Dispatched task",
      read: false,
      timestamp: Date.parse("2026-05-02T12:00:00Z"),
    });
    expect(result.current.unreadCount).toBe(1);

    act(() => {
      result.current.markRead(id);
    });

    expect(result.current.items[0]?.read).toBe(true);
    expect(result.current.unreadCount).toBe(0);
  });

  it("marks all read and clears", () => {
    const { result } = renderHook(() => useNotifications());

    act(() => {
      result.current.push({ kind: "warning", title: "Agent idle" });
      result.current.push({ kind: "error", title: "Task failed" });
    });
    expect(result.current.unreadCount).toBe(2);

    act(() => {
      result.current.markAllRead();
    });
    expect(result.current.unreadCount).toBe(0);

    act(() => {
      result.current.clear();
    });
    expect(result.current.items).toEqual([]);
  });

  it("persists v1 history and prunes old entries", () => {
    const now = Date.parse("2026-05-02T12:00:00Z");
    window.localStorage.setItem(
      "tmux-ide.notifications.v1",
      JSON.stringify({
        items: [
          { id: "fresh", timestamp: now, kind: "success", title: "Fresh", read: false },
          {
            id: "old",
            timestamp: now - 31 * 24 * 60 * 60 * 1000,
            kind: "info",
            title: "Old",
            read: false,
          },
        ],
      }),
    );

    __resetNotificationsForTests();
    const { result } = renderHook(() => useNotifications());

    expect(result.current.items.map((item) => item.id)).toEqual(["fresh"]);

    act(() => {
      result.current.push({ id: "stable", kind: "info", title: "Persisted" });
    });

    const stored = JSON.parse(window.localStorage.getItem("tmux-ide.notifications.v1") ?? "{}") as {
      items: Array<{ id: string }>;
    };
    expect(stored.items.map((item) => item.id)).toEqual(["stable", "fresh"]);
  });

  it("caps history at 500 newest items", () => {
    const { result } = renderHook(() => useNotifications());

    act(() => {
      for (let index = 1; index <= 505; index += 1) {
        vi.setSystemTime(new Date(Date.parse("2026-05-02T12:00:00Z") + index));
        result.current.push({ kind: "info", title: `Item ${index}` });
      }
    });

    expect(result.current.items).toHaveLength(500);
    expect(result.current.items[0]?.title).toBe("Item 505");
    expect(result.current.items.at(-1)?.title).toBe("Item 6");
  });
});
