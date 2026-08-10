import { describe, expect, it, vi } from "vitest";

import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { DaemonActionInvocationError } from "@tmux-ide/daemon-client/owner-action-client";

import { executeTuiAgentProvisioning } from "./agent-provisioning-executor.ts";

const INSTANCE = "20000000-0000-4000-8000-000000000002";
const OPERATION = "10000000-0000-4000-8000-000000000001";

const canonical: CanonicalDaemonInfo = {
  pid: process.pid,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: INSTANCE,
  startedAt: "2026-08-07T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner-token",
};

function request(overrides: Partial<Parameters<typeof executeTuiAgentProvisioning>[0]> = {}) {
  return {
    sessionName: "renamed-session",
    kind: "codex",
    command: "codex",
    displayTitle: "Codex",
    placement: "window" as const,
    targetSemanticPaneId: null,
    ...overrides,
  };
}

function catalog(instanceId = INSTANCE): Response {
  return Response.json({
    version: 1,
    daemon: {
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId,
      startedAt: canonical.startedAt,
    },
    workspaces: [
      {
        workspaceName: "project-stable-identity",
        sessionName: "renamed-session",
      },
    ],
  });
}

function createdResult() {
  return {
    operationId: OPERATION,
    daemonInstanceId: INSTANCE,
    outcome: "created" as const,
    resource: {
      resourceVersion: 1 as const,
      workspaceName: "project-stable-identity",
      semanticPaneId: "agent.codex.1",
      displayTitle: "Codex",
      kind: "agent" as const,
      harnessProfileId: "codex",
      role: "implementer" as const,
      missionId: null,
    },
  };
}

describe("TUI agent provisioning executor", () => {
  it("routes a compatible launch through the GUI's semantic daemon action", async () => {
    const createWorkspacePane = vi.fn(async () => createdResult());

    await expect(
      executeTuiAgentProvisioning(request(), {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => true,
        fetch: vi.fn(async () => catalog()) as typeof fetch,
        createWorkspacePane,
        operationId: () => OPERATION,
      }),
    ).resolves.toEqual({
      status: "daemon",
      resource: createdResult().resource,
      message: "started Codex in renamed-session",
    });

    expect(createWorkspacePane).toHaveBeenCalledWith(
      canonical,
      {
        kind: "agent",
        workspaceName: "project-stable-identity",
        displayTitle: "Codex",
        harnessProfileId: "codex",
        role: "implementer",
        placement: { kind: "window" },
      },
      { operationId: OPERATION, autostart: false },
    );
  });

  it("routes split placement through the same action using durable pane identity", async () => {
    const createWorkspacePane = vi.fn(async () => createdResult());
    await expect(
      executeTuiAgentProvisioning(
        request({ placement: "split-h", targetSemanticPaneId: "pane.editor" }),
        {
          readCanonicalDaemonInfo: () => canonical,
          isCanonicalDaemonAlive: async () => true,
          fetch: vi.fn(async () => catalog()) as typeof fetch,
          createWorkspacePane,
          operationId: () => OPERATION,
        },
      ),
    ).resolves.toMatchObject({ status: "daemon" });

    expect(createWorkspacePane).toHaveBeenCalledWith(
      canonical,
      expect.objectContaining({
        placement: {
          kind: "split",
          direction: "right",
          targetSemanticPaneId: "pane.editor",
        },
      }),
      { operationId: OPERATION, autostart: false },
    );
  });

  it("keeps fresh sessions and custom commands on the explicit transitional path", async () => {
    const createWorkspacePane = vi.fn();
    const deps = {
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
      createWorkspacePane: createWorkspacePane as never,
    };

    await expect(
      executeTuiAgentProvisioning(request({ placement: "session" }), deps),
    ).resolves.toEqual({ status: "legacy-local", reason: "unsupported-placement" });
    await expect(
      executeTuiAgentProvisioning(
        request({ kind: "custom-command", command: "my-agent --flag" }),
        deps,
      ),
    ).resolves.toEqual({ status: "legacy-local", reason: "custom-command" });
    expect(createWorkspacePane).not.toHaveBeenCalled();
  });

  it("fails closed when a live split target lacks durable identity", async () => {
    await expect(
      executeTuiAgentProvisioning(request({ placement: "split-v" }), {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => true,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "the active pane does not have a durable semantic identity yet",
    });
  });

  it("allows standalone fallback only when no live canonical daemon exists", async () => {
    await expect(
      executeTuiAgentProvisioning(request(), {
        readCanonicalDaemonInfo: () => null,
      }),
    ).resolves.toEqual({ status: "legacy-local", reason: "no-daemon" });

    await expect(
      executeTuiAgentProvisioning(request(), {
        readCanonicalDaemonInfo: () => canonical,
        isCanonicalDaemonAlive: async () => false,
      }),
    ).resolves.toEqual({ status: "legacy-local", reason: "no-daemon" });
  });

  it("fails closed after a live daemon refuses or cannot confirm the mutation", async () => {
    const common = {
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
      fetch: vi.fn(async () => catalog()) as typeof fetch,
    };

    await expect(
      executeTuiAgentProvisioning(request(), {
        ...common,
        createWorkspacePane: vi.fn(async () => {
          throw new DaemonActionInvocationError({
            code: "harness_not_ready",
            message: "Codex is not ready in this workspace.",
          });
        }) as never,
      }),
    ).resolves.toEqual({ status: "error", message: "Codex is not ready in this workspace." });

    await expect(
      executeTuiAgentProvisioning(request(), {
        ...common,
        createWorkspacePane: vi.fn(async () => null),
      }),
    ).resolves.toEqual({
      status: "error",
      message: "the daemon did not confirm the agent creation; nothing was retried locally",
    });
  });

  it("rejects stale generations and sessions outside daemon ownership", async () => {
    const createWorkspacePane = vi.fn();
    const common = {
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
      createWorkspacePane: createWorkspacePane as never,
    };

    await expect(
      executeTuiAgentProvisioning(request(), {
        ...common,
        fetch: vi.fn(async () => catalog("30000000-0000-4000-8000-000000000003")) as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "error",
      message:
        "agent creation unavailable: daemon generation changed while resolving the workspace",
    });

    const emptyCatalog = Response.json({
      version: 1,
      daemon: {
        protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
        productVersion: "2.8.0",
        instanceId: INSTANCE,
        startedAt: canonical.startedAt,
      },
      workspaces: [],
    });
    await expect(
      executeTuiAgentProvisioning(request(), {
        ...common,
        fetch: vi.fn(async () => emptyCatalog) as typeof fetch,
      }),
    ).resolves.toEqual({
      status: "error",
      message: "the live daemon does not own session renamed-session",
    });
    expect(createWorkspacePane).not.toHaveBeenCalled();
  });
});
