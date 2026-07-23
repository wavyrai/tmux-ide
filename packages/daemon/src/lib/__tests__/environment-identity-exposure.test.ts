import { describe, expect, it } from "vitest";
import { DaemonIdentitySchema } from "@tmux-ide/contracts";

import { createApp } from "../../command-center/server.ts";

const OWNER = "owner-capability-secret";
const ENVIRONMENT_ID = "0f4e9a7c-2f4a-4d55-9d2e-1f6cf3a3b210";

function makeApp(environmentId?: string): ReturnType<typeof createApp> {
  return createApp({
    remoteAccess: {
      bindHostname: "127.0.0.1",
      token: null,
      localBypassToken: null,
      ownerToken: OWNER,
    },
    daemonIdentity: {
      productVersion: "0.0.0-test",
      instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
      startedAt: "2026-07-20T12:34:56.123Z",
      ...(environmentId !== undefined ? { environmentId } : {}),
    },
  });
}

describe("environment identity exposure", () => {
  it("exposes the environment id on the credential-free /identity probe", async () => {
    const response = await makeApp(ENVIRONMENT_ID).request("/identity");
    expect(response.status).toBe(200);
    const identity = DaemonIdentitySchema.parse(await response.json());
    expect(identity.environmentId).toBe(ENVIRONMENT_ID);
    expect(identity.instanceId).toBe("9bcf33b0-c837-4a94-b5e8-c0977f54464f");
  });

  it("omits the field entirely for a daemon identity without one", async () => {
    const response = await makeApp().request("/identity");
    expect(response.status).toBe(200);
    const raw = (await response.json()) as Record<string, unknown>;
    expect("environmentId" in raw).toBe(false);
    expect(DaemonIdentitySchema.parse(raw).environmentId).toBeUndefined();
  });

  it("stamps the authenticated instance identity envelope with the id", async () => {
    const response = await makeApp(ENVIRONMENT_ID).request("/api/v2/capabilities", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      daemon: { environmentId?: string; instanceId: string };
    };
    expect(body.daemon.environmentId).toBe(ENVIRONMENT_ID);
    expect(body.daemon.instanceId).toBe("9bcf33b0-c837-4a94-b5e8-c0977f54464f");
  });
});
