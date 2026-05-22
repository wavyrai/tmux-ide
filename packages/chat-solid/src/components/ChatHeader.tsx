import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import type { AgentProvider, ChatThreadUsageSummary, StopReason, ThreadState } from "../types";
import type { ProviderInfo, ProviderModelCapabilities } from "../api";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ModelCapabilitiesPicker } from "./ModelCapabilitiesPicker";
import type { ModelListRowModel } from "./ModelListRow";
import {
  loadModelFavorites,
  toggleModelFavorite,
  type ModelFavorite,
} from "../lib/modelFavoritesStore";
import { loadModelSelection, saveModelSelection } from "../lib/modelSelectionStore";
import {
  activeProviderKindAccessor,
  saveActiveProviderKind,
  type ActiveProviderKind,
} from "../lib/activeProviderStore";
import { loadProviderOptions, upsertProviderOption } from "../lib/providerOptionsStore";

interface ChatHeaderProps {
  thread: Accessor<ThreadState | null>;
  inflight: Accessor<boolean>;
  stopReason: Accessor<StopReason | null>;
  usage: Accessor<ChatThreadUsageSummary | null>;
  sessionName: Accessor<string | null>;
  /** Discovered providers used by the right-slot model picker. */
  availableProviders?: Accessor<ReadonlyArray<ProviderInfo>>;
  /** Fires when the picker selects a different provider. */
  onProviderChange?: (next: AgentProvider) => void;
  onCancel(): void;
  onRename(title: string): Promise<void>;
  onClose?: () => void;
  /** Fires when the Delete button is clicked. Host owns the
   *  destructive-action confirm and the daemon dispatch — see
   *  ChatMountOptions.onDelete for the contract. */
  onDelete?: () => void;
}

