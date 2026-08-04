import { describe, expect, it } from "vitest";

import {
  STARTUP_READINESS_RESOURCE_VERSION,
  STARTUP_READINESS_RUNG_ORDER,
  StartupReadinessLadderSchemaZ,
  StartupReadinessResourceSchemaZ,
  StartupReadinessRungSchemaZ,
  buildStartupReadinessLadder,
  projectDesktopStartupReadiness,
  startupReadinessBlockingRung,
  type StartupReadinessLadder,
} from "../startup-readiness.ts";
import { DaemonChildOutputTailSchemaZ, type DaemonChildOutputTail } from "../desktop-host.ts";

const OBSERVED_AT = "2026-08-04T12:00:00.000Z";

const IDENTITY = {
  protocolVersion: 1,
  productVersion: "2.7.0",
  instanceId: "0f5a2a3e-6f0a-4f1a-9f2b-1c2d3e4f5a6b",
  startedAt: "2026-08-04T11:59:00.000Z",
} as const;

function fullyWalked(): StartupReadinessLadder {
  return buildStartupReadinessLadder(
    [
      { status: "satisfied" },
      { status: "satisfied" },
      { status: "satisfied" },
      {
        status: "satisfied",
        population: { fleet: "populated", workspaceCount: 2, attachablePaneCount: 3 },
      },
      { status: "satisfied" },
    ],
    OBSERVED_AT,
  );
}

