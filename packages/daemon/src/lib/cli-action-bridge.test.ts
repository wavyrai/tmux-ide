import { describe, it, expect, afterEach } from "bun:test";
import {
  __setCliActionBridgeDepsForTests,
  CliActionInvocationError,
  tryDispatchAction,
} from "./cli-action-bridge.ts";
import { makeTask } from "../__tests__/support.ts";
import type { CanonicalDaemonInfo } from "./canonical-daemon.ts";
import type { EmbeddedDaemonHandle } from "./daemon-embed.ts";

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

const daemonInfo = (port = 6060): CanonicalDaemonInfo => ({
  pid: process.pid,
  port,
  version: "0.0.0-test",
  startedAt: "2026-01-01T00:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: null,
});

function transientHandle(port = 6061): EmbeddedDaemonHandle {
  return {
    port,
    apiBaseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws/events`,
    activateProject: async () => ({ stop: async () => {} }),
    stop: async () => {},
  };
}

function setBridgeFetch(fetchImpl: typeof fetch, alive = true): void {
  restore = __setCliActionBridgeDepsForTests({
    cwd: () => "/tmp/project",
    readCanonicalDaemonInfo: () => (alive ? daemonInfo() : null),
    clearCanonicalDaemonInfo: () => {},
    isCanonicalDaemonAlive: async () => alive,
    startEmbeddedDaemon: async () => transientHandle(),
    fetch: fetchImpl,
  });
}

describe("tryDispatchAction", () => {
  it("posts typed input and parses a successful envelope", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    setBridgeFetch(async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/health")) return Response.json({ ok: true });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { taskId: "001", task: makeTask({ id: "001" }) } });
    });

    const result = await tryDispatchAction("task.create", { title: "Test" });
    expect(urls).toEqual(["http://127.0.0.1:6060/api/v2/action/task.create"]);
    expect(bodies).toEqual([{ title: "Test" }]);
    expect(result?.taskId).toBe("001");
  });

  it("starts a transient headless canonical daemon when no live daemon exists", async () => {
    const urls: string[] = [];
    let started = false;
    let stopped = false;
    restore = __setCliActionBridgeDepsForTests({
      cwd: () => process.cwd(),
      readCanonicalDaemonInfo: () => null,
      clearCanonicalDaemonInfo: () => {},
      isCanonicalDaemonAlive: async () => false,
      startEmbeddedDaemon: async (opts) => {
        started = opts.sessionName === undefined && opts.bindHostname === "127.0.0.1";
        return { ...transientHandle(), stop: async () => void (stopped = true) };
      },
      fetch: async (url, _init) => {
        urls.push(String(url));
        if (String(url).endsWith("/health")) return Response.json({ ok: true });
        return Response.json({
          ok: true,
          result: { taskId: "001", task: makeTask({ id: "001" }) },
        });
      },
    });

    const result = await tryDispatchAction("task.create", { title: "Test" });

    expect(started).toBe(true);
    expect(stopped).toBe(true);
    expect(urls).toEqual([
      "http://127.0.0.1:6061/health",
      "http://127.0.0.1:6061/api/v2/action/task.create",
    ]);
    expect(result?.taskId).toBe("001");
  });

  it("clears stale daemon info and returns null when fallback cannot start", async () => {
    let cleared = false;
    restore = __setCliActionBridgeDepsForTests({
      cwd: () => "/tmp/project",
      readCanonicalDaemonInfo: () => daemonInfo(),
      clearCanonicalDaemonInfo: () => void (cleared = true),
      isCanonicalDaemonAlive: async () => false,
      startEmbeddedDaemon: async () => {
        throw new Error("no daemon");
      },
      fetch: async () => new Response("should not be called"),
    });

    const result = await tryDispatchAction("task.delete", { taskId: "001" });

    expect(cleared).toBe(true);
    expect(result).toBeNull();
  });

  it("throws typed action errors from ok:false envelopes", async () => {
    setBridgeFetch(async (url) => {
      if (String(url).endsWith("/health")) return Response.json({ ok: true });
      return Response.json({
        ok: false,
        error: { code: "task_not_found", message: "Task missing", details: { taskId: "404" } },
      });
    });

    await expect(tryDispatchAction("task.delete", { taskId: "404" })).rejects.toBeInstanceOf(
      CliActionInvocationError,
    );
  });
});
