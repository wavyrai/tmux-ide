import { describe, expect, it, vi } from "vitest";
import { workspaceSessionCreateHandler } from "./fleet-lifecycle.ts";

describe("fleet create generation fence", () => {
  it("refuses a queued target for a replaced daemon before reaching creation", async () => {
    const createSession = vi.fn();
    await expect(
      workspaceSessionCreateHandler(
        { displayName: "work", expectedDaemonInstanceId: "11111111-1111-4111-8111-111111111111" },
        {
          operationId: "33333333-3333-4333-8333-333333333333",
          daemonInstanceId: "22222222-2222-4222-8222-222222222222",
          hostClientId: "fleet-test",
          ownerAuthorized: true,
          fleetLifecycleBackend: { createSession } as never,
        },
      ),
    ).rejects.toThrow("replaced");
    expect(createSession).not.toHaveBeenCalled();
  });
});
