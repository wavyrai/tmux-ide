import { describe, it, expect } from "vitest";
import { resolveEntry } from "./entry.ts";

describe("resolveEntry", () => {
  it("launches the project when an ide.yml is present", () => {
    expect(resolveEntry({ hasIdeYml: true, teamFlag: false, frontDoor: false })).toBe("project");
  });

  it("opens the cockpit when there's no ide.yml and the front door is off", () => {
    expect(resolveEntry({ hasIdeYml: false, teamFlag: false, frontDoor: false })).toBe("cockpit");
  });

  it("forces the cockpit with --team even when an ide.yml is present", () => {
    expect(resolveEntry({ hasIdeYml: true, teamFlag: true, frontDoor: false })).toBe("cockpit");
  });

  it("opens the cockpit with --team and no ide.yml", () => {
    expect(resolveEntry({ hasIdeYml: false, teamFlag: true, frontDoor: false })).toBe("cockpit");
  });

  describe("front-door flip (app.frontDoor)", () => {
    it("opens the unified app when no ide.yml and the front door is on", () => {
      expect(resolveEntry({ hasIdeYml: false, teamFlag: false, frontDoor: true })).toBe("app");
    });

    it("still launches a present ide.yml even with the front door on", () => {
      expect(resolveEntry({ hasIdeYml: true, teamFlag: false, frontDoor: true })).toBe("project");
    });

    it("still honors an explicit --team as the classic cockpit with the front door on", () => {
      expect(resolveEntry({ hasIdeYml: false, teamFlag: true, frontDoor: true })).toBe("cockpit");
      expect(resolveEntry({ hasIdeYml: true, teamFlag: true, frontDoor: true })).toBe("cockpit");
    });
  });
});
