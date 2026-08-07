import { describe, expect, it } from "vitest";

import {
  AppWindowMutationArgumentsSchemaZ,
  AppWindowMutationRequestSchemaZ,
  AppWindowMutationResultSchemaZ,
} from "../app-window-mutation.ts";

const command = { type: "window.move", windowId: "window.shell", x: 10, y: 20 } as const;

describe("AppWindow mutation contracts", () => {
  it("accepts only semantic renderer arguments", () => {
    const input = { workspaceName: "alpha", expectedDocumentRevision: 3, command };
    expect(AppWindowMutationArgumentsSchemaZ.parse(input)).toEqual(input);
    for (const hostile of [
      { ...input, operationId: crypto.randomUUID() },
      { ...input, expectedDaemonInstanceId: crypto.randomUUID() },
      { ...input, projectDir: "/tmp/alpha" },
      { ...input, tmuxPaneId: "%4" },
      { ...input, command: { ...command, x: Number.POSITIVE_INFINITY } },
      { ...input, command: { ...command, x: Number.NaN } },
      {
        ...input,
        command: { type: "window.resize", windowId: "window.shell", width: 0, height: 20 },
      },
    ]) {
      expect(AppWindowMutationArgumentsSchemaZ.safeParse(hostile).success).toBe(false);
    }
  });

  it("strictly separates host-authored request authority from daemon results", () => {
    const request = {
      operationId: "00000000-0000-4000-8000-000000000010",
      expectedDaemonInstanceId: "00000000-0000-4000-8000-000000000001",
      intent: { workspaceName: "alpha", expectedDocumentRevision: 3, command },
    };
    expect(AppWindowMutationRequestSchemaZ.parse(request)).toEqual(request);
    expect(
      AppWindowMutationRequestSchemaZ.safeParse({ ...request, bearer: "secret" }).success,
    ).toBe(false);
    expect(
      AppWindowMutationResultSchemaZ.safeParse({
        operationId: request.operationId,
        daemonInstanceId: request.expectedDaemonInstanceId,
        outcome: "applied",
        workspaceName: "alpha",
        documentRevision: -1,
      }).success,
    ).toBe(false);
  });
});
