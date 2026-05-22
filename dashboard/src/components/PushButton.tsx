/**
 * Push button — small affordance next to the StatusBar BranchPicker.
 * Pushes the current branch to its upstream (defaults to `origin`).
 * On 'auth_failed' or 'no_remote', shows a transient toast-style label
 * the user can act on (e.g. "Sign in with gh").
 */

import { createSignal, Show } from "solid-js";
import { Effect, Exit, Cause } from "effect";
import { Upload } from "lucide-solid";
import type { GitErrorPayload } from "@tmux-ide/contracts";
import { pushBranch, GitApiError } from "@/lib/git";

interface PushButtonProps {
  sessionName: string;
  /** When set, the button shows ↑<ahead> as its hint. Hidden when 0. */
  ahead?: number;
  /** Fired after a successful push so the host can refetch status. */
  onPushed?: () => void;
}

function messageForError(err: GitErrorPayload): string {
  switch (err.type) {
    case "auth_failed":
      return "Authentication failed";
    case "no_remote":
      return "No remote configured";
    case "network_error":
      return "Network error";
    case "rejected":
      return "Push rejected (non-fast-forward)";
    case "hook_rejected":
      return "Push hook rejected";
    case "error":
    default:
      return (err as { message?: string }).message ?? "Push failed";
  }
}

export function PushButton(props: PushButtonProps) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  async function push() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const exit = await Effect.runPromiseExit(pushBranch(props.sessionName, { setUpstream: true }));
    setBusy(false);
    if (Exit.isSuccess(exit)) {
      setSuccess(`Pushed ${exit.value.branch} → ${exit.value.remote}`);
      props.onPushed?.();
      // Clear the success label after a beat so the chip returns to neutral.
      window.setTimeout(() => setSuccess(null), 2500);
      return;
    }
    const f = Cause.failureOption(exit.cause);
    const payload: GitErrorPayload =
      f._tag === "Some" && f.value instanceof GitApiError
        ? f.value.payload
        : { type: "error", message: Cause.pretty(exit.cause) };
    setError(messageForError(payload));
    window.setTimeout(() => setError(null), 4000);
  }

  return (
    <>
      <button
        type="button"
        data-testid="status-bar-push"
        onClick={() => void push()}
        disabled={busy()}
        title={
          props.ahead && props.ahead > 0
            ? `Push ${props.ahead} commit${props.ahead === 1 ? "" : "s"}`
            : "Push current branch"
        }
        class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[var(--dim)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.08))] hover:text-[var(--fg)] disabled:opacity-50"
      >
        <Upload aria-hidden="true" size={12} />
        <Show when={(props.ahead ?? 0) > 0}>
          <span class="text-xs tabular-nums">↑{props.ahead}</span>
        </Show>
        <Show when={busy()}>
          <span class="text-xs">…</span>
        </Show>
      </button>
      <Show when={success()}>
        <span data-testid="status-bar-push-success" class="text-xs text-[var(--accent)]">
          {success()}
        </span>
      </Show>
      <Show when={error()}>
        <span data-testid="status-bar-push-error" class="text-xs text-[var(--danger,#d34)]">
          {error()}
        </span>
      </Show>
    </>
  );
}
