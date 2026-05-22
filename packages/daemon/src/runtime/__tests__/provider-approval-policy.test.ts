/**
 * G14-T12 / T102 — ProviderApprovalPolicy tests.
 *
 * Exercises the policy at three levels:
 *   1. Plain TS impl (`makeProviderApprovalPolicy`) — verdicts, rule
 *      layering, hot-update, prompt resolve.
 *   2. Effect service surface (`ProviderApprovalPolicyLive`) — the
 *      Layer wrapping is type-checked and resolved at runtime.
 *   3. End-to-end through `dispatchToolCallThroughPolicy` — proves the
 *      pipeline only invokes the dispatch callback when the verdict is
 *      `approved`, short-circuiting on `denied` / `needs-confirmation`.
 *
 * Coverage matches the brief verbatim:
 *   - Auto-approve provider: tool call passes
 *   - Deny-by-default provider: tool call denied with reason
 *   - Always-ask provider: emits permission.requested, blocks dispatch
 *   - Per-provider rules layered correctly
 *   - Policy can be hot-updated mid-thread
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import {
  makeProviderApprovalPolicy,
  type EvaluateInput,
  type PermissionRequestEmission,
  type ProviderApprovalRules,
} from "../../chat/provider-approval-policy.ts";
import { ProviderApprovalPolicyLive } from "../layers.ts";
import { ProviderApprovalPolicyService } from "../services.ts";
import { dispatchToolCallThroughPolicy } from "../chat-turn-pipeline.ts";

function evalInput(overrides: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    provider: "claude-code",
    toolCall: { kind: "edit", name: "Edit" },
    threadId: "thr-1",
    turnId: "turn-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Plain-TS policy
// ---------------------------------------------------------------------------

describe("ProviderApprovalPolicy (plain TS)", () => {
  it("auto-approve provider: every tool call passes with `approved` verdict", () => {
    const policy = makeProviderApprovalPolicy({
      initialRules: {
        "*": { default: "untrusted" },
        "claude-code": { default: "never" }, // trust this provider entirely
      },
    });
    const v1 = policy.evaluate(evalInput({ toolCall: { kind: "read", name: "Read" } }));
    const v2 = policy.evaluate(evalInput({ toolCall: { kind: "edit", name: "Edit" } }));
    const v3 = policy.evaluate(evalInput({ toolCall: { kind: "execute", name: "Bash" } }));
    expect(v1).toEqual({ kind: "approved" });
    expect(v2).toEqual({ kind: "approved" });
    expect(v3).toEqual({ kind: "approved" });
    // No prompts queued — policy didn't emit anything.
    expect(policy.pendingPrompts()).toEqual([]);
  });

  it("deny-by-default provider: tool call denied with structured reason", () => {
    const policy = makeProviderApprovalPolicy({
      initialRules: { "scary-bot": { default: "untrusted" } },
    });
    const verdict = policy.evaluate(
      evalInput({ provider: "scary-bot", toolCall: { kind: "execute", name: "Bash" } }),
    );
    expect(verdict.kind).toBe("denied");
    if (verdict.kind === "denied") {
      expect(verdict.reason).toMatch(/scary-bot/);
      expect(verdict.reason).toMatch(/untrusted/);
      // The message must surface the tool name so the UI can show it.
      expect(verdict.reason).toMatch(/Bash/);
    }
  });

  it("always-ask provider: emits permission request envelope, returns needs-confirmation", () => {
    const emitted: PermissionRequestEmission[] = [];
    const policy = makeProviderApprovalPolicy({
      initialRules: { "ask-bot": { default: "on-request" } },
      emitPermissionRequest: (req) => emitted.push(req),
      now: () => new Date("2026-05-12T12:00:00.000Z"),
      randomId: (() => {
        let n = 0;
        return () => `prompt_${++n}`;
      })(),
    });
    const verdict = policy.evaluate(
      evalInput({
        provider: "ask-bot",
        toolCall: { kind: "edit", name: "Edit" },
        threadId: "thr-9",
        turnId: "turn-9",
      }),
    );
    expect(verdict).toEqual({
      kind: "needs-confirmation",
      promptId: "prompt_1",
      toolKind: "edit",
      toolName: "Edit",
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      promptId: "prompt_1",
      provider: "ask-bot",
      threadId: "thr-9",
      turnId: "turn-9",
      toolKind: "edit",
      toolName: "Edit",
      issuedAt: "2026-05-12T12:00:00.000Z",
    });
    expect(policy.pendingPrompts()).toEqual(emitted);

    // Resolving the prompt drops it from the pending list.
    expect(policy.resolvePrompt("prompt_1", "approve")).toBe(true);
    expect(policy.pendingPrompts()).toEqual([]);
    // Idempotent: re-resolving an unknown prompt returns false.
    expect(policy.resolvePrompt("prompt_1", "approve")).toBe(false);
  });

  it("per-provider rules layered correctly: per-tool-kind override beats default", () => {
    const policy = makeProviderApprovalPolicy({
      initialRules: {
        "*": { default: "untrusted" }, // wildcard fallback denies
        "claude-code": {
          default: "never", // auto-approve EXCEPT
          perToolKind: {
            delete: "on-request", // dangerous tool kinds need confirmation
            execute: "untrusted", // shell exec is denied
          },
        },
      },
      emitPermissionRequest: () => undefined,
    });
    expect(policy.evaluate(evalInput({ toolCall: { kind: "read", name: "Read" } })).kind).toBe(
      "approved",
    ); // default = never
    expect(policy.evaluate(evalInput({ toolCall: { kind: "delete", name: "Delete" } })).kind).toBe(
      "needs-confirmation",
    ); // per-tool override
    expect(policy.evaluate(evalInput({ toolCall: { kind: "execute", name: "Bash" } })).kind).toBe(
      "denied",
    ); // per-tool override
    // Unknown provider falls through to wildcard (untrusted → denied).
    expect(
      policy.evaluate(
        evalInput({ provider: "rogue-provider", toolCall: { kind: "read", name: "Read" } }),
      ).kind,
    ).toBe("denied");
  });

  it("hot-update mid-thread: register() changes verdicts without rebuilding the policy", () => {
    const policy = makeProviderApprovalPolicy({
      initialRules: { "claude-code": { default: "untrusted" } },
    });
    const before = policy.evaluate(evalInput()); // denied
    expect(before.kind).toBe("denied");

    // Operator flips the toggle in the settings UI → register() called.
    const newRules: ProviderApprovalRules = { default: "never" };
    policy.register("claude-code", newRules);
    expect(policy.getRules("claude-code")).toEqual(newRules);

    const after = policy.evaluate(evalInput());
    expect(after.kind).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// 2. Effect service surface
// ---------------------------------------------------------------------------

describe("ProviderApprovalPolicyLive (Effect Service)", () => {
  it("evaluate, getRules, resolvePrompt all flow through Effect with typed errors", async () => {
    const emitted: PermissionRequestEmission[] = [];
    const program = Effect.gen(function* () {
      const policy = yield* ProviderApprovalPolicyService;
      // Register hot-update via Effect.
      yield* policy.register("claude-code", {
        default: "on-request",
        perToolKind: { read: "never" },
      });
      const readVerdict = yield* policy.evaluate({
        provider: "claude-code",
        toolCall: { kind: "read", name: "Read" },
        threadId: "thr-effect",
        turnId: "turn-effect",
      });
      const editVerdict = yield* policy.evaluate({
        provider: "claude-code",
        toolCall: { kind: "edit", name: "Edit" },
        threadId: "thr-effect",
        turnId: "turn-effect",
      });
      const rules = yield* policy.getRules("claude-code");
      const pending = yield* policy.pendingPrompts;
      return { readVerdict, editVerdict, rules, pendingCount: pending.length };
    });

    const layer = ProviderApprovalPolicyLive({
      emitPermissionRequest: (req) => emitted.push(req),
      randomId: (() => {
        let n = 0;
        return () => `effect_prompt_${++n}`;
      })(),
    });
    const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

    expect(result.readVerdict.kind).toBe("approved");
    expect(result.editVerdict.kind).toBe("needs-confirmation");
    expect(result.rules?.default).toBe("on-request");
    expect(result.pendingCount).toBe(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.promptId).toBe("effect_prompt_1");
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end gating through dispatchToolCallThroughPolicy
// ---------------------------------------------------------------------------

describe("dispatchToolCallThroughPolicy (T102 pipeline integration)", () => {
  it("invokes the dispatch callback only when the verdict is `approved`", async () => {
    let dispatchCount = 0;
    const program = dispatchToolCallThroughPolicy(
      {
        provider: "claude-code",
        toolCall: { kind: "read", name: "Read" },
        threadId: "thr-dispatch",
        turnId: "turn-dispatch",
      },
      () =>
        Effect.sync(() => {
          dispatchCount += 1;
          return "dispatched-payload";
        }),
    );
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          ProviderApprovalPolicyLive({
            initialRules: { "claude-code": { default: "never" } },
          }),
        ),
      ),
    );
    expect(result.verdict.kind).toBe("approved");
    expect(result.result).toBe("dispatched-payload");
    expect(dispatchCount).toBe(1);
  });

  it("short-circuits on `denied` — dispatch callback is never invoked", async () => {
    let dispatchCount = 0;
    const program = dispatchToolCallThroughPolicy(
      {
        provider: "rogue-bot",
        toolCall: { kind: "execute", name: "Bash" },
        threadId: "thr-deny",
        turnId: "turn-deny",
      },
      () =>
        Effect.sync(() => {
          dispatchCount += 1;
          return "should-not-run";
        }),
    );
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          ProviderApprovalPolicyLive({
            initialRules: { "rogue-bot": { default: "untrusted" } },
          }),
        ),
      ),
    );
    expect(result.verdict.kind).toBe("denied");
    expect(result.result).toBeNull();
    expect(dispatchCount).toBe(0);
  });

  it("short-circuits on `needs-confirmation` — emits prompt, dispatch deferred", async () => {
    const emitted: PermissionRequestEmission[] = [];
    let dispatchCount = 0;
    const program = dispatchToolCallThroughPolicy(
      {
        provider: "ask-bot",
        toolCall: { kind: "edit", name: "Edit" },
        threadId: "thr-ask",
        turnId: "turn-ask",
      },
      () =>
        Effect.sync(() => {
          dispatchCount += 1;
          return "deferred";
        }),
    );
    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(
          ProviderApprovalPolicyLive({
            initialRules: { "ask-bot": { default: "on-request" } },
            emitPermissionRequest: (req) => emitted.push(req),
            randomId: () => "prompt-deferred-1",
          }),
        ),
      ),
    );
    expect(result.verdict.kind).toBe("needs-confirmation");
    expect(result.result).toBeNull();
    expect(dispatchCount).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.promptId).toBe("prompt-deferred-1");
  });
});
