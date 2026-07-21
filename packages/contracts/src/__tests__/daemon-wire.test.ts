import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CanonicalDaemonInfoSchema,
  DAEMON_WIRE_PROTOCOL_VERSION,
  DaemonHealthSchema,
  DaemonHealthzSchema,
  DaemonIdentitySchema,
  isDaemonWireProtocolCompatible,
} from "../daemon-wire.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/daemon-wire-v1.json", import.meta.url));

describe("daemon wire protocol", () => {
  it("validates the shared Swift/TypeScript v1 fixture", () => {
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
    const health = DaemonHealthSchema.parse({ ...fixture.health, protocolVersion: 2 });
    const canonical = CanonicalDaemonInfoSchema.parse({
      ...fixture.canonical,
      protocolVersion: 2,
    });

    expect(health.protocolVersion).toBe(2);
    expect(canonical.protocolVersion).toBe(2);
    expect(isDaemonWireProtocolCompatible(2)).toBe(false);
    expect(isDaemonWireProtocolCompatible(DAEMON_WIRE_PROTOCOL_VERSION)).toBe(true);
  });
});
