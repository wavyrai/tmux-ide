import { afterEach, describe, expect, it } from "vitest";
import { DaemonHealthSchema, DaemonHealthzSchema, DaemonIdentitySchema } from "@tmux-ide/contracts";
import { createApp } from "../../command-center/server.ts";
import { AuthService } from "../auth/auth-service.ts";

const identity = {
  productVersion: "2.8.0-test",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};

let auth: AuthService | null = null;

afterEach(() => {
  auth?.dispose();
  auth = null;
});

describe("daemon discovery probes", () => {
  it("uses one product version and exposes identity before credentials", async () => {
    auth = new AuthService("probe-test-secret");
    const app = createApp({
      authService: auth,
      authConfig: { method: "ssh", token_expiry: 60 },
      remoteAccess: { bindHostname: "0.0.0.0", token: "remote-secret" },
      daemonIdentity: identity,
    });

    const health = DaemonHealthSchema.parse(await (await app.request("/health")).json());
    const healthz = DaemonHealthzSchema.parse(await (await app.request("/healthz")).json());
    const probe = DaemonIdentitySchema.parse(await (await app.request("/identity")).json());

    expect(health.productVersion).toBe(identity.productVersion);
    expect(healthz.productVersion).toBe(identity.productVersion);
    expect(probe).toMatchObject(identity);
  });
});
