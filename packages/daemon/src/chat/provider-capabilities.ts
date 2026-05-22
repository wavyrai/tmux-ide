/**
 * G14-T13 / T103 — Provider capability negotiation.
 *
 * Each provider kind declares what features it supports (streaming,
 * tool-calls, vision, prompt-caching, …); the chat layer consults the
 * declared capabilities BEFORE building a request so it can degrade
 * gracefully instead of sending a request the provider will reject.
 *
 * Why a declarative table per kind, not a runtime probe:
 *   - The kinds we ship are well-known (anthropic, openai, ollama,
 *     lm-studio, generic-acp). Their capability sets change on a
 *     provider release cadence (weeks), not a request cadence.
 *   - A probe ("call models endpoint, infer") doubles request latency
 *     and adds a failure mode at the worst time (cold-start of a new
 *     chat). The declared table is the source of truth; users can
 *     override per-instance via `overrides` if they self-host a model
 *     that supports more or less.
 *
 * Mirrors t3's `ProviderRuntime` capabilities surface at
 * `context/t3code/packages/contracts/src/provider.ts` (search for
 * `Capabilities`) — minus the bits that are Anthropic-only quirks
 * we'd never expose to our user-facing settings UI.
 *
 * Crosses into T102: `toolApprovalPolicy` is the recommended starting
 * point for the operator's policy choice on first connect. The
 * ProviderApprovalPolicy (T102) still has the final say at dispatch
 * time — this is just a hint the settings UI surfaces in the "configure
 * provider" flow.
 */

import type { ProviderInstance, ProviderKind } from "@tmux-ide/contracts";

/** Reasoning-effort tier on providers that support thinking budgets. */
export type ReasoningEffort = false | "low" | "medium" | "high";

/** Default policy hint emitted on first connect — operators can override. */
export type CapabilityApprovalHint = "ask" | "auto" | "deny";

export interface ProviderCapabilities {
  /** True when the provider streams text incrementally (SSE or chunked JSON). */
  streaming: boolean;
  /** True when the provider exposes a structured tool-call interface. */
  toolCalls: boolean;
  /** True when the provider accepts image inputs (vision-capable models). */
  vision: boolean;
  /** True when the provider supports server-side prompt-cache markers. */
  promptCaching: boolean;
  /** True when the provider distinguishes a system message from chat history. */
  systemPrompts: boolean;
  /** Reasoning-effort tiers; `false` when the provider has no thinking budget. */
  reasoningEffort: ReasoningEffort;
  /** Context-window size hint; UI uses this for the "remaining tokens" gauge. */
  contextWindowTokens: number;
  /** Maximum output tokens per response. */
  maxOutputTokens: number;
  /**
   * Recommended default approval policy for the operator's first connect.
   * The actual gate at dispatch time runs through `ProviderApprovalPolicy`
   * (T102); this is just a UI hint that pre-fills the toggle.
   */
  toolApprovalPolicy: CapabilityApprovalHint;
}

/**
 * Built-in capability table per ProviderKind. Values are conservative
 * defaults — operators can override per-instance via `overrides` on the
 * `capabilitiesFor(instance, overrides?)` helper.
 *
 * Numbers (`contextWindowTokens`, `maxOutputTokens`) reflect the most
 * common model on each provider as of 2026-Q1; over-aggressive values
 * surface as truncated responses, under-aggressive as wasted context.
 * If you need a higher budget, pass an override at registry time.
 */
export const BUILT_IN_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  anthropic: {
    streaming: true,
    toolCalls: true,
    vision: true,
    promptCaching: true,
    systemPrompts: true,
    reasoningEffort: false,
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    toolApprovalPolicy: "ask",
  },
  openai: {
    streaming: true,
    toolCalls: true,
    vision: true,
    promptCaching: true, // gpt-4o-mini onwards; default to true for the modern lineup
    systemPrompts: true,
    reasoningEffort: "medium", // o1/o3 surface; non-reasoning models ignore
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    toolApprovalPolicy: "ask",
  },
  "local-ollama": {
    streaming: true,
    toolCalls: false, // most local quantized models lack the structured surface
    vision: false,
    promptCaching: false,
    systemPrompts: true,
    reasoningEffort: false,
    contextWindowTokens: 8_192,
    maxOutputTokens: 2_048,
    toolApprovalPolicy: "auto", // local-only — trust by default
  },
  "local-lmstudio": {
    streaming: true,
    toolCalls: false,
    vision: false,
    promptCaching: false,
    systemPrompts: true,
    reasoningEffort: false,
    contextWindowTokens: 8_192,
    maxOutputTokens: 4_096,
    toolApprovalPolicy: "auto",
  },
  "generic-acp": {
    // ACP is a transport, not a provider: the inner agent's capabilities
    // are opaque to the daemon until the binary identifies itself.
    // Start permissive on tool-calls because the whole point of ACP is to
    // run an agent that owns tooling.
    streaming: true,
    toolCalls: true,
    vision: false,
    promptCaching: false,
    systemPrompts: true,
    reasoningEffort: false,
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    toolApprovalPolicy: "ask",
  },
};

