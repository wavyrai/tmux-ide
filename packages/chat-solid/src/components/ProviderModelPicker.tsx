/**
 * Compact provider switcher rendered in the chat header's right-hand
 * slot. Replaces the inline "provider name" badge with a clickable
 * dropdown: the user sees what's currently dispatching, and one click
 * away can switch to any other discovered provider.
 *
 *   ┌─ ChatHeader ──────────────────────────────────────────────┐
 *   │  Thread title  ·  …meters…   [ ⌥ Claude Code  ▾ ]  [Close] │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Provider data flows in via `availableProviders` — the host fetches
 * `/api/chat/providers` (see `ProviderStatusBanner` for the polling
 * variant) and pushes the latest list as a signal. The picker stays
 * dumb: it renders the rows + bubbles `onChange(provider)` upward so
 * the host can issue whatever action it owns (provider switch, thread
 * recreate, etc.). Model selection lands in a follow-up — the wire
 * shape carries `{ kind, name, available }`, not per-provider model
 * arrays yet, so we render providers and stub the model slot.
 */
import { createMemo, createSignal, For, Show, onCleanup, type Accessor } from "solid-js";
import type { AgentProvider } from "../types";
import type { ProviderInfo } from "../api";

interface ProviderModelPickerProps {
  /** Current provider; null until the thread loads. */
  provider: Accessor<AgentProvider | null>;
  /** Discovered providers from `/api/chat/providers`. */
  availableProviders: Accessor<ReadonlyArray<ProviderInfo>>;
  /** Fired when the user picks a different provider in the dropdown. */
  onChange?: (next: AgentProvider) => void;
  /** Optional disabled state (e.g. while a turn is in flight). */
  disabled?: Accessor<boolean>;
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

function labelFor(kind: string | null | undefined): string {
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

export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();

  const activeKind = createMemo(() => props.provider()?.kind ?? null);
  const isDisabled = () => props.disabled?.() ?? false;

  function toggle() {
    if (isDisabled()) return;
    setOpen((v) => !v);
  }

  function close() {
    setOpen(false);
  }

  function select(info: ProviderInfo) {
    if (isDisabled()) return;
    close();
    // Discovery only surfaces built-in kinds (claude-code / codex /
    // gemini). The `custom` variant of AgentProvider requires
    // command+args which discovery doesn't carry — host code never
    // mounts a `custom` provider through this picker.
    const kind = info.kind;
    let next: AgentProvider | null = null;
    if (kind === "claude-code") next = { kind: "claude-code" };
    else if (kind === "codex") next = { kind: "codex" };
    else if (kind === "gemini") next = { kind: "gemini" };
    if (!next) return;
    props.onChange?.(next);
  }

  // Close on outside click + Escape. Listeners are attached only while
  // open so the picker stays cheap when nobody's interacting with it.
  function onDocPointer(event: PointerEvent) {
    const el = trigger();
    if (!el) return;
    if (event.target instanceof Node && el.parentElement?.contains(event.target)) return;
    close();
  }
  function onDocKey(event: KeyboardEvent) {
    if (event.key === "Escape") close();
  }
  // eslint-disable-next-line solid/reactivity
  createMemo(() => {
    if (!open()) return;
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onDocKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onDocKey);
    });
  });

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
        class="inline-flex h-7 max-w-48 cursor-pointer items-center gap-1.5 truncate rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[12px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden="true" class="text-[var(--accent)]">
          {glyphFor(activeKind())}
        </span>
        <span class="truncate">{labelFor(activeKind())}</span>
        <span aria-hidden="true" class="text-[10px] opacity-60">
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div
          data-testid="provider-model-picker-menu"
          role="listbox"
          aria-label="Available providers"
          class="absolute right-0 top-[calc(100%+0.25rem)] z-30 min-w-56 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-elevated,var(--bg-strong))] shadow-2xl"
        >
          <Show
            when={props.availableProviders().length > 0}
            fallback={
              <div
                data-testid="provider-model-picker-empty"
                class="px-3 py-4 text-center text-[12px] text-[var(--dim)]"
              >
                No providers discovered
              </div>
            }
          >
            <ul class="m-0 list-none p-1">
              <For each={props.availableProviders()}>
                {(info) => {
                  const isActive = () => info.kind === activeKind();
                  return (
                    <li>
                      <button
                        type="button"
                        role="option"
                        data-testid="provider-model-picker-option"
                        data-kind={info.kind}
                        data-active={isActive() ? "true" : "false"}
                        data-available={info.available ? "true" : "false"}
                        aria-selected={isActive()}
                        onClick={() => select(info)}
                        class={
                          "flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-[12px] text-[var(--fg)] hover:bg-[var(--surface-hover)] " +
                          (isActive() ? "bg-[var(--surface-active)] " : "")
                        }
                      >
                        <span aria-hidden="true" class="w-4 text-center text-[var(--accent)]">
                          {glyphFor(info.kind)}
                        </span>
                        <span class="min-w-0 flex-1 truncate">
                          <span class="block truncate">{info.name || labelFor(info.kind)}</span>
                          <Show when={info.version || info.description}>
                            <span class="block truncate text-[10px] text-[var(--dim)]">
                              {info.version ? `v${info.version}` : info.description}
                            </span>
                          </Show>
                        </span>
                        <span
                          aria-hidden="true"
                          class="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            background: info.available ? "var(--green)" : "var(--red)",
                          }}
                          title={info.available ? "available" : (info.error ?? "unavailable")}
                        />
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
          <div class="border-t border-[var(--border-weak,var(--border))] px-3 py-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
            Provider · ↩ select · Esc close
          </div>
        </div>
      </Show>
    </div>
  );
}
