import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type { PermissionOption, PermissionRequest, ToolCallContent } from "../types";

const AUTO_REJECT_MS = 60_000;

/**
 * Button variant per daemon option kind. Replaces the binary
 * allow/reject treatment so the four-state vocabulary the daemon
 * already emits (allow_once / allow_always / reject_once /
 * reject_always) reads as four distinct decisions rather than
 * "green vs red". Approve-once is the typical action and gets the
 * primary slot; reject_always is the strong commit and gets the
 * destructive treatment.
 *
 * Single source of truth for the four-button verdict cluster — the
 * standalone `ComposerPendingApprovalPanel` shape was retired in
 * favor of feeding everything through this dialog (audit §W6).
 */
type OptionVariant = "primary" | "allow-outline" | "reject-outline" | "destructive";

function variantFor(option: PermissionOption): OptionVariant {
  switch (option.kind) {
    case "allow_once":
      return "primary";
    case "allow_always":
      return "allow-outline";
    case "reject_once":
      return "reject-outline";
    case "reject_always":
      return "destructive";
  }
}

const VARIANT_CLASS: Record<OptionVariant, string> = {
  primary: "border-transparent bg-green text-bg hover:opacity-90",
  "allow-outline": "border-green/40 text-green hover:bg-green/10",
  "reject-outline": "border-red/40 text-red hover:bg-red/10",
  destructive: "border-transparent bg-red text-bg hover:opacity-90",
};

function optionClass(option: PermissionOption): string {
  const base =
    "h-9 rounded-md border px-3 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  return `${base} ${VARIANT_CLASS[variantFor(option)]}`;
}

function fallbackRejectOption(options: PermissionOption[]): PermissionOption | null {
  return (
    options.find((option) => option.optionId === "reject_once") ??
    options.find((option) => option.kind.startsWith("reject")) ??
    options[0] ??
    null
  );
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentPreview(content: ToolCallContent[] | null | undefined): string | null {
  const first = content?.[0];
  if (!first) return null;
  if (first.type === "diff") return `${first.path}\n${first.newText}`;
  if (first.type === "terminal") return first.terminalId;
  return previewValue(first.content);
}

export function PermissionDialog(props: {
  pending: Accessor<PermissionRequest | null>;
  onRespond: (optionId: string) => Promise<void>;
}) {
  const [now, setNow] = createSignal(Date.now());
  const [submittingOptionId, setSubmittingOptionId] = createSignal<string | null>(null);
  let dialogRef: HTMLDivElement | undefined;
  let previousFocus: Element | null = null;

  const remainingSeconds = createMemo(() => {
    const pending = props.pending();
    if (!pending) return 0;
    return Math.max(0, Math.ceil((pending.receivedAt + AUTO_REJECT_MS - now()) / 1000));
  });

  const preview = createMemo(() => contentPreview(props.pending()?.toolCall.content));

  async function respond(optionId: string): Promise<void> {
    if (submittingOptionId()) return;
    setSubmittingOptionId(optionId);
    try {
      await props.onRespond(optionId);
    } finally {
      setSubmittingOptionId(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      const option = fallbackRejectOption(props.pending()?.options ?? []);
      if (!option) return;
      event.preventDefault();
      void respond(option.optionId);
      return;
    }
    if (event.key !== "Tab" || !dialogRef) return;
    const focusables = Array.from(
      dialogRef.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [tabindex]:not([tabindex='-1'])",
      ),
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  createEffect(() => {
    const pending = props.pending();
    if (!pending) return;
    setNow(Date.now());
    previousFocus = document.activeElement;
    queueMicrotask(() => dialogRef?.focus());
  });

  createEffect(() => {
    if (props.pending()) return;
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
    previousFocus = null;
  });

  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  return (
    <Show when={props.pending()}>
      {(pending) => (
        <div
          class="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onKeyDown={handleKeyDown}
        >
          <div
            ref={(element) => {
              dialogRef = element;
            }}
            class="w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface-elevated text-fg shadow-2xl outline-none"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-solid-permission-title"
            tabIndex={-1}
          >
            <div class="flex gap-3 border-b border-border-weak p-4">
              <div
                class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-yellow/50 text-[13px] font-bold text-yellow"
                aria-hidden="true"
              >
                !
              </div>
              <div class="min-w-0 flex-1">
                <h2
                  id="chat-solid-permission-title"
                  class="m-0 text-[14px] font-semibold leading-tight text-fg"
                >
                  Permission required
                </h2>
                <p class="mt-1 text-[12px] leading-relaxed text-fg-secondary">
                  Claude wants to: {pending().toolCall.title}
                </p>
              </div>
            </div>

            <div class="grid gap-3 p-4">
              <div class="flex items-center justify-between gap-3 text-[12px] text-dim">
                <span class="flex-shrink-0">Tool</span>
                <code class="min-w-0 truncate font-mono text-[11px] text-fg-secondary">
                  {pending().toolCall.kind ?? pending().toolCall.toolCallId}
                </code>
              </div>
              <Show when={preview()}>
                {(text) => (
                  <pre class="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border-weak bg-bg p-2 font-mono text-[11px] leading-relaxed text-fg-secondary">
                    {text()}
                  </pre>
                )}
              </Show>
            </div>

            <div class="grid grid-cols-2 gap-2 border-t border-border-weak p-3">
              <For each={pending().options}>
                {(option) => (
                  <button
                    type="button"
                    class={optionClass(option)}
                    data-option-id={option.optionId}
                    data-option-kind={option.kind}
                    data-variant={variantFor(option)}
                    disabled={Boolean(submittingOptionId())}
                    onClick={() => void respond(option.optionId)}
                  >
                    {option.name}
                  </button>
                )}
              </For>
            </div>

            <div class="border-t border-border-weak px-4 py-2.5 text-[12px] text-dim">
              Auto-reject in{" "}
              <span class="text-fg" style={{ "font-variant-numeric": "tabular-nums" }}>
                {remainingSeconds()}s
              </span>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
