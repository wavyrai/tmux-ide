/**
 * T079 — Provider registry.
 *
 * Maps a `ProviderKind` to a `ProviderAdapter`. The adapter is the small
 * surface the chat layer needs to drive a single turn end-to-end:
 *
 *   - `sendTurn({ messages, signal })` — submit a user message and get
 *     back a stream of `ProviderEvent`s (text chunks, tool calls,
 *     final-message, error, end-turn).
 *   - `validateConfig(config)` — typed-up-front Zod validation so the
 *     registry never instantiates an adapter with bad inputs.
 *   - `accounting(events)` — pure helper that extracts a `UsagePatch`
 *     from a stream so per-provider token accounting stays separate
 *     from session-level accounting.
 *
 * Built-in adapters: anthropic, openai, local-ollama, local-lmstudio,
 * generic-acp. Each is a thin wrapper around the HTTP API (fetch-based
 * so tests can inject a stub).
 *
 * The registry is ADDITIVE today — thread-manager still uses the legacy
 * `AgentProvider` union for live thread spawning. T080 flips the switch
 * by replacing `Thread.provider: AgentProvider` with
 * `Thread.providerInstanceId: ProviderInstanceId` and resolving against
 * the registry.
 */

import {
  ProviderConfigZ,
  ProviderInstanceZ,
  type AnthropicProviderConfig,
  type GenericAcpProviderConfig,
  type LocalLmStudioProviderConfig,
  type LocalOllamaProviderConfig,
  type OpenAIProviderConfig,
  type ProviderConfig,
  type ProviderInstance,
  type ProviderKind,
} from "@tmux-ide/contracts";
import { capabilitiesFor, type ProviderCapabilities } from "./provider-capabilities.ts";

// ---------------------------------------------------------------------------
// Adapter surface
// ---------------------------------------------------------------------------

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; name: string; input: unknown }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "error"; message: string }
  | { type: "end"; reason: "completed" | "max_tokens" | "refusal" | "cancelled" };

export interface SendTurnInput {
  messages: ReadonlyArray<{ role: "user" | "assistant" | "system"; content: string }>;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly instance: ProviderInstance;
  /**
   * Declared capability surface (T103). The chat layer consults this
   * BEFORE issuing requests so it can degrade gracefully (skip vision,
   * fall back from streaming, drop tool-call hints) instead of sending
   * a request the provider will reject. Defaults come from
   * `BUILT_IN_CAPABILITIES[kind]`; per-instance overrides flow through
   * the `ProviderCapabilitiesStore` (runtime/services.ts).
   */
  readonly capabilities: ProviderCapabilities;
  sendTurn(input: SendTurnInput): AsyncIterable<ProviderEvent>;
}

export interface AdapterFactoryDeps {
  /**
   * Inject a `fetch`-shaped function so tests can swap network calls for
   * stubs. Falls back to `globalThis.fetch` at runtime.
   */
  fetch?: typeof fetch;
}

export type AdapterFactory = (
  instance: ProviderInstance,
  deps?: AdapterFactoryDeps,
) => ProviderAdapter;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ProviderRegistryError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_kind" | "invalid_config" | "instance_not_found" | "duplicate",
  ) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

export interface ProviderRegistry {
  registerKind(kind: ProviderKind, factory: AdapterFactory): void;
  hasKind(kind: ProviderKind): boolean;
  registerInstance(instance: ProviderInstance): void;
  unregisterInstance(id: string): boolean;
  listInstances(): ProviderInstance[];
  getInstance(id: string): ProviderInstance | null;
  adapterFor(id: string, deps?: AdapterFactoryDeps): ProviderAdapter;
  validateConfig(config: unknown): ProviderConfig;
}

export interface MakeProviderRegistryOptions {
  /**
   * Pre-seed factory overrides (e.g. for tests). Anything missing falls
   * back to the built-in adapters defined below.
   */
  factories?: Partial<Record<ProviderKind, AdapterFactory>>;
}

