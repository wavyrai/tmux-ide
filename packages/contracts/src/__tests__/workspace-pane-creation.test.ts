import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PANE_CREATE_COMMAND_DESCRIPTOR,
  WORKSPACE_PANE_CREATE_COMMAND_ID,
  WorkspacePaneCreateInvocationSchemaZ,
  WorkspacePaneCreateHostResultSchemaZ,
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  WorkspacePaneCreationReferenceSchemaZ,
  WorkspacePaneCreationWorkspaceNameSchemaZ,
  workspacePaneCreateInvocation,
} from "../workspace-pane-creation.ts";

describe("semantic workspace pane creation command", () => {
  it("publishes one daemon-owned descriptor for every host surface", () => {
    expect(WORKSPACE_PANE_CREATE_COMMAND_DESCRIPTOR).toEqual({
      version: 1,
      id: WORKSPACE_PANE_CREATE_COMMAND_ID,
      owner: "daemon",
      label: "Create terminal or agent",
      description:
        "Ask the daemon to create a tmux-backed terminal or harness-backed agent from semantic workspace resources.",
      category: "workspace",
      schemas: {
        input: "workspace.pane.create.input.v1",
        result: "workspace.pane.create.result.v1",
      },
      dangerous: false,
      confirmation: "none",
    });
    expect(Object.isFrozen(WORKSPACE_PANE_CREATE_COMMAND_DESCRIPTOR)).toBe(true);
  });

  it("keeps host retry metadata outside renderer-authored semantic intent", () => {
    const request = WorkspacePaneCreateMutationRequestSchemaZ.parse({
      operationId: "10000000-0000-4000-8000-000000000001",
      expectedDaemonInstanceId: "20000000-0000-4000-8000-000000000002",
      intent: {
        kind: "agent",
        workspaceName: "tmux-ide",
        displayTitle: "Implementer",
        harnessProfileId: "codex",
        role: "implementer",
      },
    });
    expect(request.intent).not.toHaveProperty("operationId");
    expect(request.intent).not.toHaveProperty("expectedDaemonInstanceId");
    expect(
      WorkspacePaneCreateMutationRequestSchemaZ.safeParse({
        ...request,
        cwd: "/tmp/project",
      }).success,
    ).toBe(false);
  });

  it("returns stable semantic resource identity without daemon-private runtime facts", () => {
    const result = WorkspacePaneCreateMutationResultSchemaZ.parse({
      operationId: "10000000-0000-4000-8000-000000000001",
      daemonInstanceId: "20000000-0000-4000-8000-000000000002",
      outcome: "created",
      resource: {
        resourceVersion: 1,
        workspaceName: "tmux-ide",
        semanticPaneId: "pane.10000000000040008000000000000001",
        kind: "terminal",
        displayTitle: "Terminal",
        harnessProfileId: null,
        role: null,
        missionId: null,
      },
    });
    for (const forbidden of ["paneId", "windowId", "sessionName", "cwd", "argv", "env"]) {
      expect(JSON.stringify(result)).not.toContain(`"${forbidden}"`);
    }
    expect(WorkspacePaneCreateHostResultSchemaZ.parse({ status: "ok", result })).toEqual({
      status: "ok",
      result,
    });
  });

  it("round-trips a terminal request containing presentation identity only", () => {
    const invocation = workspacePaneCreateInvocation(
      {
        kind: "terminal",
        workspaceName: "tmux-ide/docs",
        displayTitle: "Release shell",
      },
      { kind: "palette", surface: "command-palette" },
    );

    expect(
      WorkspacePaneCreateInvocationSchemaZ.parse(JSON.parse(JSON.stringify(invocation))),
    ).toEqual(invocation);
    expect(invocation.args).not.toHaveProperty("cwd");
    expect(invocation.args).not.toHaveProperty("argv");
    expect(Object.isFrozen(invocation.args)).toBe(true);
  });

  it("round-trips an agent request using an exposed harness and mission identity", () => {
    expect(
      workspacePaneCreateInvocation(
        {
          kind: "agent",
          workspaceName: "tmux-ide",
          harnessProfileId: "codex-implementer",
          role: "implementer",
          missionId: "mis_gloomberb_parity",
        },
        { kind: "mouse", surface: "create-pane-dialog" },
      ),
    ).toMatchObject({
      id: WORKSPACE_PANE_CREATE_COMMAND_ID,
      args: {
        kind: "agent",
        harnessProfileId: "codex-implementer",
        role: "implementer",
        missionId: "mis_gloomberb_parity",
      },
    });
  });

  const forbiddenRuntimeFields = [
    ["cwd", "/Users/example/project"],
    ["argv", ["codex", "--yolo"]],
    ["command", "claude"],
    ["sessionName", "tmux-ide"],
    ["paneId", "%42"],
    ["token", "renderer-secret"],
    ["executable", "/usr/local/bin/codex"],
    ["env", { SECRET: "value" }],
    ["model", "provider-owned-model"],
  ] as const;

  it.each(forbiddenRuntimeFields)(
    "rejects terminal renderer-owned runtime field %s",
    (field, value) => {
      expect(
        WorkspacePaneCreateInvocationSchemaZ.safeParse({
          version: 1,
          id: WORKSPACE_PANE_CREATE_COMMAND_ID,
          source: { kind: "mouse", surface: "create-pane-dialog" },
          args: { kind: "terminal", workspaceName: "tmux-ide", [field]: value },
        }).success,
      ).toBe(false);
    },
  );

  it.each(forbiddenRuntimeFields)(
    "rejects agent renderer-owned runtime field %s",
    (field, value) => {
      expect(
        WorkspacePaneCreateInvocationSchemaZ.safeParse({
          version: 1,
          id: WORKSPACE_PANE_CREATE_COMMAND_ID,
          source: { kind: "mouse", surface: "create-pane-dialog" },
          args: {
            kind: "agent",
            workspaceName: "tmux-ide",
            harnessProfileId: "codex",
            role: "implementer",
            [field]: value,
          },
        }).success,
      ).toBe(false);
    },
  );

  it.each([
    ["token", "renderer-secret"],
    ["daemonUrl", "http://127.0.0.1:9999"],
    ["sessionName", "tmux-ide"],
    ["paneId", "%42"],
  ])("rejects invocation-level runtime field %s", (field, value) => {
    expect(
      WorkspacePaneCreateInvocationSchemaZ.safeParse({
        version: 1,
        id: WORKSPACE_PANE_CREATE_COMMAND_ID,
        source: { kind: "mouse", surface: "create-pane-dialog" },
        args: { kind: "terminal", workspaceName: "tmux-ide" },
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("uses canonical desktop workspace names losslessly, including slash names", () => {
    expect(WorkspacePaneCreationWorkspaceNameSchemaZ.parse("docs/site")).toBe("docs/site");
    expect(WorkspacePaneCreationWorkspaceNameSchemaZ.safeParse(" docs/site ").success).toBe(false);
    expect(WorkspacePaneCreationWorkspaceNameSchemaZ.safeParse("\u0000docs").success).toBe(false);
  });

  it.each(["%42", "$session", "@window", "/tmp/project", "folder\\project", " padded "])(
    "rejects raw runtime or path-shaped reference %s",
    (reference) => {
      expect(WorkspacePaneCreationReferenceSchemaZ.safeParse(reference).success).toBe(false);
    },
  );

  it("rejects C0, DEL, and C1 controls from titles and semantic references", () => {
    for (const control of ["\u0009", "\u007f", "\u0085"]) {
      expect(WorkspacePaneCreationReferenceSchemaZ.safeParse(`agent${control}one`).success).toBe(
        false,
      );
      expect(
        WorkspacePaneCreateInvocationSchemaZ.safeParse({
          version: 1,
          id: WORKSPACE_PANE_CREATE_COMMAND_ID,
          source: { kind: "mouse" },
          args: {
            kind: "terminal",
            workspaceName: "tmux-ide",
            displayTitle: `Terminal${control}one`,
          },
        }).success,
      ).toBe(false);
    }
  });
});
