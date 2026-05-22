/**
 * Provider + model switcher rendered in the chat header. A trigger
 * button opens a dropdown that mounts `ModelPickerContent` — a
 * search-driven content panel with a vertical rail of provider
 * instances on the left.
 *
 *   ┌─ ChatHeader ──────────────────────────────────────────────┐
 *   │  …meters…   [ ⌁ Claude Code  ▾ ]  [Stop] [Delete] [Close] │
 *   └─────────────────────────────────────────────────────────────┘
 *
 *   On click:
 *   ┌─────┬───────────────────────────────────────────────────────┐
 *   │  ★  │ 🔍 Search models…                                     │
 *   │ [C] │ ★ Claude Opus 4.7                                     │
 *   │ [G] │   Codex                                                │
 *   └─────┴───────────────────────────────────────────────────────┘
 *
 * Backward-compat: when callers don't supply a `modelsByInstance`
 * map (the case today — chat-solid has no model API yet), each
 * provider renders as a single row whose slug equals the driver
 * kind. The trigger continues to fire `onChange({ kind })` with the
 * picked provider, so existing consumers see no behavior change.
 *
 * Public testid contract preserved for the previous flat picker:
 *
 *   - `provider-model-picker`            (root)
 *   - `provider-model-picker-trigger`    (button)
 *   - `provider-model-picker-menu`       (dropdown)
 *   - `provider-model-picker-option`     (each model/provider row)
 *   - `provider-model-picker-empty`      (zero-state placeholder)
 *
 * New testids surfaced by the rich content:
 *
 *   - `model-picker-content`             (panel root)
 *   - `model-picker-sidebar`             (rail)
 *   - `model-picker-content-search`      (search input)
 *   - `model-list-row-*`                 (badges, jump labels, …)
 */

import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type { AgentProvider } from "../types";
import type { ProviderInfo } from "../api";
import { ModelPickerContent, type ModelPickerSelection } from "./ModelPickerContent";
import type { ModelPickerSidebarComingSoon, ProviderInstanceSummary } from "./ModelPickerSidebar";
import type { ModelListRowModel } from "./ModelListRow";

interface ProviderModelPickerProps {
  /** Current provider; null until the thread loads. */
  provider: Accessor<AgentProvider | null>;
  /** Discovered providers from `/api/chat/providers`. */
  availableProviders: Accessor<ReadonlyArray<ProviderInfo>>;
  /** Fired when the user picks a different provider in the dropdown. */
  onChange?: (next: AgentProvider) => void;
  /** Optional disabled state (e.g. while a turn is in flight). */
  disabled?: Accessor<boolean>;
  /**
   * Optional per-provider model list. When supplied, the content
   * panel renders each model as its own row and `onPickModel` fires
   * with the chosen (kind, slug). Keyed by driver kind (e.g.
   * "claude-code") so callers don't need to know about instance
   * ids.
   */
  modelsByKind?: Accessor<ReadonlyMap<string, ReadonlyArray<ModelListRowModel>>>;
  /**
   * Currently selected model slug. Optional — when omitted, no row
   * renders as active.
   */
  activeModel?: Accessor<string | null>;
  onPickModel?: (kind: string, slug: string) => void;
  /** Favorites — a list of (kind, slug) tuples. */
  favorites?: Accessor<ReadonlyArray<{ kind: string; slug: string }>>;
  onToggleFavorite?: (kind: string, slug: string) => void;
  /**
   * Optional coming-soon rail entries (e.g. "Gemini · soon"). Hidden
   * when the picker is locked.
   */
  comingSoonEntries?: Accessor<ReadonlyArray<ModelPickerSidebarComingSoon>>;
  /**
   * Locks the picker to a single driver kind — used when editing a
   * sent message where the served-by driver can't change.
   */
  lockedDriverKind?: Accessor<string | null>;
}

const GLYPH: Record<string, string> = {
  "claude-code": "⌁",
  codex: "◇",
  gemini: "✦",
};

function glyphFor(kind: string | null | undefined): string {
  if (!kind) return "·";
  return GLYPH[kind] ?? "•";
}

function labelFor(info: ProviderInfo | null | undefined, kind: string | null | undefined): string {
  if (info?.name) return info.name;
  if (!kind) return "Pick provider";
  switch (kind) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    default:
      return kind;
  }
}

function asAgentProvider(kind: string): AgentProvider | null {
  // Discovery only surfaces built-in kinds (claude-code / codex /
  // gemini). The `custom` variant of AgentProvider requires
  // command+args which discovery doesn't carry — host code never
  // mounts a `custom` provider through this picker.
  if (kind === "claude-code") return { kind: "claude-code" };
  if (kind === "codex") return { kind: "codex" };
  if (kind === "gemini") return { kind: "gemini" };
  return null;
}

