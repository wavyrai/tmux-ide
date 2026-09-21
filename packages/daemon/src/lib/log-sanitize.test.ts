import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_BUDGET,
  REDACTED,
  RESERVED_LOG_KEYS,
  isSecretKey,
  redactLogValue,
  redactText,
  sanitizeLogMessage,
  sanitizeLogPayload,
} from "./log-sanitize.ts";

describe("isSecretKey", () => {
  it("matches credential keys regardless of casing and separators", () => {
    for (const key of [
      "authToken",
      "auth_token",
      "AUTH-TOKEN",
      "tokens",
      "Authorization",
      "proxy-authorization",
      "x-api-key",
      "apiKey",
      "password",
      "passwd",
      "cookie",
      "clientSecret",
      "credentials",
      "privateKey",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it("leaves ordinary keys alone", () => {
    for (const key of ["pid", "port", "instanceId", "protocolVersion", "msg", "path"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("redactText", () => {
  it("redacts bearer and basic authorization values", () => {
    expect(redactText("Authorization: Bearer abc.def-123")).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactText("auth Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==")).toBe(`auth Basic ${REDACTED}`);
  });

  it("redacts tokens in websocket and http URLs", () => {
    expect(redactText("connect ws://127.0.0.1:4010/ws?token=s3cr3t&pane=1")).toBe(
      `connect ws://127.0.0.1:4010/ws?token=${REDACTED}&pane=1`,
    );
    expect(redactText("GET http://h/x?authToken=abc#frag")).toBe(
      `GET http://h/x?authToken=${REDACTED}#frag`,
    );
    expect(redactText("wss://user:pw@host/ws")).toBe(`wss://${REDACTED}@host/ws`);
  });

  it("redacts key=value credential fragments", () => {
    expect(redactText("authToken=abc123 port=4010")).toBe(`authToken=${REDACTED} port=4010`);
    expect(redactText('token: "abc", other: 1')).toBe(`token: "${REDACTED}", other: 1`);
  });

  it("redacts registered secret literals wherever they appear", () => {
    const secrets = new Set(["hunter2hunter2"]);
    expect(redactText("prefix hunter2hunter2 suffix", secrets)).toBe(`prefix ${REDACTED} suffix`);
  });
});

describe("redactLogValue", () => {
  it("replaces credential keys at any depth and keeps structure", () => {
    const value = redactLogValue({
      port: 4010,
      authToken: "abc",
      headers: { Authorization: "Bearer x", accept: "json" },
      nested: [{ tokens: ["a", "b"] }],
    });
    expect(value).toEqual({
      port: 4010,
      authToken: REDACTED,
      headers: { Authorization: REDACTED, accept: "json" },
      nested: [{ tokens: REDACTED }],
    });
  });

  it("describes errors without leaking credentials", () => {
    const error = new Error("connect failed for ws://h/ws?token=abc");
    const value = redactLogValue(error) as Record<string, unknown>;
    expect(value.name).toBe("Error");
    expect(value.message).toBe(`connect failed for ws://h/ws?token=${REDACTED}`);
  });

  it("marks circular references and depth overruns instead of throwing", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(redactLogValue(loop)).toEqual({ a: 1, self: "[circular]" });
    let deep: unknown = "leaf";
    for (let i = 0; i < 10; i++) deep = { deep };
    expect(JSON.stringify(redactLogValue(deep))).toContain("[depth exceeded]");
  });
});

describe("sanitizeLogPayload", () => {
  it("is deterministic and leaves an in-budget payload intact", () => {
    const a = sanitizeLogPayload({ port: 1, list: [1, 2] });
    const b = sanitizeLogPayload({ port: 1, list: [1, 2] });
    expect(a).toEqual(b);
    expect(a.data).toEqual({ port: 1, list: [1, 2] });
    expect(a.truncated).toBe(false);
    expect(a.renamedKeys).toEqual([]);
  });

  it("renames every reserved key so caller data cannot overwrite identity metadata", () => {
    const data: Record<string, unknown> = {};
    for (const key of RESERVED_LOG_KEYS) data[key] = `caller-${key}`;
    const result = sanitizeLogPayload(data);
    expect(result.renamedKeys).toEqual([...RESERVED_LOG_KEYS]);
    for (const key of RESERVED_LOG_KEYS) {
      expect(result.data).not.toHaveProperty(key);
      expect(result.data).toHaveProperty(`payload_${key}`, `caller-${key}`);
    }
  });

  it("truncates long strings on code points with an explicit marker", () => {
    const long = "é".repeat(3_000); // 2 bytes each → 6000 bytes
    const result = sanitizeLogPayload({ long });
    const kept = result.data!.long as string;
    expect(kept.endsWith("bytes]")).toBe(true);
    expect(Buffer.byteLength(kept, "utf8")).toBeLessThanOrEqual(
      DEFAULT_LOG_BUDGET.maxStringBytes + 40,
    );
    expect(kept.startsWith("é")).toBe(true);
  });

  it("caps container sizes", () => {
    const list = Array.from({ length: 200 }, (_, i) => i);
    const result = sanitizeLogPayload({ list });
    const kept = result.data!.list as unknown[];
    expect(kept).toHaveLength(DEFAULT_LOG_BUDGET.maxContainerSize + 1);
    expect(kept.at(-1)).toBe(`[+${200 - DEFAULT_LOG_BUDGET.maxContainerSize} items]`);
  });

  it("summarizes a payload that exceeds the record byte budget", () => {
    const data: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) data[`k${i}`] = "x".repeat(1_000);
    const result = sanitizeLogPayload(data);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(DEFAULT_LOG_BUDGET.maxDataBytes);
    expect(result.data).toMatchObject({ truncated: true });
    expect((result.data!.keys as string[])[0]).toBe("k0");
    expect(result.data!.droppedBytes).toBeGreaterThan(DEFAULT_LOG_BUDGET.maxDataBytes);
  });

  it("redacts before truncating so a secret never survives at a cut edge", () => {
    const secret = "S3CRET-VALUE-THAT-IS-LONG";
    const result = sanitizeLogPayload(
      { note: `${"a".repeat(50)} token=${secret}` },
      { secrets: new Set([secret]), budget: { ...DEFAULT_LOG_BUDGET, maxStringBytes: 64 } },
    );
    expect(JSON.stringify(result.data)).not.toContain(secret);
    expect(JSON.stringify(result.data)).not.toContain("S3CRET");
  });
});

describe("sanitizeLogMessage", () => {
  it("redacts and bounds messages", () => {
    expect(sanitizeLogMessage("ws://h/ws?token=abc")).toBe(`ws://h/ws?token=${REDACTED}`);
    const long = sanitizeLogMessage("m".repeat(10_000));
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(
      DEFAULT_LOG_BUDGET.maxMessageBytes + 40,
    );
    expect(long).toContain("[truncated");
  });
});
