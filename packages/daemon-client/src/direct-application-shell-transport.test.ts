import { describe, expect, it } from "bun:test";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  ApplicationShellProjectionInputV2SchemaZ,
  COHESION_FIXTURE_V1,
  type DesktopApplicationShellTarget,
  type DesktopDaemonHostDescriptor,
} from "@tmux-ide/contracts";

import { createDirectLoopbackDaemonTransport } from "./direct-application-shell-transport.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-08-09T12:00:00.000Z",
};

const descriptor: DesktopDaemonHostDescriptor = {
  ...daemon,
  apiBaseUrl: "http://127.0.0.1:6060/",
};

const target: DesktopApplicationShellTarget = {
  daemon,
  workspaceName: "workspace.alpha",
};

const terminalFirstResource = ApplicationShellProjectionInputV2SchemaZ.parse({
  project: COHESION_FIXTURE_V1.project,
  workspace: {
    ...COHESION_FIXTURE_V1.workspace,
    sidebar: {
      ...COHESION_FIXTURE_V1.workspace.sidebar,
      agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) => ({
        ...agent,
        paneId: null,
      })),
    },
  },
  dock: COHESION_FIXTURE_V1.dock,
  focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
  connection: COHESION_FIXTURE_V1.connection,
  terminalInventory: {
    activeResourceId: "pane.worker",
    resources: [
      {
        id: "pane.worker",
        title: "Worker",
        kind: "terminal",
        active: true,
        attachability: { status: "available", semanticPaneId: "pane.worker" },
      },
    ],
  },
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("direct application-shell transport version selection", () => {
  it("requests and validates terminal-first V2 without app-window enrichment", async () => {
    const requests: URL[] = [];
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return json({
          version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
          daemon,
          resource: terminalFirstResource,
        });
      },
    });

    const resource = await transport.fetchApplicationShell(target, new AbortController().signal);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.pathname).toBe("/api/project/alpha/application-shell");
    expect(requests[0]!.searchParams.get("version")).toBe("2");
    expect(resource.terminalInventory).toEqual(terminalFirstResource.terminalInventory);
    expect("appWindows" in resource).toBe(false);
  });

  it("rejects a V2 response that omits the required terminal inventory", async () => {
    const incomplete = Object.fromEntries(
      Object.entries(terminalFirstResource).filter(([key]) => key !== "terminalInventory"),
    );
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      fetch: async () =>
        json({
          version: APPLICATION_SHELL_RESOURCE_V2_VERSION,
          daemon,
          resource: incomplete,
        }),
    });

    await expect(
      transport.fetchApplicationShell(target, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "schema-invalid" });
  });

  it("retains V3 as the default for canvas hosts", async () => {
    const requests: URL[] = [];
    const transport = createDirectLoopbackDaemonTransport({
      descriptor,
      resolveSessionName: () => "alpha",
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return json({ error: "fixture stops after request capture" }, 500);
      },
    });

    await expect(
      transport.fetchApplicationShell(target, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "http-error", statusCode: 500 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("version")).toBe("3");
  });
});
