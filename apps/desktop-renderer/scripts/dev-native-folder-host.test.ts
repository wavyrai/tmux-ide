import { describe, expect, it, vi } from "vitest";

import { openSelectedDevelopmentProject } from "./dev-native-folder-host.ts";

const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const DAEMON_ID = "11111111-1111-4111-8111-111111111111";
const options = {
  daemonOrigin: "http://127.0.0.1:6060",
  ownerToken: "owner-secret",
  hostClientId: "dev-web:document",
};

describe("local development native folder host", () => {
  it("treats native cancellation as a quiet no-op", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      openSelectedDevelopmentProject(options, {
        selectDirectory: async () => null,
        request,
        createOperationId: () => OPERATION_ID,
      }),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the path in the host and returns only the browser-safe result", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer owner-secret",
        "X-Tmux-Ide-Host-Client-Id": "dev-web:document",
        "X-Tmux-Ide-Operation-Id": OPERATION_ID,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        source: { kind: "project", projectDir: "/Users/test/project" },
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            operationId: OPERATION_ID,
            daemonInstanceId: DAEMON_ID,
            phase: "prepared",
            prepareToken: "33333333-3333-4333-8333-333333333333",
            preparedRevision: 1,
            outcome: "created",
            workspaceName: "project-00112233445566778899aabbccddeeff",
            previousWorkspaceName: null,
            proof: {
              semanticPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
              paneCount: 1,
              terminalRevision: 0,
              terminalStateHash: "0123456789abcdef",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await openSelectedDevelopmentProject(options, {
      selectDirectory: async () => "/Users/test/project",
      request,
      createOperationId: () => OPERATION_ID,
    });
    expect(result).toMatchObject({ status: "ok", result: { operationId: OPERATION_ID } });
    expect(JSON.stringify(result)).not.toContain("/Users/test/project");
  });

  it("rejects a mismatched daemon receipt", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        result: {
          operationId: "44444444-4444-4444-8444-444444444444",
          daemonInstanceId: DAEMON_ID,
          phase: "prepared",
          prepareToken: "33333333-3333-4333-8333-333333333333",
          preparedRevision: 1,
          outcome: "created",
          workspaceName: "project-00112233445566778899aabbccddeeff",
          previousWorkspaceName: null,
          proof: {
            semanticPaneId: "pane.workspace.00112233445566778899aabbccddeeff",
            paneCount: 1,
            terminalRevision: 0,
            terminalStateHash: "0123456789abcdef",
          },
        },
      }),
    );
    await expect(
      openSelectedDevelopmentProject(options, {
        selectDirectory: async () => "/Users/test/project",
        request,
        createOperationId: () => OPERATION_ID,
      }),
    ).resolves.toMatchObject({ status: "error", error: { code: "request-failed" } });
  });
});
