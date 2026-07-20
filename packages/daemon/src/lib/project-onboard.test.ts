import { describe, expect, it } from "bun:test";
import {
  assertNoExistingIdeYml,
  composeIdeYml,
  composeIdeYmlConfig,
  OnboardConflictError,
  OnboardInvalidInputError,
} from "./project-onboard.ts";
import type { ProjectResolution } from "./project-resolver.ts";

function resolution(kind: "none" | "legacy" | "workspace", path: string | null): ProjectResolution {
  return {
    inputDir: "/dir",
    projectRoot: "/dir",
    identityKey: "path-test",
    identitySource: "canonical-realpath",
    identityAnchor: "/dir",
    config:
      kind === "none"
        ? { kind: "none", path: null, explicit: false }
        : { kind, path: path!, explicit: false },
    workspaceConfigPath: kind === "workspace" ? path : null,
    legacyConfigPath: kind === "legacy" ? path : null,
    hasLegacyConfigAtInput: kind === "legacy",
  };
}

describe("composeIdeYmlConfig", () => {
  it("produces a 1-agent config without a team block", () => {
    const config = composeIdeYmlConfig({ name: "alpha", agents: 1 });
    expect(config.name).toBe("alpha");
    expect(config.team).toBeUndefined();
    expect(config.rows).toHaveLength(2);
    expect(config.rows[0]!.panes).toHaveLength(1);
    expect(config.rows[0]!.panes[0]).toMatchObject({
      id: "agent-1",
      title: "Claude 1",
      command: "claude",
      focus: true,
    });
    // 1-agent should not declare a role
    expect(config.rows[0]!.panes[0]!.role).toBeUndefined();
  });

  it("produces a 2-agent config without legacy team metadata", () => {
    const config = composeIdeYmlConfig({ name: "alpha", agents: 2 });
    expect(config.team).toBeUndefined();
    expect(config.rows[0]!.panes).toHaveLength(2);
    expect(config.rows[0]!.panes[0]).toMatchObject({
      id: "agent-1",
      title: "Lead",
      command: "claude",
      focus: true,
    });
    expect(config.rows[0]!.panes[1]).toMatchObject({
      id: "agent-2",
      title: "Teammate 1",
      command: "claude",
    });
    expect(config.rows[0]!.panes[0]!.role).toBeUndefined();
    expect(config.rows[0]!.panes[1]!.role).toBeUndefined();
    expect(config.rows[0]!.panes[1]!.focus).toBeUndefined();
  });

  it("produces a 3-agent config without legacy pane roles", () => {
    const config = composeIdeYmlConfig({ name: "alpha", agents: 3 });
    expect(config.team).toBeUndefined();
    expect(config.rows[0]!.panes).toHaveLength(3);
    expect(config.rows[0]!.panes.map((p) => p.title)).toEqual(["Lead", "Teammate 1", "Teammate 2"]);
    expect(config.rows[0]!.panes.map((p) => p.role)).toEqual([undefined, undefined, undefined]);
  });

  it("includes a Dev pane when devCommand is set", () => {
    const config = composeIdeYmlConfig({
      name: "alpha",
      agents: 2,
      devCommand: "pnpm dev",
    });
    expect(config.rows[1]!.panes).toEqual([
      { id: "dev", title: "Dev", command: "pnpm dev" },
      { id: "shell", title: "Shell" },
    ]);
  });

  it("omits the Dev pane when devCommand is null/undefined/empty", () => {
    expect(
      composeIdeYmlConfig({ name: "alpha", agents: 1, devCommand: null }).rows[1]!.panes,
    ).toEqual([{ id: "shell", title: "Shell" }]);
    expect(
      composeIdeYmlConfig({ name: "alpha", agents: 1, devCommand: "  " }).rows[1]!.panes,
    ).toEqual([{ id: "shell", title: "Shell" }]);
    expect(composeIdeYmlConfig({ name: "alpha", agents: 1 }).rows[1]!.panes).toEqual([
      { id: "shell", title: "Shell" },
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
    expect(config.rows[0]!.panes.map((p) => p.role)).toEqual([undefined, undefined]);
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
    expect(yaml).not.toContain("team:");
    expect(yaml).not.toContain("role:");
    expect(yaml).toContain("Lead");
    expect(yaml).toContain("Teammate 1");
    expect(yaml).toContain("pnpm dev");
  });
});

describe("assertNoExistingIdeYml", () => {
  it("throws OnboardConflictError when a legacy config resolves", async () => {
    await expect(
      assertNoExistingIdeYml("/dir", async () => resolution("legacy", "/dir/ide.yml")),
    ).rejects.toMatchObject({
      name: "OnboardConflictError",
      code: "IDE_YML_EXISTS",
      message: "project config already exists at /dir/ide.yml",
    });
    await expect(
      assertNoExistingIdeYml("/dir", async () => resolution("legacy", "/dir/ide.yml")),
    ).rejects.toBeInstanceOf(OnboardConflictError);
  });

  it("throws OnboardConflictError when a workspace config resolves", async () => {
    await expect(
      assertNoExistingIdeYml("/dir", async () =>
        resolution("workspace", "/dir/.tmux-ide/workspace.yml"),
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_CONFIG_EXISTS",
      message: "project config already exists at /dir/.tmux-ide/workspace.yml",
    });
  });

  it("returns silently when no config resolves", async () => {
    await expect(
      assertNoExistingIdeYml("/dir", async () => resolution("none", null)),
    ).resolves.toBeUndefined();
  });
});
