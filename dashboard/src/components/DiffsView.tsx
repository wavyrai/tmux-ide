/**
 * DiffsView — entry surface for G18-P2 commit / PR flows.
 *
 * Mounts where the `view=diffs` placeholder used to live. Lists the
 * working-tree changes from `useGitStatus`, surfaces a top toolbar
 * with Commit / Push / Create-PR buttons, and opens the matching
 * dialog/modal on click. Hunk-level staging waits for the full diff
 * widget port — the dialog's checkbox lets the user pick whole-file
 * granularity for now, which already closes the audit's "Commit
 * action on Diffs widget" gap.
 */

import { createMemo, createSignal, For, Show } from "solid-js";
import { GitBranch, GitPullRequest, GitCommit } from "lucide-solid";
import { useGitStatus } from "@/lib/git";
import { CommitDialog } from "@/components/CommitDialog";
import { CreatePrModal } from "@/components/CreatePrModal";
import { PushButton } from "@/components/PushButton";
import { CheckRunsRail } from "@/components/CheckRunsRail";

interface DiffsViewProps {
  projectName: string;
}

export function DiffsView(props: DiffsViewProps) {
  const status = useGitStatus(() => props.projectName);
  const [commitOpen, setCommitOpen] = createSignal(false);
  const [prOpen, setPrOpen] = createSignal(false);
  const [lastCommit, setLastCommit] = createSignal<string | null>(null);
  const [lastPrUrl, setLastPrUrl] = createSignal<string | null>(null);

  const rows = createMemo(() => {
    const s = status();
    if (!s) return [] as Array<{ path: string; status: string; group: "staged" | "unstaged" }>;
    const seen = new Set<string>();
    const out: Array<{ path: string; status: string; group: "staged" | "unstaged" }> = [];
    for (const c of s.staged) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push({ path: c.path, status: c.status, group: "staged" });
    }
    for (const c of s.unstaged) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      out.push({ path: c.path, status: c.status, group: "unstaged" });
    }
    return out;
  });

  const hasChanges = createMemo(() => rows().length > 0);

  return (
    <div
      data-testid="v2-diffs-view"
      class="flex h-full min-h-0 flex-col bg-[var(--bg)] text-[12px] text-[var(--fg)]"
    >
      <CheckRunsRail sessionName={props.projectName} ref={status()?.currentBranch ?? null} />
      <header class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2">
        <GitBranch aria-hidden="true" size={12} class="text-[var(--dim)]" />
        <span data-testid="diffs-view-branch" class="font-mono text-[11px]">
          {status()?.currentBranch ?? "—"}
        </span>
        <Show when={(status()?.ahead ?? 0) > 0}>
          <span class="text-[10px] tabular-nums text-[var(--dim)]">↑{status()?.ahead}</span>
        </Show>
        <Show when={(status()?.behind ?? 0) > 0}>
          <span class="text-[10px] tabular-nums text-[var(--dim)]">↓{status()?.behind}</span>
        </Show>
        <span class="ml-auto flex items-center gap-2">
          <button
            type="button"
            data-testid="diffs-view-commit"
            onClick={() => setCommitOpen(true)}
            disabled={!hasChanges()}
            class="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[var(--fg)] hover:bg-[var(--surface-hover,rgba(127,127,127,0.06))] disabled:opacity-50"
          >
            <GitCommit aria-hidden="true" size={12} />
            Commit
          </button>
          <PushButton
            sessionName={props.projectName}
            ahead={status()?.ahead ?? 0}
            onPushed={() => status.refetch()}
          />
          <button
            type="button"
            data-testid="diffs-view-create-pr"
            onClick={() => setPrOpen(true)}
            class="inline-flex items-center gap-1 rounded border border-[var(--accent)] bg-[var(--accent)] px-2 py-1 text-[var(--bg)] hover:opacity-90"
          >
            <GitPullRequest aria-hidden="true" size={12} />
            Create PR
          </button>
        </span>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={hasChanges()}
          fallback={
            <div
              data-empty-state
              class="flex h-full items-center justify-center text-[var(--dim)]"
            >
              <Show when={status.loading} fallback="No changes in the working tree.">
                Loading status…
              </Show>
            </div>
          }
        >
          <For each={rows()}>
            {(row) => (
              <div
                data-testid={`diffs-row-${row.path}`}
                data-group={row.group}
                class="flex items-center gap-3 border-b border-[var(--border-weak,var(--border))] px-3 py-1 hover:bg-[var(--surface-hover,rgba(127,127,127,0.04))]"
              >
                <span class="w-14 text-[10px] uppercase text-[var(--dim)]">{row.status}</span>
                <span class="flex-1 truncate font-mono" title={row.path}>
                  {row.path}
                </span>
                <span class="text-[9px] uppercase tracking-wider text-[var(--dim)]">
                  {row.group}
                </span>
              </div>
            )}
          </For>
        </Show>
      </div>

      <Show when={lastCommit() || lastPrUrl()}>
        <footer
          data-testid="diffs-view-toast"
          class="flex flex-col gap-1 border-t border-[var(--border-weak,var(--border))] px-3 py-1 text-[10px] text-[var(--accent)]"
        >
          <Show when={lastCommit()}>
            <span>
              Committed <code class="font-mono">{lastCommit()?.slice(0, 7)}</code>
            </span>
          </Show>
          <Show when={lastPrUrl()}>
            <span>
              PR:{" "}
              <a class="underline" href={lastPrUrl()!} target="_blank" rel="noreferrer">
                {lastPrUrl()}
              </a>
            </span>
          </Show>
        </footer>
      </Show>

      <CommitDialog
        sessionName={props.projectName}
        open={commitOpen()}
        staged={status()?.staged ?? []}
        unstaged={status()?.unstaged ?? []}
        onClose={() => setCommitOpen(false)}
        onCommitted={(sha) => {
          setLastCommit(sha);
          status.refetch();
        }}
      />
      <CreatePrModal
        sessionName={props.projectName}
        open={prOpen()}
        initialHead={status()?.currentBranch ?? null}
        onClose={() => setPrOpen(false)}
        onCreated={(url) => {
          setLastPrUrl(url);
        }}
      />

      <Show when={status.error}>
        <span class="hidden" data-testid="diffs-view-error" />
      </Show>
    </div>
  );
}
