/**
 * G14-T12 / T102 — ProviderApprovalPolicy.
 *
 * Typed tool-call gating per provider, consulted by the chat-turn
 * pipeline BEFORE any tool call is dispatched. Modelled on t3's policy
 * literals (`untrusted` / `on-failure` / `on-request` / `never`) but
 * collapsed for our daemon to a 3-state verdict the reactor can act on
 * synchronously:
 *
 *   - `approved`             → dispatch the tool call
 *   - `denied {reason}`      → drop the call; surface the reason
 *   - `needs-confirmation`   → block, emit a permission request via the
 *                              existing PermissionCoordinator, resume
 *                              once the user clicks an option
 *
 * Why plain TS, not Effect?
 *   - The contract surface (packages/contracts) MUST stay Effect-free.
 *     This file is the canonical implementation; the Effect Service in
 *     runtime/services.ts wraps it so Effect callers get a typed shape
 *     without leaking `effect` into HTTP/IPC code (schema-at-edge).
 *   - Rules registration / hot-update is a synchronous Map mutation —
 *     dressing it as `Effect.sync` would obscure that.
 *
 * Rule layering (mirrors t3's per-tool-per-policy table):
 *   - Provider declares a base `default` verdict ("untrusted" =
 *     deny-by-default, "on-request" = always-ask, "never" = auto-approve,
 *     "on-failure" = approve unless a prior call failed — we treat this
 *     as `always-ask` for now; surface as TODO).
 *   - Provider declares per-tool-kind overrides for the 9 ToolKind values
 *     (read / edit / delete / move / search / execute / think / fetch /
 *     switch_mode). A `delete` tool can require confirmation even when
 *     the rest auto-approve.
 *   - A wildcard provider entry under the key `"*"` provides the fallback
 *     rules when no per-provider entry is registered.
 *
 * Hot-update:
 *   - `register(provider, rules)` is intentionally idempotent + last-write-
 *     wins. The chat-v2 settings UI calls it whenever the operator flips a
 *     toggle; no daemon restart needed.
 */

import type { ToolKind } from "../acp/schema.ts";

/** Coarse per-provider default. Mirrors t3's ProviderApprovalPolicy literals. */
export type ProviderApprovalLevel =
  /** Deny by default. Every tool call returns `denied` unless overridden. */
  | "untrusted"
  /** Ask the user (`needs-confirmation`) unless overridden. */
  | "on-request"
  /**
   * Ask only when a prior call from the same turn failed; otherwise
   * approve. Implemented as `on-request` for now — recovering the
   * per-turn failure history requires the reactor channel (G14-T10).
   */
  | "on-failure"
  /** Auto-approve every call. The "trusted local-only" stance. */
  | "never";

/** Per-tool-kind override, layered on top of the provider default. */
export type ProviderApprovalRules = {
  default: ProviderApprovalLevel;
  /** Override the default for specific tool kinds. */
  perToolKind?: Partial<Record<ToolKind, ProviderApprovalLevel>>;
};

/** Wildcard provider key — used as the fallback when no provider-specific
 *  entry is registered. */
export const WILDCARD_PROVIDER = "*";

/** Input passed to `evaluate`. Kept narrow so the policy never accidentally
 *  reaches into the rest of the chat state. */
export interface EvaluateInput {
  /** Provider key — typically the ProviderInstance id, e.g. "claude-code". */
  provider: string;
  toolCall: {
    /** ACP tool kind. Drives per-tool overrides. */
    kind: ToolKind;
    /** Free-form tool name (e.g. "Bash", "Read"). Surfaced in the
     *  permission prompt so operators see what they're approving. */
    name: string;
  };
  threadId: string;
  turnId: string;
}

/** The verdict the policy hands back to the dispatch path. */
export type ApprovalVerdict =
  | { readonly kind: "approved" }
  | { readonly kind: "denied"; readonly reason: string }
  | {
      readonly kind: "needs-confirmation";
      readonly promptId: string;
      readonly toolName: string;
      readonly toolKind: ToolKind;
    };

/**
 * Outbound side-effect surface — the policy emits a `permission.requested`
 * event when the verdict is `needs-confirmation`. The bus already knows
 * how to render this; the chat-v2 UI's existing permission-prompt panel
 * handles it. The shape is intentionally narrow (no Effect / no busEvent
 * type) so the policy stays standalone-testable.
 */
export interface PermissionRequestEmission {
  readonly promptId: string;
  readonly provider: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly toolKind: ToolKind;
  readonly toolName: string;
  readonly issuedAt: string;
}

