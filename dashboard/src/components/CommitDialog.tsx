/**
 * CommitDialog — compose a commit message + stage selected paths + run
 * `git commit`. Opens from DiffsView's "Commit" button. The Solid host
 * passes the changed-file list in (already split into staged +
 * unstaged); the dialog decides what ends up staged before the commit
 * call.
 *
 * Wire flow:
 *   1. User adjusts checkbox selection (already-staged rows start
 *      checked; unstaged rows can be toggled in).
 *   2. Submit → `stagePaths()` for newly-checked rows → `commit({
 *      message })` → `onCommitted(sha)`.
 *
 * Errors surface inline using the daemon's `GitErrorPayload` so the
 * copy is intent-specific.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Effect, Exit, Cause } from "effect";
import type { GitChange, GitErrorPayload } from "@tmux-ide/contracts";
import { commitChanges, GitApiError, stagePaths } from "@/lib/git";

interface ChangedRow {
  path: string;
  status: GitChange["status"];
  /** True when the path is already in the index. */
  staged: boolean;
}

interface CommitDialogProps {
  sessionName: string;
  open: boolean;
  staged: ReadonlyArray<GitChange>;
  unstaged: ReadonlyArray<GitChange>;
  onClose: () => void;
  onCommitted?: (sha: string) => void;
}

function gitErrorMessage(err: GitErrorPayload): string {
  switch (err.type) {
    case "nothing_to_commit":
      return "Nothing to commit — select at least one file.";
    case "hook_rejected":
      return `Hook rejected: ${err.message}`;
    case "auth_failed":
      return "Authentication failed";
    case "not_git_repo":
      return "Not a git repository";
    case "error":
    default:
      return (err as { message?: string }).message ?? "Commit failed";
  }
}

