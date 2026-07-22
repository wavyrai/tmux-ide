import { describe, expect, it, vi } from "vitest";

import { DAEMON_WIRE_PROTOCOL_VERSION, type CanonicalDaemonInfo } from "@tmux-ide/contracts";

import { __setCliActionBridgeDepsForTests, tryDispatchAction } from "./cli-action-bridge.ts";

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
});
