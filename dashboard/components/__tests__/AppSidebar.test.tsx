import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "../AppSidebar";
import {
  __resetNavigationForTests,
  setNavigation,
  type NavigationState,
} from "@/lib/navigation";
import { __resetLayoutStateForTests } from "@/lib/useLayoutState";

const SESSIONS = [
  {
    name: "alpha",
    dir: "/repos/alpha",
    pid: 1,
    started: "now",
    pane_count: 1,
    mission: { title: "Ship v2", status: "active" },
    stats: { totalTasks: 6, doneTasks: 4 },
  },
  {
    name: "beta",
    dir: "/repos/beta",
    pid: 2,
    started: "now",
    pane_count: 1,
    mission: null,
    stats: { totalTasks: 0, doneTasks: 0 },
  },
];

const MISSION = {
  mission: {
    title: "Ship v2",
    description: "",
    status: "active",
    branch: null,
    milestones: [],
  },
  validationSummary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
};

const MILESTONES = [
  {
    id: "M1",
    title: "Foundation",
    description: "",
    status: "active",
    order: 1,
    taskCount: 6,
    tasksDone: 4,
  },
  {
    id: "M2",
    title: "Polish",
    description: "",
    status: "locked",
    order: 2,
    taskCount: 3,
    tasksDone: 0,
  },
];

const PLANS = [
  {
    name: "feature-x.md",
    path: "plans/feature-x.md",
    title: "Feature X",
    status: "in-progress" as const,
    effort: null,
    completed: null,
  },
];

const SKILLS = [
  {
    name: "frontend",
    specialties: ["UI"],
    role: "teammate",
    description: "",
    body: "",
  },
];

vi.mock("@/lib/api", () => ({
  fetchSessions: vi.fn(async () => SESSIONS),
  fetchPlans: vi.fn(async () => PLANS),
  fetchSkills: vi.fn(async () => SKILLS),
  injectIntoProject: vi.fn(async () => true),
}));

vi.mock("@/lib/useSessionStream", () => ({
  useSessionStream: () => ({
    snapshot: {
      project: null,
      mission: MISSION,
      milestones: MILESTONES,
      goals: [],
      tasks: [],
      skills: SKILLS,
      agents: [],
      events: [],
    },
    lastEventAt: 0,
    connected: true,
  }),
}));

function renderSidebar() {
  return render(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  __resetNavigationForTests({ type: "overview" });
  __resetLayoutStateForTests();
  if (typeof window !== "undefined") {
    window.localStorage.clear();
  }
});

afterEach(() => {
  __resetNavigationForTests({ type: "overview" });
});

describe("AppSidebar", () => {
  it("does not render the legacy mode-picker buttons", () => {
    renderSidebar();
    expect(screen.queryByTestId("sidebar-mode-sessions")).toBeNull();
    expect(screen.queryByTestId("sidebar-mode-skills")).toBeNull();
    expect(screen.queryByTestId("sidebar-mode-settings")).toBeNull();
  });

  it("shows the sessions list on overview", async () => {
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-session-alpha")).toBeTruthy();
    });
    expect(screen.getByTestId("sidebar-session-beta")).toBeTruthy();
    // No project tree sections on overview
    expect(screen.queryByTestId("sidebar-section-mission")).toBeNull();
  });

  it("renders project tree sections + view leaves when on a project", async () => {
    setNavigation({ type: "sessions", sessionName: "alpha" } as NavigationState);
    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("sidebar-section-mission")).toBeTruthy();
    });
    expect(screen.getByTestId("sidebar-section-plans")).toBeTruthy();
    expect(screen.getByTestId("sidebar-section-skills")).toBeTruthy();
    expect(screen.getByTestId("sidebar-section-files")).toBeTruthy();

    // View leaves
    expect(screen.getByTestId("sidebar-view-diffs")).toBeTruthy();
    expect(screen.getByTestId("sidebar-view-validation")).toBeTruthy();
    expect(screen.getByTestId("sidebar-view-metrics")).toBeTruthy();
    expect(screen.getByTestId("sidebar-view-activity")).toBeTruthy();
  });

  it("renders milestone tree items inside the Mission section", async () => {
    setNavigation({ type: "sessions", sessionName: "alpha" } as NavigationState);
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-milestone-M1")).toBeTruthy();
    });
    expect(screen.getByTestId("sidebar-milestone-M2")).toBeTruthy();
  });

  it("toggles section expansion when the header is clicked", async () => {
    setNavigation({ type: "sessions", sessionName: "alpha" } as NavigationState);
    renderSidebar();
    const skillsHeader = await screen.findByTestId("sidebar-section-skills");
    // Default for skills is collapsed.
    expect(skillsHeader.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(skillsHeader);
    await waitFor(() => {
      expect(
        screen.getByTestId("sidebar-section-skills").getAttribute("aria-expanded"),
      ).toBe("true");
    });
  });

  it("opens a project view leaf via setNavigation", async () => {
    setNavigation({ type: "sessions", sessionName: "alpha" } as NavigationState);
    renderSidebar();
    const diffs = await screen.findByTestId("sidebar-view-diffs");
    fireEvent.click(diffs);
    // window.location is updated by the navigation store via replaceState.
    await waitFor(() => {
      expect(window.location.search).toContain("tab=diffs");
    });
  });

  // Regression: clicking the Terminal leaf must add the terminal tab to
  // openTabs AND make it the active tab, persisting through any subsequent
  // URL-driven resync. The bug was that the implicit kanban default in the
  // URL flowed back into navigation state and clobbered the terminal.
  it("opens the project's default terminal tab when the Terminal leaf is clicked", async () => {
    const { setActiveSession, getNavigationStateLive, defaultTerminalTabId, stateFromPath, setNavigation: setNav } =
      await import("@/lib/navigation");
    window.history.replaceState(null, "", "/project/alpha");
    setActiveSession("alpha");
    renderSidebar();
    const terminal = await screen.findByTestId("sidebar-view-terminal");
    fireEvent.click(terminal);

    const expectedId = defaultTerminalTabId("alpha");
    await waitFor(() => {
      const live = getNavigationStateLive();
      expect(live.openTabs.some((t) => t.id === expectedId)).toBe(true);
      expect(live.activeTabId).toBe(expectedId);
    });

    // localStorage must persist the terminal tab so a reload restores it.
    const persisted = window.localStorage.getItem("tmux-ide.tabs.alpha");
    expect(persisted).toBeTruthy();
    const parsed = JSON.parse(persisted!) as {
      openTabs: Array<{ id: string }>;
      activeTabId: string;
    };
    expect(parsed.openTabs.some((t) => t.id === expectedId)).toBe(true);
    expect(parsed.activeTabId).toBe(expectedId);

    // Simulate a popstate-like resync: re-derive state from the URL and
    // feed it through setNavigation. The terminal must NOT snap back to
    // kanban — the bug we are fixing.
    const fromUrl = stateFromPath(window.location.pathname, window.location.search);
    setNav(fromUrl);

    const after = getNavigationStateLive();
    expect(after.openTabs.some((t) => t.id === expectedId)).toBe(true);
    expect(after.activeTabId).toBe(expectedId);
  });
});
