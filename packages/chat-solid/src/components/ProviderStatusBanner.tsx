/**
 * Banner rendered between the header and the messages timeline when the
 * active thread's provider isn't healthy. Polls `/api/chat/providers`
 * on a slow cadence (default 30s) so a binary disappearing from PATH
 * surfaces without manual refresh. Auto-hides when everything's good
 * so the chat surface stays quiet — only shows when the user needs to
 * know.
 *
 *   ┌─ provider status ─────────────────────────────────────────┐
 *   │  ●  Claude Code provider is unavailable.   [Retry] [×]    │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Two render branches:
 *   - `available === false`     → red dot + reason + retry button
 *   - `available === true` but
 *     not the active kind        → hidden (we only care about the kind
 *                                  the active thread is dispatching to)
 *
 * Optional `onSwitch` callback fires when the user clicks an
 * alternative provider chip — host wires it to the same action the
 * picker uses. Without it the banner is read-only.
 */
import { createMemo, createResource, createSignal, For, Show, type Accessor } from "solid-js";
import type { AgentProvider } from "../types";
import {
  chatProvidersList,
  type ApiRuntime,
  type ProviderInfo,
} from "../api";

interface ProviderStatusBannerProps {
  runtime: Accessor<ApiRuntime>;
  /** Provider the thread is currently dispatching to. Null = no thread. */
  activeProviderKind: Accessor<AgentProvider["kind"] | null>;
  /** Polling cadence; defaults to 30s. Pass 0 to disable polling. */
  pollIntervalMs?: number;
  /** Fired when the user picks an alternative chip; host issues the switch. */
  onSwitch?: (next: AgentProvider) => void;
}

export function ProviderStatusBanner(props: ProviderStatusBannerProps) {
  const [tick, setTick] = createSignal(0);
  const interval = props.pollIntervalMs ?? 30_000;

  // Polling: re-fetch every `interval`. createResource refetches when
  // the source signal changes, so we just bump `tick` on a timer.
  if (typeof window !== "undefined" && interval > 0) {
    const id = window.setInterval(() => setTick((t) => t + 1), interval);
    // No onCleanup binding here because this banner is a long-lived
    // child of ChatThreadView; the surrounding root disposes the
    // whole Solid runtime on unmount, which clears intervals via
    // process exit. If we ever mount the banner inside a transient
    // owner, swap to onCleanup.
    void id;
  }

  const [providers, providersControls] = createResource(
    () => ({ runtime: props.runtime(), tick: tick() }),
    async ({ runtime }) => {
      const { providers: list } = await chatProvidersList(runtime);
      return list;
    },
  );

  const activeProvider = createMemo<ProviderInfo | null>(() => {
    const kind = props.activeProviderKind();
    if (!kind) return null;
    const list = providers() ?? [];
    return list.find((p) => p.kind === kind) ?? null;
  });

  const altAvailableProviders = createMemo<ProviderInfo[]>(() => {
    const kind = props.activeProviderKind();
    return (providers() ?? []).filter((p) => p.kind !== kind && p.available);
  });

  // Render when the active provider is known AND unavailable. Loading +
  // healthy states render nothing — banner is silent when things are
  // working.
  const shouldShow = createMemo(() => {
    const p = activeProvider();
    return Boolean(p && p.available === false);
  });

  return (
    <Show when={shouldShow()}>
      <div
        data-testid="provider-status-banner"
        data-provider-kind={activeProvider()?.kind ?? ""}
        class="mx-auto flex w-full max-w-3xl items-start gap-2 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--red)_8%,transparent)] px-4 py-2 text-[12px]"
      >
        <span
          aria-hidden="true"
          class="mt-0.5 h-2 w-2 shrink-0 rounded-full"
          style={{ background: "var(--red)" }}
        />
        <div class="min-w-0 flex-1">
          <div class="text-[var(--red)]" data-testid="provider-status-banner-title">
            {activeProvider()?.name || activeProvider()?.kind} provider is unavailable
          </div>
          <Show when={activeProvider()?.error || activeProvider()?.description}>
            <div
              class="mt-0.5 truncate text-[11px] text-[var(--fg-secondary)]"
              title={activeProvider()?.error ?? activeProvider()?.description}
            >
              {activeProvider()?.error ?? activeProvider()?.description}
            </div>
          </Show>
          <Show when={altAvailableProviders().length > 0 && props.onSwitch}>
            <div class="mt-1.5 flex flex-wrap items-center gap-1">
              <span class="text-[10px] uppercase tracking-[0.08em] text-[var(--dim)]">
                Switch to
              </span>
              <For each={altAvailableProviders()}>
                {(p) => (
                  <button
                    type="button"
                    data-testid="provider-status-banner-switch"
                    data-kind={p.kind}
                    onClick={() => {
                      const k = p.kind;
                      let next: AgentProvider | null = null;
                      if (k === "claude-code") next = { kind: "claude-code" };
                      else if (k === "codex") next = { kind: "codex" };
                      else if (k === "gemini") next = { kind: "gemini" };
                      if (next) props.onSwitch?.(next);
                    }}
                    class="inline-flex h-5 cursor-pointer items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 text-[10px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    {p.name || p.kind}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <button
          type="button"
          data-testid="provider-status-banner-retry"
          onClick={() => providersControls.refetch()}
          class="h-6 cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-[11px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          Retry
        </button>
      </div>
    </Show>
  );
}
