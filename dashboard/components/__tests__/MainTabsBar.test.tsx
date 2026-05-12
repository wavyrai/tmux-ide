import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainTabsBar } from "../MainTabsBar";
import {
  __resetNavigationForTests,
  getNavigationStateLive,
  openTab,
  setActiveSession,
  skillTab,
  viewTab,
} from "@/lib/navigation";

beforeEach(() => {
  window.localStorage.clear();
  __resetNavigationForTests({ type: "overview" });
});

afterEach(() => {
  __resetNavigationForTests({ type: "overview" });
});

describe("MainTabsBar", () => {
  it("renders nothing when no tabs are open", () => {
    const { container } = render(<MainTabsBar />);
    expect(container.firstChild).toBeNull();
  });

  it("renders all open tabs and marks the active one", () => {
    setActiveSession("alpha");
    openTab(viewTab("alpha", "plans"));
    render(<MainTabsBar />);

    const tabs = screen.getAllByTestId("main-tab");
    const ids = tabs.map((tab) => tab.getAttribute("data-tab-id"));
    expect(ids).toContain("view:alpha:kanban");
    expect(ids).toContain("view:alpha:plans");
    const activeTab = tabs.find((tab) => tab.getAttribute("data-active") === "true");
    expect(activeTab?.getAttribute("data-tab-id")).toBe("view:alpha:plans");
  });

  it("activates a tab when clicked", () => {
    setActiveSession("alpha");
    openTab(viewTab("alpha", "plans"));
    render(<MainTabsBar />);

    const kanbanTab = screen
      .getAllByTestId("main-tab")
      .find((tab) => tab.getAttribute("data-tab-id") === "view:alpha:kanban");
    expect(kanbanTab).toBeTruthy();
    fireEvent.click(kanbanTab!);
    expect(getNavigationStateLive().activeTabId).toBe("view:alpha:kanban");
  });

  it("closes a tab when its close button is clicked", () => {
    setActiveSession("alpha");
    const skill = skillTab("alpha", "frontend");
    openTab(skill);
    render(<MainTabsBar />);

    const closeButton = screen.getByTestId(`main-tab-close-${skill.id}`);
    fireEvent.click(closeButton);

    const ids = getNavigationStateLive().openTabs.map((t) => t.id);
    expect(ids).not.toContain(skill.id);
  });

  it("renders heterogeneous tab kinds side-by-side", () => {
    setActiveSession("alpha");
    openTab(skillTab("alpha", "frontend"));
    render(<MainTabsBar />);

    const kinds = screen.getAllByTestId("main-tab").map((tab) => tab.getAttribute("data-kind"));
    expect(kinds).toContain("view");
    expect(kinds).toContain("skill");
  });

  it("renders the + add button next to the tabs", () => {
    setActiveSession("alpha");
    render(<MainTabsBar />);
    expect(screen.getByTestId("main-tabs-add")).toBeTruthy();
  });
});
