/**
 * Search-driven content panel for the model picker. Renders a
 * search input + filtered model list, with `ModelPickerSidebar` on
 * the left when not actively searching (search collapses the rail
 * because the result list spans every instance).
 *
 *   ┌─────┬───────────────────────────────────────────────────────┐
 *   │ ★   │ 🔍 Search models…                                     │
 *   ├─────┤────────────────────────────────────────────────────────│
 *   │ [C] │ ★ Claude Opus 4.7        NEW    ⌘1                    │
 *   │ [G] │   Claude Code                                          │
 *   │ [⁕] │ ★ GPT-5 Codex                    ⌘2                    │
 *   └─────┴───────────────────────────────────────────────────────┘
 *
 * For chat-solid's simpler data model: `instances` are derived from
 * `ProviderInfo` and `modelsByInstance` is optional. When no models
 * are supplied, the panel synthesizes one row per available instance
 * — slug equals the driver kind — so callers that only want to pick
 * a provider can still use this content panel (and the existing
 * provider-only tests pass against the legacy testids).
 */

import type { Accessor, JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import { ModelListRow, type ModelListRowModel } from "./ModelListRow";
import {
  ModelPickerSidebar,
  type ModelPickerSidebarComingSoon,
  type ProviderInstanceSummary,
} from "./ModelPickerSidebar";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "../lib/modelPickerSearch";
import {
  isModelPickerNewModel,
  isModelPickerRecommendedModel,
} from "../lib/modelPickerModelHighlights";

export interface ModelPickerSelection {
  instanceId: string;
  slug: string;
}

export interface ModelPickerContentProps {
  instances: Accessor<ReadonlyArray<ProviderInstanceSummary>>;
  /**
   * Models per instance. When omitted (or empty for an instance),
   * the content panel falls back to one synthetic row per instance
   * — useful for callers that only want to pick a provider.
   */
  modelsByInstance?: Accessor<ReadonlyMap<string, ReadonlyArray<ModelListRowModel>>>;
  active: Accessor<ModelPickerSelection | null>;
  favorites?: Accessor<ReadonlyArray<ModelPickerSelection>>;
  /**
   * When set, lock the picker to the given driver kind. Hides the
   * "favorites" rail entry and skips sidebar / coming-soon
   * rendering when there's only one matching instance.
   */
  lockedDriverKind?: Accessor<string | null>;
  comingSoonEntries?: Accessor<ReadonlyArray<ModelPickerSidebarComingSoon>>;
  newBadgeInstanceIds?: Accessor<ReadonlySet<string>>;
  onSelect: (selection: ModelPickerSelection) => void;
  onToggleFavorite?: (selection: ModelPickerSelection) => void;
  /** Defaults to "Search models…". */
  placeholder?: string;
  /** When set, drives a jump-label kbd on the first 9 rendered rows ("⌘1", "⌘2", …). */
  jumpLabelPrefix?: string;
}

interface FlatModel {
  instanceId: string;
  driverKind: string;
  instanceDisplayName: string;
  instanceAccentColor?: string;
  instanceStatus?: ProviderInstanceSummary["status"];
  available: boolean;
  model: ModelListRowModel;
}

function buildFlatModels(
  instances: ReadonlyArray<ProviderInstanceSummary>,
  modelsByInstance: ReadonlyMap<string, ReadonlyArray<ModelListRowModel>> | undefined,
): FlatModel[] {
  const out: FlatModel[] = [];
  for (const entry of instances) {
    const models = modelsByInstance?.get(entry.instanceId);
    if (!models || models.length === 0) {
      out.push({
        instanceId: entry.instanceId,
        driverKind: entry.driverKind,
        instanceDisplayName: entry.displayName,
        instanceAccentColor: entry.accentColor,
        instanceStatus: entry.status,
        available: entry.available,
        model: {
          slug: entry.instanceId,
          name: entry.displayName,
          ...(entry.description ? { subProvider: entry.description } : {}),
        },
      });
      continue;
    }
    for (const model of models) {
      out.push({
        instanceId: entry.instanceId,
        driverKind: entry.driverKind,
        instanceDisplayName: entry.displayName,
        instanceAccentColor: entry.accentColor,
        instanceStatus: entry.status,
        available: entry.available,
        model,
      });
    }
  }
  return out;
}

function favoriteKey(selection: ModelPickerSelection): string {
  return `${selection.instanceId}:${selection.slug}`;
}

export function ModelPickerContent(props: ModelPickerContentProps): JSX.Element {
  const [query, setQuery] = createSignal("");

  const lockedKind = (): string | null => props.lockedDriverKind?.() ?? null;
  const isLocked = (): boolean => lockedKind() !== null;
  const isSearching = (): boolean => query().trim().length > 0;

  const favoritesSet = createMemo(() => {
    const fav = props.favorites?.() ?? [];
    return new Set(fav.map((f) => favoriteKey(f)));
  });

  const visibleInstances = createMemo<ReadonlyArray<ProviderInstanceSummary>>(() => {
    const lk = lockedKind();
    if (!lk) return props.instances();
    return props.instances().filter((entry) => entry.driverKind === lk);
  });

  const [selectedInstanceId, setSelectedInstanceId] = createSignal<string | "favorites">(
    "favorites",
  );

  const showFavorites = (): boolean => !isLocked() && (props.favorites?.().length ?? 0) > 0;

  // Initialize / re-sync the sidebar selection when instances or locks change.
  // Prefer the active selection, fall back to favorites or first instance.
  createMemo(() => {
    const list = visibleInstances();
    if (list.length === 0) return;
    const current = selectedInstanceId();
    if (current === "favorites") {
      if (showFavorites()) return;
      setSelectedInstanceId(list[0]!.instanceId);
      return;
    }
    const stillPresent = list.some((entry) => entry.instanceId === current);
    if (!stillPresent) {
      const activeId = props.active()?.instanceId;
      const next =
        (activeId && list.find((entry) => entry.instanceId === activeId)?.instanceId) ??
        (showFavorites() ? "favorites" : list[0]!.instanceId);
      setSelectedInstanceId(next);
    }
  });

  // Provider-only mode: caller didn't supply any real model lists, so
  // every instance contributes exactly one synthetic row (slug ==
  // instanceId). The sidebar adds no information — collapse it and
  // show the full list at once so callers that only want to pick a
  // provider see all options on first open.
  const isProviderOnlyMode = createMemo<boolean>(() => {
    const map = props.modelsByInstance?.();
    if (!map) return true;
    for (const list of map.values()) {
      if (list.length > 0) return false;
    }
    return true;
  });

  const showSidebar = createMemo<boolean>(() => {
    if (isSearching()) return false;
    if (isProviderOnlyMode()) return false;
    if (!isLocked()) return visibleInstances().length > 0;
    return visibleInstances().length > 1;
  });

  const flatModels = createMemo<FlatModel[]>(() =>
    buildFlatModels(visibleInstances(), props.modelsByInstance?.()),
  );

  interface RankedModel {
    flat: FlatModel;
    score: number;
    tieBreaker: string;
  }

  const rankedSearchResults = createMemo<RankedModel[]>(() => {
    const q = query().trim();
    if (!q) return [];
    const fav = favoritesSet();
    const ranked: RankedModel[] = [];
    for (const flat of flatModels()) {
      const score = scoreModelPickerSearch(
        {
          name: flat.model.name,
          ...(flat.model.shortName ? { shortName: flat.model.shortName } : {}),
          ...(flat.model.subProvider ? { subProvider: flat.model.subProvider } : {}),
          driverKind: flat.driverKind,
          providerDisplayName: flat.instanceDisplayName,
          isFavorite: fav.has(favoriteKey({ instanceId: flat.instanceId, slug: flat.model.slug })),
        },
        q,
      );
      if (score === null) continue;
      ranked.push({
        flat,
        score,
        tieBreaker: buildModelPickerSearchText({
          name: flat.model.name,
          ...(flat.model.shortName ? { shortName: flat.model.shortName } : {}),
          ...(flat.model.subProvider ? { subProvider: flat.model.subProvider } : {}),
          driverKind: flat.driverKind,
          providerDisplayName: flat.instanceDisplayName,
        }),
      });
    }
    ranked.sort((a, b) => {
      const delta = a.score - b.score;
      if (delta !== 0) return delta;
      return a.tieBreaker.localeCompare(b.tieBreaker);
    });
    return ranked;
  });

  const filteredModels = createMemo<FlatModel[]>(() => {
    if (isSearching()) return rankedSearchResults().map((r) => r.flat);
    if (isProviderOnlyMode()) return flatModels();
    const sel = selectedInstanceId();
    const flat = flatModels();
    if (sel === "favorites") {
      const fav = favoritesSet();
      return flat.filter((m) =>
        fav.has(favoriteKey({ instanceId: m.instanceId, slug: m.model.slug })),
      );
    }
    return flat.filter((m) => m.instanceId === sel);
  });

  const jumpLabelFor = (index: number): string | null => {
    if (!props.jumpLabelPrefix) return null;
    if (index >= 9) return null;
    return `${props.jumpLabelPrefix}${index + 1}`;
  };

  // A model list is bounded (a handful of rows per provider), so it
  // renders in full with a scroll container. Virtualization was
  // removed here for the same reason it was removed from
  // MessagesTimeline: `@tanstack/solid-virtual`'s `getVirtualItems()`
  // returned `[]` perpetually against the built bundle, leaving the
  // list silently empty.

  return (
    <div
      data-testid="model-picker-content"
      data-locked={isLocked() ? "true" : "false"}
      data-searching={isSearching() ? "true" : "false"}
      class="flex max-h-96 min-h-[160px] w-full max-w-[28rem] flex-row overflow-hidden rounded-md border border-border bg-surface text-fg"
    >
      <Show when={showSidebar()}>
        <ModelPickerSidebar
          selectedInstanceId={selectedInstanceId}
          instances={visibleInstances}
          onSelectInstance={setSelectedInstanceId}
          showFavorites={showFavorites()}
          showComingSoon={!isLocked()}
          comingSoonEntries={props.comingSoonEntries}
          newBadgeInstanceIds={props.newBadgeInstanceIds}
        />
      </Show>

      <div class="flex min-h-0 flex-1 flex-col">
        <div class="border-b border-border-weak px-2 py-1.5">
          <input
            data-testid="model-picker-content-search"
            type="text"
            class="w-full rounded-sm border-0 bg-transparent px-1 text-base text-fg outline-none placeholder:text-dim"
            placeholder={props.placeholder ?? "Search models…"}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            aria-label="Search models"
          />
        </div>

        <div
          data-testid="model-picker-content-list"
          role="listbox"
          class="flex min-h-0 flex-1 flex-col overflow-y-auto py-1"
        >
          <Show
            when={filteredModels().length > 0}
            fallback={
              <div
                data-testid="provider-model-picker-empty"
                class="px-3 py-6 text-center text-base text-dim"
              >
                <Show when={props.instances().length === 0} fallback={<span>No models match</span>}>
                  No providers discovered
                </Show>
              </div>
            }
          >
            <For each={filteredModels()}>
              {(flat, index) => (
                <ModelListRow
                  index={index()}
                  model={flat.model}
                  instanceId={flat.instanceId}
                  driverKind={flat.driverKind}
                  providerDisplayName={flat.instanceDisplayName}
                  providerAccentColor={flat.instanceAccentColor}
                  providerStatus={flat.instanceStatus}
                  isActive={() => {
                    const active = props.active();
                    return (
                      active !== null &&
                      active.instanceId === flat.instanceId &&
                      active.slug === flat.model.slug
                    );
                  }}
                  isFavorite={() =>
                    favoritesSet().has(
                      favoriteKey({
                        instanceId: flat.instanceId,
                        slug: flat.model.slug,
                      }),
                    )
                  }
                  showProvider={!isLocked() || visibleInstances().length > 1}
                  preferShortName={!isLocked()}
                  showNewBadge={isModelPickerNewModel(flat.driverKind, flat.model.slug)}
                  showRecommendedBadge={isModelPickerRecommendedModel(
                    flat.driverKind,
                    flat.model.slug,
                  )}
                  jumpLabel={jumpLabelFor(index())}
                  available={flat.available}
                  onSelect={() =>
                    props.onSelect({
                      instanceId: flat.instanceId,
                      slug: flat.model.slug,
                    })
                  }
                  onToggleFavorite={
                    props.onToggleFavorite
                      ? () =>
                          props.onToggleFavorite!({
                            instanceId: flat.instanceId,
                            slug: flat.model.slug,
                          })
                      : undefined
                  }
                />
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
