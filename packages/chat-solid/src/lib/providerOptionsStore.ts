/**
 * Per-thread × provider-kind × model provider-options cache.
 *
 * Mirrors `modelSelectionStore`: the daemon owns the authoritative
 * per-turn semantics (it remembers the last-used in-memory and falls
 * back to the model's defaultReasoningEffort) — this client store is
 * a UX cache so the picker rehydrates the user's effort + fast-mode
 * choice after a reload and so `useChatThread.send()` can attach
 * `providerOptions` to the action call.
 *
 * Keyed by `${threadId}::${providerKind}::${modelSlug}` because the
 * effort surface is model-specific: switching from `gpt-5.4` to
 * `gpt-5.3-codex-spark` should NOT carry the old selection — each
 * model has its own catalogue.
 *
 * Canonical t3 array shape: `Array<{id, value}>` (see
 * `context/t3code/packages/contracts/src/model.ts:49-53`). No legacy
 * object compat — we adopt the array shape from day one.
 */

const STORAGE_KEY = "tmux-ide:chat:provider-options:v1";

export interface ProviderOptionSelection {
  id: string;
  value: string | boolean;
}

interface OptionsMap {
  [key: string]: ProviderOptionSelection[];
}

function hasStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readAll(): OptionsMap {
  if (!hasStorage()) return {};
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: OptionsMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const entries: ProviderOptionSelection[] = [];
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const id = (item as { id?: unknown }).id;
        const v = (item as { value?: unknown }).value;
        if (typeof id !== "string" || id.length === 0) continue;
        if (typeof v === "string" && v.length > 0) entries.push({ id, value: v });
        else if (typeof v === "boolean") entries.push({ id, value: v });
      }
      if (entries.length > 0) out[key] = entries;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(map: OptionsMap): void {
  if (!hasStorage()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / storage disabled — selection degrades to session-only.
  }
}

function compositeKey(threadId: string, providerKind: string, modelSlug: string): string {
  return `${threadId}::${providerKind}::${modelSlug}`;
}

export function loadProviderOptions(
  threadId: string,
  providerKind: string,
  modelSlug: string,
): ProviderOptionSelection[] {
  return readAll()[compositeKey(threadId, providerKind, modelSlug)] ?? [];
}

export function saveProviderOptions(
  threadId: string,
  providerKind: string,
  modelSlug: string,
  options: ProviderOptionSelection[],
): void {
  const map = readAll();
  const key = compositeKey(threadId, providerKind, modelSlug);
  if (options.length === 0) {
    if (!(key in map)) return;
    delete map[key];
  } else {
    map[key] = options;
  }
  writeAll(map);
}

/** Merge a single id → value into the existing selection for
 *  (thread, kind, model). When `value` is null the id is removed. */
export function upsertProviderOption(
  threadId: string,
  providerKind: string,
  modelSlug: string,
  id: string,
  value: string | boolean | null,
): ProviderOptionSelection[] {
  const current = loadProviderOptions(threadId, providerKind, modelSlug);
  const next = current.filter((entry) => entry.id !== id);
  if (value !== null && value !== "") next.push({ id, value });
  saveProviderOptions(threadId, providerKind, modelSlug, next);
  return next;
}

export const __PROVIDER_OPTIONS_STORAGE_KEY_FOR_TESTS = STORAGE_KEY;
