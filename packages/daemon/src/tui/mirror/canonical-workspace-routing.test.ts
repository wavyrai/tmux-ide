import { describe, expect, it, vi } from "vitest";

import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";

import { fetchCanonicalWorkspaceRouting } from "./canonical-workspace-routing.ts";

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
