/**
 * Branch picker overlay (G18-P1).
 *
 * Triggered from `StatusBar`'s git chip. Lists local branches, marks
 * the current one, and on row click runs `git checkout` against the
 * daemon. Remote-only branches (no local tracking) are surfaced under
 * a separate group — selecting one creates a local tracking branch via
 * `checkout -b <branch>`.
 *
 * Owns: open/close, search query, busy state, last error.
 * Doesn't own: the canonical current-branch — that flows in via the
 * `useGitStatus` resource passed from the host.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import { Effect, Exit, Cause } from "effect";
import type { BranchesPayload, GitErrorPayload } from "@tmux-ide/contracts";
import { checkoutBranch, GitApiError, useBranches } from "@/lib/git";

interface BranchPickerProps {
  sessionName: string;
  open: boolean;
  onClose: () => void;
  /** Anchor coords (page-relative) for positioning the popover next
   *  to the trigger button. */
  anchor?: { x: number; y: number };
  /** Fired after a successful checkout so the host can refresh its
   *  derived status (the StatusBar `useGitStatus` already auto-refetches
   *  on session change but doesn't watch refs yet — G18-P2 wires the
   *  watcher). */
  onCheckedOut?: (branch: string) => void;
}

interface ListEntry {
  name: string;
  isCurrent: boolean;
  group: "local" | "remote";
  /** When the entry is a remote-only branch, the remote name we'd track. */
  remote?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

function intoListEntries(payload: BranchesPayload | null): ListEntry[] {
  if (!payload) return [];
  const localNames = new Set(payload.local.map((b) => b.branch));
  const local: ListEntry[] = payload.local.map((b) => {
    const entry: ListEntry = {
      name: b.branch,
      isCurrent: b.branch === payload.currentBranch,
      group: "local",
    };
    if (b.upstream !== undefined) entry.upstream = b.upstream;
    if (b.ahead !== undefined) entry.ahead = b.ahead;
    if (b.behind !== undefined) entry.behind = b.behind;
    return entry;
  });
  const remoteOnly: ListEntry[] = payload.remote
    .filter((r) => !localNames.has(r.branch))
    .map((r) => ({
      name: r.branch,
      isCurrent: false,
      group: "remote",
      remote: r.remote.name,
    }));
  return [...local, ...remoteOnly];
}

function errorMessage(err: GitErrorPayload): string {
  switch (err.type) {
    case "auth_failed":
      return "Authentication failed";
    case "network_error":
      return "Network error";
    case "uncommitted_changes":
      return "Commit or stash your changes first";
    case "branch_not_found":
      return `Branch not found${err.name ? `: ${err.name}` : ""}`;
    case "not_git_repo":
      return "Not a git repository";
    case "rejected":
      return err.message;
    case "no_remote":
      return "No remote configured";
    case "branch_exists":
      return `Branch already exists: ${err.name}`;
    case "invalid_branch_name":
      return `Invalid branch name: ${err.name}`;
    case "hook_rejected":
      return `Hook rejected: ${err.message}`;
    case "nothing_to_commit":
      return "Nothing to commit";
    case "error":
    default:
      return err.message ?? "Git command failed";
  }
}

export function BranchPicker(props: BranchPickerProps) {
  const sessionAccessor = () => (props.open ? props.sessionName : null);
  const { resource, refetch } = useBranches(sessionAccessor);
  const [query, setQuery] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const entries = createMemo<ListEntry[]>(() => intoListEntries(resource() ?? null));

  const filtered = createMemo<ListEntry[]>(() => {
    const q = query().trim().toLowerCase();
    const list = entries();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q));
  });

  async function handleCheckout(entry: ListEntry) {
    if (entry.isCurrent) {
      props.onClose();
      return;
    }
    setBusy(entry.name);
    setError(null);
    // remote-only branches need `checkout -b <name>` so git creates
    // the local tracking branch. Locals omit the flag — the request
    // schema treats it as optional, and omitting keeps the wire log
    // tidy.
    const requestBody: { branch: string; create?: boolean } = { branch: entry.name };
    if (entry.group === "remote") requestBody.create = true;
    const exit = await Effect.runPromiseExit(checkoutBranch(props.sessionName, requestBody));
    setBusy(null);
    if (Exit.isSuccess(exit)) {
      // Close first — the picker is going away, so the internal
      // branches list doesn't need a refresh. The host's onCheckedOut
      // callback owns surface refresh (StatusBar git chip etc.).
      props.onClose();
      props.onCheckedOut?.(exit.value.currentBranch);
      return;
    }
    // Failure path: pull the tagged GitApiError out of the Cause, or
    // fall back to the cause message for unexpected runtime errors.
    const failure = Cause.failureOption(exit.cause);
    let payload: GitErrorPayload;
    if (failure._tag === "Some" && failure.value instanceof GitApiError) {
      payload = failure.value.payload;
    } else {
      payload = {
        type: "error",
        message: Cause.pretty(exit.cause),
      };
    }
    setError(errorMessage(payload));
  }

  const positionStyle = (): Record<string, string> => {
    const a = props.anchor;
    if (!a) {
      return {
        position: "fixed",
        left: "12px",
        bottom: "28px",
      };
    }
    return {
      position: "fixed",
      left: `${a.x}px`,
      bottom: `${Math.max(window.innerHeight - a.y, 28)}px`,
    };
  };

  return (
    <Show when={props.open}>
      <div
        data-testid="branch-picker-overlay"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
        class="fixed inset-0 z-30"
      >
        <div
          data-testid="branch-picker"
          style={{ ...positionStyle(), width: "320px", "max-height": "70vh" }}
          class="flex flex-col rounded-md border border-[var(--border)] bg-[var(--bg)] text-[12px] shadow-2xl"
        >
          <header class="flex items-center gap-2 border-b border-[var(--border-weak,var(--border))] px-3 py-2">
            <span class="text-[10px] uppercase tracking-wider text-[var(--dim)]">
              Switch branch
            </span>
            <span class="ml-auto text-[10px] text-[var(--dim)] tabular-nums">
              {filtered().length}/{entries().length}
            </span>
          </header>
          <div class="px-2 pt-2">
            <input
              data-testid="branch-picker-search"
              type="search"
              placeholder="Filter branches…"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              class="w-full rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[12px] text-[var(--fg)]"
            />
          </div>
          <Show when={resource.loading}>
            <div
              data-testid="branch-picker-loading"
              class="px-3 py-4 text-center text-[var(--dim)]"
            >
              Loading…
            </div>
          </Show>
          <Show when={error()}>
            <div
              data-testid="branch-picker-error"
              class="border-t border-[var(--border-weak,var(--border))] px-3 py-2 text-[var(--danger,#d34)]"
            >
              {error()}
            </div>
          </Show>
          <Show when={!resource.loading && filtered().length === 0}>
            <div data-empty-state class="px-3 py-4 text-center text-[var(--dim)]">
              <Show when={entries().length === 0} fallback="No matches">
                — no branches —
              </Show>
            </div>
          </Show>
          <div class="min-h-0 flex-1 overflow-y-auto py-1">
            <For each={filtered()}>
              {(entry) => (
                <button
                  type="button"
                  data-testid={`branch-row-${entry.name}`}
                  data-current={entry.isCurrent ? "true" : "false"}
                  data-group={entry.group}
                  disabled={busy() !== null}
                  onClick={() => handleCheckout(entry)}
                  class={
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--surface-hover,rgba(127,127,127,0.08))] disabled:opacity-50 " +
                    (entry.isCurrent ? "text-[var(--accent)]" : "text-[var(--fg)]")
                  }
                >
                  <span aria-hidden="true" class="w-3 text-[var(--dim)]">
                    {entry.isCurrent ? "●" : entry.group === "remote" ? "↗" : "○"}
                  </span>
                  <span class="flex-1 truncate" title={entry.name}>
                    {entry.name}
                  </span>
                  <Show when={entry.group === "remote"}>
                    <span class="text-[10px] text-[var(--dim)]">{entry.remote}</span>
                  </Show>
                  <Show when={busy() === entry.name}>
                    <span class="text-[10px] text-[var(--dim)]">…</span>
                  </Show>
                  <Show
                    when={entry.ahead !== undefined && (entry.ahead > 0 || (entry.behind ?? 0) > 0)}
                  >
                    <span class="text-[10px] text-[var(--dim)] tabular-nums">
                      <Show when={(entry.ahead ?? 0) > 0}>↑{entry.ahead}</Show>
                      <Show when={(entry.behind ?? 0) > 0}>↓{entry.behind}</Show>
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
}
