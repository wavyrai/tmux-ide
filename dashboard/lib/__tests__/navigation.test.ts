import { describe, expect, it } from "vitest";
import {
  isOverview,
  isSessions,
  isSettings,
  isSkills,
  pathFromState,
  stateFromPath,
  type NavigationState,
} from "../navigation";

describe("navigation type guards", () => {
  it("isOverview narrows to the overview variant", () => {
    const overview: NavigationState = { type: "overview" };
    expect(isOverview(overview)).toBe(true);
    expect(isSettings(overview)).toBe(false);
    expect(isSkills(overview)).toBe(false);
    expect(isSessions(overview)).toBe(false);
  });

  it("isSessions / isSkills / isSettings narrow correctly", () => {
    const sessions: NavigationState = { type: "sessions", sessionName: "alpha", tab: "kanban" };
    const skills: NavigationState = { type: "skills", sessionName: "alpha" };
    const settings: NavigationState = { type: "settings", section: "general" };

    expect(isSessions(sessions)).toBe(true);
    expect(isSessions(skills)).toBe(false);
    expect(isSkills(skills)).toBe(true);
    expect(isSkills(settings)).toBe(false);
    expect(isSettings(settings)).toBe(true);
    expect(isSettings(sessions)).toBe(false);
  });
});

describe("pathFromState", () => {
  it("renders overview at /", () => {
    expect(pathFromState({ type: "overview" })).toBe("/");
  });

  it("renders settings with mode=settings query param", () => {
    expect(pathFromState({ type: "settings" })).toBe("/?mode=settings");
    expect(pathFromState({ type: "settings", section: "general" })).toBe("/?mode=settings");
    expect(pathFromState({ type: "settings", section: "appearance" })).toBe(
      "/?mode=settings&section=appearance",
    );
  });

  it("renders skills with and without an active session", () => {
    expect(pathFromState({ type: "skills" })).toBe("/?mode=skills");
    expect(pathFromState({ type: "skills", sessionName: "alpha" })).toBe(
      "/project/alpha?mode=skills",
    );
    expect(pathFromState({ type: "skills", sessionName: "alpha", skillName: "frontend" })).toBe(
      "/project/alpha?mode=skills&skill=frontend",
    );
  });

  it("renders session paths and only includes ?tab= for non-default tabs", () => {
    expect(pathFromState({ type: "sessions" })).toBe("/");
    expect(pathFromState({ type: "sessions", sessionName: "alpha" })).toBe("/project/alpha");
    expect(pathFromState({ type: "sessions", sessionName: "alpha", tab: "kanban" })).toBe(
      "/project/alpha",
    );
    expect(pathFromState({ type: "sessions", sessionName: "alpha", tab: "plans" })).toBe(
      "/project/alpha?tab=plans",
    );
  });

  it("encodes session names with special characters", () => {
    expect(pathFromState({ type: "sessions", sessionName: "my project" })).toBe(
      "/project/my%20project",
    );
  });
});

describe("stateFromPath", () => {
  it("parses overview from /", () => {
    expect(stateFromPath("/", "")).toEqual({ type: "overview" });
  });

  it("parses settings with optional section", () => {
    expect(stateFromPath("/", "mode=settings")).toEqual({ type: "settings" });
    expect(stateFromPath("/", "mode=settings&section=keybinds")).toEqual({
      type: "settings",
      section: "keybinds",
    });
  });

  it("ignores unknown settings sections", () => {
    expect(stateFromPath("/", "mode=settings&section=bogus")).toEqual({ type: "settings" });
  });

  it("parses skills mode without a project", () => {
    expect(stateFromPath("/", "mode=skills")).toEqual({ type: "skills" });
  });

  it("parses session routes with default kanban tab", () => {
    expect(stateFromPath("/project/alpha", "")).toEqual({
      type: "sessions",
      sessionName: "alpha",
      tab: "kanban",
    });
  });

  it("parses session routes with explicit tab and decodes session names", () => {
    expect(stateFromPath("/project/my%20app", "tab=plans")).toEqual({
      type: "sessions",
      sessionName: "my app",
      tab: "plans",
    });
  });

  it("falls back to kanban when ?tab= is unknown", () => {
    expect(stateFromPath("/project/alpha", "tab=garbage")).toEqual({
      type: "sessions",
      sessionName: "alpha",
      tab: "kanban",
    });
  });

  it("parses skill routes with optional skill name", () => {
    expect(stateFromPath("/project/alpha", "mode=skills")).toEqual({
      type: "skills",
      sessionName: "alpha",
    });
    expect(stateFromPath("/project/alpha", "mode=skills&skill=frontend")).toEqual({
      type: "skills",
      sessionName: "alpha",
      skillName: "frontend",
    });
  });

  it("round-trips through pathFromState → stateFromPath", () => {
    const cases: NavigationState[] = [
      { type: "overview" },
      { type: "settings" },
      { type: "settings", section: "keybinds" },
      { type: "skills" },
      { type: "skills", sessionName: "alpha" },
      { type: "skills", sessionName: "alpha", skillName: "frontend" },
      { type: "sessions", sessionName: "alpha", tab: "kanban" },
      { type: "sessions", sessionName: "alpha", tab: "plans" },
      { type: "sessions", sessionName: "alpha", tab: "metrics" },
    ];
    for (const state of cases) {
      const url = pathFromState(state);
      const [pathname, search = ""] = url.split("?");
      const parsed = stateFromPath(pathname!, search);
      expect(parsed).toEqual(state);
    }
  });
});
