/**
 * Compact `+N / −M` badge for diff-stat rows. Mirrors the upstream
 * shape: green additions, red deletions, neutral `/` divider, with
 * an optional parenthesized variant for inline use beside a filename.
 *
 * Pure render — purely a function of its two numeric props.
 *
 *   ChangedFilesTree → DiffStatLabel
 *   Future inline-file callsites in DiffsView / Inspector reuse it.
 */

import { Show, type JSX } from "solid-js";

export interface DiffStatLabelProps {
  additions: number;
  deletions: number;
  /** When true, wraps the stat in parentheses. */
  showParentheses?: boolean;
  class?: string;
}

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

export function DiffStatLabel(props: DiffStatLabelProps): JSX.Element {
  return (
    <span
      data-testid="diff-stat-label"
      data-additions={props.additions}
      data-deletions={props.deletions}
      class={`inline-flex items-center font-mono text-xs tabular-nums ${props.class ?? ""}`}
    >
      <Show when={props.showParentheses}>
        <span class="text-[var(--dim)]" aria-hidden="true">
          (
        </span>
      </Show>
      <span class="text-[var(--green,#0a0)]">+{props.additions}</span>
      <span class="mx-0.5 text-[var(--dim)]" aria-hidden="true">
        /
      </span>
      <span class="text-[var(--red,#c33)]">−{props.deletions}</span>
      <Show when={props.showParentheses}>
        <span class="text-[var(--dim)]" aria-hidden="true">
          )
        </span>
      </Show>
    </span>
  );
}
