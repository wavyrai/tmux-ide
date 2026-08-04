import { describe, expect, it } from "vitest";
import type { DaemonEventServerFrame, DaemonInstanceIdentity } from "@tmux-ide/contracts";

import {
  projectDaemonServerFrame,
  sameIdentity,
  type DevWorkspaceCatalogEntry,
} from "./dev-web-host.ts";

const CATALOG: readonly DevWorkspaceCatalogEntry[] = [
  { workspaceName: "alpha", sessionName: "alpha-session" },
  { workspaceName: "beta", sessionName: "beta-session" },
];

const IDENTITY: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-04T00:00:00.000Z",
};

function frame(value: unknown): DaemonEventServerFrame {
  return value as DaemonEventServerFrame;
}

describe("sameIdentity", () => {
  it("matches only on the whole generation tuple", () => {
    expect(sameIdentity(IDENTITY, { ...IDENTITY })).toBe(true);
    expect(sameIdentity(IDENTITY, { ...IDENTITY, startedAt: "2026-08-05T00:00:00.000Z" })).toBe(
      false,
    );
    expect(sameIdentity(IDENTITY, { ...IDENTITY, instanceId: "other" })).toBe(false);
    expect(sameIdentity(IDENTITY, { ...IDENTITY, productVersion: "2.9.0" })).toBe(false);
    expect(sameIdentity(IDENTITY, { ...IDENTITY, protocolVersion: 2 })).toBe(false);
  });

  it("never matches a missing peer", () => {
    expect(sameIdentity(null, IDENTITY)).toBe(false);
    expect(sameIdentity(IDENTITY, null)).toBe(false);
  });
});

describe("projectDaemonServerFrame", () => {
  it("maps a session-scoped frame onto only that session's workspaces", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "terminals.changed", sessionName: "beta-session" }),
        CATALOG,
      ),
    ).toEqual([{ type: "application-shell.changed", workspaceName: "beta" }]);
  });

  it("drops a session-scoped frame for a session no workspace owns", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "config.changed", sessionName: "unadopted" }),
        CATALOG,
      ),
    ).toEqual([]);
  });

  it("invalidates the fleet as well as the shell on ground-truth agent status", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "agent-status.changed", sessionName: "alpha-session" }),
        CATALOG,
      ),
    ).toEqual([
      { type: "application-shell.changed", workspaceName: "alpha" },
      { type: "fleet.changed" },
    ]);
  });

  it("maps a fleet composition change onto the workspace-free invalidation", () => {
    expect(projectDaemonServerFrame(frame({ type: "fleet.changed" }), CATALOG)).toEqual([
      { type: "fleet.changed" },
    ]);
  });

  it("invalidates the catalog and every shell on a fleet-wide change", () => {
    expect(projectDaemonServerFrame(frame({ type: "sessions.changed" }), CATALOG)).toEqual([
      { type: "workspaces.changed" },
      { type: "application-shell.changed", workspaceName: "alpha" },
      { type: "application-shell.changed", workspaceName: "beta" },
    ]);
  });

  it("reports a daemon protocol error as a degraded connection", () => {
    expect(
      projectDaemonServerFrame(
        frame({ type: "protocol.error", code: "invalid-frame", message: "bad" }),
        CATALOG,
      ),
    ).toEqual([
      {
        type: "connection.changed",
        state: "degraded",
        error: { code: "protocol-error", reason: "The daemon reported a protocol error." },
      },
    ]);
  });

  it("projects frames the renderer has no resource for onto nothing", () => {
    expect(
      projectDaemonServerFrame(frame({ type: "pong", sentAt: 1, receivedAt: 2 }), CATALOG),
    ).toEqual([]);
    expect(projectDaemonServerFrame(frame({ type: "hello", daemon: IDENTITY }), CATALOG)).toEqual(
      [],
    );
  });
});
