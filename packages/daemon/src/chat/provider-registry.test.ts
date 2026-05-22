/**
 * T079 — provider-registry unit tests + integration scenarios.
 *
 * Adapters are mocked via the `deps.fetch` injection; no real network
 * calls. The integration scenarios cover the acceptance scenarios spelled
 * out in the task brief (a)–(f).
 */

import { describe, expect, it } from "vitest";
import type {
  AnthropicProviderConfig,
  LocalLmStudioProviderConfig,
  LocalOllamaProviderConfig,
  OpenAIProviderConfig,
  ProviderInstance,
} from "@tmux-ide/contracts";
import {
  accountingFromEvents,
  makeProviderRegistry,
  ProviderRegistryError,
  type ProviderAdapter,
  type ProviderEvent,
} from "./provider-registry.ts";

const NOW = "2026-05-11T10:00:00.000Z";

function anthropicConfig(
  overrides: Partial<AnthropicProviderConfig> = {},
): AnthropicProviderConfig {
  return {
    kind: "anthropic",
    apiKey: "sk-ant-test",
    model: "claude-opus-4-7",
    ...overrides,
  };
}

function openaiConfig(overrides: Partial<OpenAIProviderConfig> = {}): OpenAIProviderConfig {
  return { kind: "openai", apiKey: "sk-openai-test", model: "gpt-4o", ...overrides };
}

function ollamaConfig(
  overrides: Partial<LocalOllamaProviderConfig> = {},
): LocalOllamaProviderConfig {
  return {
    kind: "local-ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen2.5-coder",
    ...overrides,
  };
}

function lmStudioConfig(
  overrides: Partial<LocalLmStudioProviderConfig> = {},
): LocalLmStudioProviderConfig {
  return {
    kind: "local-lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-coder",
    ...overrides,
  };
}

function instance(id: string, kind: ProviderInstance["kind"], config: unknown): ProviderInstance {
  return {
    id,
    kind,
    displayName: id,
    config: config as ProviderInstance["config"],
    createdAt: NOW,
  };
}

