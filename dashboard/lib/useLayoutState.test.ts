import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLayoutStateForTests, useLayoutState } from "./useLayoutState";

beforeEach(() => {
  window.localStorage.clear();
  __resetLayoutStateForTests({
    terminalOpen: false,
    activeTabIdByProject: {},
    tabs: [],
    workspaceTabs: [],
    activeWorkspaceTabId: null,
    activitySection: "sessions",
  });
});

function readPersisted() {
  const raw = window.localStorage.getItem("tmux-ide.layout.v4");
  return raw ? (JSON.parse(raw) as unknown) : null;
}

describe("useLayoutState", () => {
  it("starts closed and creates a tab whose project becomes active", () => {
    const { result } = renderHook(() => useLayoutState());

    expect(result.current.terminalOpen).toBe(false);
    expect(result.current.activeTabIdByProject).toEqual({});
    expect(result.current.tabs).toEqual([]);

    let tab: ReturnType<typeof result.current.newTab> | undefined;
    act(() => {
      tab = result.current.newTab("alpha");
    });

    expect(tab).toEqual({ id: "alpha:1", title: "alpha 1", projectName: "alpha" });
    expect(result.current.terminalOpen).toBe(true);
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:1");
    expect(result.current.tabs).toEqual([tab]);
    expect(readPersisted()).toEqual({
      activeTabIdByProject: { alpha: "alpha:1" },
      tabs: [tab],
      workspaceTabs: [],
      activeWorkspaceTabId: null,
      activitySection: "sessions",
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
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:2");
    expect(result.current.getActiveTabId("beta")).toBe("beta:1");
  });

  it("creates pane-backed tabs and deduplicates by project pane id", () => {
    const { result } = renderHook(() => useLayoutState());

    let first;
    let duplicate;
    act(() => {
      first = result.current.newPaneTab("alpha", "%2", "alpha · Agent 1");
      duplicate = result.current.newPaneTab("alpha", "%2", "Ignored");
    });

    expect(first).toEqual({
      id: "alpha:%2",
      title: "alpha · Agent 1",
      projectName: "alpha",
      paneId: "%2",
    });
    expect(duplicate).toBe(first);
    expect(result.current.tabs).toEqual([first]);
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:%2");
    expect(readPersisted()).toMatchObject({
      activeTabIdByProject: { alpha: "alpha:%2" },
      tabs: [first],
    });
  });

  it("scopes active tab per project — switching projects restores their own focused tab", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha");
      result.current.newTab("beta");
      result.current.setActiveTab("alpha", "alpha:1");
    });

    expect(result.current.getActiveTabId("alpha")).toBe("alpha:1");
    expect(result.current.getActiveTabId("beta")).toBe("beta:1");

    expect(result.current.getProjectTabs("alpha").map((t) => t.id)).toEqual(["alpha:1"]);
    expect(result.current.getProjectTabs("beta").map((t) => t.id)).toEqual(["beta:1"]);
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

  it("ignores setActiveTab when the tab does not belong to the project", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha");
      result.current.newTab("beta");
      result.current.setActiveTab("alpha", "beta:1");
    });

    expect(result.current.getActiveTabId("alpha")).toBe("alpha:1");
    expect(result.current.getActiveTabId("beta")).toBe("beta:1");

    act(() => {
      result.current.setActiveTab("alpha", "missing:1");
    });
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:1");
  });

  it("closes active tabs with same-project fallthrough and closes mode after the last tab", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.newTab("alpha"); // alpha:1
      result.current.newTab("alpha"); // alpha:2
      result.current.newTab("beta"); // beta:1
      result.current.setActiveTab("alpha", "alpha:1");
      result.current.closeTab("alpha:1");
    });

    // Active falls through to the next alpha tab, not beta:1.
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:2");
    expect(result.current.getActiveTabId("beta")).toBe("beta:1");
    expect(result.current.terminalOpen).toBe(true);

    act(() => {
      result.current.closeTab("alpha:2");
      result.current.closeTab("beta:1");
    });

    expect(result.current.tabs).toEqual([]);
    expect(result.current.getActiveTabId("alpha")).toBeNull();
    expect(result.current.terminalOpen).toBe(false);
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
  });

  it("loads persisted tabs but defaults terminalOpen to false", () => {
    const persisted = {
      activeTabIdByProject: { alpha: "alpha:1", beta: "beta:1" },
      tabs: [
        { id: "alpha:1", title: "alpha 1", projectName: "alpha" },
        { id: "beta:1", title: "beta 1", projectName: "beta" },
      ],
      workspaceTabs: [
        { id: "project:alpha", kind: "project", projectName: "alpha", title: "Alpha" },
      ],
      activeWorkspaceTabId: "project:alpha",
      activitySection: "settings",
    };
    window.localStorage.setItem("tmux-ide.layout.v4", JSON.stringify(persisted));
    __resetLayoutStateForTests();

    const { result } = renderHook(() => useLayoutState());

    expect(result.current.terminalOpen).toBe(false);
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:1");
    expect(result.current.getActiveTabId("beta")).toBe("beta:1");
    expect(result.current.tabs).toEqual(persisted.tabs);
    expect(result.current.workspaceTabs).toEqual(persisted.workspaceTabs);
    expect(result.current.activeWorkspaceTabId).toBe("project:alpha");
    expect(result.current.activitySection).toBe("settings");
  });

  it("migrates legacy v1 single activeTabId into the per-project map", () => {
    const legacy = {
      activeTabId: "alpha:1",
      tabs: [
        { id: "alpha:1", title: "alpha 1", projectName: "alpha" },
        { id: "beta:1", title: "beta 1", projectName: "beta" },
      ],
    };
    window.localStorage.setItem("tmux-ide.layout.v1", JSON.stringify(legacy));
    __resetLayoutStateForTests();

    const { result } = renderHook(() => useLayoutState());

    expect(result.current.tabs.map((t) => t.id)).toEqual(["alpha:1", "beta:1"]);
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:1");
    // beta had no legacy active assignment, so it falls back to first beta tab.
    expect(result.current.getActiveTabId("beta")).toBe("beta:1");
    expect(result.current.workspaceTabs).toEqual([]);
    expect(result.current.activeWorkspaceTabId).toBeNull();
    expect(result.current.activitySection).toBe("sessions");
  });

  it("migrates v2 layout state into v3 workspace tab defaults", () => {
    const legacy = {
      activeTabIdByProject: { alpha: "alpha:1" },
      tabs: [{ id: "alpha:1", title: "alpha 1", projectName: "alpha" }],
    };
    window.localStorage.setItem("tmux-ide.layout.v2", JSON.stringify(legacy));
    __resetLayoutStateForTests();

    const { result } = renderHook(() => useLayoutState());

    expect(result.current.tabs).toEqual(legacy.tabs);
    expect(result.current.activeTabIdByProject).toEqual(legacy.activeTabIdByProject);
    expect(result.current.workspaceTabs).toEqual([]);
    expect(result.current.activeWorkspaceTabId).toBeNull();
    expect(result.current.activitySection).toBe("sessions");
  });

  it("migrates v3 layout state into v4 while preserving optional pane ids", () => {
    const legacy = {
      activeTabIdByProject: { alpha: "alpha:%1" },
      tabs: [
        { id: "alpha:%1", title: "alpha · Master", projectName: "alpha", paneId: "%1" },
        { id: "alpha:1", title: "alpha 1", projectName: "alpha" },
      ],
      workspaceTabs: [],
      activeWorkspaceTabId: null,
      activitySection: "sessions",
    };
    window.localStorage.setItem("tmux-ide.layout.v3", JSON.stringify(legacy));
    __resetLayoutStateForTests();

    const { result } = renderHook(() => useLayoutState());

    expect(result.current.tabs).toEqual(legacy.tabs);
    expect(result.current.getActiveTabId("alpha")).toBe("alpha:%1");
  });

  it("opens workspace tabs and deduplicates by kind and projectName", () => {
    const { result } = renderHook(() => useLayoutState());

    let alpha;
    let duplicate;
    let settings;
    act(() => {
      alpha = result.current.openWorkspaceTab("project", "alpha", "Alpha Project");
      settings = result.current.openWorkspaceTab("settings", null);
      duplicate = result.current.openWorkspaceTab("project", "alpha", "Ignored Title");
    });

    expect(alpha).toEqual({
      id: "project:alpha",
      kind: "project",
      projectName: "alpha",
      title: "Alpha Project",
    });
    expect(settings).toEqual({
      id: "settings:",
      kind: "settings",
      projectName: null,
      title: "Settings",
    });
    expect(duplicate).toBe(alpha);
    expect(result.current.workspaceTabs).toEqual([alpha, settings]);
    expect(result.current.activeWorkspaceTabId).toBe("project:alpha");
    expect(readPersisted()).toMatchObject({
      workspaceTabs: [alpha, settings],
      activeWorkspaceTabId: "project:alpha",
    });
  });

  it("sets active workspace tabs and ignores unknown ids", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openWorkspaceTab("project", "alpha");
      result.current.openWorkspaceTab("settings", null);
      result.current.setActiveWorkspaceTab("project:alpha");
    });

    expect(result.current.activeWorkspaceTabId).toBe("project:alpha");

    act(() => {
      result.current.setActiveWorkspaceTab("missing");
    });

    expect(result.current.activeWorkspaceTabId).toBe("project:alpha");
  });

  it("closes workspace tabs with neighbor fallthrough", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openWorkspaceTab("project", "alpha");
      result.current.openWorkspaceTab("project", "beta");
      result.current.openWorkspaceTab("settings", null);
      result.current.setActiveWorkspaceTab("project:beta");
      result.current.closeWorkspaceTab("project:beta");
    });

    expect(result.current.workspaceTabs.map((tab) => tab.id)).toEqual([
      "project:alpha",
      "settings:",
    ]);
    expect(result.current.activeWorkspaceTabId).toBe("project:alpha");

    act(() => {
      result.current.closeWorkspaceTab("project:alpha");
    });

    expect(result.current.activeWorkspaceTabId).toBe("settings:");

    act(() => {
      result.current.closeWorkspaceTab("settings:");
    });

    expect(result.current.workspaceTabs).toEqual([]);
    expect(result.current.activeWorkspaceTabId).toBeNull();
  });

  it("reorders workspace tabs while ignoring unknown ids and appending omitted tabs", () => {
    const { result } = renderHook(() => useLayoutState());

    act(() => {
      result.current.openWorkspaceTab("project", "alpha");
      result.current.openWorkspaceTab("project", "beta");
      result.current.openWorkspaceTab("settings", null);
      result.current.reorderWorkspaceTabs(["settings:", "missing", "project:alpha"]);
    });

    expect(result.current.workspaceTabs.map((tab) => tab.id)).toEqual([
      "settings:",
      "project:alpha",
      "project:beta",
    ]);
  });

  it("sets and persists the activity section", () => {
    const { result } = renderHook(() => useLayoutState());

    expect(result.current.activitySection).toBe("sessions");

    act(() => {
      result.current.setActivitySection("settings");
    });

    expect(result.current.activitySection).toBe("settings");
    expect(readPersisted()).toMatchObject({ activitySection: "settings" });
  });
});
