/**
 * Composer-footer dropdown surfacing per-provider trait knobs:
 * effort, context-window, agent, and boolean toggles (thinking,
 * fast-mode, ...). The shape is provider-agnostic — the host passes
 * a list of trait descriptors and a change handler, this component
 * renders the picker.
 *
 *   ┌─ Composer footer ────────────────────────────────────────┐
 *   │ ...           [ effort: high · context: 200k · thinking on ▾ ] │
 *   └────────────────────────────────────────────────────────────┘
 *
 *   On click:
 *   ┌──────────────────────────┐
 *   │ EFFORT                   │
 *   │   ● low                  │
 *   │   ● medium               │
 *   │   ● high                 │
 *   │ ─────────                │
 *   │ CONTEXT WINDOW           │
 *   │   ● 200k                 │
 *   │   ● 1M                   │
 *   │ ─────────                │
 *   │ THINKING                 │
 *   │   ● On  ● Off            │
 *   └──────────────────────────┘
 *
 * Returns `null` when no descriptors are supplied — render-site can
 * mount unconditionally.
 *
 * Trait state lives entirely with the host. The picker is pure
 * render — every change bubbles via `onTraitChange(id, value)`. The
 * host owns persistence (composer draft store), wire shape
 * (ProviderOptionSelection), and any prompt-injected effort hacks
 * (e.g. ultrathink-via-prompt-prefix).
 */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";

export type TraitDescriptor =
  | {
      id: string;
      label: string;
      type: "select";
      currentValue: string | null;
      options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>;
    }
  | {
      id: string;
      label: string;
      type: "boolean";
      currentValue: boolean;
    };

export interface TraitsPickerProps {
  /**
   * Live trait descriptors. Return an empty array to hide the
   * trigger entirely (the host gets no chrome and the composer
   * footer collapses).
   */
  descriptors: Accessor<ReadonlyArray<TraitDescriptor>>;
  /**
   * Fired on every change. `value` is the option id for selects and
   * a boolean for boolean traits. The picker keeps no internal
   * state — it just reflects `descriptors` back.
   */
  onTraitChange: (descriptorId: string, value: string | boolean) => void;
  /**
   * Optional custom trigger label. Defaults to a `·`-joined list of
   * each descriptor's current value (or "On"/"Off" for booleans).
   */
  triggerLabel?: Accessor<string | null>;
  disabled?: Accessor<boolean>;
  class?: string;
}

function defaultTriggerLabel(descriptors: ReadonlyArray<TraitDescriptor>): string {
  return descriptors
    .map((descriptor) => {
      if (descriptor.type === "boolean") {
        return `${descriptor.label} ${descriptor.currentValue ? "On" : "Off"}`;
      }
      const match = descriptor.options.find((opt) => opt.id === descriptor.currentValue);
      return match?.label ?? descriptor.options[0]?.label ?? "";
    })
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
}

const TRIGGER_CLASS =
  "inline-flex h-7 min-w-0 max-w-56 cursor-pointer items-center gap-1.5 truncate rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--fg-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const POPUP_CLASS =
  "absolute right-0 bottom-[calc(100%+0.25rem)] z-30 min-w-56 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl";

const SECTION_LABEL_CLASS = "px-2 py-1.5 text-xs uppercase tracking-[0.08em] text-[var(--dim)]";

const RADIO_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-[var(--fg)] hover:bg-[var(--surface-hover,var(--surface))] disabled:cursor-not-allowed disabled:opacity-50";

const DIVIDER_CLASS = "my-1 border-t border-[var(--border-weak,var(--border))]";