describe("startup readiness ladder", () => {
  it("walks every rung to satisfied with nothing blocking", () => {
    const ladder = fullyWalked();
    expect(ladder.rungs.map((rung) => rung.rung)).toEqual([...STARTUP_READINESS_RUNG_ORDER]);
    expect(ladder.rungs.every((rung) => rung.status === "satisfied")).toBe(true);
    expect(ladder.blockedAt).toBeNull();
    expect(startupReadinessBlockingRung(ladder)).toBeNull();
    expect(StartupReadinessLadderSchemaZ.safeParse(ladder).success).toBe(true);
  });

  it("stops the ladder at the stuck rung and leaves everything above it pending", () => {
    const ladder = buildStartupReadinessLadder(
      [
        { status: "satisfied" },
        { status: "satisfied" },
        { status: "satisfied" },
        {
          status: "stuck",
          reason: { vocabulary: "terminal-resource-unavailable", code: "missing-semantic-stamp" },
        },
        // A verdict past the blocking rung is ignored; it cannot be believed.
        { status: "satisfied" },
      ],
      OBSERVED_AT,
    );
    expect(ladder.blockedAt).toBe("catalog-populated");
    expect(ladder.rungs[3]).toEqual({
      rung: "catalog-populated",
      status: "stuck",
      observedAt: OBSERVED_AT,
      reason: { vocabulary: "terminal-resource-unavailable", code: "missing-semantic-stamp" },
    });
    expect(ladder.rungs[4]!.status).toBe("pending");
    expect(StartupReadinessLadderSchemaZ.safeParse(ladder).success).toBe(true);
  });

  it("fills unproven rungs as pending when the caller supplies fewer verdicts", () => {
    const ladder = buildStartupReadinessLadder([{ status: "satisfied" }], OBSERVED_AT);
    expect(ladder.blockedAt).toBe("credential-held");
    expect(ladder.rungs.slice(1).every((rung) => rung.status === "pending")).toBe(true);
  });

  it("rejects a ladder that claims a satisfied rung above an unsatisfied one", () => {
    const ladder = fullyWalked();
    const broken = {
      ...ladder,
      rungs: [
        ladder.rungs[0]!,
        { rung: "credential-held", status: "pending", observedAt: OBSERVED_AT },
        ...ladder.rungs.slice(2),
      ],
      blockedAt: "credential-held",
    };
    const result = StartupReadinessLadderSchemaZ.safeParse(broken);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "a rung cannot be satisfied above an unsatisfied rung",
    );
  });

  it("rejects a blockedAt that does not name the first unsatisfied rung", () => {
    const ladder = buildStartupReadinessLadder([{ status: "satisfied" }], OBSERVED_AT);
    const result = StartupReadinessLadderSchemaZ.safeParse({
      ...ladder,
      blockedAt: "attachment-issuable",
    });
    expect(result.success).toBe(false);
  });

  it("rejects rungs presented out of canonical order", () => {
    const ladder = fullyWalked();
    const result = StartupReadinessLadderSchemaZ.safeParse({
      ...ladder,
      rungs: [ladder.rungs[1]!, ladder.rungs[0]!, ...ladder.rungs.slice(2)],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a stuck reason drawn from a vocabulary that cannot explain the rung", () => {
    const result = StartupReadinessRungSchemaZ.safeParse({
      rung: "catalog-populated",
      status: "stuck",
      observedAt: OBSERVED_AT,
      reason: { vocabulary: "desktop-daemon-host-issue", code: "probe-timeout" },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("cannot be explained by");
  });

  it("accepts each rung's own vocabulary", () => {
    const accepted = [
      {
        rung: "daemon-spawned",
        reason: { vocabulary: "desktop-daemon-host-issue", code: "process-not-running" },
      },
      {
        rung: "credential-held",
        reason: { vocabulary: "startup-readiness", code: "owner-capability-unavailable" },
      },
      {
        rung: "identity-established",
        reason: { vocabulary: "desktop-daemon-host-issue", code: "identity-mismatch" },
      },
      {
        rung: "catalog-populated",
        reason: { vocabulary: "startup-readiness", code: "catalog-discovery-failed" },
      },
      {
        rung: "attachment-issuable",
        reason: { vocabulary: "terminal-attachment-issue", code: "attachment-unavailable" },
      },
    ] as const;
    for (const { rung, reason } of accepted) {
      expect(
        StartupReadinessRungSchemaZ.safeParse({
          rung,
          status: "stuck",
          observedAt: OBSERVED_AT,
          reason,
        }).success,
      ).toBe(true);
    }
  });
});

describe("empty fleet versus stuck", () => {
  it("treats a catalog with no workspaces as satisfied, not stuck", () => {
    const ladder = buildStartupReadinessLadder(
      [
        { status: "satisfied" },
        { status: "satisfied" },
        { status: "satisfied" },
        {
          status: "satisfied",
          population: { fleet: "empty", workspaceCount: 0, attachablePaneCount: 0 },
        },
        { status: "satisfied" },
      ],
      OBSERVED_AT,
    );
    expect(ladder.blockedAt).toBeNull();
    const catalogRung = ladder.rungs[3]!;
    expect(catalogRung.status).toBe("satisfied");
    expect(catalogRung.status === "satisfied" ? catalogRung.population : null).toEqual({
      fleet: "empty",
      workspaceCount: 0,
      attachablePaneCount: 0,
    });
    expect(StartupReadinessLadderSchemaZ.safeParse(ladder).success).toBe(true);
  });

  it("rejects an 'empty' fleet that reports workspaces, or a populated one with none", () => {
    const base = {
      rung: "catalog-populated",
      status: "satisfied",
      observedAt: OBSERVED_AT,
    } as const;
    expect(
      StartupReadinessRungSchemaZ.safeParse({
        ...base,
        population: { fleet: "empty", workspaceCount: 2, attachablePaneCount: 0 },
      }).success,
    ).toBe(false);
    expect(
      StartupReadinessRungSchemaZ.safeParse({
        ...base,
        population: { fleet: "populated", workspaceCount: 0, attachablePaneCount: 0 },
      }).success,
    ).toBe(false);
  });

  it("rejects catalog population claimed on any other rung", () => {
    expect(
      StartupReadinessRungSchemaZ.safeParse({
        rung: "attachment-issuable",
        status: "satisfied",
        observedAt: OBSERVED_AT,
        population: { fleet: "empty", workspaceCount: 0, attachablePaneCount: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("startup readiness resource", () => {
  it("carries the daemon generation stamp alongside the ladder", () => {
    const parsed = StartupReadinessResourceSchemaZ.safeParse({
      version: STARTUP_READINESS_RESOURCE_VERSION,
      daemon: IDENTITY,
      ladder: fullyWalked(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("desktop projection", () => {
  const childOutput: DaemonChildOutputTail = {
    stream: "stderr",
    lines: ["Error: listen EADDRINUSE: address already in use 127.0.0.1:8787"],
    truncated: false,
    exitCode: 1,
    signal: null,
  };

  it("names daemon-spawned as the stuck rung and carries the child's own words", () => {
    const readiness = projectDesktopStartupReadiness({
      daemon: {
        status: "unavailable",
        code: "process-not-running",
        reason: "The canonical daemon is unavailable.",
        childOutput,
      },
      ladder: null,
      observedAt: OBSERVED_AT,
    });
    expect(readiness.ladder.blockedAt).toBe("daemon-spawned");
    expect(readiness.ladder.rungs[0]).toEqual({
      rung: "daemon-spawned",
      status: "stuck",
      observedAt: OBSERVED_AT,
      reason: { vocabulary: "desktop-daemon-host-issue", code: "process-not-running" },
    });
    expect(readiness.childOutput).toEqual(childOutput);
    expect(DaemonChildOutputTailSchemaZ.safeParse(readiness.childOutput).success).toBe(true);
    expect(StartupReadinessLadderSchemaZ.safeParse(readiness.ladder).success).toBe(true);
  });

  it("carries a halted supervisor through as the daemon-spawned reason", () => {
    const readiness = projectDesktopStartupReadiness({
      daemon: {
        status: "degraded",
        code: "supervisor-halted",
        reason: "The bundled engine stopped after 3 consecutive fatal startup failures.",
      },
      ladder: null,
      observedAt: OBSERVED_AT,
    });
    expect(readiness.ladder.blockedAt).toBe("daemon-spawned");
    expect(readiness.childOutput).toBeUndefined();
  });

  it("proves the first three rungs from a connected host state alone", () => {
    const readiness = projectDesktopStartupReadiness({
      daemon: { status: "connected", identity: IDENTITY },
      ladder: null,
      observedAt: OBSERVED_AT,
    });
    expect(readiness.ladder.blockedAt).toBe("catalog-populated");
    expect(readiness.ladder.rungs.slice(0, 3).every((rung) => rung.status === "satisfied")).toBe(
      true,
    );
    expect(readiness.ladder.rungs[3]!.status).toBe("pending");
  });

  it("defers to the daemon's own ladder once it has been read", () => {
    const ladder = fullyWalked();
    const readiness = projectDesktopStartupReadiness({
      daemon: { status: "connected", identity: IDENTITY },
      ladder,
      observedAt: OBSERVED_AT,
    });
    expect(readiness.ladder).toEqual(ladder);
  });
});
