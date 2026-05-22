/**
 * Per-thread visible provider selection (Step 3b — t3-mirror).
 *
 * The DAEMON-PERSISTED `thread.provider` is the reload default; the
 * CLIENT owns "what the user is looking at right now". Picking a
 * different provider in the header writes here synchronously — the
 * dropdown + composer placeholder flip immediately, no daemon
 * round-trip — and the selection rides on the next
 * `chat.session.send` as the per-turn `provider.kind`.
 *
 * Modeled on t3's `composerDraftStore.activeProvider` keyed per
 * thread (see context/t3code/apps/web/src/composerDraftStore.ts).
 * Persisted to localStorage so a reload restores the visible
 * selection alongside the model store
 * ([[modelSelectionStore]]).
 */

import { createSignal, type Accessor } from "solid-js";

export type ActiveProviderKind = "claude-code" | "codex" | "gemini" | "custom";

const STORAGE_KEY = "tmux-ide:chat:active-provider:v1";

interface SelectionMap {
  [threadId: string]: ActiveProviderKind;
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
      if (
        typeof value === "string" &&
        (value === "claude-code" || value === "codex" || value === "gemini" || value === "custom")
      ) {
        out[key] = value;
      }
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
    // Quota / disabled — degrade to session-only.
  }
}

/**
 * Shared in-memory mirror so multiple consumers (ChatHeader,
 * ChatThreadView, useChatThread.send) see the same value within the
 * same window without each component subscribing to a `storage`
 * event. Hydrated lazily on first read.
 */
const [overrides, setOverrides] = createSignal<SelectionMap>(readAll());

export function loadActiveProviderKind(threadId: string): ActiveProviderKind | null {
  return overrides()[threadId] ?? null;
}

/** Reactive accessor — re-runs whenever any thread's active provider changes. */
export function activeProviderKindAccessor(threadId: Accessor<string | null | undefined>) {
  return () => {
    const id = threadId();
    if (!id) return null;
    return overrides()[id] ?? null;
  };
}

export function saveActiveProviderKind(threadId: string, kind: ActiveProviderKind | null): void {
  const current = overrides();
  if (kind === null) {
    if (!(threadId in current)) return;
    const next = { ...current };
    delete next[threadId];
    setOverrides(next);
    writeAll(next);
    return;
  }
  if (current[threadId] === kind) return;
  const next = { ...current, [threadId]: kind };
  setOverrides(next);
  writeAll(next);
}

export const __ACTIVE_PROVIDER_STORAGE_KEY_FOR_TESTS = STORAGE_KEY;
