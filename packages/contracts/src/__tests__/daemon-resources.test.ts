import { describe, expect, it } from "vitest";
import {
  DaemonPanesResponseSchemaZ,
  DaemonProjectResponseSchemaZ,
  DaemonProjectsResponseSchemaZ,
  DaemonProjectTemplatesResponseSchemaZ,
  DaemonSessionsResponseSchemaZ,
  DaemonWorkspacesResponseSchemaZ,
} from "../daemon-resources.ts";
import {
  WORKSPACE_CATALOG_RESOURCE_VERSION,
  WorkspaceCatalogResourceV1SchemaZ,
} from "../workspace-catalog-resource.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T12:00:00.000Z",
};

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

  it("strictly parses the generation-stamped workspace catalog resource", () => {
    const resource = {
      version: WORKSPACE_CATALOG_RESOURCE_VERSION,
      daemon,
      workspaces: [{ workspaceName: "tmux-ide", sessionName: "tmux-ide-live" }],
    };
    expect(WorkspaceCatalogResourceV1SchemaZ.parse(resource)).toEqual(resource);
    expect(
      WorkspaceCatalogResourceV1SchemaZ.safeParse({ ...resource, apiBaseUrl: "secret" }).success,
    ).toBe(false);
    expect(
      WorkspaceCatalogResourceV1SchemaZ.safeParse({
        ...resource,
        workspaces: [{ ...resource.workspaces[0], projectDir: "/private/project" }],
      }).success,
    ).toBe(false);
  });
});
