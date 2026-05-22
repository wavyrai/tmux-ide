/**
 * Compact footer menu rendered next to the primary actions when
 * the composer is collapsed (or always on small viewports). Holds:
 *
 *   - Mode toggle: Chat | Plan (single-select)
 *   - Access (runtime mode): Supervised | Auto-accept edits | Full access
 *   - Optional plan-sidebar visibility entry (when a plan is active)
 *   - Optional `traitsMenuContent` slot above the dividers — host
 *     supplies the traits picker UI for the active provider
 *
 * Opens a popover anchored to the trigger; outside-click / Escape
 * close. Pure-render — every state change bubbles to the host via
 * callbacks so the composer doesn't need to know about the wire
 * shape behind interaction mode or runtime mode.
 */

import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  type Accessor,
  type JSX,
} from "solid-js";

export type ProviderInteractionMode = "default" | "plan";
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

export interface CompactComposerControlsMenuProps {
  activePlan: Accessor<boolean>;
  interactionMode: Accessor<ProviderInteractionMode>;
  planSidebarLabel: Accessor<string>;
  planSidebarOpen: Accessor<boolean>;
  runtimeMode: Accessor<RuntimeMode>;
  showInteractionModeToggle: Accessor<boolean>;
  /**
   * Optional traits slot rendered above the Mode group with a
   * divider. Host supplies a fragment of menu items wired to the
   * active provider's traits picker (effort / context window /
   * model-specific knobs).
   */
  traitsMenuContent?: Accessor<JSX.Element | null>;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}

const MODE_OPTIONS: ReadonlyArray<{ value: ProviderInteractionMode; label: string }> = [
  { value: "default", label: "Chat" },
  { value: "plan", label: "Plan" },
];

const RUNTIME_OPTIONS: ReadonlyArray<{ value: RuntimeMode; label: string }> = [
  { value: "approval-required", label: "Supervised" },
  { value: "auto-accept-edits", label: "Auto-accept edits" },
  { value: "full-access", label: "Full access" },
];

const TRIGGER_CLASS =
  "inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-border bg-surface text-fg-secondary transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45";

const POPUP_CLASS =
  "absolute right-0 bottom-[calc(100%+0.25rem)] z-30 min-w-56 overflow-hidden rounded-md border border-border bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl";

const SECTION_LABEL_CLASS = "px-2 py-1.5 text-xs uppercase tracking-[0.08em] text-dim";

const RADIO_ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-fg hover:bg-[var(--surface-hover,var(--surface))] disabled:cursor-not-allowed";

const DIVIDER_CLASS = "my-1 border-t border-border-weak";

export function CompactComposerControlsMenu(props: CompactComposerControlsMenuProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  const [popup, setPopup] = createSignal<HTMLDivElement>();

  function close(): void {
    setOpen(false);
  }

  function toggle(): void {
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

  return (
    <div data-testid="compact-composer-controls" class="relative inline-flex">
      <button
        ref={setTrigger}
        type="button"
        data-testid="compact-composer-controls-trigger"
        data-open={open() ? "true" : "false"}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-label="More composer controls"
        class={TRIGGER_CLASS}
        onClick={toggle}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      <Show when={open()}>
        <div
          ref={setPopup}
          data-testid="compact-composer-controls-menu"
          role="menu"
          class={POPUP_CLASS}
        >
          <Show when={props.traitsMenuContent?.() ?? null}>
            {(content) => (
              <>
                <div data-testid="compact-composer-controls-traits" class="p-1">
                  {content()}
                </div>
                <div class={DIVIDER_CLASS} aria-hidden="true" />
              </>
            )}
          </Show>

          <Show when={props.showInteractionModeToggle()}>
            <div role="group" aria-label="Mode">
              <div class={SECTION_LABEL_CLASS}>Mode</div>
              <For each={MODE_OPTIONS}>
                {(option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    data-testid="compact-composer-controls-mode-option"
                    data-value={option.value}
                    data-active={props.interactionMode() === option.value ? "true" : "false"}
                    aria-checked={props.interactionMode() === option.value}
                    class={RADIO_ITEM_CLASS}
                    onClick={() => {
                      if (props.interactionMode() === option.value) return;
                      props.onToggleInteractionMode();
                      close();
                    }}
                  >
                    <span
                      aria-hidden="true"
                      class="inline-flex size-3.5 shrink-0 items-center justify-center"
                    >
                      {props.interactionMode() === option.value ? "●" : "○"}
                    </span>
                    <span class="flex-1">{option.label}</span>
                  </button>
                )}
              </For>
              <div class={DIVIDER_CLASS} aria-hidden="true" />
            </div>
          </Show>

          <div role="group" aria-label="Access">
            <div class={SECTION_LABEL_CLASS}>Access</div>
            <For each={RUNTIME_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  data-testid="compact-composer-controls-runtime-option"
                  data-value={option.value}
                  data-active={props.runtimeMode() === option.value ? "true" : "false"}
                  aria-checked={props.runtimeMode() === option.value}
                  class={RADIO_ITEM_CLASS}
                  onClick={() => {
                    if (props.runtimeMode() === option.value) return;
                    props.onRuntimeModeChange(option.value);
                    close();
                  }}
                >
                  <span
                    aria-hidden="true"
                    class="inline-flex size-3.5 shrink-0 items-center justify-center"
                  >
                    {props.runtimeMode() === option.value ? "●" : "○"}
                  </span>
                  <span class="flex-1">{option.label}</span>
                </button>
              )}
            </For>
          </div>

          <Show when={props.activePlan()}>
            <div class={DIVIDER_CLASS} aria-hidden="true" />
            <button
              type="button"
              role="menuitem"
              data-testid="compact-composer-controls-plan-sidebar"
              class={RADIO_ITEM_CLASS}
              onClick={() => {
                props.onTogglePlanSidebar();
                close();
              }}
            >
              <span
                aria-hidden="true"
                class="inline-flex size-3.5 shrink-0 items-center justify-center"
              >
                ☰
              </span>
              <span class="flex-1">
                {props.planSidebarOpen()
                  ? `Hide ${props.planSidebarLabel().toLowerCase()} sidebar`
                  : `Show ${props.planSidebarLabel().toLowerCase()} sidebar`}
              </span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
