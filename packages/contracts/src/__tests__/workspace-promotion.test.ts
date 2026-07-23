import { describe, expect, it } from "vitest";

import {
  WorkspacePromoteArgumentsSchemaZ,
  WorkspacePromoteMutationRequestSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
  WorkspacePromotedResourceSchemaZ,
} from "../workspace-promotion.ts";

const DAEMON = "20000000-0000-4000-8000-000000000002";
const OPERATION = "10000000-0000-4000-8000-000000000001";

describe("workspace promotion contract", () => {
  it("accepts an opaque fleet session id as the promotion target", () => {
    const parsed = WorkspacePromoteArgumentsSchemaZ.parse({
      sessionId: "session.0123456789abcdef0123",
    });
    expect(parsed.sessionId).toBe("session.0123456789abcdef0123");
  });

  it("rejects a raw tmux session name or id as the target", () => {
    expect(WorkspacePromoteArgumentsSchemaZ.safeParse({ sessionId: "$3" }).success).toBe(false);
    expect(WorkspacePromoteArgumentsSchemaZ.safeParse({ sessionId: "my session" }).success).toBe(
      false,
    );
    expect(
      WorkspacePromoteArgumentsSchemaZ.safeParse({ sessionId: "/home/user/project" }).success,
    ).toBe(false);
  });

  it("requires the operation and daemon-generation envelope", () => {
    const request = WorkspacePromoteMutationRequestSchemaZ.parse({
      operationId: OPERATION,
      expectedDaemonInstanceId: DAEMON,
      intent: { sessionId: "session.0123456789abcdef0123" },
    });
    expect(request.operationId).toBe(OPERATION);
    expect(
      WorkspacePromoteMutationRequestSchemaZ.safeParse({
        operationId: "not-a-uuid",
        expectedDaemonInstanceId: DAEMON,
        intent: { sessionId: "session.0123456789abcdef0123" },
      }).success,
    ).toBe(false);
  });

  it("carries only the workspace name in the wire-safe result", () => {
    const result = WorkspacePromoteMutationResultSchemaZ.parse({
      operationId: OPERATION,
      daemonInstanceId: DAEMON,
      outcome: "promoted",
      resource: {
        resourceVersion: 1,
        workspaceName: "fleet-alpha-0123456789abcdef0123456789abcdef",
      },
    });
    expect(result.outcome).toBe("promoted");
    // The resource is strictly the version + workspace name — no path or id keys.
    expect(Object.keys(result.resource).sort()).toEqual(["resourceVersion", "workspaceName"]);
  });

  it("only permits the promoted and replayed outcomes", () => {
    for (const outcome of ["promoted", "replayed"] as const) {
      expect(
        WorkspacePromoteMutationResultSchemaZ.safeParse({
          operationId: OPERATION,
          daemonInstanceId: DAEMON,
          outcome,
          resource: { resourceVersion: 1, workspaceName: "w" },
        }).success,
      ).toBe(true);
    }
    for (const outcome of ["created", "reopened"]) {
      expect(
        WorkspacePromoteMutationResultSchemaZ.safeParse({
          operationId: OPERATION,
          daemonInstanceId: DAEMON,
          outcome,
          resource: { resourceVersion: 1, workspaceName: "w" },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects an extra key on the promoted resource", () => {
    expect(
      WorkspacePromotedResourceSchemaZ.safeParse({
        resourceVersion: 1,
        workspaceName: "w",
        projectDir: "/home/user/project",
      }).success,
    ).toBe(false);
  });
});
