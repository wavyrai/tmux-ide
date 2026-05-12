/**
 * T101a — "changed files" panel rendered beneath a Turn that produced
 * a checkpoint. Pure presentational; data fetched in ChatV2Root and
 * passed through ThreadView → TurnBlock.
 *
 * Styling uses the design tokens landed in PR 1 (commit 4abb90c) —
 * var(--bg-*), var(--fg-*), var(--accent), var(--border*). No hardcoded
 * hex values so the dark/light theme switch picks the panel up for free.
 */

import { useState } from "react";
import type { TurnDiffEntry } from "@/lib/api";

const STATUS_LABEL: Record<TurnDiffEntry["status"], string> = {
  added: "+",
  modified: "~",
  deleted: "−",
  renamed: "→",
};

const STATUS_COLOR: Record<TurnDiffEntry["status"], string> = {
  added: "text-[var(--ok)]",
  modified: "text-[var(--accent)]",
  deleted: "text-[var(--danger)]",
  renamed: "text-[var(--warn)]",
};

export interface TurnDiffPanelProps {
  entries: ReadonlyArray<TurnDiffEntry>;
  /** Optional click handler — wires up to the project's Diff viewer later. */
  onPickFile?: (entry: TurnDiffEntry) => void;
  /** Collapsed by default; the user expands to inspect file-by-file. */
  defaultExpanded?: boolean;
}

function sumEntries(entries: ReadonlyArray<TurnDiffEntry>): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const e of entries) {
    additions += e.additions;
    deletions += e.deletions;
  }
  return { additions, deletions };
}

export function TurnDiffPanel({ entries, onPickFile, defaultExpanded }: TurnDiffPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);

  if (entries.length === 0) return null;

  const { additions, deletions } = sumEntries(entries);

  return (
    <section
      data-testid="turn-diff-panel"
      data-expanded={expanded}
      data-files={entries.length}
      className="rounded border border-[var(--border-weak)] bg-[var(--surface)] text-[11px]"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[var(--fg-soft)] hover:bg-[var(--bg-strong)]"
      >
        <span
          aria-hidden="true"
          className={`inline-block w-3 text-[var(--dim)] transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
        >
          ▸
        </span>
        <span className="font-medium text-[var(--fg)]">
          {entries.length} {entries.length === 1 ? "file" : "files"} changed
        </span>
        <span className="text-[var(--ok)]" data-testid="turn-diff-additions">
          +{additions}
        </span>
        <span className="text-[var(--danger)]" data-testid="turn-diff-deletions">
          −{deletions}
        </span>
      </button>
      {expanded ? (
        <ul data-testid="turn-diff-list" className="flex flex-col border-t border-[var(--border-weak)]">
          {entries.map((entry) => (
            <li
              key={`${entry.turnId}:${entry.fileIndex}`}
              className="flex items-center gap-2 px-2 py-0.5 hover:bg-[var(--bg-strong)]"
            >
              <span
                aria-label={entry.status}
                title={entry.rawKind || entry.status}
                className={`inline-block w-3 text-center ${STATUS_COLOR[entry.status]}`}
              >
                {STATUS_LABEL[entry.status]}
              </span>
              {onPickFile ? (
                <button
                  type="button"
                  onClick={() => onPickFile(entry)}
                  className="flex-1 truncate text-left text-[var(--fg)] hover:underline"
                >
                  {entry.path}
                </button>
              ) : (
                <span className="flex-1 truncate text-[var(--fg)]">{entry.path}</span>
              )}
              <span className="text-[var(--ok)]" data-testid={`add-${entry.fileIndex}`}>
                +{entry.additions}
              </span>
              <span className="text-[var(--danger)]" data-testid={`del-${entry.fileIndex}`}>
                −{entry.deletions}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
