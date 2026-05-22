/**
 * Vertical rail of provider instances + favorites at the left of
 * `ModelPickerContent`. Each rail button is a square icon — driver
 * glyph for known kinds, initials for custom-named instances. The
 * active rail item gets a primary-coloured indicator strip on the
 * right edge so the rail communicates which list the content panel
 * is currently showing.
 *
 * Optional coming-soon entries (e.g. "Gemini · soon", "Copilot ·
 * soon") render disabled below the configured instances so the user
 * sees the platform's roadmap without needing the picker to wire up
 * a real instance for them. Toggle via `showComingSoon` —
 * `ModelPickerContent` hides the section when the picker is locked
 * to one driver.
 */

import type { Accessor, JSX } from "solid-js";
import { For, Show } from "solid-js";
import { ProviderInstanceIcon, type ProviderInstanceStatus } from "./ProviderInstanceIcon";

export interface ProviderInstanceSummary {
  instanceId: string;
  driverKind: string;
  displayName: string;
  available: boolean;
  status?: ProviderInstanceStatus;
  accentColor?: string;
  description?: string;
  version?: string;
  error?: string;
}

export interface ModelPickerSidebarComingSoon {
  id: string;
  driverKind: string;
  label: string;
}

export interface ModelPickerSidebarProps {
  selectedInstanceId: Accessor<string | "favorites">;
  instances: Accessor<ReadonlyArray<ProviderInstanceSummary>>;
  onSelectInstance: (id: string | "favorites") => void;
  showFavorites?: boolean;
  showComingSoon?: boolean;
  comingSoonEntries?: Accessor<ReadonlyArray<ModelPickerSidebarComingSoon>>;
  newBadgeInstanceIds?: Accessor<ReadonlySet<string>>;
}

const STAR_PATH =
  "M8 1.5l1.96 4.43 4.84.46-3.66 3.21 1.1 4.75L8 11.85 3.76 14.35l1.1-4.75L1.2 6.39l4.84-.46L8 1.5Z";

const RAIL_BUTTON =
  "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded-md border border-transparent text-fg-secondary transition-colors hover:bg-[var(--surface-hover,var(--surface))]";

const RAIL_BUTTON_SELECTED = "bg-[var(--surface-active,var(--surface))] text-fg shadow-sm";

const RAIL_BUTTON_DISABLED = "cursor-not-allowed opacity-50 hover:bg-transparent";

const SELECTED_INDICATOR =
  "pointer-events-none absolute -right-1 top-1/2 z-10 h-5 w-0.5 -translate-y-1/2 rounded-l-full bg-accent";

export function ModelPickerSidebar(props: ModelPickerSidebarProps): JSX.Element {
  const showFavorites = (): boolean => props.showFavorites ?? true;
  const showComingSoon = (): boolean => props.showComingSoon ?? true;

  const isSelected = (id: string | "favorites"): boolean => props.selectedInstanceId() === id;
  const hasNewBadge = (id: string): boolean => props.newBadgeInstanceIds?.()?.has(id) ?? false;

  return (
    <nav
      data-testid="model-picker-sidebar"
      aria-label="Provider instances"
      class="flex w-12 shrink-0 flex-col gap-1 border-r border-border-weak bg-surface/40 p-1"
    >
      <Show when={showFavorites()}>
        <div class="relative w-full border-b border-border-weak pb-1">
          <Show when={isSelected("favorites")}>
            <span class={SELECTED_INDICATOR} aria-hidden="true" />
          </Show>
          <button
            type="button"
            data-testid="model-picker-sidebar-favorites"
            data-selected={isSelected("favorites") ? "true" : "false"}
            class={`${RAIL_BUTTON} ${isSelected("favorites") ? RAIL_BUTTON_SELECTED : ""}`}
            onClick={() => props.onSelectInstance("favorites")}
            aria-label="Favorites"
            title="Favorites"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d={STAR_PATH} />
            </svg>
          </button>
        </div>
      </Show>

      <For each={props.instances()}>
        {(entry) => {
          const disabled = (): boolean => !entry.available || entry.status === "disabled";
          const selected = (): boolean => isSelected(entry.instanceId);
          return (
            <div class="relative w-full">
              <Show when={selected()}>
                <span class={SELECTED_INDICATOR} aria-hidden="true" />
              </Show>
              <button
                type="button"
                data-testid="model-picker-sidebar-instance"
                data-instance-id={entry.instanceId}
                data-driver-kind={entry.driverKind}
                data-selected={selected() ? "true" : "false"}
                data-available={entry.available ? "true" : "false"}
                data-new={hasNewBadge(entry.instanceId) ? "true" : "false"}
                disabled={disabled()}
                class={
                  RAIL_BUTTON +
                  (selected() ? ` ${RAIL_BUTTON_SELECTED}` : "") +
                  (disabled() ? ` ${RAIL_BUTTON_DISABLED}` : "")
                }
                onClick={() => {
                  if (disabled()) return;
                  props.onSelectInstance(entry.instanceId);
                }}
                aria-label={
                  disabled()
                    ? `${entry.displayName} — unavailable`
                    : hasNewBadge(entry.instanceId)
                      ? `${entry.displayName}, new`
                      : entry.displayName
                }
                title={
                  disabled()
                    ? entry.error
                      ? `${entry.displayName} — ${entry.error}`
                      : `${entry.displayName} — unavailable`
                    : entry.displayName
                }
              >
                <ProviderInstanceIcon
                  driverKind={entry.driverKind}
                  displayName={entry.displayName}
                  accentColor={entry.accentColor}
                  status={entry.status}
                  class="size-6"
                />
                <Show when={hasNewBadge(entry.instanceId)}>
                  <span
                    data-testid="model-picker-sidebar-new-badge"
                    class="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-yellow"
                    aria-hidden="true"
                  />
                </Show>
              </button>
            </div>
          );
        }}
      </For>

      <Show when={showComingSoon() && props.comingSoonEntries}>
        {(getEntries) => (
          <For each={getEntries()()}>
            {(soon) => (
              <button
                type="button"
                data-testid="model-picker-sidebar-coming-soon"
                data-id={soon.id}
                data-driver-kind={soon.driverKind}
                class={`${RAIL_BUTTON} ${RAIL_BUTTON_DISABLED}`}
                disabled
                aria-label={`${soon.label} — coming soon`}
                title={`${soon.label} — coming soon`}
              >
                <ProviderInstanceIcon
                  driverKind={soon.driverKind}
                  displayName={soon.label}
                  class="size-6"
                />
                <span
                  class="pointer-events-none absolute -right-0.5 -top-0.5 size-2 rounded-full bg-dim"
                  aria-hidden="true"
                />
              </button>
            )}
          </For>
        )}
      </Show>
    </nav>
  );
}
