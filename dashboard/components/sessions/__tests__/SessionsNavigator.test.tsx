import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsNavigator } from "../SessionsNavigator";

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/alpha",
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ setOpenMobile: vi.fn(), isMobile: false }),
}));

vi.mock("@/lib/useLayoutState", () => ({
  useLayoutState: () => ({
    openWorkspaceTab: vi.fn(),
    setActivitySection: vi.fn(),
  }),
}));

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

describe("SessionsNavigator", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ sessions }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("renders the navigator shell with a session count badge", async () => {
    await act(async () => {
      render(<SessionsNavigator />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("sessions-navigator")).toBeTruthy(),
    );
  });

  it("renders one row per session and marks the active project", async () => {
    await act(async () => {
      render(<SessionsNavigator />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("navigator-session-alpha")).toBeTruthy();
      expect(screen.getByTestId("navigator-session-beta")).toBeTruthy();
    });
    expect(
      screen.getByTestId("navigator-session-alpha").getAttribute("data-active"),
    ).toBe("true");
    expect(
      screen.getByTestId("navigator-session-beta").getAttribute("data-active"),
    ).toBe("false");
  });

  it("renders an api-unreachable banner when the fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline"))),
    );

    await act(async () => {
      render(<SessionsNavigator />);
    });

    await waitFor(() => {
      expect(screen.getByText(/api unreachable/i)).toBeTruthy();
    });
  });
});