function makeFakeFetch(
  reply: { ok?: boolean; status?: number; json: unknown },
  observer?: { calls: Array<{ url: string; init?: RequestInit }> },
): typeof fetch {
  const json = reply.json;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    observer?.calls.push({ url: String(url), init });
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      async json() {
        return json;
      },
      async text() {
        return JSON.stringify(json);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

async function collect(
  adapter: ProviderAdapter,
  messages: ReadonlyArray<{ role: "user" | "assistant" | "system"; content: string }>,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const e of adapter.sendTurn({ messages })) events.push(e);
  return events;
}

// ---------------------------------------------------------------------------
// Registry surface — unit tests
// ---------------------------------------------------------------------------

describe("provider-registry: kind + instance management", () => {
  it("ships built-in factories for all 5 kinds", () => {
    const reg = makeProviderRegistry();
    expect(reg.hasKind("anthropic")).toBe(true);
    expect(reg.hasKind("openai")).toBe(true);
    expect(reg.hasKind("local-ollama")).toBe(true);
    expect(reg.hasKind("local-lmstudio")).toBe(true);
    expect(reg.hasKind("generic-acp")).toBe(true);
  });

  it("registerInstance accepts a valid ProviderInstance", () => {
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("a1", "anthropic", anthropicConfig()));
    expect(reg.getInstance("a1")?.kind).toBe("anthropic");
  });

  it("registerInstance rejects an invalid shape via Zod parse", () => {
    const reg = makeProviderRegistry();
    expect(() =>
      reg.registerInstance({
        id: "bad",
        kind: "anthropic",
        displayName: "bad",
        // missing required apiKey
        config: { kind: "anthropic", model: "x" } as never,
      }),
    ).toThrow(ProviderRegistryError);
  });

  it("registerInstance rejects duplicate ids", () => {
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("dup", "anthropic", anthropicConfig()));
    expect(() => reg.registerInstance(instance("dup", "anthropic", anthropicConfig()))).toThrow(
      /duplicate|already/i,
    );
  });

  it("unregisterInstance removes the instance and returns true", () => {
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("a1", "anthropic", anthropicConfig()));
    expect(reg.unregisterInstance("a1")).toBe(true);
    expect(reg.getInstance("a1")).toBeNull();
  });

  it("listInstances returns the registered set", () => {
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("a1", "anthropic", anthropicConfig()));
    reg.registerInstance(instance("o1", "openai", openaiConfig()));
    expect(
      reg
        .listInstances()
        .map((i) => i.id)
        .sort(),
    ).toEqual(["a1", "o1"]);
  });

  it("adapterFor on a missing id throws instance_not_found", () => {
    const reg = makeProviderRegistry();
    expect(() => reg.adapterFor("missing")).toThrow(ProviderRegistryError);
  });

  it("validateConfig parses well-formed configs without throwing", () => {
    const reg = makeProviderRegistry();
    expect(reg.validateConfig(anthropicConfig()).kind).toBe("anthropic");
    expect(reg.validateConfig(openaiConfig()).kind).toBe("openai");
    expect(reg.validateConfig(ollamaConfig()).kind).toBe("local-ollama");
    expect(reg.validateConfig(lmStudioConfig()).kind).toBe("local-lmstudio");
  });

  it("validateConfig rejects unknown kinds", () => {
    const reg = makeProviderRegistry();
    expect(() => reg.validateConfig({ kind: "xyz" } as never)).toThrow(/Invalid provider config/);
  });

  it("validateConfig defaults Ollama baseUrl when omitted", () => {
    const reg = makeProviderRegistry();
    const parsed = reg.validateConfig({
      kind: "local-ollama",
      model: "qwen2.5-coder",
    } as never);
    if (parsed.kind === "local-ollama") {
      expect(parsed.baseUrl).toBe("http://127.0.0.1:11434");
    } else {
      throw new Error("expected local-ollama kind");
    }
  });

  it("registerKind allows overriding a built-in factory (test seam)", () => {
    const overridden: ProviderAdapter = {
      kind: "anthropic",
      instance: instance("a1", "anthropic", anthropicConfig()),
      async *sendTurn() {
        yield { type: "text", text: "overridden" };
        yield { type: "end", reason: "completed" };
      },
    };
    const reg = makeProviderRegistry();
    reg.registerKind("anthropic", () => overridden);
    reg.registerInstance(instance("a1", "anthropic", anthropicConfig()));
    expect(reg.adapterFor("a1")).toBe(overridden);
  });
});

// ---------------------------------------------------------------------------
// Per-adapter happy-path tests via mocked fetch
// ---------------------------------------------------------------------------

describe("anthropic adapter (mocked)", () => {
  it("posts to /v1/messages with x-api-key + parses content blocks", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = makeFakeFetch(
      {
        json: {
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 12, output_tokens: 34 },
          stop_reason: "end_turn",
        },
      },
      { calls },
    );
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("a1", "anthropic", anthropicConfig()));
    const adapter = reg.adapterFor("a1", { fetch: fetchFn });
    const events = await collect(adapter, [{ role: "user", content: "hi" }]);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "hello" });
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 12, outputTokens: 34 },
    });
  });

  it("surfaces non-OK HTTP as a `type: error` event followed by `type: end`", async () => {
    const fetchFn = makeFakeFetch({ ok: false, status: 401, json: { error: "unauthorized" } });
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("a1", "anthropic", anthropicConfig()));
    const events = await collect(reg.adapterFor("a1", { fetch: fetchFn }), [
      { role: "user", content: "hi" },
    ]);
    expect(events[0]?.type).toBe("error");
    expect(events.at(-1)).toEqual({ type: "end", reason: "refusal" });
  });
});

