/* @vitest-environment happy-dom */
/**
 * Browser mode must stay as honest as the Electron shell about WHY startup is
 * blocked: when the daemon refuses this app but still answers, its own readiness
 * ladder travels on the disconnected bootstrap state.
 */
import { buildStartupReadinessLadder } from "@tmux-ide/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDevWebHostCapabilities } from "./dev-web-host.ts";

const CONFIG = {
  daemonOrigin: "http://127.0.0.1:6060",
  daemonWebSocketOrigin: "ws://127.0.0.1:6060",
  ownerToken: "owner-token",
  transport: "direct",
} as const;

const LADDER = buildStartupReadinessLadder(
  [
    { status: "satisfied" },
    { status: "satisfied" },
    { status: "satisfied" },
    {
      status: "stuck",
      reason: { vocabulary: "startup-readiness", code: "catalog-sessions-unreachable" },
    },
  ],
  "2026-08-05T09:00:00.000Z",
);

const DAEMON = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "8a3d1f0e-1b2c-4d3e-9f10-abcdef012345",
  startedAt: "2026-08-05T08:59:00.000Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dev web host bootstrap", () => {
  it("carries the daemon's ladder when the identity read is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/resources/startup-readiness")) {
          return json({ version: 1, daemon: DAEMON, ladder: LADDER });
        }
        return json({ error: "unauthorized" }, 401);
      }),
    );
    const host = createDevWebHostCapabilities({ ...CONFIG });
    const { daemon } = await host.bootstrap();
    expect(daemon.status).toBe("unavailable");
    if (daemon.status === "connected") throw new Error("expected a disconnected state");
    expect(daemon.startupReadiness?.blockedAt).toBe("catalog-populated");
    host.dispose();
  });

  it("leaves the state usable when the ladder cannot be read either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const host = createDevWebHostCapabilities({ ...CONFIG });
    const { daemon } = await host.bootstrap();
    if (daemon.status === "connected") throw new Error("expected a disconnected state");
    expect(daemon.code).toBe("probe-failed");
    expect(daemon.startupReadiness).toBeUndefined();
    host.dispose();
  });

  it("does not read the ladder at all once the daemon answers", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/v2/capabilities")) {
        return json({
          status: "ok",
          daemon: DAEMON,
          capabilities: { appWindowMutation: { available: true } },
        });
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const host = createDevWebHostCapabilities({ ...CONFIG });
    const { daemon } = await host.bootstrap();
    expect(daemon.status).toBe("connected");
    expect(
      fetchImpl.mock.calls.some(([input]) =>
        String(input).includes("/api/resources/startup-readiness"),
      ),
    ).toBe(false);
    host.dispose();
  });
});
