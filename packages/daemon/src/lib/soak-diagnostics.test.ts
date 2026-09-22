import { describe, expect, it } from "vitest";
import {
  diagnosticsDelta,
  parseSoakDiagnostics,
  RESOURCE_KEYS,
  type DiagnosticsSample,
} from "./soak-diagnostics.ts";
const expected = {
  pid: 123,
  protocolVersion: 1,
  productVersion: "test",
  instanceId: "original",
  startedAt: "2026-09-22T00:00:00Z",
};
const fixture = (): DiagnosticsSample => ({
  daemon: {
    protocolVersion: 1,
    productVersion: "test",
    instanceId: "original",
    startedAt: expected.startedAt,
  },
  pid: 123,
  uptimeMs: 1000,
  sampledAtMs: 10000,
  memory: { rss: 100, heapTotal: 80, heapUsed: 50, external: 10, arrayBuffers: 5 },
  cpu: { user: 1000, system: 1000 },
  eventLoop: { idle: 900, active: 100, utilization: 0.1 },
  activeResources: Object.fromEntries(
    RESOURCE_KEYS.map((k) => [k, 1]),
  ) as DiagnosticsSample["activeResources"],
});
const parse = (v: unknown) => parseSoakDiagnostics(JSON.stringify(v), 200, expected);
describe("bounded diagnostics parser", () => {
  it("projects only allowed fields at every level", () => {
    const f = fixture();
    expect(
      parse({
        ...f,
        token: "secret",
        daemon: { ...f.daemon, token: "secret" },
        cpu: { ...f.cpu, secret: 1 },
        memory: { ...f.memory, secret: 1 },
        eventLoop: { ...f.eventLoop, secret: 1 },
        activeResources: { ...f.activeResources, secret: 1 },
      }),
    ).toEqual({ status: "ok", sample: f });
  });
  it.each(["pid", "protocolVersion", "productVersion", "instanceId", "startedAt", "environmentId"])(
    "rejects identity mismatch %s",
    (key) => {
      const f = fixture();
      if (key === "pid") f.pid++;
      else
        Object.assign(f.daemon, {
          [key]:
            key === "protocolVersion"
              ? 2
              : key === "startedAt"
                ? "2026-09-23T00:00:00Z"
                : "changed",
        });
      expect(parse(f)).toEqual({ status: "identity-mismatch", sample: null });
    },
  );
  it.each([
    "memory",
    "cpu",
    "eventLoop",
    "activeResources",
    "uptimeMs",
    "sampledAtMs",
    "daemon",
    "pid",
  ])("rejects missing %s", (key) => {
    const f = { ...fixture() } as Record<string, unknown>;
    delete f[key];
    expect(parse(f).status).toBe("malformed");
  });
  it.each([-1, NaN, Infinity, "10", null])("rejects invalid units %s", (value) => {
    expect(parse({ ...fixture(), memory: { ...fixture().memory, heapUsed: value } }).status).toBe(
      "malformed",
    );
    expect(parse({ ...fixture(), cpu: { user: value, system: 1 } }).status).toBe("malformed");
    expect(
      parse({ ...fixture(), eventLoop: { ...fixture().eventLoop, active: value } }).status,
    ).toBe("malformed");
    expect(
      parse({ ...fixture(), activeResources: { ...fixture().activeResources, Timeout: value } })
        .status,
    ).toBe("malformed");
  });
  it("requires integer resource counts and a bounded utilization ratio", () => {
    expect(
      parse({ ...fixture(), activeResources: { ...fixture().activeResources, Timeout: 0.5 } })
        .status,
    ).toBe("malformed");
    expect(
      parse({ ...fixture(), eventLoop: { ...fixture().eventLoop, utilization: 1.1 } }).status,
    ).toBe("malformed");
  });
  it("preserves unsupported resources and never invents zero", () => {
    expect(parse({ ...fixture(), activeResources: null })).toMatchObject({
      status: "ok",
      sample: { activeResources: null },
    });
  });
  it("bounds payloads and distinguishes missing, legacy 404, invalid JSON and HTTP failure", () => {
    for (const [body, code, status] of [
      [null, 200, "missing"],
      ["secret", 404, "unsupported-endpoint"],
      ["secret", 401, "http-error"],
      ["secret", 200, "malformed"],
      ["x".repeat(16385), 200, "malformed"],
    ] as const)
      expect(parseSoakDiagnostics(body, code, expected)).toEqual({ status, sample: null });
  });
});
describe("diagnostic counter deltas", () => {
  it("uses monotonic uptime despite wall-clock reversal; no initial fabricated delta", () => {
    const a = fixture();
    const b = {
      ...a,
      uptimeMs: 2000,
      sampledAtMs: 1,
      cpu: { user: 301000, system: 201000 },
      eventLoop: { idle: 1700, active: 300, utilization: 0.15 },
    };
    expect(diagnosticsDelta(null, a)).toEqual({ status: "missing-baseline" });
    expect(diagnosticsDelta(a, b)).toEqual({
      status: "ok",
      intervalMs: 1000,
      cpuUserMicros: 300000,
      cpuSystemMicros: 200000,
      cpuPercent: 50,
      eventLoopIdleMs: 800,
      eventLoopActiveMs: 200,
      eventLoopUtilization: 0.2,
    });
  });
  it("rejects replacements, clock regression and decreasing counters", () => {
    const a = fixture();
    expect(diagnosticsDelta(a, { ...a, pid: 2 }).status).toBe("identity-mismatch");
    expect(diagnosticsDelta(a, a).status).toBe("invalid-interval");
    expect(diagnosticsDelta(a, { ...a, uptimeMs: 2000, cpu: { user: 0, system: 1 } }).status).toBe(
      "counter-regression",
    );
    expect(
      diagnosticsDelta(a, {
        ...a,
        uptimeMs: 2000,
        eventLoop: { idle: 0, active: 100, utilization: 1 },
      }).status,
    ).toBe("counter-regression");
    expect(diagnosticsDelta(a, { ...a, uptimeMs: 2000 })).toMatchObject({
      status: "ok",
      eventLoopUtilization: null,
    });
  });
});
