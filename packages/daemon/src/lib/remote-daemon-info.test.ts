import { describe, expect, it, vi } from "vitest";
import { type CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  readRemoteDaemonHandshake,
  readRemoteDaemonHandshakeResult,
} from "./remote-daemon-info.ts";

const info: CanonicalDaemonInfo = {
  pid: 123,
  port: 43123,
  bindHostname: "127.0.0.1",
  authToken: "private-test-owner-token",
  protocolVersion: 2,
  productVersion: "2.9.0-beta.8",
  instanceId: "328f7407-2a86-468f-b2e2-cd4e5d47fcc9",
  startedAt: "2026-09-09T08:00:00.000Z",
};
function response(override: Partial<CanonicalDaemonInfo> = {}) {
  const { protocolVersion, productVersion, instanceId, startedAt, environmentId } = {
    ...info,
    ...override,
  };
  return Response.json({
    status: "ok",
    daemon: { protocolVersion, productVersion, instanceId, startedAt, environmentId },
    capabilities: { appWindowMutation: { available: true } },
  });
}
describe("remote daemon discovery command", () => {
  it("exports only a verified existing daemon and authenticates without redirects", async () => {
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/identity")
        ? Response.json({
            ok: true,
            pid: info.pid,
            protocolVersion: info.protocolVersion,
            productVersion: info.productVersion,
            instanceId: info.instanceId,
            startedAt: info.startedAt,
          })
        : response(),
    );
    expect(
      await readRemoteDaemonHandshake({ readInfo: () => info, isAlive: async () => true, request }),
    ).toEqual({ version: 1, daemon: info });
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:43123/api/v2/capabilities",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        redirect: "error",
        headers: { Authorization: `Bearer ${info.authToken}`, "Content-Type": "application/json" },
      }),
    );
  });
  it("does not probe or launch when no live daemon exists", async () => {
    const request = vi.fn();
    for (const readInfo of [() => null, () => info]) {
      await expect(
        readRemoteDaemonHandshake({ readInfo, isAlive: async () => false, request }),
      ).rejects.toThrow("No running");
    }
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { instanceId: "08d44942-319b-4e08-b174-51d246b204f6" },
    { startedAt: "2026-09-09T08:01:00.000Z" },
    { productVersion: "2.9.0-beta.9" },
    { protocolVersion: 3 },
    { environmentId: "08d44942-319b-4e08-b174-51d246b204f6" },
  ])("rejects a changed daemon identity %j", async (override) => {
    await expect(
      readRemoteDaemonHandshake({
        readInfo: () => info,
        isAlive: async () => true,
        request: async () => response(override),
      }),
    ).rejects.toThrow("Could not verify");
  });
  it("keeps credentials and response details out of failures", async () => {
    for (const request of [
      async () => new Response(info.authToken, { status: 401 }),
      async () => {
        throw new Error(info.authToken!);
      },
    ]) {
      await expect(
        readRemoteDaemonHandshake({ readInfo: () => info, isAlive: async () => true, request }),
      ).rejects.toThrow("Could not verify the running daemon's identity and owner authority.");
    }
    const request = vi.fn();
    await expect(
      readRemoteDaemonHandshake({
        readInfo: () => ({ ...info, authToken: null }),
        isAlive: async () => true,
        request,
      }),
    ).rejects.toThrow("does not support");
    expect(request).not.toHaveBeenCalled();
  });
});

it("returns structured credential-free missing-daemon and unexpected failures", async () => {
  expect(await readRemoteDaemonHandshakeResult({ readInfo: () => null })).toEqual({
    version: 1,
    error: { code: "daemon-missing" },
  });
  const failed = await readRemoteDaemonHandshakeResult({
    readInfo: () => {
      throw new Error("secret-token");
    },
  });
  expect(failed).toEqual({ version: 1, error: { code: "unavailable" } });
});
