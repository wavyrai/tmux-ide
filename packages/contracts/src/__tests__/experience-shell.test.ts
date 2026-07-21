import { describe, expect, it } from "vitest";
import {
  CANONICAL_SHELL_AREAS,
  CANONICAL_SURFACE_REGISTRY,
  canonicalSurface,
  commandsToOpenSurface,
} from "../experience-shell.ts";
import { VISUAL_RECIPE_REGISTRY } from "../visual-recipes.ts";

describe("experience shell", () => {
  it("keeps one canonical shell order", () => {
    expect(CANONICAL_SHELL_AREAS.map(({ id }) => id)).toEqual([
      "application-bar",
      "sidebar",
      "primary-navigation",
      "context-actions",
      "workspace-canvas",
      "bottom-dock",
      "status-strip",
    ]);
    expect(CANONICAL_SHELL_AREAS.map(({ order }) => order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("keeps modes and tools in separate, stable registries", () => {
    expect(CANONICAL_SURFACE_REGISTRY.map(({ id }) => id)).toEqual([
      "home",
      "terminals",
      "files",
      "changes",
      "missions",
      "activity",
    ]);
    expect(
      CANONICAL_SURFACE_REGISTRY.filter(({ kind }) => kind === "primary-mode").map(({ id }) => id),
    ).toEqual(["home", "terminals"]);
    expect(
      CANONICAL_SURFACE_REGISTRY.filter(({ kind }) => kind === "dock-tool").map(({ id }) => id),
    ).toEqual(["files", "changes", "missions", "activity"]);
    expect(new Set(CANONICAL_SURFACE_REGISTRY.map(({ shortcut }) => shortcut)).size).toBe(6);
  });

  it("converges direct, keyboard, and deep-link opening on semantic commands", () => {
    expect(commandsToOpenSurface({ surface: "terminals" })).toEqual([
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
    ]);
    expect(commandsToOpenSurface({ surface: "missions", resourceId: "mission.m31" })).toEqual([
      { id: "application.shell.mode.activate", args: { mode: "terminals" } },
      { id: "application.shell.dock.mode.set", args: { mode: "open" } },
      { id: "application.shell.dock.activate", args: { tool: "missions" } },
      {
        id: "application.shell.resource.select",
        args: { surface: "missions", resourceId: "mission.m31" },
      },
    ]);
    expect(canonicalSurface("files").area).toBe("bottom-dock");
    expect(Object.isFrozen(commandsToOpenSurface({ surface: "missions" }))).toBe(true);
  });

  it("keeps flat and elevated presentation intent explicit", () => {
    expect(VISUAL_RECIPE_REGISTRY["pane-docked"].elevation).toBeNull();
    expect(VISUAL_RECIPE_REGISTRY["workspace-canvas"].elevation).toBeNull();
    expect(VISUAL_RECIPE_REGISTRY["pane-floating"].elevation).toBe("floating");
    expect(VISUAL_RECIPE_REGISTRY["command-palette"].elevation).toBe("palette");
  });
});