export function ChatHeader(props: ChatHeaderProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  // Step 3b: visible provider is owned client-side. The header picker
  // writes here synchronously (no daemon round-trip); the persisted
  // thread.provider is only the reload fallback.
  const overrideKind = activeProviderKindAccessor(() => props.thread()?.id ?? null);
  const activeProvider = createMemo<AgentProvider | null>(() => {
    const persisted = props.thread()?.provider ?? null;
    const ov = overrideKind();
    // Only synthesize a built-in provider for kind overrides — a
    // "custom" provider requires command/args we don't have here, so
    // we fall back to the persisted record in that (rare) case.
    if (ov && ov !== "custom" && (!persisted || ov !== persisted.kind)) {
      return { kind: ov };
    }
    return persisted;
  });
  const providerList = createMemo<ReadonlyArray<ProviderInfo>>(
    () => props.availableProviders?.() ?? [],
  );

  // Real, daemon-discovered model list (Step 3). The hardcoded
  // PROVIDER_MODEL_CATALOG is gone — `availableProviders` now carries
  // each provider's `models[]` straight from
  // `provider-discovery.ts`.
  const modelsByKind = createMemo<ReadonlyMap<string, ReadonlyArray<ModelListRowModel>>>(() => {
    const out = new Map<string, ReadonlyArray<ModelListRowModel>>();
    for (const info of providerList()) {
      out.set(
        info.kind,
        (info.models ?? []).map((m) => ({
          slug: m.slug,
          name: m.name,
          ...(m.description ? { subProvider: m.description } : {}),
        })),
      );
    }
    return out;
  });

  // CODEX-FULL: capabilities surface (effort + fast-mode) for the
  // currently-active model. Drives the small adjacent selector — when
  // the model declares neither, the selector renders nothing.
  const capabilitiesByKindSlug = createMemo<Map<string, ProviderModelCapabilities>>(() => {
    const out = new Map<string, ProviderModelCapabilities>();
    for (const info of providerList()) {
      for (const m of info.models ?? []) {
        if (m.capabilities) out.set(`${info.kind}::${m.slug}`, m.capabilities);
      }
    }
    return out;
  });

  const defaultModelFor = (kind: string): string | null => {
    const list = modelsByKind().get(kind);
    return list && list.length > 0 ? (list[0]?.slug ?? null) : null;
  };

  const [favorites, setFavorites] = createSignal<ModelFavorite[]>(loadModelFavorites());
  const favoriteTuples = createMemo(() => favorites().map((f) => ({ kind: f.kind, slug: f.slug })));

  // Per-thread model selection: persisted via modelSelectionStore so
  // a reload restores the pick. The picked slug rides on the next
  // `chat.session.send` (see useChatThread.send).
  const [selectionTick, setSelectionTick] = createSignal(0);
  const activeModel = createMemo<string | null>(() => {
    selectionTick(); // re-run on any save
    const id = props.thread()?.id ?? null;
    const kind = activeProvider()?.kind ?? null;
    if (!id || !kind) return null;
    const fromThread = props.thread()?.provider.model ?? null;
    return fromThread ?? loadModelSelection(id, kind) ?? defaultModelFor(kind);
  });

  const builtInProvider = (kind: string): AgentProvider | null => {
    if (kind === "claude-code") return { kind: "claude-code" };
    if (kind === "codex") return { kind: "codex" };
    if (kind === "gemini") return { kind: "gemini" };
    return null;
  };
  const handlePickModel = (kind: string, slug: string): void => {
    const id = props.thread()?.id;
    if (id) saveModelSelection(id, kind, slug);
    setSelectionTick((n) => n + 1);
    // Step 3b: kind switch flips the VISIBLE provider locally
    // (synchronous — placeholder + dropdown update without a daemon
    // round-trip). The host's fire-and-forget setProvider keeps the
    // persisted thread.provider in sync for reload memory only.
    if (id && kind !== (activeProvider()?.kind ?? null)) {
      const isKnown =
        kind === "claude-code" || kind === "codex" || kind === "gemini" || kind === "custom";
      if (isKnown) saveActiveProviderKind(id, kind as ActiveProviderKind);
      const next = builtInProvider(kind);
      if (next) props.onProviderChange?.(next);
    }
  };
  const handleToggleFavorite = (kind: string, slug: string): void => {
    setFavorites((current) => toggleModelFavorite(current, { kind, slug }));
  };

  // CODEX-FULL: per-thread × kind × model effort + fast-mode store.
  // Bump on save so the createMemo re-reads localStorage.
  const [optionsTick, setOptionsTick] = createSignal(0);
  const activeCapabilities = createMemo<ProviderModelCapabilities | undefined>(() => {
    const kind = activeProvider()?.kind;
    const slug = activeModel();
    if (!kind || !slug) return undefined;
    return capabilitiesByKindSlug().get(`${kind}::${slug}`);
  });
  const activeEffort = createMemo<string | null>(() => {
    optionsTick();
    const id = props.thread()?.id ?? null;
    const kind = activeProvider()?.kind ?? null;
    const slug = activeModel();
    if (!id || !kind || !slug) return null;
    const entry = loadProviderOptions(id, kind, slug).find((o) => o.id === "reasoningEffort");
    return typeof entry?.value === "string" ? entry.value : null;
  });
  const activeFastMode = createMemo<boolean>(() => {
    optionsTick();
    const id = props.thread()?.id ?? null;
    const kind = activeProvider()?.kind ?? null;
    const slug = activeModel();
    if (!id || !kind || !slug) return false;
    const entry = loadProviderOptions(id, kind, slug).find((o) => o.id === "fastMode");
    return entry?.value === true;
  });
  const handleEffortChange = (_id: "reasoningEffort", value: string): void => {
    const id = props.thread()?.id;
    const kind = activeProvider()?.kind;
    const slug = activeModel();
    if (!id || !kind || !slug) return;
    upsertProviderOption(id, kind, slug, "reasoningEffort", value);
    setOptionsTick((n) => n + 1);
  };
  const handleFastModeToggle = (next: boolean): void => {
    const id = props.thread()?.id;
    const kind = activeProvider()?.kind;
    const slug = activeModel();
    if (!id || !kind || !slug) return;
    upsertProviderOption(id, kind, slug, "fastMode", next ? true : null);
    setOptionsTick((n) => n + 1);
  };

  function beginEdit() {
    setDraft(props.thread()?.title ?? "New chat");
    setEditing(true);
  }

  async function commit() {
    const title = draft().trim();
    setEditing(false);
    if (title && title !== props.thread()?.title) await props.onRename(title);
  }

  return (
    <header class="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border-weak bg-surface px-3">
      <Show
        when={editing()}
        fallback={
          <button
            class="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent text-left text-md text-fg outline-none hover:text-accent"
            type="button"
            onClick={beginEdit}
            title="Rename chat"
          >
            {props.thread()?.title ?? "Chat"}
          </button>
        }
      >
        <input
          class="min-w-0 flex-1 truncate border-0 bg-transparent text-md text-fg outline-none"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") setEditing(false);
          }}
          autofocus
        />
      </Show>
      <ContextWindowMeter usage={props.usage} />
      <Show when={props.availableProviders}>
        <ProviderModelPicker
          provider={activeProvider}
          availableProviders={providerList}
          onChange={(next) => props.onProviderChange?.(next)}
          disabled={props.inflight}
          modelsByKind={modelsByKind}
          activeModel={activeModel}
          onPickModel={handlePickModel}
          favorites={favoriteTuples}
          onToggleFavorite={handleToggleFavorite}
        />
        <ModelCapabilitiesPicker
          capabilities={activeCapabilities}
          effort={activeEffort}
          fastMode={activeFastMode}
          onChange={handleEffortChange}
          onToggleFastMode={handleFastModeToggle}
          disabled={props.inflight}
        />
      </Show>
      <Show when={props.sessionName()}>
        {(session) => (
          <span class="inline-flex items-center rounded-md border border-border-weak px-1.5 py-0.5 text-sm text-dim">
            {session()}
          </span>
        )}
      </Show>
      <Show when={props.stopReason()}>
        {(reason) => (
          <span class="inline-flex items-center rounded-md border border-border-weak px-1.5 py-0.5 text-sm text-dim">
            {reason().replaceAll("_", " ")}
          </span>
        )}
      </Show>
      <Show when={props.inflight()}>
        <button
          class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-base text-fg-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          onClick={props.onCancel}
        >
          Stop
        </button>
      </Show>
      <Show when={props.onDelete}>
        {(onDelete) => (
          <button
            data-testid="chat-header-delete"
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-base text-fg-secondary hover:border-red/60 hover:text-red"
            type="button"
            onClick={onDelete()}
            title="Delete this thread"
            aria-label="Delete thread"
          >
            Delete
          </button>
        )}
      </Show>
      <Show when={props.onClose}>
        {(onClose) => (
          <button
            data-testid="chat-header-close"
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-base text-fg-secondary hover:border-accent hover:text-accent"
            type="button"
            onClick={onClose()}
          >
            Close
          </button>
        )}
      </Show>
    </header>
  );
}
