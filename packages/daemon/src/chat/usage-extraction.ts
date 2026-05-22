/**
 * Token-usage extraction & merging helpers. Pure functions — extracted
 * from thread-manager.ts so the manager can stay focused on session
 * lifecycle while these helpers carry the provider-specific decoding of
 * usage telemetry off the ACP/Codex wire.
 */

import type { ChatThreadUsageSummary } from "./types.ts";

export interface UsagePatch {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
  tokensAreCumulative?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(source[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function costUsd(value: unknown): number | undefined {
  if (numberValue(value) !== undefined) return numberValue(value);
  if (!isRecord(value)) return undefined;
  const amount =
    firstNumber(value, ["totalCostUsd", "total_cost_usd", "costUsd", "cost_usd", "amount"]) ??
    undefined;
  const currency = typeof value.currency === "string" ? value.currency.toUpperCase() : "USD";
  return amount !== undefined && currency === "USD" ? amount : undefined;
}

export function extractTokenUsage(value: unknown, tokensAreCumulative = false): UsagePatch | null {
  if (!isRecord(value)) return null;

  const total = isRecord(value.total) ? value.total : null;
  if (total) {
    return {
      inputTokens: firstNumber(total, ["inputTokens", "input_tokens"]),
      outputTokens: firstNumber(total, ["outputTokens", "output_tokens"]),
      cacheReadTokens: firstNumber(total, [
        "cachedInputTokens",
        "cacheReadTokens",
        "cache_read_tokens",
      ]),
      cacheWriteTokens: firstNumber(total, ["cacheWriteTokens", "cache_write_tokens"]),
      contextWindowMaxTokens: firstNumber(value, ["modelContextWindow", "contextWindowMaxTokens"]),
      contextWindowUsedTokens: firstNumber(total, [
        "totalTokens",
        "total_tokens",
        "contextWindowUsedTokens",
      ]),
      tokensAreCumulative: true,
    };
  }

  const patch: UsagePatch = {
    inputTokens: firstNumber(value, ["inputTokens", "input_tokens", "promptTokens"]),
    outputTokens: firstNumber(value, [
      "outputTokens",
      "output_tokens",
      "completionTokens",
      "reasoningOutputTokens",
    ]),
    cacheReadTokens: firstNumber(value, [
      "cacheReadTokens",
      "cache_read_tokens",
      "cachedInputTokens",
      "cache_read_input_tokens",
    ]),
    cacheWriteTokens: firstNumber(value, [
      "cacheWriteTokens",
      "cache_write_tokens",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ]),
    contextWindowMaxTokens: firstNumber(value, [
      "contextWindowMaxTokens",
      "context_window_max_tokens",
      "modelContextWindow",
      "size",
    ]),
    contextWindowUsedTokens: firstNumber(value, [
      "contextWindowUsedTokens",
      "context_window_used_tokens",
      "used",
      "totalTokens",
      "total_tokens",
    ]),
    totalCostUsd:
      costUsd(value.cost) ?? costUsd(value.totalCostUsd) ?? costUsd(value.total_cost_usd),
    ...(tokensAreCumulative ? { tokensAreCumulative: true } : {}),
  };

  return [
    patch.inputTokens,
    patch.outputTokens,
    patch.cacheReadTokens,
    patch.cacheWriteTokens,
    patch.totalCostUsd,
    patch.contextWindowMaxTokens,
    patch.contextWindowUsedTokens,
  ].some((candidate) => candidate !== undefined)
    ? patch
    : null;
}

export function mergeUsage(
  previous: ChatThreadUsageSummary | undefined,
  patch: UsagePatch,
): ChatThreadUsageSummary {
  const addOrSet = (current: number | undefined, next: number | undefined): number | undefined => {
    if (next === undefined) return current;
    return patch.tokensAreCumulative ? next : (current ?? 0) + next;
  };
  const merged: ChatThreadUsageSummary = {
    inputTokens: addOrSet(previous?.inputTokens, patch.inputTokens) ?? previous?.inputTokens ?? 0,
    outputTokens:
      addOrSet(previous?.outputTokens, patch.outputTokens) ?? previous?.outputTokens ?? 0,
  };
  const cacheReadTokens = addOrSet(previous?.cacheReadTokens, patch.cacheReadTokens);
  const cacheWriteTokens = addOrSet(previous?.cacheWriteTokens, patch.cacheWriteTokens);
  if (cacheReadTokens !== undefined) merged.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) merged.cacheWriteTokens = cacheWriteTokens;
  if (patch.totalCostUsd !== undefined) merged.totalCostUsd = patch.totalCostUsd;
  else if (previous?.totalCostUsd !== undefined) merged.totalCostUsd = previous.totalCostUsd;
  if (patch.contextWindowMaxTokens !== undefined) {
    merged.contextWindowMaxTokens = patch.contextWindowMaxTokens;
  } else if (previous?.contextWindowMaxTokens !== undefined) {
    merged.contextWindowMaxTokens = previous.contextWindowMaxTokens;
  }
  if (patch.contextWindowUsedTokens !== undefined) {
    merged.contextWindowUsedTokens = patch.contextWindowUsedTokens;
  } else if (previous?.contextWindowUsedTokens !== undefined) {
    merged.contextWindowUsedTokens = previous.contextWindowUsedTokens;
  }
  return merged;
}

export function usageChanged(
  left: ChatThreadUsageSummary | undefined,
  right: ChatThreadUsageSummary,
): boolean {
  return JSON.stringify(left ?? null) !== JSON.stringify(right);
}

export function extractUsagePatch(value: unknown): UsagePatch | null {
  if (!isRecord(value)) return null;
  if (value.sessionUpdate === "usage_update") {
    const patch = extractTokenUsage(value);
    const usd = costUsd(value.cost);
    if (!patch && usd === undefined) return null;
    return { ...(patch ?? {}), ...(usd !== undefined ? { totalCostUsd: usd } : {}) };
  }

  for (const candidate of [
    value.usage,
    value.tokenUsage,
    value.tokens,
    isRecord(value._meta) ? value._meta.usage : undefined,
    isRecord(value._meta) ? value._meta.tokenUsage : undefined,
    isRecord(value._meta) ? value._meta.tokens : undefined,
  ]) {
    const patch = extractTokenUsage(candidate);
    if (patch) return patch;
  }

  const usd =
    costUsd(value.cost) ?? (isRecord(value._meta) ? costUsd(value._meta.cost) : undefined);
  return usd !== undefined ? { totalCostUsd: usd } : null;
}