export function makeProviderRegistry(opts: MakeProviderRegistryOptions = {}): ProviderRegistry {
  const factories = new Map<ProviderKind, AdapterFactory>();
  for (const [kind, factory] of Object.entries(BUILT_IN_FACTORIES)) {
    factories.set(kind as ProviderKind, factory);
  }
  for (const [kind, factory] of Object.entries(opts.factories ?? {})) {
    if (factory) factories.set(kind as ProviderKind, factory);
  }
  const instances = new Map<string, ProviderInstance>();

  return {
    registerKind(kind, factory) {
      factories.set(kind, factory);
    },
    hasKind(kind) {
      return factories.has(kind);
    },
    registerInstance(instance) {
      const parsed = ProviderInstanceZ.safeParse(instance);
      if (!parsed.success) {
        throw new ProviderRegistryError(
          `Invalid provider instance: ${parsed.error.message}`,
          "invalid_config",
        );
      }
      if (instances.has(parsed.data.id)) {
        throw new ProviderRegistryError(
          `Provider instance already registered: ${parsed.data.id}`,
          "duplicate",
        );
      }
      instances.set(parsed.data.id, parsed.data);
    },
    unregisterInstance(id) {
      return instances.delete(id);
    },
    listInstances() {
      return [...instances.values()];
    },
    getInstance(id) {
      return instances.get(id) ?? null;
    },
    adapterFor(id, deps) {
      const instance = instances.get(id);
      if (!instance) {
        throw new ProviderRegistryError(`Provider instance not found: ${id}`, "instance_not_found");
      }
      const factory = factories.get(instance.kind);
      if (!factory) {
        throw new ProviderRegistryError(
          `No adapter registered for provider kind: ${instance.kind}`,
          "unknown_kind",
        );
      }
      return factory(instance, deps);
    },
    validateConfig(config) {
      const parsed = ProviderConfigZ.safeParse(config);
      if (!parsed.success) {
        throw new ProviderRegistryError(
          `Invalid provider config: ${parsed.error.message}`,
          "invalid_config",
        );
      }
      return parsed.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Built-in adapters — fetch-based stubs. They're intentionally small;
// real production adapters can swap in the official SDKs (e.g.
// @anthropic-ai/sdk, openai) without changing the registry surface.
// Tests inject `deps.fetch` so they never hit the network.
// ---------------------------------------------------------------------------

function resolveFetch(deps: AdapterFactoryDeps | undefined): typeof fetch {
  const candidate = deps?.fetch ?? globalThis.fetch;
  if (!candidate) {
    throw new ProviderRegistryError(
      "No fetch implementation available — pass deps.fetch in test or run on Node 18+.",
      "invalid_config",
    );
  }
  return candidate;
}

function makeAnthropicAdapter(
  instance: ProviderInstance,
  deps?: AdapterFactoryDeps,
): ProviderAdapter {
  const config = instance.config as AnthropicProviderConfig;
  return {
    kind: "anthropic",
    instance,
    capabilities: capabilitiesFor(instance),
    async *sendTurn({ messages, signal }) {
      const fetchFn = resolveFetch(deps);
      const url = `${config.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
      const res = await fetchFn(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 4096,
          messages: messages.filter((m) => m.role !== "system"),
          system: messages.find((m) => m.role === "system")?.content,
        }),
      });
      if (!res.ok) {
        yield { type: "error", message: `Anthropic ${res.status}: ${await safeText(res)}` };
        yield { type: "end", reason: "refusal" };
        return;
      }
      const body = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        stop_reason?: string;
      };
      for (const block of body.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") {
          yield { type: "text", text: block.text };
        }
      }
      if (body.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: body.usage.input_tokens,
            outputTokens: body.usage.output_tokens,
          },
        };
      }
      yield { type: "end", reason: mapStopReason(body.stop_reason) };
    },
  };
}

function makeOpenAIAdapter(instance: ProviderInstance, deps?: AdapterFactoryDeps): ProviderAdapter {
  const config = instance.config as OpenAIProviderConfig;
  return {
    kind: "openai",
    instance,
    capabilities: capabilitiesFor(instance),
    async *sendTurn({ messages, signal }) {
      const fetchFn = resolveFetch(deps);
      const url = `${config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      };
      if (config.organization) headers["openai-organization"] = config.organization;
      const res = await fetchFn(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({ model: config.model, messages }),
      });
      if (!res.ok) {
        yield { type: "error", message: `OpenAI ${res.status}: ${await safeText(res)}` };
        yield { type: "end", reason: "refusal" };
        return;
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      if (choice?.message?.content) {
        yield { type: "text", text: choice.message.content };
      }
      if (body.usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: body.usage.prompt_tokens,
            outputTokens: body.usage.completion_tokens,
          },
        };
      }
      yield { type: "end", reason: mapStopReason(choice?.finish_reason) };
    },
  };
}

function makeOllamaAdapter(instance: ProviderInstance, deps?: AdapterFactoryDeps): ProviderAdapter {
  const config = instance.config as LocalOllamaProviderConfig;
  return {
    kind: "local-ollama",
    instance,
    capabilities: capabilitiesFor(instance),
    async *sendTurn({ messages, signal }) {
      const fetchFn = resolveFetch(deps);
      const url = `${config.baseUrl}/api/chat`;
      const res = await fetchFn(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: config.model, messages, stream: false }),
      });
      if (!res.ok) {
        yield { type: "error", message: `Ollama ${res.status}: ${await safeText(res)}` };
        yield { type: "end", reason: "refusal" };
        return;
      }
      const body = (await res.json()) as {
        message?: { content?: string };
        eval_count?: number;
        prompt_eval_count?: number;
        done_reason?: string;
      };
      if (body.message?.content) yield { type: "text", text: body.message.content };
      if (body.eval_count !== undefined || body.prompt_eval_count !== undefined) {
        yield {
          type: "usage",
          usage: {
            inputTokens: body.prompt_eval_count,
            outputTokens: body.eval_count,
          },
        };
      }
      yield { type: "end", reason: mapStopReason(body.done_reason) };
    },
  };
}

