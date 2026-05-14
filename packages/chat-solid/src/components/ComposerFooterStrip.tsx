/**
 * Wide-screen composer footer — inline trio of Mode toggle, Runtime
 * mode select, and (optional) Plan sidebar toggle, rendered as a
 * horizontal strip with thin separators between sections.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  ⌁ Chat │ ● Supervised ▾ │ ☰ Roadmap                      │
 *   └──────────────────────────────────────────────────────────┘
 *
 * This is the wide-viewport companion to `CompactComposerControlsMenu`
 * — `ChatComposer` swaps between them via the
 * `useResponsiveFooter` prop based on the form's measured width.
 * Both expose the same callback surface so the host can wire one
 * set of handlers and let the composer pick the chrome.
 *
 * Pure render — no internal state. Every change bubbles via the
 * same `onToggleInteractionMode` / `onTogglePlanSidebar` /
 * `onRuntimeModeChange` callbacks the popover already calls, so a
 * future host can drop a `CompactComposerControlsMenu` in for the
 * strip (or vice versa) without rewiring.
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
import type { ProviderInteractionMode, RuntimeMode } from "./CompactComposerControlsMenu";

export interface ComposerFooterStripProps {
  activePlan: Accessor<boolean>;
  interactionMode: Accessor<ProviderInteractionMode>;
  planSidebarLabel: Accessor<string>;
  planSidebarOpen: Accessor<boolean>;
  runtimeMode: Accessor<RuntimeMode>;
  showInteractionModeToggle: Accessor<boolean>;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  class?: string;
}

interface RuntimeModeOption {
  value: RuntimeMode;
  label: string;
  glyph: string;
  hint: string;
}

const RUNTIME_OPTIONS: ReadonlyArray<RuntimeModeOption> = [
  {
    value: "approval-required",
    label: "Supervised",
    glyph: "◯",
    hint: "Ask before every tool call.",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    glyph: "◐",
    hint: "Accept file edits automatically; still ask before destructive commands.",
  },
  {
    value: "full-access",
    label: "Full access",
    glyph: "●",
    hint: "Accept every action without prompting.",
  },
];

const SECTION_BUTTON =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-[11px] font-medium text-fg-secondary transition-colors hover:bg-[var(--surface-hover,var(--surface))] hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

const SECTION_BUTTON_ACTIVE = "bg-[var(--surface-active,var(--surface))] text-fg";

const SEPARATOR_CLASS = "mx-0.5 hidden h-3.5 w-px bg-border-weak sm:block";

const SELECT_TRIGGER =
  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-[11px] font-medium text-fg-secondary transition-colors hover:bg-[var(--surface-hover,var(--surface))] hover:text-fg";

const SELECT_POPUP =
  "absolute left-0 bottom-[calc(100%+0.25rem)] z-30 min-w-56 overflow-hidden rounded-md border border-border bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl";

const SELECT_ITEM =
  "flex w-full cursor-pointer items-start gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-fg hover:bg-[var(--surface-hover,var(--surface))]";

export function ComposerFooterStrip(props: ComposerFooterStripProps): JSX.Element {
  const [runtimeOpen, setRuntimeOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  const [popup, setPopup] = createSignal<HTMLDivElement>();

  const activeRuntime = (): RuntimeModeOption =>
    RUNTIME_OPTIONS.find((opt) => opt.value === props.runtimeMode()) ?? RUNTIME_OPTIONS[0]!;

  function closeRuntime(): void {
    setRuntimeOpen(false);
  }

  function onDocPointer(event: PointerEvent): void {
    const triggerEl = trigger();
    const popupEl = popup();
    if (event.target instanceof Node) {
      if (popupEl?.contains(event.target)) return;
      if (triggerEl?.parentElement?.contains(event.target)) return;
    }
    closeRuntime();
  }

  function onDocKey(event: KeyboardEvent): void {
    if (event.key === "Escape") closeRuntime();
  }

  createEffect(
    on(runtimeOpen, (isOpen) => {
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
    <div data-testid="composer-footer-strip" class={`flex items-center gap-1 ${props.class ?? ""}`}>
      <Show when={props.showInteractionModeToggle()}>
        {(() => {
          const isPlan = (): boolean => props.interactionMode() === "plan";
          return (
            <button
              type="button"
              data-testid="composer-footer-strip-mode"
              data-mode={props.interactionMode()}
              class={SECTION_BUTTON}
              onClick={() => props.onToggleInteractionMode()}
              title={
                isPlan()
                  ? "Plan mode — click to return to default build mode"
                  : "Default mode — click to enter plan mode"
              }
            >
              <span aria-hidden="true" class="text-[12px]">
                {isPlan() ? "✎" : "⌁"}
              </span>
              <span class="hidden sm:inline">{isPlan() ? "Plan" : "Build"}</span>
            </button>
          );
        })()}
        <span class={SEPARATOR_CLASS} aria-hidden="true" />
      </Show>

      <div class="relative inline-flex">
        <button
          ref={setTrigger}
          type="button"
          data-testid="composer-footer-strip-runtime-trigger"
          data-open={runtimeOpen() ? "true" : "false"}
          aria-haspopup="menu"
          aria-expanded={runtimeOpen()}
          aria-label="Runtime mode"
          title={activeRuntime().hint}
          class={SELECT_TRIGGER}
          onClick={() => setRuntimeOpen((value) => !value)}
        >
          <span aria-hidden="true" class="text-[12px]">
            {activeRuntime().glyph}
          </span>
          <span>{activeRuntime().label}</span>
          <span aria-hidden="true" class="text-[9px] opacity-60">
            ▾
          </span>
        </button>
        <Show when={runtimeOpen()}>
          <div
            ref={setPopup}
            data-testid="composer-footer-strip-runtime-menu"
            role="menu"
            class={SELECT_POPUP}
          >
            <For each={RUNTIME_OPTIONS}>
              {(option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  data-testid="composer-footer-strip-runtime-option"
                  data-value={option.value}
                  data-active={props.runtimeMode() === option.value ? "true" : "false"}
                  aria-checked={props.runtimeMode() === option.value}
                  class={SELECT_ITEM}
                  onClick={() => {
                    if (props.runtimeMode() !== option.value) {
                      props.onRuntimeModeChange(option.value);
                    }
                    closeRuntime();
                  }}
                >
                  <span aria-hidden="true" class="mt-0.5 w-4 text-center text-fg-secondary">
                    {option.glyph}
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="text-[12px] font-medium text-fg">{option.label}</div>
                    <div class="text-[11px] leading-snug text-dim">{option.hint}</div>
                  </div>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.activePlan()}>
        <span class={SEPARATOR_CLASS} aria-hidden="true" />
        <button
          type="button"
          data-testid="composer-footer-strip-plan"
          data-open={props.planSidebarOpen() ? "true" : "false"}
          class={SECTION_BUTTON + (props.planSidebarOpen() ? ` ${SECTION_BUTTON_ACTIVE}` : "")}
          onClick={() => props.onTogglePlanSidebar()}
          title={
            props.planSidebarOpen()
              ? `Hide ${props.planSidebarLabel().toLowerCase()} sidebar`
              : `Show ${props.planSidebarLabel().toLowerCase()} sidebar`
          }
        >
          <span aria-hidden="true" class="text-[12px]">
            ☰
          </span>
          <span class="hidden sm:inline">{props.planSidebarLabel()}</span>
        </button>
      </Show>
    </div>
  );
}
