/**
 * Per-thread model selection (Step 3 of the t3 chat convergence).
 *
 * The daemon owns the authoritative thread.provider.model and applies
 * the per-turn model on every `chat.session.send`. This client store
 * is a UX cache only: it remembers which model the user last picked
 * inside each thread so the picker rehydrates correctly after a
 * reload and so `useChatThread.send()` can attach `model` to the
 * action call.
 *
 * Modeled on `composerDraftStore.modelSelectionByProvider` from t3
 * (see docs/audit-provider-switcher-convergence.md §1) — keyed by
 * `${threadId}::${providerKind}` so the same thread retains separate
 * selections for each driver it has touched.
 *
 * No tri-axis instanceId here; the daemon resolves the live client
 * from `provider.kind` alone. Adding instances is additive — they
 * can move to a third key segment without changing this contract.
 */

const STORAGE_KEY = "tmux-ide:chat:model-selection:v1";

interface SelectionMap {
  [key: string]: string;
}

function hasStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readAll(): SelectionMap {
  if (!hasStorage()) return {};
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SelectionMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(map: SelectionMap): void {
  if (!hasStorage()) return;
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Quota / storage disabled — selection degrades to session-only.
  }
}

function compositeKey(threadId: string, providerKind: string): string {
  return `${threadId}::${providerKind}`;
}

export function loadModelSelection(threadId: string, providerKind: string): string | null {
  return readAll()[compositeKey(threadId, providerKind)] ?? null;
}

export function saveModelSelection(
  threadId: string,
  providerKind: string,
  slug: string | null,
): void {
  const map = readAll();
  const key = compositeKey(threadId, providerKind);
  if (slug === null || slug === "") {
    if (!(key in map)) return;
    delete map[key];
  } else {
    if (map[key] === slug) return;
    map[key] = slug;
  }
  writeAll(map);
}

export const __MODEL_SELECTION_STORAGE_KEY_FOR_TESTS = STORAGE_KEY;
