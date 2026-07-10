/**
 * Schema tests for the control-socket protocol (M23.3): the versioned
 * envelope and the per-verb params. These pin the WIRE contract — a change
 * that breaks one of these breaks every connected agent loop.
 */
import { describe, expect, it } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_WAIT_MAX_TIMEOUT_MS,
  agentStatusEventSchema,
  controlEventSchema,
  controlRequestSchema,
  controlResponseSchema,
  restartAgentParamsSchema,
  sendParamsSchema,
  spawnParamsSchema,
  waitParamsSchema,
} from "../control";

describe("controlRequestSchema", () => {
  it("accepts a minimal request (params optional)", () => {
    const r = controlRequestSchema.parse({ v: 1, id: 1, verb: "fleet" });
    expect(r.verb).toBe("fleet");
    expect(r.params).toBeUndefined();
  });

  it("accepts string ids and object params", () => {
    const r = controlRequestSchema.parse({
      v: 1,
      id: "req-7",
      verb: "send",
      params: { session: "s", target: "%1", message: "hi" },
    });
    expect(r.id).toBe("req-7");
  });

  it("keeps verb an OPEN string — unknown verbs parse (dispatch answers them)", () => {
    expect(controlRequestSchema.parse({ v: 1, id: 1, verb: "verb-from-the-future" }).verb).toBe(
      "verb-from-the-future",
    );
  });

  it("rejects a wrong or missing version", () => {
    expect(() => controlRequestSchema.parse({ v: 2, id: 1, verb: "fleet" })).toThrow();
    expect(() => controlRequestSchema.parse({ id: 1, verb: "fleet" })).toThrow();
  });

  it("rejects a missing id or empty verb", () => {
    expect(() => controlRequestSchema.parse({ v: 1, verb: "fleet" })).toThrow();
    expect(() => controlRequestSchema.parse({ v: 1, id: 1, verb: "" })).toThrow();
  });
});

describe("controlResponseSchema", () => {
  it("accepts an ok response with arbitrary data", () => {
    const r = controlResponseSchema.parse({ v: 1, id: 3, ok: true, data: { projects: [] } });
    expect(r.ok).toBe(true);
  });

  it("accepts an error response with a null id (uncorrelatable frame)", () => {
    const r = controlResponseSchema.parse({
      v: 1,
      id: null,
      ok: false,
      error: { code: "bad-request", message: "unparseable frame" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects an error response without the error object", () => {
    expect(() => controlResponseSchema.parse({ v: 1, id: 1, ok: false })).toThrow();
  });
});

describe("controlEventSchema + agentStatusEventSchema", () => {
  it("accepts an event frame and its agent-status payload", () => {
    const frame = controlEventSchema.parse({
      v: CONTROL_PROTOCOL_VERSION,
      event: "agent-status",
      data: { ts: "2026-07-10T12:00:00Z", session: "zz-x", from: null, to: "working" },
    });
    const ev = agentStatusEventSchema.parse(frame.data);
    expect(ev.from).toBeNull();
    expect(ev.to).toBe("working");
  });

  it("rejects an unknown status in the payload", () => {
    expect(() =>
      agentStatusEventSchema.parse({ ts: "t", session: "s", from: null, to: "sleeping" }),
    ).toThrow();
  });
});

describe("waitParamsSchema", () => {
  it("accepts both kinds", () => {
    expect(
      waitParamsSchema.parse({ kind: "agent-status", session: "s", status: "done" }).kind,
    ).toBe("agent-status");
    expect(waitParamsSchema.parse({ kind: "output", target: "%1", match: "ok" }).kind).toBe(
      "output",
    );
  });

  it("caps timeoutMs", () => {
    expect(() =>
      waitParamsSchema.parse({
        kind: "output",
        target: "%1",
        match: "ok",
        timeoutMs: CONTROL_WAIT_MAX_TIMEOUT_MS + 1,
      }),
    ).toThrow();
  });
});

describe("spawnParamsSchema", () => {
  it("requires exactly one of kind/command", () => {
    expect(() => spawnParamsSchema.parse({ session: "s" })).toThrow();
    expect(() => spawnParamsSchema.parse({ session: "s", kind: "claude", command: "x" })).toThrow();
    expect(spawnParamsSchema.parse({ session: "s", kind: "claude" }).kind).toBe("claude");
  });

  it("requires a session or a sessionName", () => {
    expect(() => spawnParamsSchema.parse({ kind: "claude" })).toThrow();
    expect(spawnParamsSchema.parse({ sessionName: "zz-new", kind: "claude" }).sessionName).toBe(
      "zz-new",
    );
  });

  it("requires paneId for split placements only", () => {
    expect(() =>
      spawnParamsSchema.parse({ session: "s", kind: "claude", placement: "split-h" }),
    ).toThrow();
    expect(
      spawnParamsSchema.parse({ session: "s", kind: "claude", placement: "window" }).placement,
    ).toBe("window");
  });
});

describe("sendParamsSchema / restartAgentParamsSchema", () => {
  it("send requires session, target and a non-empty message", () => {
    expect(() => sendParamsSchema.parse({ session: "s", target: "%1", message: "" })).toThrow();
    expect(sendParamsSchema.parse({ session: "s", target: "%1", message: "go" }).noEnter).toBe(
      undefined,
    );
  });

  it("restart requires kind or command", () => {
    expect(() => restartAgentParamsSchema.parse({ paneId: "%1" })).toThrow();
    expect(restartAgentParamsSchema.parse({ paneId: "%1", command: "claude" }).command).toBe(
      "claude",
    );
  });
});
