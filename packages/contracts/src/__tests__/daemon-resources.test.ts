import { describe, expect, it } from "vitest";
import {
  DaemonPanesResponseSchemaZ,
  DaemonProjectResponseSchemaZ,
  DaemonProjectsResponseSchemaZ,
  DaemonProjectTemplatesResponseSchemaZ,
  DaemonSessionsResponseSchemaZ,
  DaemonWorkspacesResponseSchemaZ,
} from "../daemon-resources.ts";

const pane = {
  id: "%7",
  index: 0,
  title: "Codex",
  currentCommand: "codex",
  width: 120,
  height: 40,
  active: true,
  role: "teammate" as const,
  name: "Implementer",
  type: null,
};

describe("daemon REST resources", () => {
  it("parses the current session, project, and pane response shapes", () => {
    expect(
      DaemonSessionsResponseSchemaZ.parse({
        sessions: [{ name: "tmux-ide", dir: "/repo/tmux-ide" }],
      }),
    ).toEqual({ sessions: [{ name: "tmux-ide", dir: "/repo/tmux-ide" }] });

    expect(
      DaemonProjectResponseSchemaZ.parse({
        session: "tmux-ide",
        dir: "/repo/tmux-ide",
        panes: [pane],
      }).panes,
    ).toEqual([pane]);
    expect(DaemonPanesResponseSchemaZ.parse({ panes: [pane] })).toEqual({ panes: [pane] });
  });

  it("parses workspace, registry, and project-template envelopes", () => {
    expect(
      DaemonWorkspacesResponseSchemaZ.safeParse({
        workspaces: [
          {
            name: "tmux-ide",
            sessionName: "tmux-ide",
            projectDir: "/repo/tmux-ide",
            ideConfigPath: null,
            configKind: "workspace",
            configPath: "/repo/tmux-ide/.tmux-ide/workspace.yml",
            hasWorkspaceConfig: true,
            addedAt: "2026-07-21T12:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      DaemonProjectsResponseSchemaZ.safeParse({
        projects: [
          {
            name: "tmux-ide",
            dir: "/repo/tmux-ide",
            hasIdeYml: false,
            hasWorkspaceConfig: true,
            configKind: "workspace",
            configPath: "/repo/tmux-ide/.tmux-ide/workspace.yml",
            ideConfigPath: null,
            gitOrigin: "git@github.com:wavyrai/tmux-ide.git",
            gitBranch: "main",
            registeredAt: "2026-07-21T12:00:00.000Z",
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      DaemonProjectTemplatesResponseSchemaZ.parse({
        templates: [{ id: "default", label: "Default", description: "A balanced workspace" }],
      }).templates[0]?.id,
    ).toBe("default");
  });

  it("rejects unknown envelope and nested resource fields", () => {
    expect(DaemonSessionsResponseSchemaZ.safeParse({ sessions: [], typo: true }).success).toBe(
      false,
    );
    expect(
      DaemonSessionsResponseSchemaZ.safeParse({
        sessions: [{ name: "tmux-ide", dir: "/repo", typo: true }],
      }).success,
    ).toBe(false);
    expect(DaemonPanesResponseSchemaZ.safeParse({ panes: [{ ...pane, typo: true }] }).success).toBe(
      false,
    );
    expect(
      DaemonProjectsResponseSchemaZ.safeParse({
        projects: [
          {
            name: "tmux-ide",
            dir: "/repo",
            hasIdeYml: false,
            gitOrigin: null,
            gitBranch: null,
            registeredAt: "now",
            typo: true,
          },
        ],
      }).success,
    ).toBe(false);
  });
});