export interface ProviderApprovalPolicy {
  /** Returns the verdict for a tool call. Side-effect: when the verdict is
   *  `needs-confirmation`, the supplied `emitPermissionRequest` callback
   *  fires synchronously with the prompt envelope. */
  evaluate(input: EvaluateInput): ApprovalVerdict;
  /** Last-write-wins for a provider's rules. Trigger via the settings UI
   *  or by replaying provider-config events. */
  register(provider: string, rules: ProviderApprovalRules): void;
  /** Read-only inspection. Useful in tests and in the eventual
   *  `/api/providers/:name/policy` debug endpoint. */
  getRules(provider: string): ProviderApprovalRules | null;
  /** Resolve a previously-issued permission prompt. Returns `true` when
   *  the prompt existed and was decided; `false` if unknown / already
   *  resolved. */
  resolvePrompt(promptId: string, decision: "approve" | "deny", reason?: string): boolean;
  /** Snapshot of currently-pending prompt envelopes. */
  pendingPrompts(): ReadonlyArray<PermissionRequestEmission>;
}

export interface MakeProviderApprovalPolicyOptions {
  /** Initial provider rules. The wildcard entry under `"*"` is mandatory;
   *  the constructor seeds a safe default (`untrusted`) when absent so a
   *  brand-new daemon never auto-approves anything. */
  initialRules?: Record<string, ProviderApprovalRules>;
  /** Side-effect callback for the `needs-confirmation` path. Production
   *  wires this to the existing `PermissionCoordinator.request(...)` so
   *  the prompt flows through the same WS pipe the UI already listens to.
   *  Tests pass a recorder. */
  emitPermissionRequest?: (req: PermissionRequestEmission) => void;
  /** Inject a clock for deterministic `issuedAt` in tests. */
  now?: () => Date;
  /** ID generator for prompt ids. */
  randomId?: () => string;
}

const DEFAULT_WILDCARD: ProviderApprovalRules = { default: "untrusted" };

function pickLevel(rules: ProviderApprovalRules, kind: ToolKind): ProviderApprovalLevel {
  return rules.perToolKind?.[kind] ?? rules.default;
}

function nextPromptId(randomId?: () => string): string {
  if (randomId) return randomId();
  // Don't require crypto in this module so tests can run in restricted
  // environments — the random id is just a correlation handle.
  return `prompt_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

export function makeProviderApprovalPolicy(
  options: MakeProviderApprovalPolicyOptions = {},
): ProviderApprovalPolicy {
  const rulesByProvider = new Map<string, ProviderApprovalRules>();
  const emit = options.emitPermissionRequest ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId;

  // Seed initial rules. The wildcard entry is enforced — if the caller
  // didn't supply one, fall back to `untrusted` so first boot is safe.
  for (const [provider, rules] of Object.entries(options.initialRules ?? {})) {
    rulesByProvider.set(provider, rules);
  }
  if (!rulesByProvider.has(WILDCARD_PROVIDER)) {
    rulesByProvider.set(WILDCARD_PROVIDER, DEFAULT_WILDCARD);
  }

  const pending = new Map<string, PermissionRequestEmission>();

  function resolveLevel(provider: string, kind: ToolKind): ProviderApprovalLevel {
    const specific = rulesByProvider.get(provider);
    if (specific) {
      const direct = specific.perToolKind?.[kind];
      if (direct) return direct;
      return specific.default;
    }
    const wildcard = rulesByProvider.get(WILDCARD_PROVIDER) ?? DEFAULT_WILDCARD;
    return pickLevel(wildcard, kind);
  }

  return {
    evaluate(input) {
      const level = resolveLevel(input.provider, input.toolCall.kind);
      if (level === "never") {
        return { kind: "approved" };
      }
      if (level === "untrusted") {
        return {
          kind: "denied",
          reason:
            `Tool "${input.toolCall.name}" (kind=${input.toolCall.kind}) is denied by the ` +
            `"${input.provider}" provider's approval policy (default: untrusted). ` +
            `Update the provider rules via Settings → Providers to enable it.`,
        };
      }
      // on-request + on-failure both surface as needs-confirmation today.
      // on-failure will tighten to "only ask on prior failure" once the
      // reactor (G14-T10) exposes per-turn failure state.
      const promptId = nextPromptId(randomId);
      const emission: PermissionRequestEmission = {
        promptId,
        provider: input.provider,
        threadId: input.threadId,
        turnId: input.turnId,
        toolKind: input.toolCall.kind,
        toolName: input.toolCall.name,
        issuedAt: now().toISOString(),
      };
      pending.set(promptId, emission);
      emit(emission);
      return {
        kind: "needs-confirmation",
        promptId,
        toolKind: input.toolCall.kind,
        toolName: input.toolCall.name,
      };
    },

    register(provider, rules) {
      rulesByProvider.set(provider, rules);
    },

    getRules(provider) {
      return rulesByProvider.get(provider) ?? null;
    },

    resolvePrompt(promptId, _decision, _reason) {
      // Decision is recorded by the caller (PermissionCoordinator); the
      // policy only needs to drop the pending entry so `pendingPrompts()`
      // stays accurate. Future hooks (audit, metrics) plug in here.
      const existed = pending.delete(promptId);
      return existed;
    },

    pendingPrompts() {
      return [...pending.values()];
    },
  };
}
