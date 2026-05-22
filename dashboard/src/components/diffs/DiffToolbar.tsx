/**
 * DiffToolbar + large-diff guard — small presentational helpers
 * shared between MonacoDiffsView (rail + single editor) and
 * StackedDiffsView (one editor per file in one scroll surface).
 *
 *   - `DiffToolbar` renders an icon + directory + filename + an
 *     optional `Changed | Staged | PR | Git` badge above each diff.
 *   - `LargeDiffGuard` short-circuits a file whose total line
 *     changes exceed `LARGE_DIFF_LINE_THRESHOLD` and exposes a
 *     "Load anyway" button so the user opts into the heavy mount.
 */

import { Show, type JSX } from "solid-js";
import { getFileIcon } from "@/lib/editor/file-icon";

export const LARGE_DIFF_LINE_THRESHOLD = 1500;

/** A file's diff is considered large when additions + deletions > threshold. */
export function isLargeDiff(additions: number, deletions: number): boolean {
  return additions + deletions > LARGE_DIFF_LINE_THRESHOLD;
}

function fileBasename(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? file : file.slice(idx + 1);
}

function fileDirname(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "" : file.slice(0, idx + 1);
}

interface DiffToolbarProps {
  file: string;
  additions?: number;
  deletions?: number;
  /** Optional source label: "Changed" | "Staged" | "PR" | "Git". */
  badge?: string;
  /** Slot for view controls (style toggle, etc) on the right. */
  right?: JSX.Element;
}

export function DiffToolbar(props: DiffToolbarProps): JSX.Element {
  const Icon = getFileIcon(props.file);
  return (
    <div
      data-testid="v2-diff-toolbar"
      data-diff-file={props.file}
      class="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface)] px-3 text-base"
    >
      <Icon class="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate font-mono">
        <Show when={fileDirname(props.file)}>
          <span class="text-[var(--dim)]">{fileDirname(props.file)}</span>
        </Show>
        <span class="text-[var(--fg)]">{fileBasename(props.file)}</span>
      </span>
      <Show when={props.badge}>
        <span
          data-testid="v2-diff-toolbar-badge"
          class="rounded border border-[var(--border)] bg-[var(--bg-strong)] px-1.5 py-0 text-xs uppercase tracking-wider text-[var(--dim)]"
        >
          {props.badge}
        </span>
      </Show>
      <Show when={(props.additions ?? 0) + (props.deletions ?? 0) > 0}>
        <span class="text-[var(--green)]">+{props.additions ?? 0}</span>
        <span class="text-[var(--dim)] opacity-30">/</span>
        <span class="text-[var(--red)]">−{props.deletions ?? 0}</span>
      </Show>
      <Show when={props.right}>{props.right}</Show>
    </div>
  );
}

interface LargeDiffGuardProps {
  file: string;
  additions: number;
  deletions: number;
  onLoadAnyway: () => void;
}

export function LargeDiffGuard(props: LargeDiffGuardProps): JSX.Element {
  return (
    <div
      data-testid="v2-diff-large-guard"
      data-diff-file={props.file}
      class="flex flex-col items-center justify-center gap-3 px-4 py-8 text-base text-[var(--fg-secondary)]"
    >
      <div class="text-center">
        <div class="font-mono">{props.file}</div>
        <div class="mt-1 text-[var(--dim)]">
          Large diff — <span class="text-[var(--green)]">+{props.additions}</span>
          <span class="opacity-50"> / </span>
          <span class="text-[var(--red)]">−{props.deletions}</span> (threshold{" "}
          {LARGE_DIFF_LINE_THRESHOLD}). Skipped to keep the page snappy.
        </div>
      </div>
      <button
        type="button"
        data-testid="v2-diff-large-load-anyway"
        onClick={() => props.onLoadAnyway()}
        class="h-6 rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--fg)] hover:bg-[var(--surface-hover)]"
      >
        Load anyway
      </button>
    </div>
  );
}
