import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSwitcher } from "../ProjectSwitcher";
import { __resetNavigationForTests, getNavigationLive } from "@/lib/navigation";

const sessions = [
  {
    name: "alpha",
    dir: "/repos/alpha",
    mission: { title: "Ship v2", status: "active" },
    stats: { totalTasks: 10, doneTasks: 4, agents: 2, activeAgents: 1 },
    goals: [],
  },
  {
    name: "beta",
    dir: "/repos/beta",
    mission: null,
    stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
    goals: [],
  },
];

describe("ProjectSwitcher", () => {
  beforeEach(() => {
    __resetNavigationForTests({ type: "overview" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ sessions }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetNavigationForTests({ type: "overview" });
  });

  it("renders the trigger with the default tmux-ide label on overview", async () => {
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    const button = screen.getByTestId("project-switcher-button");
    expect(button).toBeTruthy();
    expect(button.textContent).toContain("tmux-ide");
  });

  it("opens the popover when the trigger is clicked", async () => {
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("project-switcher-popover")).toBeTruthy();
    });
  });

  it("lists fetched sessions inside the popover", async () => {
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("project-switcher-item-alpha")).toBeTruthy();
      expect(screen.getByTestId("project-switcher-item-beta")).toBeTruthy();
    });
    // Mission title should render alongside the session name.
    expect(screen.getByText("Ship v2")).toBeTruthy();
    // Task progress badge.
    expect(screen.getByText("4/10")).toBeTruthy();
  });

  it("dispatches setNavigation when a session item is clicked", async () => {
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("project-switcher-item-alpha")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-item-alpha"));
    });
    const next = getNavigationLive();
    expect(next.type).toBe("sessions");
    if (next.type === "sessions") {
      expect(next.sessionName).toBe("alpha");
      expect(next.tab).toBe("kanban");
    }
  });

  it("renders Skills, Settings, and Overview entries that update navigation", async () => {
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-button"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("project-switcher-item-settings")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-item-settings"));
    });
    expect(getNavigationLive().type).toBe("settings");
  });

  it("opens the popover via the Cmd-P keybind", async () => {
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("project-switcher-popover")).toBeTruthy();
    });
  });

  it("renders an api unreachable banner when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );
    await act(async () => {
      render(<ProjectSwitcher />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("project-switcher-button"));
    });
    await waitFor(() => {
      expect(screen.getByText(/api unreachable/i)).toBeTruthy();
    });
  });
});
