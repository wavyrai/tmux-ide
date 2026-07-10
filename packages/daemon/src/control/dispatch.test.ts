/**
 * Dispatch: every failure mode is an ANSWER (a response frame), never a
 * throw — plus routing, params passthrough, and the subscribe context.
 */
import { describe, expect, it } from "vitest";
import { IdeError } from "../lib/errors.ts";
import { ControlVerbError, dispatchLine, type VerbContext } from "./dispatch.ts";

const ctx: VerbContext = { subscribe: () => {} };

describe("dispatchLine", () => {
  it("answers unparseable JSON with bad-request and a null id", async () => {
    const res = await dispatchLine("not json", {}, ctx);
    expect(res).toMatchObject({ v: 1, id: null, ok: false, error: { code: "bad-request" } });
  });

  it("answers a bad envelope with bad-request, recovering the id when possible", async () => {
    const res = await dispatchLine('{"id":42,"verb":"fleet"}', {}, ctx); // missing v
    expect(res).toMatchObject({ id: 42, ok: false, error: { code: "bad-request" } });
  });

  it("answers an unknown verb honestly", async () => {
    const res = await dispatchLine('{"v":1,"id":1,"verb":"launch-missiles"}', {}, ctx);
    expect(res).toMatchObject({ id: 1, ok: false, error: { code: "unknown-verb" } });
  });

  it("routes to the handler and wraps its return in an ok envelope", async () => {
    const res = await dispatchLine(
      '{"v":1,"id":"a","verb":"echo","params":{"x":1}}',
      { echo: (params) => ({ got: params }) },
      ctx,
    );
    expect(res).toEqual({ v: 1, id: "a", ok: true, data: { got: { x: 1 } } });
  });

  it("defaults missing params to an empty object", async () => {
    let seen: unknown;
    await dispatchLine(
      '{"v":1,"id":1,"verb":"echo"}',
      {
        echo: (params) => {
          seen = params;
          return null;
        },
      },
      ctx,
    );
    expect(seen).toEqual({});
  });

  it("maps ControlVerbError to its code", async () => {
    const res = await dispatchLine(
      '{"v":1,"id":1,"verb":"w"}',
      {
        w: () => {
          throw new ControlVerbError("timeout", "took too long");
        },
      },
      ctx,
    );
    expect(res).toMatchObject({ ok: false, error: { code: "timeout", message: "took too long" } });
  });

  it("maps IdeError codes: USAGE → bad-request, others → not-found", async () => {
    const usage = await dispatchLine(
      '{"v":1,"id":1,"verb":"u"}',
      {
        u: () => {
          throw new IdeError("bad usage", { code: "USAGE" });
        },
      },
      ctx,
    );
    expect(usage).toMatchObject({ ok: false, error: { code: "bad-request" } });

    const missing = await dispatchLine(
      '{"v":1,"id":1,"verb":"m"}',
      {
        m: () => {
          throw new IdeError("no such session", { code: "SESSION_NOT_FOUND" });
        },
      },
      ctx,
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "not-found" } });
  });

  it("maps an unexpected throw to internal", async () => {
    const res = await dispatchLine(
      '{"v":1,"id":1,"verb":"boom"}',
      {
        boom: () => {
          throw new Error("nope");
        },
      },
      ctx,
    );
    expect(res).toMatchObject({ ok: false, error: { code: "internal", message: "nope" } });
  });

  it("hands the verb context through (subscribe)", async () => {
    let flipped = false;
    const res = await dispatchLine(
      '{"v":1,"id":1,"verb":"subscribe"}',
      { subscribe: (_p, c) => (c.subscribe(), { subscribed: true }) },
      { subscribe: () => (flipped = true) },
    );
    expect(flipped).toBe(true);
    expect(res).toMatchObject({ ok: true, data: { subscribed: true } });
  });
});
