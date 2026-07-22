import { describe, expect, it, vi } from "vitest";

import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";

import { __setCliActionBridgeDepsForTests, tryDispatchAction } from "./cli-action-bridge.ts";
import { createApp } from "../command-center/server.ts";

const OPERATION = "10000000-0000-4000-8000-000000000001";
const INSTANCE = "20000000-0000-4000-8000-000000000002";

describe("CLI owner action bridge", () => {
  it("uses the owner-only token and one stable operation id across retry", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      if (requests.length === 1) {
        return { json: async () => Promise.reject(new Error("truncated body after commit")) };
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            operationId: OPERATION,
            daemonInstanceId: INSTANCE,
            outcome: "replayed",
            resource: {
              resourceVersion: 1,
              workspaceName: "workspace.alpha",
              semanticPaneId: "pane.10000000000040008000000000000001",
              kind: "terminal",
              displayTitle: "Terminal",
              harnessProfileId: null,
              role: null,
              missionId: null,
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.pane.create",
          { kind: "terminal", workspaceName: "workspace.alpha" },
          { operationId: OPERATION },
        ),
      ).resolves.toMatchObject({ operationId: OPERATION, outcome: "replayed" });
    } finally {
      restore();
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = new Headers(request.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("x-tmux-ide-operation-id")).toBe(OPERATION);
    }
  });

  it("retries workspace.open with its stable owner correlation id and strict result contract", async () => {
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const requests: RequestInit[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(init ?? {});
      if (requests.length === 1) throw new Error("connection closed after commit");
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            operationId: OPERATION,
            daemonInstanceId: INSTANCE,
            outcome: "replayed",
            resource: {
              resourceVersion: 1,
              workspaceName: "project-00112233445566778899aabbccddeeff",
              initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.open",
          { projectDir: "/canonical/project" },
          { operationId: OPERATION },
        ),
      ).resolves.toMatchObject({ operationId: OPERATION, outcome: "replayed" });
    } finally {
      restore();
    }
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const headers = new Headers(request.headers);
      expect(headers.get("authorization")).toBe("Bearer owner-only-token");
      expect(headers.get("x-tmux-ide-operation-id")).toBe(OPERATION);
    }
  });

  it("passes workspace.open end-to-end through the owner gate and dispatcher", async () => {
    const open = vi.fn(async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: request.expectedDaemonInstanceId,
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: "project-00112233445566778899aabbccddeeff",
        initialPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
      },
    }));
    const app = createApp({
      remoteAccess: { ownerToken: "owner-only-token" },
      daemonIdentity: {
        productVersion: "2.8.0",
        instanceId: INSTANCE,
        startedAt: "2026-07-22T00:00:00.000Z",
      },
      workspaceOpenBackend: { open },
    });
    const canonical: CanonicalDaemonInfo = {
      pid: process.pid,
      port: 6060,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: "2.8.0",
      instanceId: INSTANCE,
      startedAt: "2026-07-22T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: "owner-only-token",
    };
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      app.request(typeof input === "string" ? input : input.toString(), init),
    );
    const restore = __setCliActionBridgeDepsForTests({
      fetch: fetch as typeof globalThis.fetch,
      readCanonicalDaemonInfo: () => canonical,
      isCanonicalDaemonAlive: async () => true,
    });
    try {
      await expect(
        tryDispatchAction(
          "workspace.open",
          { projectDir: "/canonical/project" },
          { operationId: OPERATION },
        ),
      ).resolves.toMatchObject({ operationId: OPERATION, outcome: "created" });
    } finally {
      restore();
    }
    expect(open).toHaveBeenCalledWith({
      operationId: OPERATION,
      expectedDaemonInstanceId: INSTANCE,
      intent: { projectDir: "/canonical/project" },
    });
  });
});
