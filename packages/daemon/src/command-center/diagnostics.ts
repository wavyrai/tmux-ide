import { performance } from "node:perf_hooks";
import type { DaemonInstanceIdentity } from "@tmux-ide/contracts";
import type { Hono } from "hono";
import { requireOwnerAuthority } from "./owner-authority.ts";

/** One synchronous, demand-only sample. No observers, discovery, or retained baseline. */
export function sampleDaemonDiagnostics(daemon: DaemonInstanceIdentity) {
  const sampledAtMs = Date.now();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const eventLoop = performance.eventLoopUtilization();
  // Fixed output cardinality. Unknown runtime resource labels are never echoed.
  const activeResources = {
    Timeout: 0,
    Immediate: 0,
    TCPServerWrap: 0,
    TCPSocketWrap: 0,
    PipeWrap: 0,
    ProcessWrap: 0,
    FSEventWrap: 0,
    other: 0,
  };
  const resourceNames = process.getActiveResourcesInfo?.();
  for (const resource of resourceNames ?? []) {
    if (Object.hasOwn(activeResources, resource) && resource !== "other") {
      activeResources[resource as keyof typeof activeResources]++;
    } else {
      activeResources.other++;
    }
  }
  return {
    daemon: {
      protocolVersion: daemon.protocolVersion,
      productVersion: daemon.productVersion,
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
      ...(daemon.environmentId !== undefined ? { environmentId: daemon.environmentId } : {}),
    },
    pid: process.pid,
    uptimeMs: process.uptime() * 1000,
    sampledAtMs,
    memory: {
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
    },
    cpu: { user: cpu.user, system: cpu.system },
    eventLoop: {
      idle: eventLoop.idle,
      active: eventLoop.active,
      utilization: eventLoop.utilization,
    },
    activeResources: resourceNames === undefined ? null : activeResources,
  };
}

export function mountDiagnosticsRoute(
  app: Hono,
  options: { daemon: DaemonInstanceIdentity; ownerToken: string | null },
) {
  app.get(
    "/api/diagnostics",
    requireOwnerAuthority(options.ownerToken, {
      whenOwnerless: "unavailable",
      unavailableMessage: "Diagnostics unavailable",
      mismatchMessage: "Diagnostics require owner authority",
    }),
    (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(sampleDaemonDiagnostics(options.daemon));
    },
  );
}
