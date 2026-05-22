/**
 * G14-T13 / T103 — Provider capability negotiation tests.
 *
 * Coverage matches the brief:
 *   - Each capability flag's gate logic
 *   - Multi-provider scenarios (capabilities differ in the same thread)
 *   - Graceful downgrade (chat still works when the provider lacks a feature)
 *
 * Layered like T102: plain-TS unit tests for the core logic, plus a
 * runtime test that confirms ProviderCapabilitiesLive resolves through
 * Effect with the right types.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import type { ProviderInstance } from "@tmux-ide/contracts";

import {
  BUILT_IN_CAPABILITIES,
  capabilitiesFor,
  makeProviderCapabilitiesStore,
  negotiateRequest,
  type ProviderCapabilities,
  type RequestedFeatures,
} from "../provider-capabilities.ts";
import { ProviderCapabilitiesLive } from "../../runtime/layers.ts";
import { ProviderCapabilitiesService } from "../../runtime/services.ts";

function instance(id: string, kind: ProviderInstance["kind"]): ProviderInstance {
  return {
    id,
    kind,
    displayName: `Test ${kind}`,
    config:
      kind === "anthropic"
        ? { kind: "anthropic", apiKey: "k", model: "claude" }
        : kind === "openai"
          ? { kind: "openai", apiKey: "k", model: "gpt-4o" }
          : kind === "local-ollama"
            ? { kind: "local-ollama", baseUrl: "http://127.0.0.1:11434", model: "llama3" }
            : kind === "local-lmstudio"
              ? { kind: "local-lmstudio", baseUrl: "http://127.0.0.1:1234/v1", model: "qwen" }
              : { kind: "generic-acp", binary: "/usr/local/bin/foo", args: [] },
  };
}

// ---------------------------------------------------------------------------
// 1. Capability tables — built-in defaults per kind
// ---------------------------------------------------------------------------

describe("ProviderCapabilities — built-in defaults", () => {
  it("anthropic claims streaming + tool-calls + vision + prompt-caching + system prompts", () => {
    const caps = BUILT_IN_CAPABILITIES.anthropic;
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalls).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.promptCaching).toBe(true);
    expect(caps.systemPrompts).toBe(true);
    expect(caps.contextWindowTokens).toBeGreaterThanOrEqual(100_000);
    expect(caps.toolApprovalPolicy).toBe("ask");
  });

  it("openai matches anthropic on streaming/tool/vision and exposes reasoning effort", () => {
    const caps = BUILT_IN_CAPABILITIES.openai;
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalls).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.promptCaching).toBe(true);
    expect(caps.reasoningEffort).not.toBe(false); // o1/o3 surface
  });

  it("local-ollama is conservative — streaming yes, tool-calls + vision + caching no", () => {
    const caps = BUILT_IN_CAPABILITIES["local-ollama"];
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalls).toBe(false);
    expect(caps.vision).toBe(false);
    expect(caps.promptCaching).toBe(false);
    // Local providers default to "auto" — trust by default since they're
    // on-device.
    expect(caps.toolApprovalPolicy).toBe("auto");
  });

  it("local-lmstudio mirrors ollama's permissive local-only stance", () => {
    const caps = BUILT_IN_CAPABILITIES["local-lmstudio"];
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalls).toBe(false);
    expect(caps.toolApprovalPolicy).toBe("auto");
  });

  it("generic-acp claims tool-calls (ACP is a tooling transport) but not vision or caching", () => {
    const caps = BUILT_IN_CAPABILITIES["generic-acp"];
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalls).toBe(true);
    expect(caps.vision).toBe(false);
    expect(caps.promptCaching).toBe(false);
    expect(caps.toolApprovalPolicy).toBe("ask");
  });

  it("capabilitiesFor applies per-instance overrides on top of the kind defaults", () => {
    const claudeWithMoreOutput = capabilitiesFor(instance("c1", "anthropic"), {
      maxOutputTokens: 64_000,
    });
    expect(claudeWithMoreOutput.maxOutputTokens).toBe(64_000);
    // Other fields untouched.
    expect(claudeWithMoreOutput.streaming).toBe(true);
    expect(claudeWithMoreOutput.toolCalls).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Negotiation — each flag's gate logic + downgrades
// ---------------------------------------------------------------------------

describe("negotiateRequest — graceful downgrade", () => {
  it("requesting only supported features grants everything with no downgrades", () => {
    const caps = BUILT_IN_CAPABILITIES.anthropic;
    const result = negotiateRequest(caps, {
      streaming: true,
      toolCalls: true,
      vision: true,
      promptCaching: true,
    });
    expect(result.downgrades).toEqual([]);
    expect(result.features.streaming).toBe(true);
    expect(result.features.toolCalls).toBe(true);
    expect(result.features.vision).toBe(true);
    expect(result.features.promptCaching).toBe(true);
  });

  it("vision request against a text-only provider is dropped with a reason", () => {
    const caps = BUILT_IN_CAPABILITIES["local-ollama"];
    const result = negotiateRequest(caps, { vision: true, streaming: true });
    expect(result.features.streaming).toBe(true);
    expect(result.features.vision).toBe(false);
    const vision = result.downgrades.find((d) => d.feature === "vision");
    expect(vision).toBeTruthy();
    expect(vision!.reason).toMatch(/text-only/i);
  });

  it("tool-calls request against a non-tool provider falls back to text-only", () => {
    const caps = BUILT_IN_CAPABILITIES["local-lmstudio"];
    const result = negotiateRequest(caps, { toolCalls: true });
    expect(result.features.toolCalls).toBe(false);
    expect(result.downgrades.map((d) => d.feature)).toContain("toolCalls");
  });

  it("streaming request against a non-streaming provider downgrades to one-shot", () => {
    const synthetic: ProviderCapabilities = {
      ...BUILT_IN_CAPABILITIES.anthropic,
      streaming: false,
    };
    const result = negotiateRequest(synthetic, { streaming: true });
    expect(result.features.streaming).toBe(false);
    expect(result.downgrades.map((d) => d.feature)).toContain("streaming");
  });

  it("prompt-caching request against a non-caching provider drops the markers", () => {
    const caps = BUILT_IN_CAPABILITIES["local-ollama"];
    const result = negotiateRequest(caps, { promptCaching: true });
    expect(result.features.promptCaching).toBe(false);
    expect(result.downgrades.map((d) => d.feature)).toContain("promptCaching");
  });

  it("reasoning request against a non-reasoning provider runs without the thinking step", () => {
    const caps = BUILT_IN_CAPABILITIES.anthropic; // reasoningEffort: false
    const result = negotiateRequest(caps, { reasoningEffort: "high" });
    expect(result.features.reasoningEffort).toBe(false);
    const down = result.downgrades.find((d) => d.feature === "reasoningEffort");
    expect(down).toBeTruthy();
    expect(down!.requested).toBe("high");
  });

  it("approval-hint downgrades to the more-restrictive of (requested, capability)", () => {
    // Provider defaults to "auto" (trust); caller wants "auto" — granted.
    const localCaps = BUILT_IN_CAPABILITIES["local-ollama"];
    const r1 = negotiateRequest(localCaps, { approvalHint: "auto" });
    expect(r1.features.approvalHint).toBe("auto");
    expect(r1.downgrades).toEqual([]);

    // Provider defaults to "ask"; caller wants "auto" — capability wins
    // (more restrictive) and the downgrade is logged.
    const claudeCaps = BUILT_IN_CAPABILITIES.anthropic;
    const r2 = negotiateRequest(claudeCaps, { approvalHint: "auto" });
    expect(r2.features.approvalHint).toBe("ask");
    expect(r2.downgrades.map((d) => d.feature)).toContain("approvalHint");
  });

  it("omitted requested features never count as downgrades", () => {
    // Caller doesn't ask for vision → no downgrade even though the
    // provider lacks it.
    const caps = BUILT_IN_CAPABILITIES["local-ollama"];
    const result = negotiateRequest(caps, { streaming: true });
    expect(result.downgrades.map((d) => d.feature)).not.toContain("vision");
    expect(result.downgrades.map((d) => d.feature)).not.toContain("toolCalls");
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-provider thread — capabilities differ per instance
// ---------------------------------------------------------------------------

describe("multi-provider thread — store + per-instance resolution", () => {
  it("two providers in one thread negotiate independently", () => {
    const store = makeProviderCapabilitiesStore();
    const claudeInstance = instance("c1", "anthropic");
    const ollamaInstance = instance("o1", "local-ollama");

    // Same request goes to both providers; the dashboard adapts each
    // turn's request payload from the negotiation result.
    const request: RequestedFeatures = {
      streaming: true,
      toolCalls: true,
      vision: true,
    };

    const claudeResult = store.negotiate(claudeInstance, request);
    const ollamaResult = store.negotiate(ollamaInstance, request);

    expect(claudeResult.features.toolCalls).toBe(true);
    expect(claudeResult.features.vision).toBe(true);
    expect(claudeResult.downgrades).toEqual([]);

    expect(ollamaResult.features.toolCalls).toBe(false);
    expect(ollamaResult.features.vision).toBe(false);
    expect(ollamaResult.downgrades.map((d) => d.feature).sort()).toEqual(["toolCalls", "vision"]);
  });

  it("per-instance overrides apply only to the target instance", () => {
    const store = makeProviderCapabilitiesStore();
    const a = instance("a1", "openai");
    const b = instance("b1", "openai");
    // Override instance `a` only — disable vision so it acts like a
    // text-only deployment.
    store.setOverride("a1", { vision: false });
    expect(store.forInstance(a).vision).toBe(false);
    expect(store.forInstance(b).vision).toBe(true);
    expect(store.getOverride("a1")).toEqual({ vision: false });
    expect(store.getOverride("b1")).toBeNull();
    expect(store.clearOverride("a1")).toBe(true);
    expect(store.forInstance(a).vision).toBe(true);
  });

  it("graceful downgrade: chat-layer caller can build a request from the negotiation result", () => {
    // Simulates the chat layer's flow:
    //   1. Caller declares what it WANTS in messages (image + tools).
    //   2. Negotiation strips features the provider can't serve.
    //   3. Caller builds the actual request body using `features`.
    const store = makeProviderCapabilitiesStore();
    const inst = instance("ollama-prod", "local-ollama");
    const result = store.negotiate(inst, {
      streaming: true,
      toolCalls: true,
      vision: true,
      promptCaching: true,
    });

    // Simulated request build — only flags from `features` survive.
    const body = {
      stream: result.features.streaming,
      tool_choice: result.features.toolCalls ? "auto" : "none",
      include_images: result.features.vision,
      cache_control: result.features.promptCaching ? "ephemeral" : undefined,
    };

    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe("none");
    expect(body.include_images).toBe(false);
    expect(body.cache_control).toBeUndefined();
    // Downgrades are surfaced so the UI can show "ollama doesn't support
    // tool-calls / vision / caching — assistant ran in text-only mode".
    expect(result.downgrades.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Effect service surface
// ---------------------------------------------------------------------------

describe("ProviderCapabilitiesLive (Effect Service)", () => {
  it("forInstance / setOverride / negotiate all resolve through Effect", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* ProviderCapabilitiesService;
      const baseClaude = yield* svc.forInstance({ id: "c1", kind: "anthropic" });
      yield* svc.setOverride("c1", { vision: false });
      const overridden = yield* svc.forInstance({ id: "c1", kind: "anthropic" });
      const negotiation = yield* svc.negotiate({ id: "c1", kind: "anthropic" }, { vision: true });
      const override = yield* svc.getOverride("c1");
      const cleared = yield* svc.clearOverride("c1");
      return { baseClaude, overridden, negotiation, override, cleared };
    });

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(ProviderCapabilitiesLive())),
    );

    expect(result.baseClaude.vision).toBe(true);
    expect(result.overridden.vision).toBe(false);
    expect(result.negotiation.features.vision).toBe(false);
    expect(result.negotiation.downgrades.map((d) => d.feature)).toContain("vision");
    expect(result.override).toEqual({ vision: false });
    expect(result.cleared).toBe(true);
  });
});
