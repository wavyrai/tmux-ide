import { describe, expect, it, vi } from "vitest";

import {
  DAEMON_RESOURCE_KINDS,
  DAEMON_RESOURCE_RESULT_SCHEMAS,
  DAEMON_WORKSPACE_ROUTE_KEYS,
  DaemonResourceRequestSchemaZ,
  createDaemonResourceMethods,
  daemonWorkspaceRouteName,
  isDaemonResourceKind,
  type DaemonResourceRequest,
} from "./daemon-resource-request.ts";

const WORKSPACE = "product";
const FILE_ID = "file.00112233445566778899aabbccddeeff";
const CHANGE_ID = "change.00112233445566778899aabbccddeeff";

/** One valid request per variant: the round-trip corpus. */
const REQUESTS: readonly DaemonResourceRequest[] = [
  { resource: "capabilities" },
  { resource: "refreshConnection" },
  { resource: "listWorkspaces" },
  { resource: "fetchFleetCatalog" },
  { resource: "fetchWidgetAsset", request: { assetId: "a".repeat(64) } },
  { resource: "startupReadiness" },
  { resource: "fetchApplicationShell", request: { workspaceName: WORKSPACE } },
  { resource: "fetchWorkspaceFiles", request: { workspaceName: WORKSPACE } },
  {
    resource: "fetchWorkspaceFilePreview",
    request: { workspaceName: WORKSPACE, fileId: FILE_ID },
  },
  { resource: "fetchWorkspaceChanges", request: { workspaceName: WORKSPACE } },
  { resource: "fetchWorkspaceMissions", request: { workspaceName: WORKSPACE } },
  {
    resource: "fetchWorkspaceChangeDiff",
    request: { workspaceName: WORKSPACE, changeId: CHANGE_ID },
  },
  {
    resource: "promoteWorkspace",
    request: { sessionId: "session.00112233445566778899aabbccddeeff" },
  },
  {
    resource: "createWorkspacePane",
    request: {
      version: 1,
      id: "workspace.pane.create",
      source: { kind: "mouse", surface: "create-pane-dialog" },
      args: { kind: "terminal", workspaceName: WORKSPACE },
    },
  },
  {
    resource: "mutateAppWindow",
    request: {
      workspaceName: WORKSPACE,
      expectedDocumentRevision: 4,
      command: { type: "window.move", windowId: "window.worker", x: 10, y: 20 },
    },
  },
  {
    resource: "invokeVerb",
    request: {
      verbId: "pane.split.right",
      intent: {
        verb: "workspace.window.split",
        workspaceName: WORKSPACE,
        semanticPaneId: "pane.worker",
        direction: "right",
      },
    },
  },
  {
    resource: "issueTerminalAttachment",
    request: {
      protocolVersion: 1,
      target: { workspaceName: WORKSPACE, semanticPaneId: "pane.worker" },
      viewerMode: "interactive",
      geometryOwnership: "passive",
      viewport: { cols: 120, rows: 40 },
    },
  },
  {
    resource: "issuePaneStream",
    request: {
      protocolVersion: 1,
      workspaceName: WORKSPACE,
      panes: ["pane.worker"],
      viewerMode: "read-only",
    },
  },
];

describe("daemon resource request union", () => {
  it("covers every declared resource exactly once", () => {
    expect([...REQUESTS].map((request) => request.resource).sort()).toEqual(
      [...DAEMON_RESOURCE_KINDS].sort(),
    );
    expect(Object.keys(DAEMON_RESOURCE_RESULT_SCHEMAS).sort()).toEqual(
      [...DAEMON_RESOURCE_KINDS].sort(),
    );
  });

  it("round-trips every variant unchanged", () => {
    for (const request of REQUESTS) {
      const parsed = DaemonResourceRequestSchemaZ.parse(JSON.parse(JSON.stringify(request)));
      expect(parsed).toEqual(request);
    }
  });

  it("refuses an unknown tag, a missing tag, and a payload on a payload-free resource", () => {
    expect(DaemonResourceRequestSchemaZ.safeParse({ resource: "readEverything" }).success).toBe(
      false,
    );
    expect(DaemonResourceRequestSchemaZ.safeParse({}).success).toBe(false);
    expect(DaemonResourceRequestSchemaZ.safeParse(null).success).toBe(false);
    expect(
      DaemonResourceRequestSchemaZ.safeParse({
        resource: "capabilities",
        request: { escalate: true },
      }).success,
    ).toBe(false);
  });

  it("refuses a payload borrowed from another variant", () => {
    expect(
      DaemonResourceRequestSchemaZ.safeParse({
        resource: "fetchWorkspaceChangeDiff",
        request: { workspaceName: WORKSPACE },
      }).success,
    ).toBe(false);
  });

  it("names a resource kind only for declared resources", () => {
    for (const kind of DAEMON_RESOURCE_KINDS) expect(isDaemonResourceKind(kind)).toBe(true);
    expect(isDaemonResourceKind("subscribe")).toBe(false);
    expect(isDaemonResourceKind("toString")).toBe(false);
    expect(isDaemonResourceKind(undefined)).toBe(false);
  });

  it("keys the application-shell route on the session name and the rest on the workspace", () => {
    const entry = { workspaceName: "product", sessionName: "tmux-product" };
    expect(daemonWorkspaceRouteName("fetchApplicationShell", entry)).toBe("tmux-product");
    for (const resource of ["fetchWorkspaceFiles", "fetchWorkspaceChangeDiff"] as const) {
      expect(daemonWorkspaceRouteName(resource, entry)).toBe("product");
    }
    // The table is the only declaration of the fork; every workspace-keyed
    // resource must appear in it.
    expect(Object.keys(DAEMON_WORKSPACE_ROUTE_KEYS).sort()).toEqual([
      "fetchApplicationShell",
      "fetchWorkspaceChangeDiff",
      "fetchWorkspaceChanges",
      "fetchWorkspaceFilePreview",
      "fetchWorkspaceFiles",
      "fetchWorkspaceMissions",
    ]);
  });

  it("builds one method per resource over a single dispatcher", async () => {
    const seen: DaemonResourceRequest[] = [];
    const methods = createDaemonResourceMethods(async (request) => {
      seen.push(request);
      return { status: "error", error: { code: "disposed", reason: "test" } };
    });
    for (const kind of DAEMON_RESOURCE_KINDS) {
      expect(typeof methods[kind]).toBe("function");
    }
    await methods.listWorkspaces();
    await methods.fetchWorkspaceChanges({ workspaceName: WORKSPACE });
    expect(seen).toEqual([
      { resource: "listWorkspaces" },
      { resource: "fetchWorkspaceChanges", request: { workspaceName: WORKSPACE } },
    ]);
  });

  it("preserves the one-argument dispatcher contract when no signal is supplied", async () => {
    const dispatch = vi.fn(async () => ({
      status: "error",
      error: { code: "disposed", reason: "test" },
    }));
    const methods = createDaemonResourceMethods(dispatch);
    await methods.capabilities();
    await methods.fetchWorkspaceFiles({ workspaceName: WORKSPACE });
    expect(dispatch.mock.calls[0]).toEqual([{ resource: "capabilities" }]);
    expect(dispatch.mock.calls[1]).toEqual([
      { resource: "fetchWorkspaceFiles", request: { workspaceName: WORKSPACE } },
    ]);
  });
});