/**
 * Per-instance override surface. Operators self-hosting a model that
 * supports more (or less) than the kind's default can register an
 * override at provider-registration time.
 */
export type ProviderCapabilitiesOverride = Partial<ProviderCapabilities>;

/**
 * Resolve capabilities for a provider instance, applying optional
 * per-instance overrides. Pure function — no I/O, no Effect, no async.
 */
export function capabilitiesFor(
  instance: Pick<ProviderInstance, "kind">,
  override?: ProviderCapabilitiesOverride,
): ProviderCapabilities {
  const base = BUILT_IN_CAPABILITIES[instance.kind];
  if (!override || Object.keys(override).length === 0) return base;
  return { ...base, ...override };
}

// ---------------------------------------------------------------------------
// Request negotiation — graceful downgrade
// ---------------------------------------------------------------------------

/**
 * Request features the chat layer wants. A boolean field means "the
 * caller wants this feature"; the negotiator checks whether the
 * provider supports it and drops the request features that can't be
 * served. Output `downgrades` enumerates what was dropped so the
 * settings UI can surface a single "your provider lacks X" toast.
 */
export interface RequestedFeatures {
  /** Caller wants a streamed response (SSE / chunked JSON). */
  streaming?: boolean;
  /** Caller wants the assistant to be able to call tools. */
  toolCalls?: boolean;
  /** Caller has image inputs in `messages`. */
  vision?: boolean;
  /** Caller wants prompt-cache breakpoints. */
  promptCaching?: boolean;
  /** Caller wants the assistant to use a reasoning budget. */
  reasoningEffort?: ReasoningEffort;
  /** Caller wants their request gated through the approval policy with
   *  this hint as the default. The negotiator returns the hint the
   *  provider actually supports (sometimes more restrictive). */
  approvalHint?: CapabilityApprovalHint;
}

/** What was actually granted, after negotiation. */
export interface NegotiatedFeatures {
  streaming: boolean;
  toolCalls: boolean;
  vision: boolean;
  promptCaching: boolean;
  reasoningEffort: ReasoningEffort;
  approvalHint: CapabilityApprovalHint;
}

export type DowngradeKind =
  | "streaming"
  | "toolCalls"
  | "vision"
  | "promptCaching"
  | "reasoningEffort"
  | "approvalHint";

export interface Downgrade {
  feature: DowngradeKind;
  requested: unknown;
  granted: unknown;
  reason: string;
}

export interface NegotiationResult {
  features: NegotiatedFeatures;
  downgrades: ReadonlyArray<Downgrade>;
}

const APPROVAL_RANK: Record<CapabilityApprovalHint, number> = {
  auto: 0, // most permissive
  ask: 1,
  deny: 2, // most restrictive
};

function mostRestrictive(
  requested: CapabilityApprovalHint,
  capability: CapabilityApprovalHint,
): CapabilityApprovalHint {
  return APPROVAL_RANK[requested] >= APPROVAL_RANK[capability] ? requested : capability;
}

/**
 * Negotiate a request against a provider's declared capabilities.
 * Returns the granted feature set + a list of downgrades the caller
 * should surface to the operator. Pure — no Effect, no async.
 *
 * Convention: a `false` / omitted requested feature is never logged as
 * a downgrade; only features the caller explicitly asked for and the
 * provider can't serve count.
 */