describe("openai adapter (mocked)", () => {
  it("posts to /chat/completions with Bearer auth + parses choices[0]", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = makeFakeFetch(
      {
        json: {
          choices: [{ message: { content: "from openai" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 9 },
        },
      },
      { calls },
    );
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("o1", "openai", openaiConfig()));
    const events = await collect(reg.adapterFor("o1", { fetch: fetchFn }), [
      { role: "user", content: "hi" },
    ]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-openai-test");
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "from openai" });
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 5, outputTokens: 9 },
    });
  });
});

describe("local-ollama adapter (mocked)", () => {
  it("posts to <baseUrl>/api/chat and extracts message.content + eval counts", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = makeFakeFetch(
      {
        json: {
          message: { content: "from ollama" },
          eval_count: 42,
          prompt_eval_count: 7,
          done_reason: "stop",
        },
      },
      { calls },
    );
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("ol1", "local-ollama", ollamaConfig()));
    const events = await collect(reg.adapterFor("ol1", { fetch: fetchFn }), [
      { role: "user", content: "hi" },
    ]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "from ollama" });
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 7, outputTokens: 42 },
    });
  });
});

describe("local-lmstudio adapter (mocked)", () => {
  it("delegates to the OpenAI-shaped endpoint with a synthesised api key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = makeFakeFetch(
      {
        json: {
          choices: [{ message: { content: "from lmstudio" }, finish_reason: "stop" }],
        },
      },
      { calls },
    );
    const reg = makeProviderRegistry();
    reg.registerInstance(instance("lm1", "local-lmstudio", lmStudioConfig()));
    const events = await collect(reg.adapterFor("lm1", { fetch: fetchFn }), [
      { role: "user", content: "hi" },
    ]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(events.find((e) => e.type === "text")).toEqual({
      type: "text",
      text: "from lmstudio",
    });
  });
});

describe("generic-acp adapter", () => {
  it("emits a clear 'not yet wired' error until T080 lands", async () => {
    const reg = makeProviderRegistry();
    reg.registerInstance(
      instance("acp1", "generic-acp", {
        kind: "generic-acp",
        binary: "/tmp/agent-bin",
        args: [],
      }),
    );
    const events = await collect(reg.adapterFor("acp1"), [{ role: "user", content: "hi" }]);
    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") expect(events[0].message).toMatch(/not yet wired/i);
  });
});

// ---------------------------------------------------------------------------
// accountingFromEvents — per-provider usage roll-up
// ---------------------------------------------------------------------------