function toInstanceSummary(info: ProviderInfo): ProviderInstanceSummary {
  return {
    instanceId: info.kind,
    driverKind: info.kind,
    displayName: info.name || info.kind,
    available: info.available,
    status: info.available ? "ready" : "error",
    ...(info.description ? { description: info.description } : {}),
    ...(info.version ? { version: info.version } : {}),
    ...(info.error ? { error: info.error } : {}),
  };
}

export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  const [menu, setMenu] = createSignal<HTMLDivElement>();

  const activeKind = createMemo<string | null>(() => props.provider()?.kind ?? null);
  const activeInfo = createMemo<ProviderInfo | null>(() => {
    const kind = activeKind();
    if (!kind) return null;
    return props.availableProviders().find((info) => info.kind === kind) ?? null;
  });
  const triggerLabel = createMemo(() => labelFor(activeInfo(), activeKind()));

  const instances = createMemo<ReadonlyArray<ProviderInstanceSummary>>(() =>
    props.availableProviders().map(toInstanceSummary),
  );

  const modelsByInstance = createMemo<
    ReadonlyMap<string, ReadonlyArray<ModelListRowModel>> | undefined
  >(() => {
    const provided = props.modelsByKind?.();
    if (!provided) return undefined;
    return provided;
  });

  const activeSelection = createMemo<ModelPickerSelection | null>(() => {
    const kind = activeKind();
    if (!kind) return null;
    const slug = props.activeModel?.() ?? kind;
    return { instanceId: kind, slug };
  });

  const favorites = createMemo<ReadonlyArray<ModelPickerSelection> | undefined>(() => {
    const fav = props.favorites?.();
    if (!fav) return undefined;
    return fav.map((f) => ({ instanceId: f.kind, slug: f.slug }));
  });

  const isDisabled = (): boolean => props.disabled?.() ?? false;

  function close(): void {
    setOpen(false);
  }

  function toggle(): void {
    if (isDisabled()) return;
    setOpen((value) => !value);
  }

  function handleSelect(selection: ModelPickerSelection): void {
    if (isDisabled()) return;
    if (props.onPickModel) {
      props.onPickModel(selection.instanceId, selection.slug);
    }
    // Legacy: when no modelsByKind is supplied OR the slug equals
    // the kind (the synthetic row), bubble the provider change.
    const synthetic = !props.modelsByKind || selection.slug === selection.instanceId;
    if (synthetic) {
      const next = asAgentProvider(selection.instanceId);
      if (next) props.onChange?.(next);
    }
    close();
  }

  function handleToggleFavorite(selection: ModelPickerSelection): void {
    props.onToggleFavorite?.(selection.instanceId, selection.slug);
  }

  function onDocPointer(event: PointerEvent): void {
    const triggerEl = trigger();
    const menuEl = menu();
    if (!triggerEl) return;
    if (event.target instanceof Node) {
      if (menuEl?.contains(event.target)) return;
      if (triggerEl.parentElement?.contains(event.target)) return;
    }
    close();
  }
  function onDocKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  createEffect(
    on(open, (isOpen) => {
      if (!isOpen) return;
      document.addEventListener("pointerdown", onDocPointer);
      document.addEventListener("keydown", onDocKey);
      onCleanup(() => {
        document.removeEventListener("pointerdown", onDocPointer);
        document.removeEventListener("keydown", onDocKey);
      });
    }),
  );

  return (
    <div data-testid="provider-model-picker" class="relative inline-flex">
      <button
        ref={setTrigger}
        type="button"
        data-testid="provider-model-picker-trigger"
        data-open={open() ? "true" : "false"}
        aria-haspopup="listbox"
        aria-expanded={open()}
        disabled={isDisabled()}
        onClick={toggle}
        class="inline-flex h-7 max-w-48 cursor-pointer items-center gap-1.5 truncate rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-base text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden="true" class="text-[var(--accent)]">
          {glyphFor(activeKind())}
        </span>
        <span class="truncate">{triggerLabel()}</span>
        <span aria-hidden="true" class="text-xs opacity-60">
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div
          ref={setMenu}
          data-testid="provider-model-picker-menu"
          role="dialog"
          aria-label="Pick a provider or model"
          class="absolute right-0 top-[calc(100%+0.25rem)] z-30 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl"
        >
          <ModelPickerContent
            instances={instances}
            modelsByInstance={
              modelsByInstance()
                ? (modelsByInstance as Accessor<
                    ReadonlyMap<string, ReadonlyArray<ModelListRowModel>>
                  >)
                : undefined
            }
            active={activeSelection}
            favorites={
              favorites() ? (favorites as Accessor<ReadonlyArray<ModelPickerSelection>>) : undefined
            }
            lockedDriverKind={props.lockedDriverKind}
            comingSoonEntries={props.comingSoonEntries}
            onSelect={handleSelect}
            onToggleFavorite={handleToggleFavorite}
          />
          <div class="border-t border-[var(--border-weak,var(--border))] px-3 py-1.5 text-xs uppercase tracking-[0.08em] text-[var(--dim)]">
            Search · ↩ select · Esc close
          </div>
        </div>
      </Show>
    </div>
  );
}
