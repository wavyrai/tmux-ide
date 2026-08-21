import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CanonicalDaemonInfoSchema,
  DAEMON_WIRE_PROTOCOL_VERSION,
  DaemonHealthSchema,
  DaemonHealthzSchema,
  DaemonIdentitySchema,
  DaemonInstanceIdentitySchemaZ,
  isDaemonWireProtocolCompatible,
} from "../daemon-wire.ts";
import { WorkspaceCatalogResourceV1SchemaZ } from "../workspace-catalog-resource.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/daemon-wire-v2.json", import.meta.url));

describe("daemon wire protocol", () => {
  it("validates the shared desktop/TypeScript v2 fixture", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

    expect(CanonicalDaemonInfoSchema.parse(fixture.canonical).protocolVersion).toBe(
      DAEMON_WIRE_PROTOCOL_VERSION,
    );
    expect(DaemonHealthSchema.parse(fixture.health).protocolVersion).toBe(
      DAEMON_WIRE_PROTOCOL_VERSION,
    );
    expect(DaemonHealthzSchema.parse(fixture.healthz).productVersion).toBe("0.0.1");
    const identity = DaemonIdentitySchema.parse(fixture.identity);
    expect(identity.instanceId).toBe(CanonicalDaemonInfoSchema.parse(fixture.canonical).instanceId);
  });

  it("retains an unknown positive wire version for a separate compatibility decision", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      canonical: Record<string, unknown>;
      health: Record<string, unknown>;
    };
    const unknownVersion = DAEMON_WIRE_PROTOCOL_VERSION + 1;
    const health = DaemonHealthSchema.parse({
      ...fixture.health,
      protocolVersion: unknownVersion,
    });
    const canonical = CanonicalDaemonInfoSchema.parse({
      ...fixture.canonical,
      protocolVersion: unknownVersion,
    });

    expect(health.protocolVersion).toBe(unknownVersion);
    expect(canonical.protocolVersion).toBe(unknownVersion);
    expect(isDaemonWireProtocolCompatible(unknownVersion)).toBe(false);
    expect(isDaemonWireProtocolCompatible(DAEMON_WIRE_PROTOCOL_VERSION)).toBe(true);
  });
});

describe("environment identity (additive, both directions)", () => {
  const ENVIRONMENT_ID = "0f4e9a7c-2f4a-4d55-9d2e-1f6cf3a3b210";
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    canonical: Record<string, unknown>;
    identity: Record<string, unknown>;
  };
  const identityFields = {
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "0.0.1",
    instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
    startedAt: "2026-07-20T12:34:56.123Z",
  };

  it("parses pre-environment payloads unchanged (old daemon, new client)", () => {
    expect(CanonicalDaemonInfoSchema.parse(fixture.canonical).environmentId).toBeUndefined();
    expect(DaemonIdentitySchema.parse(fixture.identity).environmentId).toBeUndefined();
    expect(DaemonInstanceIdentitySchemaZ.parse(identityFields).environmentId).toBeUndefined();
  });

  it("carries the environment id on every identity surface when present", () => {
    const canonical = CanonicalDaemonInfoSchema.parse({
      ...fixture.canonical,
      environmentId: ENVIRONMENT_ID,
    });
    const identity = DaemonIdentitySchema.parse({
      ...fixture.identity,
      environmentId: ENVIRONMENT_ID,
    });
    const instanceIdentity = DaemonInstanceIdentitySchemaZ.parse({
      ...identityFields,
      environmentId: ENVIRONMENT_ID,
    });
    expect(canonical.environmentId).toBe(ENVIRONMENT_ID);
    expect(identity.environmentId).toBe(ENVIRONMENT_ID);
    expect(instanceIdentity.environmentId).toBe(ENVIRONMENT_ID);
  });

  it("rejects a non-UUID environment id but keeps other unknown-key strictness", () => {
    expect(
      DaemonInstanceIdentitySchemaZ.safeParse({ ...identityFields, environmentId: "nope" }).success,
    ).toBe(false);
    expect(
      DaemonInstanceIdentitySchemaZ.safeParse({ ...identityFields, machineId: ENVIRONMENT_ID })
        .success,
    ).toBe(false);
  });

  it("stamps generation-checked resource envelopes with and without the id", () => {
    const envelope = (daemon: Record<string, unknown>) => ({
      version: 1,
      daemon,
      workspaces: [{ workspaceName: "alpha", sessionName: "alpha" }],
    });
    const without = WorkspaceCatalogResourceV1SchemaZ.parse(envelope(identityFields));
    const withId = WorkspaceCatalogResourceV1SchemaZ.parse(
      envelope({ ...identityFields, environmentId: ENVIRONMENT_ID }),
    );
    expect(without.daemon.environmentId).toBeUndefined();
    expect(withId.daemon.environmentId).toBe(ENVIRONMENT_ID);
    // Generation identity is untouched by the additive field.
    expect(withId.daemon.instanceId).toBe(identityFields.instanceId);
    expect(withId.daemon.startedAt).toBe(identityFields.startedAt);
  });
});
