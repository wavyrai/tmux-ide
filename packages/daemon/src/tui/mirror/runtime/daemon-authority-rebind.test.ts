import { describe, expect, it, vi } from "vitest";
import type { ApplicationShellSessionState } from "@tmux-ide/daemon-client/application-shell-session";

import {
  DaemonAuthorityRebindCoordinator,
  type DaemonAuthorityRebindActions,
} from "./daemon-authority-rebind.ts";

function identityMismatch(instanceId: string): ApplicationShellSessionState {
  return {
    status: "degraded",
    generation: 1,
    target: {
      daemon: {
        protocolVersion: 1,
        productVersion: "2.8.0",
        instanceId,
        startedAt: "2026-08-12T08:00:00.000Z",
      },
      workspaceName: "workspace.alpha",
    },
    data: null,
    updatedAt: null,
    code: "daemon-identity-mismatch",
    reason: "daemon generation changed",
  };
}

describe("daemon authority rebind coordinator", () => {
  it("retires stale capabilities before one canonical old-to-new generation rebind", async () => {
    let scheduled: (() => void) | null = null;
    let canonicalInstanceId = "old-daemon";
    const events: string[] = [];
    const reconnect = vi.fn(async () => {
      events.push(`connect:${canonicalInstanceId}`);
      return true;
    });
    const coordinator = new DaemonAuthorityRebindCoordinator({
      delayMs: 25,
      schedule: (callback) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    });
    const state = identityMismatch("old-daemon");

    expect(
      coordinator.request("alpha", state, {
        retire: () => events.push("retire:old-daemon"),
        reconnect,
      }),
    ).toBe(true);
    expect(events).toEqual(["retire:old-daemon"]);
    expect(reconnect).not.toHaveBeenCalled();

    canonicalInstanceId = "new-daemon";
    if (!scheduled) throw new Error("rebind was not scheduled");
    scheduled();
    await Promise.resolve();
    expect(events).toEqual(["retire:old-daemon", "connect:new-daemon"]);

    expect(
      coordinator.request("alpha", state, {
        retire: () => events.push("retire:old-daemon-again"),
        reconnect,
      }),
    ).toBe(true);
    expect(events).toEqual(["retire:old-daemon", "connect:new-daemon", "retire:old-daemon-again"]);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("does not rebind non-fatal degradation and allows a later daemon generation", () => {
    const callbacks: Array<() => void> = [];
    const retire = vi.fn();
    const coordinator = new DaemonAuthorityRebindCoordinator({
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    });
    const schemaFailure = {
      ...identityMismatch("old-daemon"),
      code: "schema-invalid" as const,
    };

    expect(
      coordinator.request("alpha", schemaFailure, { retire, reconnect: vi.fn(() => true) }),
    ).toBe(false);
    expect(
      coordinator.request("alpha", identityMismatch("old-daemon"), {
        retire,
        reconnect: vi.fn(() => true),
      }),
    ).toBe(true);
    expect(
      coordinator.request("alpha", identityMismatch("new-daemon"), {
        retire,
        reconnect: vi.fn(() => true),
      }),
    ).toBe(true);
    expect(retire).toHaveBeenCalledTimes(2);
  });

  it("bounds failed canonical discovery retries", async () => {
    const callbacks: Array<() => void> = [];
    const reconnect = vi.fn(async () => false);
    const coordinator = new DaemonAuthorityRebindCoordinator({
      maxAttempts: 3,
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    });
    coordinator.request("alpha", identityMismatch("old-daemon"), {
      retire: vi.fn(),
      reconnect,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      callbacks.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(callbacks).toHaveLength(0);
  });

  it("cannot reschedule after disposal while discovery is in flight", async () => {
    const callbacks: Array<() => void> = [];
    let resolveReconnect!: (connected: boolean) => void;
    const reconnect = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReconnect = resolve;
        }),
    );
    const coordinator = new DaemonAuthorityRebindCoordinator({
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    });
    coordinator.request("alpha", identityMismatch("old-daemon"), {
      retire: vi.fn(),
      reconnect,
    });
    callbacks.shift()?.();
    coordinator.dispose();
    resolveReconnect(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(callbacks).toHaveLength(0);
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it("keeps recursive identity mismatch recovery single-flight", async () => {
    const callbacks: Array<() => void> = [];
    let activeReconnects = 0;
    let peakReconnects = 0;
    const coordinator = new DaemonAuthorityRebindCoordinator({
      maxAttempts: 3,
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: vi.fn(),
    });
    const actions: DaemonAuthorityRebindActions = {
      retire: vi.fn(),
      reconnect: vi.fn(async () => {
        activeReconnects += 1;
        peakReconnects = Math.max(peakReconnects, activeReconnects);
        coordinator.request("alpha", identityMismatch("old-daemon"), actions);
        activeReconnects -= 1;
        return false;
      }),
    };

    coordinator.request("alpha", identityMismatch("old-daemon"), actions);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(callbacks).toHaveLength(1);
      callbacks.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(actions.reconnect).toHaveBeenCalledTimes(3);
    expect(peakReconnects).toBe(1);
    expect(callbacks).toHaveLength(0);
  });
});
