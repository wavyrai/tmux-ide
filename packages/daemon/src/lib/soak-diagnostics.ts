/** Pure, allowlisted evidence projection. Never retain response bodies or errors. */
export const DIAGNOSTICS_MAX_BYTES = 16_384;
export const RESOURCE_KEYS = [
  "Timeout",
  "Immediate",
  "TCPServerWrap",
  "TCPSocketWrap",
  "PipeWrap",
  "ProcessWrap",
  "FSEventWrap",
  "other",
] as const;
export const MEMORY_KEYS = ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"] as const;
export interface DiagnosticsIdentity {
  protocolVersion: number;
  productVersion: string;
  instanceId: string;
  startedAt: string;
  environmentId?: string;
}
export interface DiagnosticsSample {
  daemon: DiagnosticsIdentity;
  pid: number;
  uptimeMs: number;
  sampledAtMs: number;
  memory: Record<(typeof MEMORY_KEYS)[number], number>;
  cpu: { user: number; system: number };
  eventLoop: { idle: number; active: number; utilization: number };
  activeResources: Record<(typeof RESOURCE_KEYS)[number], number> | null;
}
export type DiagnosticsResult =
  | { status: "ok"; sample: DiagnosticsSample }
  | {
      status:
        | "missing"
        | "unsupported-endpoint"
        | "http-error"
        | "transport-error"
        | "malformed"
        | "identity-mismatch";
      sample: null;
    };
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
function numeric<K extends string>(
  v: unknown,
  keys: readonly K[],
  integer = false,
): Record<K, number> | null {
  if (!object(v) || !keys.every((k) => number(v[k]) && (!integer || Number.isSafeInteger(v[k]))))
    return null;
  return Object.fromEntries(keys.map((k) => [k, v[k]])) as Record<K, number>;
}
export function parseSoakDiagnostics(
  body: string | null,
  status: number,
  expected: DiagnosticsIdentity & { pid: number },
): DiagnosticsResult {
  const fail = (status: Exclude<DiagnosticsResult["status"], "ok">): DiagnosticsResult => ({
    status,
    sample: null,
  });
  if (status === 404) return fail("unsupported-endpoint");
  if (status !== 200) return fail("http-error");
  if (body === null || body === "") return fail("missing");
  if (new TextEncoder().encode(body).length > DIAGNOSTICS_MAX_BYTES) return fail("malformed");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return fail("malformed");
  }
  if (!object(raw) || !object(raw.daemon)) return fail("malformed");
  const d = raw.daemon;
  if (
    !Number.isSafeInteger(d.protocolVersion) ||
    !number(d.protocolVersion) ||
    !text(d.productVersion) ||
    !text(d.instanceId) ||
    !text(d.startedAt) ||
    !Number.isFinite(Date.parse(d.startedAt)) ||
    (d.environmentId !== undefined && !text(d.environmentId)) ||
    !Number.isSafeInteger(raw.pid) ||
    !number(raw.pid) ||
    raw.pid === 0
  )
    return fail("malformed");
  if (
    ["protocolVersion", "productVersion", "instanceId", "startedAt", "environmentId"].some(
      (k) => d[k] !== expected[k as keyof DiagnosticsIdentity],
    ) ||
    raw.pid !== expected.pid
  )
    return fail("identity-mismatch");
  const memory = numeric(raw.memory, MEMORY_KEYS, true);
  const cpu = numeric(raw.cpu, ["user", "system"], true);
  const eventLoop = numeric(raw.eventLoop, ["idle", "active", "utilization"]);
  const activeResources =
    raw.activeResources === null ? null : numeric(raw.activeResources, RESOURCE_KEYS, true);
  if (
    !memory ||
    !cpu ||
    !eventLoop ||
    eventLoop.utilization > 1 ||
    !number(raw.uptimeMs) ||
    !number(raw.sampledAtMs) ||
    (raw.activeResources !== null && !activeResources)
  )
    return fail("malformed");
  return {
    status: "ok",
    sample: {
      daemon: {
        protocolVersion: d.protocolVersion,
        productVersion: d.productVersion,
        instanceId: d.instanceId,
        startedAt: d.startedAt,
        ...(d.environmentId !== undefined ? { environmentId: d.environmentId } : {}),
      },
      pid: raw.pid,
      uptimeMs: raw.uptimeMs,
      sampledAtMs: raw.sampledAtMs,
      memory,
      cpu,
      eventLoop,
      activeResources,
    },
  };
}
export type DiagnosticsDelta =
  | {
      status: "ok";
      intervalMs: number;
      cpuUserMicros: number;
      cpuSystemMicros: number;
      cpuPercent: number;
      eventLoopIdleMs: number;
      eventLoopActiveMs: number;
      eventLoopUtilization: number | null;
    }
  | {
      status: "missing-baseline" | "identity-mismatch" | "counter-regression" | "invalid-interval";
    };
/** Uptime is monotonic; wall-clock jumps do not change interval rates. */
export function diagnosticsDelta(
  previous: DiagnosticsSample | null,
  current: DiagnosticsSample,
): DiagnosticsDelta {
  if (!previous) return { status: "missing-baseline" };
  if (
    previous.pid !== current.pid ||
    ["protocolVersion", "productVersion", "instanceId", "startedAt", "environmentId"].some(
      (key) =>
        previous.daemon[key as keyof DiagnosticsIdentity] !==
        current.daemon[key as keyof DiagnosticsIdentity],
    )
  )
    return { status: "identity-mismatch" };
  const intervalMs = current.uptimeMs - previous.uptimeMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { status: "invalid-interval" };
  const cpuUserMicros = current.cpu.user - previous.cpu.user;
  const cpuSystemMicros = current.cpu.system - previous.cpu.system;
  const eventLoopIdleMs = current.eventLoop.idle - previous.eventLoop.idle;
  const eventLoopActiveMs = current.eventLoop.active - previous.eventLoop.active;
  if (![cpuUserMicros, cpuSystemMicros, eventLoopIdleMs, eventLoopActiveMs].every(number))
    return { status: "counter-regression" };
  const cpuPercent = (cpuUserMicros + cpuSystemMicros) / (intervalMs * 10);
  if (!Number.isFinite(cpuPercent)) return { status: "invalid-interval" };
  const eventTotal = eventLoopIdleMs + eventLoopActiveMs;
  if (!Number.isFinite(eventTotal)) return { status: "invalid-interval" };
  return {
    status: "ok",
    intervalMs,
    cpuUserMicros,
    cpuSystemMicros,
    cpuPercent,
    eventLoopIdleMs,
    eventLoopActiveMs,
    eventLoopUtilization: eventTotal === 0 ? null : eventLoopActiveMs / eventTotal,
  };
}
