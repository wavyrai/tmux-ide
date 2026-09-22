import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountDiagnosticsRoute, sampleDaemonDiagnostics } from "./diagnostics.ts";
import { createApp } from "./server.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.9.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-09-22T00:00:00.000Z",
  environmentId: "10000000-0000-4000-8000-000000000001",
} as const;
const ownerToken = "diagnostics-owner-secret";
const headers = { Authorization: `Bearer ${ownerToken}` };

afterEach(() => vi.restoreAllMocks());

function sampleSpies() {
  return [
    vi.spyOn(process, "memoryUsage"),
    vi.spyOn(process, "cpuUsage"),
    vi.spyOn(process, "uptime"),
    vi.spyOn(process, "getActiveResourcesInfo"),
    vi.spyOn(performance, "eventLoopUtilization"),
  ];
}

describe("passive daemon diagnostics", () => {
  it("mounts without sampling or timers and samples once per owner request", async () => {
    const app = new Hono();
    const samples = sampleSpies();
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    mountDiagnosticsRoute(app, { daemon, ownerToken });
    for (const sample of samples) expect(sample).not.toHaveBeenCalled();
    for (let request = 1; request <= 2; request++) {
      const response = await app.request("/api/diagnostics", { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      for (const sample of samples) expect(sample).toHaveBeenCalledTimes(request);
    }
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong", "Bearer remote-secret", "Bearer bypass-secret"])(
    "rejects %s without sampling",
    async (authorization) => {
      const app = createApp({
        daemonIdentity: daemon,
        remoteAccess: {
          bindHostname: "0.0.0.0",
          ownerToken,
          token: "remote-secret",
          localBypassToken: "bypass-secret",
        },
      });
      const samples = sampleSpies();
      const response = await app.request("/api/diagnostics", {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(response.status).toBe(401);
      for (const sample of samples) expect(sample).not.toHaveBeenCalled();
    },
  );

  it("returns unavailable without sampling when no owner capability exists", async () => {
    const app = createApp({ remoteAccess: { ownerToken: null } });
    const samples = sampleSpies();
    expect((await app.request("/api/diagnostics", { headers })).status).toBe(503);
    for (const sample of samples) expect(sample).not.toHaveBeenCalled();
  });

  it("admits only the owner ahead of remote and project auth", async () => {
    const app = createApp({
      daemonIdentity: daemon,
      authConfig: { method: "ssh", token_expiry: 86_400 },
      remoteAccess: {
        bindHostname: "0.0.0.0",
        token: "remote-secret",
        localBypassToken: "bypass-secret",
        ownerToken,
      },
    });
    const response = await app.request("/api/diagnostics", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).daemon).toEqual(daemon);
  });

  it("projects fixed numeric fields and cumulative counters without leaking additional properties", () => {
    vi.spyOn(Date, "now").mockReturnValue(123456);
    vi.spyOn(process, "uptime").mockReturnValue(12.5);
    vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 100,
      heapTotal: 90,
      heapUsed: 80,
      external: 20,
      arrayBuffers: 10,
      secret: "/private/path",
    } as ReturnType<typeof process.memoryUsage>);
    vi.spyOn(process, "cpuUsage").mockReturnValue({ user: 111, system: 222 });
    vi.spyOn(performance, "eventLoopUtilization").mockReturnValue({
      idle: 90,
      active: 10,
      utilization: 0.1,
    });
    vi.spyOn(process, "getActiveResourcesInfo").mockReturnValue([
      "Timeout",
      "Timeout",
      "TCPServerWrap",
      "__proto__",
      "/private/path",
      "other",
    ]);
    const result = sampleDaemonDiagnostics({ ...daemon, secret: ownerToken } as typeof daemon);
    expect(result).toEqual({
      daemon,
      pid: process.pid,
      uptimeMs: 12500,
      sampledAtMs: 123456,
      memory: { rss: 100, heapTotal: 90, heapUsed: 80, external: 20, arrayBuffers: 10 },
      cpu: { user: 111, system: 222 },
      eventLoop: { idle: 90, active: 10, utilization: 0.1 },
      activeResources: {
        Timeout: 2,
        Immediate: 0,
        TCPServerWrap: 1,
        TCPSocketWrap: 0,
        PipeWrap: 0,
        ProcessWrap: 0,
        FSEventWrap: 0,
        other: 3,
      },
    });
    expect(process.cpuUsage).toHaveBeenCalledWith();
    expect(performance.eventLoopUtilization).toHaveBeenCalledWith();
  });

  it("keeps public health and identity free of diagnostics", async () => {
    const app = createApp({ daemonIdentity: daemon, remoteAccess: { ownerToken } });
    for (const [path, keys] of [
      ["/health", ["ok", "protocolVersion", "uptime", "productVersion"]],
      ["/healthz", ["ok", "protocolVersion", "productVersion", "uptimeMs"]],
      [
        "/identity",
        [
          "ok",
          "pid",
          "protocolVersion",
          "productVersion",
          "instanceId",
          "startedAt",
          "environmentId",
        ],
      ],
    ] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      expect(Object.keys(await response.json()).sort()).toEqual([...keys].sort());
    }
  });

  it("reports unsupported resource inspection as null rather than zero counts", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "getActiveResourcesInfo")!;
    try {
      Object.defineProperty(process, "getActiveResourcesInfo", {
        ...descriptor,
        value: undefined,
      });
      expect(sampleDaemonDiagnostics(daemon).activeResources).toBeNull();
    } finally {
      Object.defineProperty(process, "getActiveResourcesInfo", descriptor);
    }
  });
});