export function negotiateRequest(
  capabilities: ProviderCapabilities,
  requested: RequestedFeatures,
): NegotiationResult {
  const downgrades: Downgrade[] = [];

  const wantStreaming = requested.streaming === true;
  const wantToolCalls = requested.toolCalls === true;
  const wantVision = requested.vision === true;
  const wantPromptCaching = requested.promptCaching === true;
  const wantReasoning = requested.reasoningEffort ?? false;

  const grantedStreaming = wantStreaming && capabilities.streaming;
  if (wantStreaming && !capabilities.streaming) {
    downgrades.push({
      feature: "streaming",
      requested: true,
      granted: false,
      reason: "Provider does not support streaming; falling back to one-shot response.",
    });
  }

  const grantedToolCalls = wantToolCalls && capabilities.toolCalls;
  if (wantToolCalls && !capabilities.toolCalls) {
    downgrades.push({
      feature: "toolCalls",
      requested: true,
      granted: false,
      reason:
        "Provider does not expose a tool-call surface; the assistant will reply with text only.",
    });
  }

  const grantedVision = wantVision && capabilities.vision;
  if (wantVision && !capabilities.vision) {
    downgrades.push({
      feature: "vision",
      requested: true,
      granted: false,
      reason: "Provider is text-only; image inputs will be dropped from the request.",
    });
  }

  const grantedPromptCaching = wantPromptCaching && capabilities.promptCaching;
  if (wantPromptCaching && !capabilities.promptCaching) {
    downgrades.push({
      feature: "promptCaching",
      requested: true,
      granted: false,
      reason: "Provider does not honour prompt-cache markers; sending without them.",
    });
  }

  let grantedReasoning: ReasoningEffort = false;
  if (wantReasoning !== false && capabilities.reasoningEffort !== false) {
    grantedReasoning = wantReasoning;
  } else if (wantReasoning !== false && capabilities.reasoningEffort === false) {
    downgrades.push({
      feature: "reasoningEffort",
      requested: wantReasoning,
      granted: false,
      reason: "Provider has no reasoning budget; running without the thinking step.",
    });
  }

  const requestedApproval = requested.approvalHint ?? capabilities.toolApprovalPolicy;
  const grantedApproval = mostRestrictive(requestedApproval, capabilities.toolApprovalPolicy);
  if (grantedApproval !== requestedApproval) {
    downgrades.push({
      feature: "approvalHint",
      requested: requestedApproval,
      granted: grantedApproval,
      reason: `Provider's default approval stance (${capabilities.toolApprovalPolicy}) is more restrictive than requested (${requestedApproval}).`,
    });
  }

  return {
    features: {
      streaming: grantedStreaming,
      toolCalls: grantedToolCalls,
      vision: grantedVision,
      promptCaching: grantedPromptCaching,
      reasoningEffort: grantedReasoning,
      approvalHint: grantedApproval,
    },
    downgrades,
  };
}

// ---------------------------------------------------------------------------
// Service-shaped facade
// ---------------------------------------------------------------------------

export interface MakeProviderCapabilitiesStoreOptions {
  /** Per-instance overrides keyed on `ProviderInstance.id`. */
  overrides?: Record<string, ProviderCapabilitiesOverride>;
}

/**
 * Tiny store the runtime layer wraps. Keeps per-instance overrides
 * in-memory and resolves capabilities on demand. Hot-updates flow
 * through `setOverride(id, override)`.
 */
export interface ProviderCapabilitiesStore {
  forInstance(instance: Pick<ProviderInstance, "id" | "kind">): ProviderCapabilities;
  setOverride(id: string, override: ProviderCapabilitiesOverride): void;
  clearOverride(id: string): boolean;
  getOverride(id: string): ProviderCapabilitiesOverride | null;
  negotiate(
    instance: Pick<ProviderInstance, "id" | "kind">,
    requested: RequestedFeatures,
  ): NegotiationResult;
}

export function makeProviderCapabilitiesStore(
  options: MakeProviderCapabilitiesStoreOptions = {},
): ProviderCapabilitiesStore {
  const overrides = new Map<string, ProviderCapabilitiesOverride>(
    Object.entries(options.overrides ?? {}),
  );
  return {
    forInstance(instance) {
      return capabilitiesFor(instance, overrides.get(instance.id));
    },
    setOverride(id, override) {
      overrides.set(id, override);
    },
    clearOverride(id) {
      return overrides.delete(id);
    },
    getOverride(id) {
      return overrides.get(id) ?? null;
    },
    negotiate(instance, requested) {
      const caps = capabilitiesFor(instance, overrides.get(instance.id));
      return negotiateRequest(caps, requested);
    },
  };
}