export function TraitsPicker(props: TraitsPickerProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  const [popup, setPopup] = createSignal<HTMLDivElement>();

  const isDisabled = (): boolean => props.disabled?.() ?? false;
  const descriptors = createMemo(() => props.descriptors());

  function close(): void {
    setOpen(false);
  }

  function toggle(): void {
    if (isDisabled()) return;
    setOpen((value) => !value);
  }

  function onDocPointer(event: PointerEvent): void {
    const triggerEl = trigger();
    const popupEl = popup();
    if (event.target instanceof Node) {
      if (popupEl?.contains(event.target)) return;
      if (triggerEl?.parentElement?.contains(event.target)) return;
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

  const label = createMemo<string>(() => {
    const custom = props.triggerLabel?.();
    if (custom && custom.length > 0) return custom;
    return defaultTriggerLabel(descriptors());
  });

  const selectDescriptors = createMemo(() =>
    descriptors().filter(
      (d): d is Extract<TraitDescriptor, { type: "select" }> => d.type === "select",
    ),
  );

  const booleanDescriptors = createMemo(() =>
    descriptors().filter(
      (d): d is Extract<TraitDescriptor, { type: "boolean" }> => d.type === "boolean",
    ),
  );

  return (
    <Show when={descriptors().length > 0}>
      <div data-testid="traits-picker" class={`relative inline-flex ${props.class ?? ""}`}>
        <button
          ref={setTrigger}
          type="button"
          data-testid="traits-picker-trigger"
          data-open={open() ? "true" : "false"}
          aria-haspopup="menu"
          aria-expanded={open()}
          disabled={isDisabled()}
          onClick={toggle}
          class={TRIGGER_CLASS}
        >
          <span class="min-w-0 truncate">{label() || "Traits"}</span>
          <span aria-hidden="true" class="text-[9px] opacity-60">
            ▾
          </span>
        </button>
        <Show when={open()}>
          <div ref={setPopup} data-testid="traits-picker-menu" role="menu" class={POPUP_CLASS}>
            <For each={selectDescriptors()}>
              {(descriptor, index) => (
                <div>
                  <Show when={index() > 0}>
                    <div class={DIVIDER_CLASS} aria-hidden="true" />
                  </Show>
                  <div
                    role="group"
                    aria-label={descriptor.label}
                    data-testid="traits-picker-section"
                    data-descriptor-id={descriptor.id}
                  >
                    <div class={SECTION_LABEL_CLASS}>{descriptor.label}</div>
                    <For each={descriptor.options}>
                      {(option) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          data-testid="traits-picker-option"
                          data-descriptor-id={descriptor.id}
                          data-value={option.id}
                          data-active={descriptor.currentValue === option.id ? "true" : "false"}
                          aria-checked={descriptor.currentValue === option.id}
                          class={RADIO_ITEM_CLASS}
                          onClick={() => {
                            if (descriptor.currentValue === option.id) {
                              close();
                              return;
                            }
                            props.onTraitChange(descriptor.id, option.id);
                            close();
                          }}
                        >
                          <span
                            aria-hidden="true"
                            class="inline-flex size-3.5 shrink-0 items-center justify-center"
                          >
                            {descriptor.currentValue === option.id ? "●" : "○"}
                          </span>
                          <span class="flex-1">
                            {option.label}
                            <Show when={option.isDefault}>
                              <span class="ml-1 text-xs text-[var(--dim)]">(default)</span>
                            </Show>
                          </span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
            <For each={booleanDescriptors()}>
              {(descriptor, index) => (
                <div>
                  <Show when={index() > 0 || selectDescriptors().length > 0}>
                    <div class={DIVIDER_CLASS} aria-hidden="true" />
                  </Show>
                  <div
                    role="group"
                    aria-label={descriptor.label}
                    data-testid="traits-picker-section"
                    data-descriptor-id={descriptor.id}
                  >
                    <div class={SECTION_LABEL_CLASS}>{descriptor.label}</div>
                    <button
                      type="button"
                      role="menuitemradio"
                      data-testid="traits-picker-option"
                      data-descriptor-id={descriptor.id}
                      data-value="on"
                      data-active={descriptor.currentValue ? "true" : "false"}
                      aria-checked={descriptor.currentValue}
                      class={RADIO_ITEM_CLASS}
                      onClick={() => {
                        if (descriptor.currentValue) {
                          close();
                          return;
                        }
                        props.onTraitChange(descriptor.id, true);
                        close();
                      }}
                    >
                      <span
                        aria-hidden="true"
                        class="inline-flex size-3.5 shrink-0 items-center justify-center"
                      >
                        {descriptor.currentValue ? "●" : "○"}
                      </span>
                      <span class="flex-1">On</span>
                    </button>
                    <button
                      type="button"
                      role="menuitemradio"
                      data-testid="traits-picker-option"
                      data-descriptor-id={descriptor.id}
                      data-value="off"
                      data-active={descriptor.currentValue ? "false" : "true"}
                      aria-checked={!descriptor.currentValue}
                      class={RADIO_ITEM_CLASS}
                      onClick={() => {
                        if (!descriptor.currentValue) {
                          close();
                          return;
                        }
                        props.onTraitChange(descriptor.id, false);
                        close();
                      }}
                    >
                      <span
                        aria-hidden="true"
                        class="inline-flex size-3.5 shrink-0 items-center justify-center"
                      >
                        {descriptor.currentValue ? "○" : "●"}
                      </span>
                      <span class="flex-1">Off</span>
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
