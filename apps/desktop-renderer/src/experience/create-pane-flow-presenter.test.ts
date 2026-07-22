import { describe, expect, it } from "vitest";

import {
  createPaneSubmission,
  projectCreatePaneFlow,
  type CreatePaneFlowCatalogs,
} from "./create-pane-flow-presenter.ts";

function catalogs(): CreatePaneFlowCatalogs {
  return {
    workspaces: {
      status: "ready",
      items: [
        { name: "tmux-ide", label: "tmux-ide", available: true },
        { name: "docs/site", label: "Documentation", available: false },
      ],
    },
    harnessProfiles: {
      status: "ready",
      items: [
        {
          id: "codex-implementer",
          label: "Codex implementer",
          description: "Codex with the project implementation profile",
          available: true,
        },
      ],
    },
    missions: {
      status: "ready",
      items: [{ id: "parity", label: "Product parity", available: true }],
    },
  };
}

describe("create pane flow presenter", () => {
  it("accepts slash workspace names while omitting duplicates and non-canonical collisions", () => {
    const projection = projectCreatePaneFlow({
      ...catalogs(),
      workspaces: {
        status: "ready",
        items: [
          { name: "tmux-ide", label: "tmux-ide", available: true },
          { name: "tmux-ide", label: "Duplicate", available: true },
          { name: " docs ", label: "Non-canonical", available: true },
          { name: "valid", label: " padded ", available: true },
        ],
      },
    });

    expect(projection.workspaces.items).toEqual([
      { name: "tmux-ide", label: "tmux-ide", available: true },
    ]);
    expect(projection.workspaces.invalidOptionCount).toBe(3);
    expect(Object.isFrozen(projection.workspaces.items)).toBe(true);
  });

  it("reconstructs exact safe option fields and rejects nonboolean availability", () => {
    const projection = projectCreatePaneFlow({
      workspaces: {
        status: "ready",
        items: [
          {
            name: "docs/site",
            label: "Documentation",
            available: true,
            cwd: "/Users/private",
            sessionName: "secret-session",
            token: "secret-token",
          },
          { name: "bad", label: "Bad", available: "yes", command: "shell" },
        ],
      },
      harnessProfiles: {
        status: "ready",
        items: [
          {
            id: "codex",
            label: "Codex",
            description: "Implementation profile",
            available: true,
            argv: ["codex", "--yolo"],
            command: "codex",
            cwd: "/private",
            token: "secret-token",
          },
          { id: "bad", label: "Bad", available: 1, command: "codex" },
        ],
      },
      missions: {
        status: "ready",
        items: [
          {
            id: "parity",
            label: "Parity",
            available: true,
            sessionName: "secret-session",
          },
          { id: "bad", label: "Bad", available: "true", token: "secret" },
        ],
      },
    } as unknown as CreatePaneFlowCatalogs);

    expect(projection.workspaces.items).toEqual([
      { name: "docs/site", label: "Documentation", available: true },
    ]);
    expect(projection.workspaces.invalidOptionCount).toBe(1);
    expect(projection.harnessProfiles.items).toEqual([
      {
        id: "codex",
        label: "Codex",
        description: "Implementation profile",
        available: true,
      },
    ]);
    expect(projection.harnessProfiles.invalidOptionCount).toBe(1);
    expect(projection.missions.items).toEqual([{ id: "parity", label: "Parity", available: true }]);
    expect(projection.missions.invalidOptionCount).toBe(1);
    expect(JSON.stringify(projection)).not.toMatch(
      /cwd|argv|command|sessionName|token|secret-session|secret-token/u,
    );
  });

  it("requires exact available workspace membership and reports the first field", () => {
    const projection = projectCreatePaneFlow(catalogs());

    expect(
      createPaneSubmission(
        projection,
        {
          kind: "terminal",
          workspaceName: "unknown",
          displayTitle: "",
          harnessProfileId: "",
          role: "implementer",
          missionId: "",
        },
        { kind: "keyboard", surface: "create-pane-dialog" },
      ),
    ).toEqual({
      ok: false,
      errors: { workspaceName: "Choose an available workspace." },
      firstInvalidField: "workspaceName",
    });
  });

  it("distinguishes loading, unavailable, and empty workspace states", () => {
    for (const [workspaces, message] of [
      [{ status: "loading" as const }, "Workspace choices are still loading."],
      [{ status: "unavailable" as const }, "Workspace choices are unavailable."],
      [{ status: "ready" as const, items: [] }, "No workspace is available yet."],
    ] as const) {
      const result = createPaneSubmission(
        projectCreatePaneFlow({ ...catalogs(), workspaces }),
        {
          kind: "terminal",
          workspaceName: "",
          displayTitle: "",
          harnessProfileId: "",
          role: "implementer",
          missionId: "",
        },
        { kind: "keyboard", surface: "create-pane-dialog" },
      );
      expect(result).toMatchObject({ ok: false, errors: { workspaceName: message } });
    }
  });

  it("creates a terminal invocation with a trimmed optional title", () => {
    const result = createPaneSubmission(
      projectCreatePaneFlow(catalogs()),
      {
        kind: "terminal",
        workspaceName: "tmux-ide",
        displayTitle: "  Release shell  ",
        harnessProfileId: "",
        role: "implementer",
        missionId: "",
      },
      { kind: "palette", surface: "command-palette" },
    );

    expect(result).toEqual({
      ok: true,
      invocation: {
        version: 1,
        id: "workspace.pane.create",
        source: { kind: "palette", surface: "command-palette" },
        args: {
          kind: "terminal",
          workspaceName: "tmux-ide",
          displayTitle: "Release shell",
        },
      },
    });
  });

  it("requires an exposed harness while keeping mission assignment optional", () => {
    const projection = projectCreatePaneFlow(catalogs());
    const missingHarness = createPaneSubmission(
      projection,
      {
        kind: "agent",
        workspaceName: "tmux-ide",
        displayTitle: "",
        harnessProfileId: "",
        role: "reviewer",
        missionId: "",
      },
      { kind: "mouse", surface: "create-pane-dialog" },
    );
    expect(missingHarness).toMatchObject({
      ok: false,
      errors: { harnessProfileId: "Choose an agent profile." },
    });

    const valid = createPaneSubmission(
      projection,
      {
        kind: "agent",
        workspaceName: "tmux-ide",
        displayTitle: "Reviewer",
        harnessProfileId: "codex-implementer",
        role: "reviewer",
        missionId: "parity",
      },
      { kind: "mouse", surface: "create-pane-dialog" },
    );
    expect(valid).toMatchObject({
      ok: true,
      invocation: {
        args: {
          kind: "agent",
          workspaceName: "tmux-ide",
          harnessProfileId: "codex-implementer",
          role: "reviewer",
          missionId: "parity",
        },
      },
    });
  });

  it("rejects selected agent resources that disappear during catalog churn", () => {
    const draft = {
      kind: "agent" as const,
      workspaceName: "tmux-ide",
      displayTitle: "",
      harnessProfileId: "codex-implementer",
      role: "implementer" as const,
      missionId: "parity",
    };
    const workspaceGone = createPaneSubmission(
      projectCreatePaneFlow({
        ...catalogs(),
        workspaces: { status: "ready", items: [] },
      }),
      draft,
      { kind: "keyboard", surface: "create-pane-dialog" },
    );
    expect(workspaceGone).toMatchObject({
      ok: false,
      errors: { workspaceName: "No workspace is available yet." },
    });

    const harnessGone = createPaneSubmission(
      projectCreatePaneFlow({
        ...catalogs(),
        harnessProfiles: { status: "ready", items: [] },
      }),
      draft,
      { kind: "keyboard", surface: "create-pane-dialog" },
    );
    expect(harnessGone).toMatchObject({
      ok: false,
      errors: { harnessProfileId: "No agent profile is available yet." },
    });

    const missionGone = createPaneSubmission(
      projectCreatePaneFlow({
        ...catalogs(),
        missions: { status: "ready", items: [] },
      }),
      draft,
      { kind: "keyboard", surface: "create-pane-dialog" },
    );
    expect(missionGone).toMatchObject({
      ok: false,
      errors: { missionId: "Choose an available mission or leave it unassigned." },
    });
  });
});
