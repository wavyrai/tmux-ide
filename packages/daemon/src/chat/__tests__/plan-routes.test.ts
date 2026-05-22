/**
 * Plan-approve-execute REST routes — Zod request-body parse tests.
 *
 * These tests exercise the schemas exported from @tmux-ide/contracts that
 * the Hono handlers use via `zValidator("json", …)`. They do not stand
 * up the full HTTP server; the integration suite covers the end-to-end
 * flow against the chat harness.
 */

import { describe, expect, it } from "vitest";
import {
  PlanApproveBodyZ,
  PlanRejectBodyZ,
  PlanListResponseZ,
  PlanApproveResponseZ,
  PlanRejectResponseZ,
  routes,
} from "@tmux-ide/contracts";

describe("PlanApproveBodyZ", () => {
  it("accepts an empty body — runtimeMode is optional", () => {
    expect(PlanApproveBodyZ.parse({})).toEqual({});
  });

  it("accepts a body with a valid runtimeMode", () => {
    const result = PlanApproveBodyZ.parse({ runtimeMode: "auto-accept-edits" });
    expect(result.runtimeMode).toBe("auto-accept-edits");
  });

  it("rejects an invalid runtimeMode", () => {
    const parsed = PlanApproveBodyZ.safeParse({ runtimeMode: "nope" });
    expect(parsed.success).toBe(false);
  });
});

describe("PlanRejectBodyZ", () => {
  it("accepts an empty body — reason is optional", () => {
    expect(PlanRejectBodyZ.parse({})).toEqual({});
  });

  it("accepts a body with a reason string", () => {
    const result = PlanRejectBodyZ.parse({ reason: "wrong direction" });
    expect(result.reason).toBe("wrong direction");
  });

  it("rejects an empty reason string (trimmed min 1)", () => {
    const parsed = PlanRejectBodyZ.safeParse({ reason: "   " });
    expect(parsed.success).toBe(false);
  });

  it("rejects reasons over 2000 characters", () => {
    const parsed = PlanRejectBodyZ.safeParse({ reason: "x".repeat(2001) });
    expect(parsed.success).toBe(false);
  });
});

describe("Plan response schemas", () => {
  it("PlanListResponseZ accepts an empty plans array", () => {
    expect(PlanListResponseZ.parse({ plans: [] })).toEqual({ plans: [] });
  });

  it("PlanApproveResponseZ requires plan + turnId", () => {
    const parsed = PlanApproveResponseZ.safeParse({ turnId: "t" });
    expect(parsed.success).toBe(false);
  });

  it("PlanRejectResponseZ shape — { plan }", () => {
    const parsed = PlanRejectResponseZ.safeParse({});
    expect(parsed.success).toBe(false);
  });
});

describe("Route registry — plan endpoints", () => {
  it("registers GET /api/threads/:threadId/plans", () => {
    expect(routes["threads.plans.list"]).toBeDefined();
    expect(routes["threads.plans.list"].method).toBe("GET");
    expect(routes["threads.plans.list"].path).toBe("/api/threads/:threadId/plans");
  });

  it("registers POST approve + reject endpoints", () => {
    expect(routes["threads.plans.approve"].method).toBe("POST");
    expect(routes["threads.plans.approve"].path).toBe(
      "/api/threads/:threadId/plans/:planId/approve",
    );
    expect(routes["threads.plans.reject"].method).toBe("POST");
    expect(routes["threads.plans.reject"].path).toBe("/api/threads/:threadId/plans/:planId/reject");
  });
});
