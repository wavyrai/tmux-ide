import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type CanonicalDaemonInfo,
  type DaemonHealth,
  type DaemonIdentity,
} from "@tmux-ide/contracts";

import {
  createCanonicalDaemonPreflight,
  runDaemonPreflight,
  type CanonicalDaemonAttachOperations,
  type DaemonPreflight,
} from "./daemon-preflight.ts";

const info: CanonicalDaemonInfo = {
  pid: 4242,
  port: 6060,
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "must-not-cross-ipc",
};

const identity: DaemonIdentity = {
  ok: true,
  pid: info.pid,
  protocolVersion: info.protocolVersion,
  productVersion: info.productVersion,
  instanceId: info.instanceId,
  startedAt: info.startedAt,
};

const health: DaemonHealth = {
  ok: true,
  protocolVersion: info.protocolVersion,
  productVersion: info.productVersion,
  uptime: 30,
};

function operations(
  overrides: Partial<CanonicalDaemonAttachOperations> = {},
): CanonicalDaemonAttachOperations {
  return {
    inspect: () => ({
      status: "valid",
      info,
      observation: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
    }),
    isAlive: async () => true,
    probeIdentity: async () => identity,
    probeHealth: async () => health,
    httpOrigin: () => "http://127.0.0.1:6060",
    ...overrides,
  };
}

describe("canonical Electron daemon attachment", () => {
  it("reports a missing record without attempting a spawn or network probe", async () => {
    const probeIdentity = vi.fn(async () => identity);
    const preflight = createCanonicalDaemonPreflight(
      operations({ inspect: () => ({ status: "missing" }), probeIdentity }),
    );

    await expect(runDaemonPreflight(preflight)).resolves.toEqual({
      status: "unavailable",
      code: "record-missing",
      reason: "No running canonical tmux-ide daemon was found.",
    });
    expect(probeIdentity).not.toHaveBeenCalled();
  });

  it.each(["malformed-json", "unsafe-permissions", "parent-unsafe-permissions"] as const)(
    "degrades an insecure or malformed record (%s)",
    async (reason) => {
      const preflight = createCanonicalDaemonPreflight(
        operations({
          inspect: () => ({
            status: "invalid",
            reason,
            detail: "record failed secure inspection",
            ownerPid: null,
            observation: null,
          }),
        }),
      );

      await expect(runDaemonPreflight(preflight)).resolves.toMatchObject({
        status: "degraded",
        code: "record-invalid",
        reason: expect.stringContaining(reason),
      });
    },
  );

  it("reports a stale process as unavailable", async () => {
    const preflight = createCanonicalDaemonPreflight(operations({ isAlive: async () => false }));
    await expect(runDaemonPreflight(preflight)).resolves.toMatchObject({
      status: "unavailable",
      code: "process-not-running",
    });
  });

  it("refuses a non-loopback endpoint before probing it", async () => {
    const probeIdentity = vi.fn(async () => identity);
    const preflight = createCanonicalDaemonPreflight(
      operations({ httpOrigin: () => "http://192.0.2.10:6060", probeIdentity }),
    );
    await expect(runDaemonPreflight(preflight)).resolves.toMatchObject({
      status: "degraded",
      code: "endpoint-not-loopback",
    });
    expect(probeIdentity).not.toHaveBeenCalled();
  });

  it("refuses incompatible record, identity, and health protocol versions", async () => {
    const recordPreflight = createCanonicalDaemonPreflight(
      operations({
        inspect: () => ({
          status: "valid",
          info: { ...info, protocolVersion: 99 },
          observation: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
        }),
      }),
    );
    await expect(runDaemonPreflight(recordPreflight)).resolves.toMatchObject({
      status: "degraded",
      code: "protocol-incompatible",
    });

    const identityPreflight = createCanonicalDaemonPreflight(
      operations({ probeIdentity: async () => ({ ...identity, protocolVersion: 99 }) }),
    );
    await expect(runDaemonPreflight(identityPreflight)).resolves.toMatchObject({
      status: "degraded",
      code: "protocol-incompatible",
    });

    const healthPreflight = createCanonicalDaemonPreflight(
      operations({ probeHealth: async () => ({ ...health, protocolVersion: 99 }) }),
    );
    await expect(runDaemonPreflight(healthPreflight)).resolves.toMatchObject({
      status: "degraded",
      code: "protocol-incompatible",
    });
  });

  it.each([
    { field: "pid", value: info.pid + 1 },
    { field: "instanceId", value: "3adfc6e2-f1ae-4e63-b9df-7e8eb0ea94d4" },
    { field: "startedAt", value: "2026-07-21T00:00:01.000Z" },
    { field: "productVersion", value: "9.0.0" },
  ] as const)("degrades a mismatched identity $field", async ({ field, value }) => {
    const preflight = createCanonicalDaemonPreflight(
      operations({ probeIdentity: async () => ({ ...identity, [field]: value }) }),
    );
    await expect(runDaemonPreflight(preflight)).resolves.toMatchObject({
      status: "degraded",
      code: "identity-mismatch",
    });
  });

  it("distinguishes unreachable identity and health endpoints", async () => {
    const identityPreflight = createCanonicalDaemonPreflight(
      operations({ probeIdentity: async () => null }),
    );
    await expect(runDaemonPreflight(identityPreflight)).resolves.toMatchObject({
      status: "unavailable",
      code: "identity-unreachable",
    });

    const healthPreflight = createCanonicalDaemonPreflight(
      operations({ probeHealth: async () => null }),
    );
    await expect(runDaemonPreflight(healthPreflight)).resolves.toMatchObject({
      status: "unavailable",
      code: "health-unreachable",
    });
  });

  it("degrades health metadata that disagrees with the verified record", async () => {
    const preflight = createCanonicalDaemonPreflight(
      operations({ probeHealth: async () => ({ ...health, productVersion: "9.0.0" }) }),
    );
    await expect(runDaemonPreflight(preflight)).resolves.toMatchObject({
      status: "degraded",
      code: "health-mismatch",
    });
  });

  it("reuses a valid daemon and exposes only the bounded renderer-safe descriptor", async () => {
    const preflight = createCanonicalDaemonPreflight(operations());
    const result = await runDaemonPreflight(preflight);

    expect(result).toEqual({
      status: "connected",
      descriptor: {
        apiBaseUrl: "http://127.0.0.1:6060",
        protocolVersion: 1,
        productVersion: "2.8.0",
        instanceId: info.instanceId,
        startedAt: info.startedAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain(String(info.pid));
    expect(JSON.stringify(result)).not.toContain(info.authToken);
  });
});

describe("runDaemonPreflight", () => {
  it("validates and returns an injected host state", async () => {
    const probe = vi.fn(async () => ({
      status: "unavailable" as const,
      code: "record-missing" as const,
      reason: "not running",
    }));

    await expect(runDaemonPreflight({ probe })).resolves.toEqual({
      status: "unavailable",
      code: "record-missing",
      reason: "not running",
    });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("converts probe failures into an unavailable result", async () => {
    const preflight: DaemonPreflight = {
      probe: async () => {
        throw new Error("socket rejected");
      },
    };

    await expect(runDaemonPreflight(preflight)).resolves.toEqual({
      status: "unavailable",
      code: "probe-failed",
      reason: "socket rejected",
    });
  });

  it("bounds a probe and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const preflight: DaemonPreflight = {
      probe: (nextSignal) => {
        signal = nextSignal;
        return new Promise(() => undefined);
      },
    };

    const result = runDaemonPreflight(preflight, 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({
      status: "unavailable",
      code: "probe-timeout",
      reason: "Daemon preflight timed out after 25ms.",
    });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
