/**
 * Single model row inside `ModelPickerContent`. Renders:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ★  Model name  · subprovider           NEW   ↵ ⌘1        │
 *   │    [icon] Provider display name                          │
 *   └──────────────────────────────────────────────────────────┘
 *
 *   - Favorite toggle (gold star when active)
 *   - Primary name + optional "NEW" / "RECOMMENDED" capability chip
 *   - Optional jump-label kbd (e.g. ⌘1) for keyboard shortcuts
 *   - Footer line: provider icon + display name (hidden when picker
 *     is locked to a single instance and the rail isn't shown)
 *
 * Carries the legacy `provider-model-picker-option` data-testid plus
 * data-kind / data-active / data-available so the existing
 * provider-only callers (and their tests) keep working unchanged.
 * The richer surface is purely additive.
 */

import type { Accessor, JSX } from "solid-js";
import { Show } from "solid-js";
import { ProviderInstanceIcon, type ProviderInstanceStatus } from "./ProviderInstanceIcon";

export interface ModelListRowModel {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
}

export interface ModelListRowProps {
  index: number;
  model: ModelListRowModel;
  instanceId: string;
  driverKind: string;
  providerDisplayName: string;
  providerAccentColor?: string;
  providerStatus?: ProviderInstanceStatus;
  /**
   * Marks the active selection. Surfaces as
   * `data-active="true|false"` so test queries can pin the active
   * row without scraping styles.
   */
  isActive: Accessor<boolean>;
  isFavorite: Accessor<boolean>;
  /** Hide the provider footer when the picker is locked to one instance. */
  showProvider?: boolean;
  /**
   * Prefer the model's `shortName` over `name` in the primary label
   * — used when the rail already shows the long form. Defaults to
   * false.
   */
  preferShortName?: boolean;
  /** "NEW" capability chip (gold). */
  showNewBadge?: boolean;
  /** "RECOMMENDED" capability chip (blue). */
  showRecommendedBadge?: boolean;
  /** Optional jump-label rendered on the right (e.g. "⌘1"). */
  jumpLabel?: string | null;
  /** Optional availability flag — surfaced as data-available. */
  available?: boolean;
  onSelect: () => void;
  onToggleFavorite?: () => void;
}

const STAR_PATH =
  "M8 1.5l1.96 4.43 4.84.46-3.66 3.21 1.1 4.75L8 11.85 3.76 14.35l1.1-4.75L1.2 6.39l4.84-.46L8 1.5Z";

export function ModelListRow(props: ModelListRowProps): JSX.Element {
  const labelText = (): string => {
    if (props.preferShortName && props.model.shortName) return props.model.shortName;
    return props.model.name;
  };

  const providerFooter = (): string => {
    if (props.model.subProvider) {
      return `${props.providerDisplayName} · ${props.model.subProvider}`;
    }
    return props.providerDisplayName;
  };

  return (
    <button
      type="button"
      role="option"
      data-testid="provider-model-picker-option"
      data-kind={props.driverKind}
      data-instance-id={props.instanceId}
      data-slug={props.model.slug}
      data-active={props.isActive() ? "true" : "false"}
      data-available={props.available === false ? "false" : "true"}
      data-favorite={props.isFavorite() ? "true" : "false"}
      aria-selected={props.isActive()}
      onClick={(event) => {
        event.stopPropagation();
        if (props.available === false) return;
        props.onSelect();
      }}
      class={
        "group flex w-full cursor-pointer items-start gap-2 rounded px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover,var(--surface))] " +
        (props.isActive() ? "bg-[var(--surface-active,var(--surface))] " : "") +
        (props.available === false ? "cursor-not-allowed opacity-50 " : "")
      }
    >
      <Show when={props.onToggleFavorite}>
        {(onToggle) => (
          <span
            role="button"
            tabindex={-1}
            data-testid="model-list-row-favorite"
            aria-label={props.isFavorite() ? "Remove from favorites" : "Add to favorites"}
            class={
              "mt-0.5 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center opacity-40 transition-opacity group-hover:opacity-100 " +
              (props.isFavorite() ? "text-yellow" : "")
            }
            onClick={(event) => {
              event.stopPropagation();
              onToggle()();
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill={props.isFavorite() ? "currentColor" : "none"}
              stroke="currentColor"
              stroke-width="1.4"
              aria-hidden="true"
            >
              <path d={STAR_PATH} stroke-linejoin="round" />
            </svg>
          </span>
        )}
      </Show>

      <div class="min-w-0 flex-1 text-left">
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-1.5 text-base font-medium leading-snug text-fg">
            <span class="truncate">{labelText()}</span>
            <Show when={props.showNewBadge}>
              <span
                data-testid="model-list-row-new-badge"
                class="shrink-0 rounded border border-yellow/40 bg-yellow/15 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-yellow"
                aria-label="New model"
              >
                NEW
              </span>
            </Show>
            <Show when={props.showRecommendedBadge}>
              <span
                data-testid="model-list-row-recommended-badge"
                class="shrink-0 rounded border border-accent/40 bg-accent/10 px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-accent"
                aria-label="Recommended model"
              >
                REC
              </span>
            </Show>
          </div>
          <Show when={props.jumpLabel}>
            {(label) => (
              <kbd
                data-testid="model-list-row-jump-label"
                class="h-4 shrink-0 rounded-sm border border-border-weak px-1 text-xs leading-tight text-fg-secondary"
              >
                {label()}
              </kbd>
            )}
          </Show>
        </div>
        <Show when={props.showProvider !== false}>
          <div class="mt-0.5 flex items-center gap-1.5">
            <ProviderInstanceIcon
              driverKind={props.driverKind}
              displayName={props.providerDisplayName}
              accentColor={props.providerAccentColor}
              class="size-3"
            />
            <Show when={props.providerAccentColor}>
              {(color) => (
                <span
                  class="size-1.5 shrink-0 rounded-full"
                  style={{ background: color() }}
                  aria-hidden="true"
                />
              )}
            </Show>
            <span class="truncate text-sm font-normal leading-snug text-dim">
              {providerFooter()}
            </span>
            <Show when={props.providerStatus && props.providerStatus !== "ready"}>
              {(status) => (
                <span
                  data-testid="model-list-row-status"
                  class="ml-1 inline-flex shrink-0 rounded-sm border border-border-weak px-1 text-xs uppercase tracking-wide text-dim"
                >
                  {status()}
                </span>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </button>
  );
}
