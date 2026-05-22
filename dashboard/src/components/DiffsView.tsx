/**
 * DiffsView — the single git surface the activity-bar git icon opens
 * (`?view=diffs`).
 *
 * Owns the git chrome: branch + ahead/behind, the Commit / Push /
 * Create-PR actions, CheckRunsRail, and the commit/PR dialogs. The
 * body delegates to `SolidDiffsView`, a Solid-native + shiki diff
 * renderer carrying the full read-only experience — working / staged /
 * pr changes, commit history, and the Branch-vs-main (PR) range diff —
 * so every git review mode is reachable from this one panel without
 * losing the header actions. Monaco is intentionally retired here; it
 * stays only for the editable hunk editor + three-way merge under
 * `?view=changes`.
 */

import { createMemo, createSignal, Show } from "solid-js";
import { GitBranch, GitPullRequest, GitCommit } from "lucide-solid";
import { useGitStatus } from "@/lib/git";
import { CommitDialog } from "@/components/CommitDialog";
import { CreatePrModal } from "@/components/CreatePrModal";
import { PushButton } from "@/components/PushButton";
import { CheckRunsRail } from "@/components/CheckRunsRail";
import { SolidDiffsView } from "@/components/diffs/SolidDiffsView";

interface DiffsViewProps {
  projectName: string;
}

export function DiffsView(props: DiffsViewProps) {
  const status = useGitStatus(() => props.projectName);
  const [commitOpen, setCommitOpen] = createSignal(false);
  const [prOpen, setPrOpen] = createSignal(false);
  const [lastCommit, setLastCommit] = createSignal<string | null>(null);
  const [lastPrUrl, setLastPrUrl] = createSignal<string | null>(null);

  const hasChanges = createMemo(() => {
    const s = status();
    if (!s) return false;
    return s.staged.length > 0 || s.unstaged.length > 0;
  });

  return (
    <div
      data-testid="v2-diffs-view"
      class="flex h-full min-h-0 flex-col bg-[var(--bg)] text-base text-[var(--fg)]"
    >
      <CheckRunsRail sessionName={props.projectName} ref={status()?.currentBranch ?? null} />
      <header class="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2">
        <GitBranch aria-hidden="true" size={12} class="text-[var(--dim)]" />
        <span data-testid="diffs-view-branch" class="font-mono text-sm">
          {status()?.currentBranch ?? "—"}
        </span>
        <Show when={(status()?.ahead ?? 0) > 0}>
          <span class="text-xs tabular-nums text-[var(--dim)]">↑{status()?.ahead}</span>
        </Show>
        <Show when={(status()?.behind ?? 0) > 0}>
          <span class="text-xs tabular-nums text-[var(--dim)]">↓{status()?.behind}</span>
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

      <div data-testid="diffs-view-body" class="min-h-0 flex-1 overflow-hidden">
        <SolidDiffsView projectName={props.projectName} />
      </div>

      <Show when={lastCommit() || lastPrUrl()}>
        <footer
          data-testid="diffs-view-toast"
          class="flex flex-col gap-1 border-t border-[var(--border-weak,var(--border))] px-3 py-1 text-xs text-[var(--accent)]"
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