export function CommitDialog(props: CommitDialogProps) {
  const [message, setMessage] = createSignal("");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const rows = createMemo<ChangedRow[]>(() => {
    const seen = new Set<string>();
    const merged: ChangedRow[] = [];
    for (const s of props.staged) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      merged.push({ path: s.path, status: s.status, staged: true });
    }
    for (const u of props.unstaged) {
      if (seen.has(u.path)) continue;
      seen.add(u.path);
      merged.push({ path: u.path, status: u.status, staged: false });
    }
    return merged;
  });

  // Default selection: every staged path + nothing from unstaged. Re-
  // computed when the dialog opens so prior selections don't leak
  // across sessions.
  function syncDefaultSelection() {
    const next = new Set<string>();
    for (const r of rows()) {
      if (r.staged) next.add(r.path);
    }
    setSelected(next);
    setError(null);
    setMessage("");
  }

  let prevOpen = false;
  createEffect(() => {
    if (props.open && !prevOpen) syncDefaultSelection();
    prevOpen = props.open;
  });

  function toggle(path: string) {
    const next = new Set(selected());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  }

  async function submit() {
    const trimmed = message().trim();
    if (!trimmed) {
      setError("Commit message is required.");
      return;
    }
    const picks = rows().filter((r) => selected().has(r.path));
    if (picks.length === 0) {
      setError("Select at least one file to commit.");
      return;
    }
    setBusy(true);
    setError(null);

    // Stage any newly-selected unstaged paths first. We don't unstage
    // currently-staged-but-deselected paths automatically — that's
    // explicit work for a future "discard staged" affordance.
    const toStage = picks.filter((p) => !p.staged).map((p) => p.path);
    if (toStage.length > 0) {
      const stageExit = await Effect.runPromiseExit(stagePaths(props.sessionName, toStage));
      if (Exit.isFailure(stageExit)) {
        setBusy(false);
        const f = Cause.failureOption(stageExit.cause);
        const payload: GitErrorPayload =
          f._tag === "Some" && f.value instanceof GitApiError
            ? f.value.payload
            : { type: "error", message: Cause.pretty(stageExit.cause) };
        setError(gitErrorMessage(payload));
        return;
      }
    }

    const exit = await Effect.runPromiseExit(
      commitChanges(props.sessionName, { message: trimmed }),
    );
    setBusy(false);
    if (Exit.isSuccess(exit)) {
      props.onCommitted?.(exit.value.sha);
      props.onClose();
      return;
    }
    const f = Cause.failureOption(exit.cause);
    const payload: GitErrorPayload =
      f._tag === "Some" && f.value instanceof GitApiError
        ? f.value.payload
        : { type: "error", message: Cause.pretty(exit.cause) };
    setError(gitErrorMessage(payload));
  }

  return (
    <Show when={props.open}>
      <div
        data-testid="commit-dialog-overlay"
        class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy()) props.onClose();
        }}
      >
        <div
          data-testid="commit-dialog"
          class="flex w-[min(560px,92vw)] max-h-[85vh] flex-col rounded-md border border-[var(--border)] bg-[var(--bg)] text-[12px] text-[var(--fg)] shadow-2xl"
        >
          <header class="flex items-center gap-2 border-b border-[var(--border-weak,var(--border))] px-3 py-2">
            <span class="text-[10px] uppercase tracking-wider text-[var(--dim)]">Commit</span>
            <span class="ml-auto text-[10px] text-[var(--dim)] tabular-nums">
              {selected().size}/{rows().length}
            </span>
          </header>

          <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
            <label class="flex flex-col gap-1">
              <span class="text-[10px] uppercase tracking-wider text-[var(--dim)]">Message</span>
              <textarea
                data-testid="commit-dialog-message"
                value={message()}
                onInput={(e) => setMessage(e.currentTarget.value)}
                rows={4}
                placeholder="Describe the change…"
                disabled={busy()}
                class="resize-y rounded border border-[var(--border)] bg-[var(--bg-weak,var(--bg))] px-2 py-1 font-mono text-[12px] text-[var(--fg)]"
              />
            </label>

            <div class="flex min-h-0 flex-1 flex-col gap-1">
              <span class="text-[10px] uppercase tracking-wider text-[var(--dim)]">Files</span>
              <div
                data-testid="commit-dialog-files"
                class="min-h-0 flex-1 overflow-y-auto rounded border border-[var(--border-weak,var(--border))]"
              >
                <Show
                  when={rows().length > 0}
                  fallback={
                    <div data-empty-state class="px-2 py-3 text-center text-[var(--dim)]">
                      — no changes —
                    </div>
                  }
                >
                  <For each={rows()}>
                    {(row) => (
                      <label
                        data-testid={`commit-dialog-row-${row.path}`}
                        data-staged={row.staged ? "true" : "false"}
                        class="flex items-center gap-2 border-b border-[var(--border-weak,var(--border))] px-2 py-1 last:border-b-0 hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))]"
                      >
                        <input
                          type="checkbox"
                          data-testid={`commit-dialog-check-${row.path}`}
                          checked={selected().has(row.path)}
                          disabled={busy()}
                          onChange={() => toggle(row.path)}
                        />
                        <span class="w-12 text-[10px] uppercase text-[var(--dim)]">
                          {row.status}
                        </span>
                        <span class="flex-1 truncate font-mono" title={row.path}>
                          {row.path}
                        </span>
                        <Show when={row.staged}>
                          <span class="text-[9px] uppercase tracking-wider text-[var(--accent)]">
                            staged
                          </span>
                        </Show>
                      </label>
                    )}
                  </For>
                </Show>
              </div>
            </div>

            <Show when={error()}>
              <div
                data-testid="commit-dialog-error"
                class="rounded border border-[var(--danger,#d34)] bg-[var(--danger,#d34)]/10 px-2 py-1 text-[var(--danger,#d34)]"
              >
                {error()}
              </div>
            </Show>
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-[var(--border-weak,var(--border))] px-3 py-2">
            <button
              type="button"
              data-testid="commit-dialog-cancel"
              onClick={() => props.onClose()}
              disabled={busy()}
              class="rounded border border-[var(--border)] px-3 py-1 hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="commit-dialog-submit"
              onClick={() => void submit()}
              disabled={busy()}
              class="rounded border border-[var(--accent)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] hover:opacity-90 disabled:opacity-50"
            >
              {busy() ? "Committing…" : "Commit"}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}
