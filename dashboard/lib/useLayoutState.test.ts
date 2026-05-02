import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLayoutStateForTests, useLayoutState } from "./useLayoutState";

beforeEach(() => {
  window.localStorage.clear();
  __resetLayoutStateForTests({
    terminalOpen: false,
    activeTabId: null,
    tabs: [],
  });
});

function readPersisted() {
  const raw = window.localStorage.getItem("tmux-ide.layout.v1");
  return raw ? (JSON.parse(raw) as unknown) : null;
}

describe("useLayoutState", () => {
  it("starts closed and creates an active tab with the project sequence", () => {
    const { result } = renderHook(() => useLayoutState());

    expect(result.current.terminalOpen).toBe(false);
    expect(result.current.activeTabId).toBeNull();
    expect(result.current.tabs).toEqual([]);

    let tab: ReturnType<typeof result.current.newTab> | undefined;
    act(() => {
      tab = result.current.newTab("alpha");
    });

    expect(tab).toEqual({ id: "alpha:1", title: "alpha 1", projectName: "alpha" });
    expect(result.current.terminalOpen).toBe(true);
    expect(result.current.activeTabId).toBe("alpha:1");
    expect(result.current.tabs).toEqual([tab]);
    expect(readPersisted()).toEqual({
      activeTabId: "alpha:1",
      tabs: [tab],
    });
  });

  it("supports custom titles and per-project id sequences", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha", "Shell");
      result.current.newTab("beta");
      result.current.newTab("alpha");
    });

    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["alpha:1", "beta:1", "alpha:2"]);
    expect(result.current.tabs[0]?.title).toBe("Shell");
    expect(result.current.tabs[2]?.title).toBe("alpha 2");
    expect(result.current.activeTabId).toBe("alpha:2");
  });

  it("opens, closes, and toggles terminal mode without persisting terminalOpen", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openTerminalMode();
    });
    expect(result.current.terminalOpen).toBe(true);
    expect(readPersisted()).toBeNull();

    act(() => {
      result.current.toggleTerminal();
    });
    expect(result.current.terminalOpen).toBe(false);

    act(() => {
      result.current.closeTerminalMode();
    });
    expect(result.current.terminalOpen).toBe(false);
  });

  it("sets an existing active tab and ignores unknown ids", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha");
      result.current.newTab("beta");
      result.current.setActiveTab("alpha:1");
    });

    expect(result.current.activeTabId).toBe("alpha:1");
    expect(result.current.terminalOpen).toBe(true);

    act(() => {
      result.current.setActiveTab("missing:1");
    });

    expect(result.current.activeTabId).toBe("alpha:1");
  });

  it("closes active tabs with neighbor fallthrough and closes mode after the last tab", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha");
      result.current.newTab("beta");
      result.current.newTab("gamma");
      result.current.setActiveTab("beta:1");
      result.current.closeTab("beta:1");
    });

    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["alpha:1", "gamma:1"]);
    expect(result.current.activeTabId).toBe("alpha:1");
    expect(result.current.terminalOpen).toBe(true);

    act(() => {
      result.current.closeTab("alpha:1");
    });

    expect(result.current.activeTabId).toBe("gamma:1");
    expect(result.current.terminalOpen).toBe(true);

    act(() => {
      result.current.closeTab("gamma:1");
    });

    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBeNull();
    expect(result.current.terminalOpen).toBe(false);
  });

  it("does not change state when closing a missing tab", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha");
      result.current.closeTab("missing:1");
    });

    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["alpha:1"]);
    expect(result.current.activeTabId).toBe("alpha:1");
  });

  it("reorders known tab ids and appends omitted tabs", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha");
      result.current.newTab("beta");
      result.current.newTab("gamma");
      result.current.reorderTabs(["gamma:1", "alpha:1"]);
    });

    expect(result.current.tabs.map((tab) => tab.id)).toEqual(["gamma:1", "alpha:1", "beta:1"]);
    expect(result.current.activeTabId).toBe("gamma:1");
  });

  it("loads persisted tabs but defaults terminalOpen to false", () => {
    const persisted = {
      activeTabId: "beta:1",
      tabs: [
        { id: "alpha:1", title: "alpha 1", projectName: "alpha" },
        { id: "beta:1", title: "beta 1", projectName: "beta" },
      ],
    };
    window.localStorage.setItem("tmux-ide.layout.v1", JSON.stringify(persisted));
    __resetLayoutStateForTests();

    const { result } = renderHook(() => useLayoutState());

    expect(result.current.terminalOpen).toBe(false);
    expect(result.current.activeTabId).toBe("beta:1");
    expect(result.current.tabs).toEqual(persisted.tabs);
  });
});
