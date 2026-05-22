/**
 * Banner rendered between the header (or ProviderStatusBanner, if one is
 * showing) and the messages timeline. Surfaces the most recent thread
 * error pulled OUT of the message stream so the user can scan the
 * transcript without errors confusing the assistant's voice.
 *
 *   ┌─ thread error ────────────────────────────────────────────┐
 *   │  ●  Failed to send: connection refused.   [details] [×]   │
 *   │     ↳ Error: ECONNREFUSED at fetch (api.ts:138:9)         │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Renders nothing when `error` is null. Click the toggle to expand a
 * pre-formatted stack trace (if the host provided one). Dismiss removes
 * the banner for this session — host owns persistence; the banner only
 * fires `onDismiss` so the host can clear its own state.
 */
import { createSignal, Show, type Accessor } from "solid-js";

export interface ThreadError {
  message: string;
  stack?: string;
  /** Optional code (e.g. "network", "providers_fetch_failed") for chip. */
  code?: string;
}

interface ThreadErrorBannerProps {
  error: Accessor<ThreadError | null>;
  onDismiss?: () => void;
}

export function ThreadErrorBanner(props: ThreadErrorBannerProps) {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <Show when={props.error()}>
      {(err) => (
        <div
          data-testid="thread-error-banner"
          data-error-code={err().code ?? ""}
          class="mx-auto flex w-full max-w-3xl flex-col gap-1 border-b border-[var(--border)] bg-[color-mix(in_oklab,var(--red)_8%,transparent)] px-4 py-2 text-base"
        >
          <div class="flex items-start gap-2">
            <span
              aria-hidden="true"
              class="mt-0.5 h-2 w-2 shrink-0 rounded-full"
              style={{ background: "var(--red)" }}
            />
            <div
              class="min-w-0 flex-1 text-[var(--red)]"
              data-testid="thread-error-banner-message"
              title={err().message}
            >
              {err().message}
            </div>
            <Show when={err().stack}>
              <button
                type="button"
                data-testid="thread-error-banner-toggle"
                aria-expanded={expanded()}
                onClick={() => setExpanded((v) => !v)}
                class="h-6 cursor-pointer rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                {expanded() ? "Hide" : "Details"}
              </button>
            </Show>
            <Show when={props.onDismiss}>
              <button
                type="button"
                data-testid="thread-error-banner-dismiss"
                aria-label="Dismiss error"
                onClick={() => props.onDismiss?.()}
                class="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--dim)] hover:text-[var(--fg)]"
              >
                ×
              </button>
            </Show>
          </div>
          <Show when={expanded() && err().stack}>
            <pre
              data-testid="thread-error-banner-stack"
              class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--bg-strong)] px-2 py-1 text-sm leading-relaxed text-[var(--fg-secondary)]"
            >
              {err().stack}
            </pre>
          </Show>
        </div>
      )}
    </Show>
  );
}
