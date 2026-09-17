import { describe, expect, it } from "vitest";
import {
  restartCanonicalDaemon,
  type RestartCanonicalDaemonDependencies,
} from "./restart-canonical-daemon.ts";
import type { CanonicalDaemonInfoState } from "./canonical-daemon.ts";
const prior = {
  pid: 42,
  port: 4001,
  protocolVersion: 2,
  productVersion: "2.9.0-beta.18",
  instanceId: "10000000-0000-4000-8000-000000000001",
  startedAt: "2026-09-16T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "private-owner-token",
};
const next = {
  ...prior,
  port: 4002,
  instanceId: "20000000-0000-4000-8000-000000000002",
  startedAt: "2026-09-16T00:00:01.000Z",
  authToken: "replacement-owner-token",
};
function fixture() {
  let current = prior;
  const calls: { url: string; init?: RequestInit }[] = [];
  const deps: RestartCanonicalDaemonDependencies = {
    inspect: () => ({
      status: "valid",
      info: current,
      observation: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
    }),
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/identity")) return Response.json({ ok: true, ...current });
      if (url.endsWith("/health"))
        return Response.json({
          ok: true,
          protocolVersion: current.protocolVersion,
          productVersion: current.productVersion,
          uptime: 1,
        });
      current = next;
      return Response.json({
        ok: true,
        result: { restarting: true, instanceId: prior.instanceId },
      });
    }) as typeof fetch,
  };
  return {
    deps,
    calls,
    replace: (value: typeof prior) => {
      current = value;
    },
  };
}
describe("canonical daemon runtime restart command", () => {
  it("verifies a new generation under the same owner and emits no credentials", async () => {
    const f = fixture();
    const result = await restartCanonicalDaemon({}, f.deps);
    expect(result).toEqual({
      status: "restarted",
      pid: 42,
      previousInstanceId: prior.instanceId,
      instanceId: next.instanceId,
      productVersion: prior.productVersion,
    });
    const posts = f.calls.filter((call) => call.init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]!.init!.body as string)).toEqual({
      expectedInstanceId: prior.instanceId,
    });
    expect(posts[0]!.init!.headers).toMatchObject({ Authorization: `Bearer ${prior.authToken}` });
    expect(f.calls.filter((call) => call.url.includes(":4002/"))).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("token");
  });
  it("refuses absent or invalid state without making network requests", async () => {
    for (const state of [
      { status: "missing" },
      {
        status: "invalid",
        reason: "unsafe-permissions",
        detail: "fixture",
        ownerPid: null,
        observation: null,
      },
    ] as CanonicalDaemonInfoState[]) {
      const f = fixture();
      f.deps.inspect = () => state;
      await expect(restartCanonicalDaemon({}, f.deps)).rejects.toMatchObject({
        code: "DAEMON_RESTART_UNAVAILABLE",
      });
      expect(f.calls).toHaveLength(0);
    }
  });
  it("never sends owner credentials when initial identity disagrees", async () => {
    const f = fixture();
    f.deps.fetch = (async () => Response.json({ ok: true, ...next })) as typeof fetch;
    await expect(restartCanonicalDaemon({}, f.deps)).rejects.toMatchObject({
      code: "DAEMON_IDENTITY_MISMATCH",
    });
  });
  it("fails safely when an older daemon does not support restart", async () => {
    const f = fixture();
    const fetch = f.deps.fetch;
    f.deps.fetch = ((url, init) =>
      init?.method === "POST"
        ? Promise.resolve(Response.json({ ok: false }, { status: 404 }))
        : fetch(url, init)) as typeof fetch;
    await expect(restartCanonicalDaemon({}, f.deps)).rejects.toMatchObject({
      code: "DAEMON_RESTART_REJECTED",
    });
  });
  it("does not accept the old healthy generation as restart completion", async () => {
    const f = fixture();
    const fetch = f.deps.fetch;
    f.deps.fetch = ((url, init) =>
      init?.method === "POST"
        ? Promise.resolve(
            Response.json({ ok: true, result: { restarting: true, instanceId: prior.instanceId } }),
          )
        : fetch(url, init)) as typeof fetch;
    await expect(restartCanonicalDaemon({ timeoutMs: 15 }, f.deps)).rejects.toMatchObject({
      code: "DAEMON_RESTART_TIMEOUT",
    });
  });
  it("rejects replacement by a different supervising process", async () => {
    const f = fixture();
    const fetch = f.deps.fetch;
    f.deps.fetch = (async (url, init) => {
      const result = await fetch(url, init);
      if (init?.method === "POST") f.replace({ ...next, pid: 84 });
      return result;
    }) as typeof fetch;
    await expect(restartCanonicalDaemon({}, f.deps)).rejects.toMatchObject({
      code: "DAEMON_RESTART_OWNER_CHANGED",
    });
  });
  it("requires healthy replacement identity before success", async () => {
    const f = fixture();
    const fetch = f.deps.fetch;
    f.deps.fetch = ((url, init) =>
      String(url).includes(":4002/")
        ? Promise.resolve(Response.json({ ok: false }, { status: 503 }))
        : fetch(url, init)) as typeof fetch;
    await expect(restartCanonicalDaemon({ timeoutMs: 15 }, f.deps)).rejects.toMatchObject({
      code: "DAEMON_RESTART_TIMEOUT",
    });
  });
  it("bounds a noncooperating request and keeps raw network error contents private", async () => {
    const f = fixture();
    f.deps.fetch = (() => new Promise(() => {})) as typeof fetch;
    await expect(restartCanonicalDaemon({ timeoutMs: 5 }, f.deps)).rejects.toMatchObject({
      code: "DAEMON_RESTART_TIMEOUT",
    });
    f.deps.fetch = (async () => {
      throw new Error(prior.authToken);
    }) as typeof fetch;
    const error = await restartCanonicalDaemon({}, f.deps).catch((error: unknown) => error);
    expect(String(error)).not.toContain(prior.authToken);
    expect(error).toMatchObject({ code: "DAEMON_RESTART_FAILED" });
  });
});