function makeLmStudioAdapter(
  instance: ProviderInstance,
  deps?: AdapterFactoryDeps,
): ProviderAdapter {
  // LM Studio exposes an OpenAI-compatible API on /v1/chat/completions.
  const config = instance.config as LocalLmStudioProviderConfig;
  const openAiInstance: ProviderInstance = {
    ...instance,
    kind: "openai",
    config: {
      kind: "openai",
      apiKey: config.apiKey ?? "lm-studio",
      model: config.model,
      baseUrl: config.baseUrl,
    },
  };
  const inner = makeOpenAIAdapter(openAiInstance, deps);
  return {
    ...inner,
    kind: "local-lmstudio",
    instance,
    capabilities: capabilitiesFor(instance),
  };
}

function makeGenericAcpAdapter(instance: ProviderInstance): ProviderAdapter {
  const config = instance.config as GenericAcpProviderConfig;
  return {
    kind: "generic-acp",
    instance,
    capabilities: capabilitiesFor(instance),
    async *sendTurn() {
      // The actual ACP transport lives in packages/daemon/src/acp; this
      // adapter is the registry's stub for the generic-ACP case. T080
      // wires the real spawn-and-pipe path. Until then we just surface a
      // clear "not yet wired" error so callers can detect it.
      yield {
        type: "error",
        message: `Generic ACP adapter not yet wired (binary=${config.binary}). Wired in T080.`,
      };
      yield { type: "end", reason: "refusal" };
    },
  };
}

const BUILT_IN_FACTORIES: Record<ProviderKind, AdapterFactory> = {
  anthropic: makeAnthropicAdapter,
  openai: makeOpenAIAdapter,
  "local-ollama": makeOllamaAdapter,
  "local-lmstudio": makeLmStudioAdapter,
  "generic-acp": (instance) => makeGenericAcpAdapter(instance),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function mapStopReason(raw: unknown): "completed" | "max_tokens" | "refusal" | "cancelled" {
  if (typeof raw !== "string") return "completed";
  const lower = raw.toLowerCase();
  if (lower === "max_tokens" || lower === "length") return "max_tokens";
  if (lower === "refusal" || lower === "stopped") return "refusal";
  if (lower === "cancelled" || lower === "aborted") return "cancelled";
  return "completed";
}

/**
 * Aggregate `usage` events from a provider stream into a single
 * UsagePatch-shaped delta. Pure function — drives per-provider
 * accounting independent of session-level totals.
 */
export function accountingFromEvents(events: Iterable<ProviderEvent>): {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd?: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd: number | undefined;
  for (const e of events) {
    if (e.type !== "usage") continue;
    if (e.usage.inputTokens !== undefined) inputTokens += e.usage.inputTokens;
    if (e.usage.outputTokens !== undefined) outputTokens += e.usage.outputTokens;
    if (e.usage.totalCostUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + e.usage.totalCostUsd;
    }
  }
  const out: { inputTokens: number; outputTokens: number; totalCostUsd?: number } = {
    inputTokens,
    outputTokens,
  };
  if (totalCostUsd !== undefined) out.totalCostUsd = totalCostUsd;
  return out;
}
