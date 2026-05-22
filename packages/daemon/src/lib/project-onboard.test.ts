import { describe, expect, it } from "bun:test";
import {
  assertNoExistingIdeYml,
  composeIdeYml,
  composeIdeYmlConfig,
  OnboardConflictError,
  OnboardInvalidInputError,
} from "./project-onboard.ts";

describe("composeIdeYmlConfig", () => {
  it("produces a 1-agent config without a team block", () => {
    const config = composeIdeYmlConfig({ name: "alpha", agents: 1 });
    expect(config.name).toBe("alpha");
    expect(config.team).toBeUndefined();
    expect(config.rows).toHaveLength(2);
    expect(config.rows[0]!.panes).toHaveLength(1);
    expect(config.rows[0]!.panes[0]).toMatchObject({
      title: "Claude 1",
      command: "claude",
      focus: true,
    });
    // 1-agent should not declare a role
    expect(config.rows[0]!.panes[0]!.role).toBeUndefined();
  });

  it("produces a 2-agent config with team block + lead/teammate roles", () => {
    const config = composeIdeYmlConfig({ name: "alpha", agents: 2 });
    expect(config.team).toEqual({ name: "alpha" });
    expect(config.rows[0]!.panes).toHaveLength(2);
    expect(config.rows[0]!.panes[0]).toMatchObject({
      title: "Lead",
      command: "claude",
      role: "lead",
      focus: true,
    });
    expect(config.rows[0]!.panes[1]).toMatchObject({
      title: "Teammate 1",
      command: "claude",
      role: "teammate",
    });
    expect(config.rows[0]!.panes[1]!.focus).toBeUndefined();
  });

  it("produces a 3-agent config with team block + 2 teammates", () => {
    const config = composeIdeYmlConfig({ name: "alpha", agents: 3 });
    expect(config.team).toEqual({ name: "alpha" });
    expect(config.rows[0]!.panes).toHaveLength(3);
    expect(config.rows[0]!.panes.map((p) => p.title)).toEqual(["Lead", "Teammate 1", "Teammate 2"]);
    expect(config.rows[0]!.panes.map((p) => p.role)).toEqual(["lead", "teammate", "teammate"]);
  });

  it("includes a Dev pane when devCommand is set", () => {
    const config = composeIdeYmlConfig({
      name: "alpha",
      agents: 2,
      devCommand: "pnpm dev",
    });
    expect(config.rows[1]!.panes).toEqual([
      { title: "Dev", command: "pnpm dev" },
      { title: "Shell" },
    ]);
  });

  it("omits the Dev pane when devCommand is null/undefined/empty", () => {
    expect(
      composeIdeYmlConfig({ name: "alpha", agents: 1, devCommand: null }).rows[1]!.panes,
    ).toEqual([{ title: "Shell" }]);
    expect(
      composeIdeYmlConfig({ name: "alpha", agents: 1, devCommand: "  " }).rows[1]!.panes,
    ).toEqual([{ title: "Shell" }]);
    expect(composeIdeYmlConfig({ name: "alpha", agents: 1 }).rows[1]!.panes).toEqual([
      { title: "Shell" },
    ]);
  });

  it("rejects agents outside 1-3", () => {
    expect(() => composeIdeYmlConfig({ name: "x", agents: 0 })).toThrow(OnboardInvalidInputError);
    expect(() => composeIdeYmlConfig({ name: "x", agents: 4 })).toThrow(OnboardInvalidInputError);
    expect(() => composeIdeYmlConfig({ name: "x", agents: 1.5 })).toThrow(OnboardInvalidInputError);
  });

  it("rejects empty/whitespace-only names", () => {
    expect(() => composeIdeYmlConfig({ name: "", agents: 1 })).toThrow(OnboardInvalidInputError);
    expect(() => composeIdeYmlConfig({ name: "   ", agents: 1 })).toThrow(OnboardInvalidInputError);
  });

  it("uses provided agentNames as pane titles when length matches", () => {
    const config = composeIdeYmlConfig({
      name: "alpha",
      agents: 2,
      agentNames: ["Captain", "Frontend"],
    });
    expect(config.rows[0]!.panes.map((p) => p.title)).toEqual(["Captain", "Frontend"]);
    // Roles stay canonical regardless of titles.
    expect(config.rows[0]!.panes.map((p) => p.role)).toEqual(["lead", "teammate"]);
  });

  it("rejects agentNames whose length disagrees with agents", () => {
    expect(() =>
      composeIdeYmlConfig({ name: "alpha", agents: 2, agentNames: ["Only one"] }),
    ).toThrow(OnboardInvalidInputError);
    expect(() => composeIdeYmlConfig({ name: "alpha", agents: 1, agentNames: ["A", "B"] })).toThrow(
      OnboardInvalidInputError,
    );
  });

  it("rejects agentNames containing empty strings", () => {
    expect(() =>
      composeIdeYmlConfig({ name: "alpha", agents: 2, agentNames: ["Lead", "  "] }),
    ).toThrow(OnboardInvalidInputError);
  });
});

describe("composeIdeYml (yaml output)", () => {
  it("emits a parseable YAML string", () => {
    const yaml = composeIdeYml({ name: "alpha", agents: 2, devCommand: "pnpm dev" });
    expect(yaml).toContain("name: alpha");
    expect(yaml).toContain("team:");
    expect(yaml).toContain("Lead");
    expect(yaml).toContain("Teammate 1");
    expect(yaml).toContain("pnpm dev");
  });
});

describe("assertNoExistingIdeYml", () => {
  it("throws OnboardConflictError when ide.yml exists", () => {
    expect(() => assertNoExistingIdeYml("/dir", () => true)).toThrow(OnboardConflictError);
  });

  it("returns silently when ide.yml is absent", () => {
    expect(() => assertNoExistingIdeYml("/dir", () => false)).not.toThrow();
  });
});
