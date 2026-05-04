import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLayoutStateForTests, useLayoutState } from "./useLayoutState";
import {
  __resetNavigationForTests,
  defaultTerminalTabId,
  getNavigationStateLive,
  setActiveSession,
} from "./navigation";

beforeEach(() => {
  window.localStorage.clear();
  __resetNavigationForTests({ type: "overview" });
  __resetLayoutStateForTests();
});

afterEach(() => {
  __resetNavigationForTests({ type: "overview" });
});

describe("useLayoutState (deprecated terminal shims)", () => {
  it("terminalOpen is always false — terminals are now part of NavigationState", () => {
    const { result } = renderHook(() => useLayoutState());
    expect(result.current.terminalOpen).toBe(false);
  });

  it("openTerminalMode opens the project's default terminal tab", () => {
    setActiveSession("alpha");
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openTerminalMode();
    });

    const expectedId = defaultTerminalTabId("alpha");
    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === expectedId && t.kind === "terminal")).toBe(true);
    expect(live.activeTabId).toBe(expectedId);
  });

  it("closeTerminalMode closes the default terminal tab when it is active", () => {
    setActiveSession("alpha");
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openTerminalMode();
      result.current.closeTerminalMode();
    });

    const expectedId = defaultTerminalTabId("alpha");
    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === expectedId)).toBe(false);
  });

  it("toggleTerminal opens then closes the default terminal", () => {
    setActiveSession("alpha");
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.toggleTerminal();
    });
    const id = defaultTerminalTabId("alpha");
    expect(getNavigationStateLive().activeTabId).toBe(id);

    act(() => {
      result.current.toggleTerminal();
    });
    expect(getNavigationStateLive().openTabs.some((t) => t.id === id)).toBe(false);
  });

  it("workspace-tab shims compile but no longer mutate layout state", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openWorkspaceTab("project", "alpha", "Alpha");
      result.current.setActivitySection("settings");
      result.current.closeWorkspaceTab("project:alpha");
      result.current.setActiveWorkspaceTab("missing");
      result.current.reorderWorkspaceTabs([]);
    });

    expect(result.current.workspaceTabs).toEqual([]);
    expect(result.current.activeWorkspaceTabId).toBeNull();
    expect(result.current.activitySection).toBe("sessions");
  });
});
