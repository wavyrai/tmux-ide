/**
 * Logger hardening: reserved identity metadata, ring byte budget, credential
 * redaction on the wire, and degradation (not a crash) when a stream fails.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetLogStateForTests,
  _setLogBudgetForTests,
  getLogBuffer,
  getLogBufferStats,
  getLogStreamFailures,
  logger,
  registerLogSecret,
  setLogIdentity,
  setLogLevel,
  subscribeLogs,
} from "./log.ts";
import { REDACTED } from "./log-sanitize.ts";

type Writer = typeof process.stdout.write;

let stdoutLines: string[];
let stderrLines: string[];
let originalStdout: Writer;
let originalStderr: Writer;

function installCapture(options: { stdoutThrows?: boolean } = {}): void {
  stdoutLines = [];
  stderrLines = [];
  originalStdout = process.stdout.write;
  originalStderr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (options.stdoutThrows) throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    stdoutLines.push(String(chunk));
    return true;
  }) as Writer;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLines.push(String(chunk));
    return true;
  }) as Writer;
}

beforeEach(() => {
  _resetLogStateForTests();
  setLogLevel("debug");
});

afterEach(() => {
  process.stdout.write = originalStdout;
  process.stderr.write = originalStderr;
  _resetLogStateForTests();
  setLogLevel("info");
});

function lastWire(): Record<string, unknown> {
  return JSON.parse(stdoutLines.at(-1)!) as Record<string, unknown>;
}

describe("reserved metadata", () => {
  it("stamps pid, instanceId and version on ring entries and the wire", () => {
    installCapture();
    setLogIdentity({ instanceId: "11111111-1111-4111-8111-111111111111", version: "9.9.9" });
    logger.info("daemon", "started", { port: 4010 });
    const entry = getLogBuffer().at(-1)!;
    expect(entry).toMatchObject({
      component: "daemon",
      msg: "started",
      pid: process.pid,
      instanceId: "11111111-1111-4111-8111-111111111111",
      version: "9.9.9",
      data: { port: 4010 },
    });
    expect(lastWire()).toMatchObject({
      component: "daemon",
      msg: "started",
      pid: process.pid,
      instanceId: "11111111-1111-4111-8111-111111111111",
      version: "9.9.9",
      port: 4010,
    });
  });

  it("cannot be overwritten by caller payloads", () => {
    installCapture();
    setLogIdentity({ instanceId: "11111111-1111-4111-8111-111111111111", version: "1.0.0" });
    logger.warn("daemon", "real message", {
      ts: "1970-01-01T00:00:00.000Z",
      level: "error",
      component: "spoofed",
      msg: "spoofed message",
      pid: 1,
      instanceId: "spoofed",
      version: "0.0.0",
    });
    const wire = lastWire();
    expect(wire.level).toBe("warn");
    expect(wire.component).toBe("daemon");
    expect(wire.msg).toBe("real message");
    expect(wire.pid).toBe(process.pid);
    expect(wire.instanceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(wire.version).toBe("1.0.0");
    expect(wire.ts).not.toBe("1970-01-01T00:00:00.000Z");
    expect(wire.payload_msg).toBe("spoofed message");
    expect(wire.payload_pid).toBe(1);
    expect(wire.reservedKeysRenamed).toEqual([
      "ts",
      "level",
      "component",
      "msg",
      "pid",
      "instanceId",
      "version",
    ]);
    const entry = getLogBuffer().at(-1)!;
    expect(entry.msg).toBe("real message");
    expect(entry.data).not.toHaveProperty("msg");
  });
});

describe("redaction", () => {
  it("never writes a registered secret, credential key or bearer header", () => {
    installCapture();
    registerLogSecret("local-bypass-token-value");
    const seen: string[] = [];
    const unsubscribe = subscribeLogs((entry) => seen.push(JSON.stringify(entry)));
    logger.info("auth", "handshake local-bypass-token-value ok", {
      authToken: "local-bypass-token-value",
      headers: { authorization: "Bearer local-bypass-token-value" },
      url: "ws://127.0.0.1:1/ws?token=other-secret",
    });
    unsubscribe();
    const everything = [
      ...stdoutLines,
      ...stderrLines,
      ...seen,
      JSON.stringify(getLogBuffer()),
    ].join("\n");
    expect(everything).not.toContain("local-bypass-token-value");
    expect(everything).not.toContain("other-secret");
    expect(lastWire()).toMatchObject({
      msg: `handshake ${REDACTED} ok`,
      authToken: REDACTED,
      headers: { authorization: REDACTED },
      url: `ws://127.0.0.1:1/ws?token=${REDACTED}`,
    });
  });
});

describe("budgets", () => {
  it("keeps the ring under its byte budget by evicting the oldest entries", () => {
    installCapture();
    _setLogBudgetForTests({ ringBytes: 4_000, maxDataBytes: 2_000 });
    for (let i = 0; i < 50; i++) logger.info("bulk", `entry ${i}`, { blob: "x".repeat(900) });
    const stats = getLogBufferStats();
    expect(stats.bytes).toBeLessThanOrEqual(4_000);
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.entries).toBeLessThan(50);
    expect(getLogBuffer().at(-1)!.msg).toBe("entry 49");
  });

  it("bounds a single oversized payload with an explicit marker", () => {
    installCapture();
    _setLogBudgetForTests({ maxDataBytes: 512 });
    logger.info("bulk", "big", { blob: "x".repeat(5_000), other: 1 });
    const wire = lastWire();
    expect(wire.truncated).toBe(true);
    expect(wire.keys).toEqual(["blob", "other"]);
    expect(stdoutLines.at(-1)!.length).toBeLessThan(1_000);
  });
});

describe("stream degradation", () => {
  it("survives a failing stdout, warns once on stderr, and keeps the ring", () => {
    installCapture({ stdoutThrows: true });
    expect(() => logger.info("daemon", "one")).not.toThrow();
    expect(() => logger.info("daemon", "two")).not.toThrow();
    expect(getLogStreamFailures()).toEqual(["stdout"]);
    const warnings = stderrLines.filter((line) => line.includes("stdout write failed"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("EPIPE");
    expect(getLogBuffer().map((entry) => entry.msg)).toEqual(["one", "two"]);
    // Error-level records still reach stderr.
    logger.error("daemon", "three");
    expect(stderrLines.some((line) => line.includes('"msg":"three"'))).toBe(true);
  });
});
