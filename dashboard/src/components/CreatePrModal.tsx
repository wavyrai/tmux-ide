/**
 * Create-PR modal (G18-P2).
 *
 * Lists local branches as base candidates (via `useBranches`), accepts
 * a title + body + draft flag, and posts to `/api/.../git/pr`. The
 * daemon picks `gh pr create` when available and falls back to the
 * REST API. The modal surfaces `gh_unavailable / not_authenticated /
 * head_not_pushed / pr_already_exists / validation_failed` with
 * intent-specific copy so the user can act.
 */

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Effect, Exit, Cause } from "effect";
import type { GitHubErrorPayload } from "@tmux-ide/contracts";
import { createPullRequest, GitHubApiError, useBranches } from "@/lib/git";

interface CreatePrModalProps {
  sessionName: string;
  open: boolean;
  /** Pre-filled head branch. Defaults to the current branch from the
   *  branches resource if omitted. */
  initialHead?: string | null;
  onClose: () => void;
  onCreated?: (url: string) => void;
}

function messageForError(err: GitHubErrorPayload): string {
  switch (err.type) {
    case "gh_unavailable":
      return "Install the GitHub CLI (gh) or run `gh auth login` to enable PR creation.";
    case "not_authenticated":
      return "Run `gh auth login` to sign in to GitHub.";
    case "no_github_remote":
      return "This repo has no GitHub remote configured.";
    case "head_not_pushed":
      return `Push ${err.branch || "the branch"} before opening a PR.`;
    case "pr_already_exists":
      return err.url ? `A PR already exists: ${err.url}` : "A PR already exists for this branch.";
    case "validation_failed":
      return `Validation failed: ${err.message}`;
    case "network_error":
      return `Network error: ${err.message}`;
    case "error":
    default:
      return (err as { message?: string }).message ?? "PR creation failed";
  }
}

export function CreatePrModal(props: CreatePrModalProps) {
  const sessionAccessor = () => (props.open ? props.sessionName : null);
  const { resource: branches } = useBranches(sessionAccessor);

  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [base, setBase] = createSignal<string>("");
  const [draft, setDraft] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const head = createMemo(() => props.initialHead ?? branches()?.currentBranch ?? "");

  // Default the base to the first non-current local branch (often
  // `main`) so the user typically just confirms. createEffect (not
  // memo) so the run isn't gated on a subscriber.
  createEffect(() => {
    if (base()) return;
    const list = branches()?.local ?? [];
    const cur = branches()?.currentBranch ?? null;
    const candidate =
      list.find((b) => b.branch === "main" && b.branch !== cur) ??
      list.find((b) => b.branch === "master" && b.branch !== cur) ??
      list.find((b) => b.branch !== cur);
    if (candidate) setBase(candidate.branch);
  });

  async function submit() {
    if (!title().trim()) {
      setError("Title is required.");
      return;
    }
    if (!base().trim()) {
      setError("Pick a base branch.");
      return;
    }
    setBusy(true);
    setError(null);
    const payload: { title: string; body: string; base: string; head?: string; draft?: boolean } = {
      title: title().trim(),
      body: body(),
      base: base(),
    };
    if (head()) payload.head = head();
    if (draft()) payload.draft = true;
    const exit = await Effect.runPromiseExit(createPullRequest(props.sessionName, payload));
    setBusy(false);
    if (Exit.isSuccess(exit)) {
      props.onCreated?.(exit.value.url);
      props.onClose();
      return;
    }
    const f = Cause.failureOption(exit.cause);
    const err: GitHubErrorPayload =
      f._tag === "Some" && f.value instanceof GitHubApiError
        ? f.value.payload
        : { type: "error", message: Cause.pretty(exit.cause) };
    setError(messageForError(err));
  }

  return (
    <Show when={props.open}>
      <div
        data-testid="create-pr-overlay"
        class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
        onClick={(e) => {
          if (e.target === e.currentTarget && !busy()) props.onClose();
        }}
      >
        <div
          data-testid="create-pr-modal"
          class="flex w-[min(540px,92vw)] max-h-[85vh] flex-col rounded-md border border-[var(--border)] bg-[var(--bg)] text-base text-[var(--fg)] shadow-2xl"
        >
          <header class="flex items-center gap-2 border-b border-[var(--border-weak,var(--border))] px-3 py-2">
            <span class="text-xs uppercase tracking-wider text-[var(--dim)]">New pull request</span>
            <span class="ml-auto font-mono text-xs text-[var(--dim)]">
              {head() || "—"} <span aria-hidden>→</span> {base() || "—"}
            </span>
          </header>

          <div class="flex min-h-0 flex-1 flex-col gap-2 px-3 py-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs uppercase tracking-wider text-[var(--dim)]">Title</span>
              <input
                type="text"
                data-testid="create-pr-title"
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                disabled={busy()}
                placeholder="Pull request title"
                class="rounded border border-[var(--border)] bg-[var(--bg-weak,var(--bg))] px-2 py-1 text-[var(--fg)]"
              />
            </label>

            <label class="flex flex-col gap-1">
              <span class="text-xs uppercase tracking-wider text-[var(--dim)]">Base branch</span>
              <select
                data-testid="create-pr-base"
                value={base()}
                onChange={(e) => setBase(e.currentTarget.value)}
                disabled={busy() || branches.loading}
                class="rounded border border-[var(--border)] bg-[var(--bg-weak,var(--bg))] px-2 py-1 text-[var(--fg)]"
              >
                <Show when={!branches()}>
                  <option value="">Loading…</option>
                </Show>
                <For each={branches()?.local ?? []}>
                  {(b) => (
                    <option value={b.branch} disabled={b.branch === head()}>
                      {b.branch}
                      {b.branch === head() ? " (head)" : ""}
                    </option>
                  )}
                </For>
              </select>
            </label>

            <label class="flex min-h-0 flex-1 flex-col gap-1">
              <span class="text-xs uppercase tracking-wider text-[var(--dim)]">
                Description (markdown)
              </span>
              <textarea
                data-testid="create-pr-body"
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
                rows={8}
                disabled={busy()}
                placeholder="What does this PR change? Why?"
                class="min-h-0 flex-1 resize-y rounded border border-[var(--border)] bg-[var(--bg-weak,var(--bg))] px-2 py-1 font-mono text-[var(--fg)]"
              />
            </label>

            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="create-pr-draft"
                checked={draft()}
                onChange={(e) => setDraft(e.currentTarget.checked)}
                disabled={busy()}
              />
              <span>Open as draft</span>
            </label>

            <Show when={error()}>
              <div
                data-testid="create-pr-error"
                class="rounded border border-[var(--danger,#d34)] bg-[var(--danger,#d34)]/10 px-2 py-1 text-[var(--danger,#d34)]"
              >
                {error()}
              </div>
            </Show>
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-[var(--border-weak,var(--border))] px-3 py-2">
            <button
              type="button"
              data-testid="create-pr-cancel"
              onClick={() => props.onClose()}
              disabled={busy()}
              class="rounded border border-[var(--border)] px-3 py-1 hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="create-pr-submit"
              onClick={() => void submit()}
              disabled={busy()}
              class="rounded border border-[var(--accent)] bg-[var(--accent)] px-3 py-1 text-[var(--bg)] hover:opacity-90 disabled:opacity-50"
            >
              {busy() ? "Creating…" : "Create pull request"}
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}
