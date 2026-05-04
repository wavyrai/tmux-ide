import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsNavigator } from "../SkillsNavigator";

vi.mock("next/navigation", () => ({
  usePathname: () => "/project/alpha",
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ setOpenMobile: vi.fn(), isMobile: false }),
}));

vi.mock("@/lib/useLayoutState", () => ({
  useLayoutState: () => ({
    openWorkspaceTab: vi.fn(),
  }),
}));

vi.mock("@/lib/useToasts", () => ({
  useToasts: () => ({ push: vi.fn() }),
}));

const SKILLS = [
  {
    name: "frontend",
    description: "Frontend specialist",
    body: "# Frontend",
    role: "specialist",
    specialties: ["react", "tailwind"],
    tools: [],
  },
  {
    name: "backend",
    description: "",
    body: "",
    role: null,
    specialties: [],
    tools: [],
  },
];

describe("SkillsNavigator", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ skills: SKILLS }))),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders skills returned by the API", async () => {
    await act(async () => {
      render(<SkillsNavigator />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("navigator-skill-frontend")).toBeTruthy();
      expect(screen.getByTestId("navigator-skill-backend")).toBeTruthy();
      expect(screen.getByText("react")).toBeTruthy();
    });
  });

  it("exposes a per-skill inject action", async () => {
    await act(async () => {
      render(<SkillsNavigator />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("navigator-skill-inject-frontend")).toBeTruthy();
    });
  });
});