describe("accountingFromEvents", () => {
  it("sums input/output across multiple usage events", () => {
    const out = accountingFromEvents([
      { type: "usage", usage: { inputTokens: 5, outputTokens: 10 } },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 7 } },
      { type: "end", reason: "completed" },
    ]);
    expect(out).toEqual({ inputTokens: 8, outputTokens: 17 });
  });

  it("aggregates cost when provided", () => {
    const out = accountingFromEvents([
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalCostUsd: 0.01 } },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalCostUsd: 0.02 } },
    ]);
    expect(out.totalCostUsd).toBeCloseTo(0.03, 5);
  });

  it("returns zeros when no usage events are emitted", () => {
    const out = accountingFromEvents([{ type: "text", text: "no usage" }]);
    expect(out).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

// ---------------------------------------------------------------------------
// Integration scenarios — (a)–(f) from the task brief
// ---------------------------------------------------------------------------

describe("provider-abstraction integration scenarios", () => {
  function mockAdapterEmitting(events: ProviderEvent[], inst: ProviderInstance): ProviderAdapter {
    return {
      kind: inst.kind,
      instance: inst,
      async *sendTurn() {
        for (const e of events) yield e;
      },
    };
  }

  it("(a) thread starts with anthropic provider → turn completes", async () => {
    const inst = instance("a1", "anthropic", anthropicConfig());
    const reg = makeProviderRegistry({
      factories: {
        anthropic: () =>
          mockAdapterEmitting(
            [
              { type: "text", text: "hi" },
              { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
              { type: "end", reason: "completed" },
            ],
            inst,
          ),
      },
    });
    reg.registerInstance(inst);
    const events = await collect(reg.adapterFor("a1"), [{ role: "user", content: "hi" }]);
    expect(events.at(-1)).toEqual({ type: "end", reason: "completed" });
  });

  it("(b) switch provider mid-thread — second turn uses new adapter", async () => {
    const a = instance("a1", "anthropic", anthropicConfig());
    const o = instance("o1", "openai", openaiConfig());
    const reg = makeProviderRegistry({
      factories: {
        anthropic: () =>
          mockAdapterEmitting(
            [
              { type: "text", text: "anthropic" },
              { type: "end", reason: "completed" },
            ],
            a,
          ),
        openai: () =>
          mockAdapterEmitting(
            [
              { type: "text", text: "openai" },
              { type: "end", reason: "completed" },
            ],
            o,
          ),
      },
    });
    reg.registerInstance(a);
    reg.registerInstance(o);
    const turn1 = await collect(reg.adapterFor("a1"), [{ role: "user", content: "first" }]);
    const turn2 = await collect(reg.adapterFor("o1"), [{ role: "user", content: "second" }]);
    expect(turn1.find((e) => e.type === "text")).toEqual({ type: "text", text: "anthropic" });
    expect(turn2.find((e) => e.type === "text")).toEqual({ type: "text", text: "openai" });
  });

  it("(c) provider config validation rejects invalid configs via Zod parse", () => {
    const reg = makeProviderRegistry();
    expect(() =>
      reg.validateConfig({ kind: "anthropic", model: "claude-opus-4-7" } as never),
    ).toThrow(ProviderRegistryError);
    expect(() => reg.validateConfig({ kind: "openai", apiKey: "sk-x" } as never)).toThrow(
      ProviderRegistryError,
    );
  });

  it("(d) provider-not-found surfaces a typed error suitable for turn-aborted", () => {
    const reg = makeProviderRegistry();
    try {
      reg.adapterFor("nope");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderRegistryError);
      if (err instanceof ProviderRegistryError) {
        expect(err.code).toBe("instance_not_found");
      }
    }
  });

  it("(e) local provider (mocked) round-trips a turn", async () => {
    const inst = instance("ol1", "local-ollama", ollamaConfig());
    const reg = makeProviderRegistry({
      factories: {
        "local-ollama": () =>
          mockAdapterEmitting(
            [
              { type: "text", text: "local ok" },
              { type: "usage", usage: { inputTokens: 4, outputTokens: 8 } },
              { type: "end", reason: "completed" },
            ],
            inst,
          ),
      },
    });
    reg.registerInstance(inst);
    const events = await collect(reg.adapterFor("ol1"), [{ role: "user", content: "hi" }]);
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "local ok" });
    expect(accountingFromEvents(events)).toEqual({ inputTokens: 4, outputTokens: 8 });
  });

  it("(f) per-provider token usage is computed independently of session", async () => {
    const a = instance("a1", "anthropic", anthropicConfig());
    const o = instance("o1", "openai", openaiConfig());
    const reg = makeProviderRegistry({
      factories: {
        anthropic: () =>
          mockAdapterEmitting(
            [
              { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } },
              { type: "end", reason: "completed" },
            ],
            a,
          ),
        openai: () =>
          mockAdapterEmitting(
            [
              { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
              { type: "end", reason: "completed" },
            ],
            o,
          ),
      },
    });
    reg.registerInstance(a);
    reg.registerInstance(o);
    const usageA = accountingFromEvents(await collect(reg.adapterFor("a1"), []));
    const usageO = accountingFromEvents(await collect(reg.adapterFor("o1"), []));
    expect(usageA).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(usageO).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
