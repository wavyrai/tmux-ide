import { createSignal, Show, type JSX } from "solid-js";

/**
 * Hover-revealed copy button shown next to assistant messages on the
 * flat transcript. One click pushes `text` to the clipboard via
 * `navigator.clipboard.writeText` and flashes a "copied" state for
 * 1.5s so the user gets feedback without a toast.
 *
 * Visual is icon-only by design — the flat transcript stays quiet,
 * actions reveal on hover via the surrounding row's `group/...`
 * Tailwind utility.
 */

export interface MessageCopyButtonProps {
  /** Text payload to copy. Empty / whitespace-only renders nothing. */
  text: string;
  /** Optional className passthrough. Used by callers to scope hover state. */
  class?: string;
  /** Optional explicit aria-label. Defaults to "Copy message". */
  ariaLabel?: string;
  /**
   * Optional override for the navigator.clipboard.writeText impl —
   * lets tests inject a stub without poking jsdom's clipboard API.
   * Resolves to whatever the real call resolves to.
   */
  write?: (text: string) => Promise<void>;
}

const COPIED_RESET_MS = 1500;

export function MessageCopyButton(props: MessageCopyButtonProps): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const [error, setError] = createSignal(false);

  const empty = () => props.text == null || props.text.trim().length === 0;

  async function handleClick() {
    if (empty()) return;
    setError(false);
    try {
      const writer = props.write ?? ((text: string) => navigator.clipboard.writeText(text));
      await writer(props.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      setError(true);
      window.setTimeout(() => setError(false), COPIED_RESET_MS);
    }
  }

  return (
    <Show when={!empty()}>
      <button
        type="button"
        data-testid="message-copy-button"
        data-copied={copied() ? "true" : "false"}
        data-error={error() ? "true" : "false"}
        onClick={handleClick}
        aria-label={props.ariaLabel ?? "Copy message"}
        title={copied() ? "Copied" : error() ? "Copy failed" : "Copy"}
        class={
          "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--border-weak,var(--border))] bg-transparent text-[var(--fg-muted,var(--fg-secondary))] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-hover,var(--bg-strong))] hover:text-[var(--fg)] " +
          (props.class ?? "")
        }
      >
        <Show
          when={copied()}
          fallback={
            <Show
              when={error()}
              fallback={
                <span aria-hidden="true" class="text-[11px] leading-none">
                  ⧉
                </span>
              }
            >
              <span aria-hidden="true" class="text-[11px] leading-none">
                ✕
              </span>
            </Show>
          }
        >
          <span aria-hidden="true" class="text-[11px] leading-none">
            ✓
          </span>
        </Show>
      </button>
    </Show>
  );
}
