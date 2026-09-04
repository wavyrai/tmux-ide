import { describe, expect, it, vi } from "vitest";

import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";

import {
  fetchCanonicalWorkspaceRouting,
  fetchCanonicalLiveWorkspaceRouting,
} from "./canonical-workspace-routing.ts";

const daemon: CanonicalDaemonInfo = {
  pid: 123,
  port: 4321,
  protocolVersion: 2,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-17T00:00:00.000Z",
  bindHostname: "127.0.0.1",
};

const catalog = {
  version: 2 as const,
  daemon: {
    protocolVersion: 2,
    productVersion: "2.8.0",
    instanceId: daemon.instanceId,
    startedAt: daemon.startedAt,
  },
  intents: [],
  liveSessions: [],
};

describe("canonical workspace routing", () => {
  it("reads the incarnation-bearing V3 catalog with one bounded request", async () => {
    const v3 = { ...catalog, version: 3 };
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(v3));
    await expect(fetchCanonicalLiveWorkspaceRouting(daemon, request)).resolves.toEqual(v3);
    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toContain("workspace-catalog?version=3");
  });
  it("rejects incarnation catalogs belonging to a retired daemon", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...catalog,
        version: 3,
        daemon: { ...catalog.daemon, instanceId: "22222222-2222-4222-8222-222222222222" },
      }),
    );
    await expect(fetchCanonicalLiveWorkspaceRouting(daemon, request)).rejects.toThrow(
      "daemon generation changed",
    );
  });
  it("retries bounded timeout-only cold catalog reads", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json(catalog));

    await expect(fetchCanonicalWorkspaceRouting(daemon, request)).resolves.toEqual(catalog);
    expect(request).toHaveBeenCalledTimes(3);
    for (const [, init] of request.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not retry a non-timeout catalog failure", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("connection failed"));

    await expect(fetchCanonicalWorkspaceRouting(daemon, request)).rejects.toThrow(
      "connection failed",
    );
    expect(request).toHaveBeenCalledOnce();
  });
});
