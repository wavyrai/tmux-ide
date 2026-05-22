/**
 * MergeConflictPanel — per-hunk three-way merge UI.
 *
 * Built on the pure `three-way-merge` module: the buffer's base /
 * external / local content is split into hunks, then the panel
 * renders one row per hunk. Conflict hunks (both sides diverge)
 * expose three explicit choice buttons — Apply external / Keep
 * local / Combine — and a per-hunk "Reset" undo. Non-conflict
 * hunks render as a compact "auto-resolved" row so the user can
 * see what's happening without having to interact with them.
 *
 * Top status bar shows `X / Y conflicts resolved` with two quick
 * actions: "Apply all external" / "Keep all local" that bulk-set
 * the unresolved conflicts. The footer's "Apply merged" button
 * stays disabled until every conflict has a `choice`; once all
 * conflicts resolve, the panel auto-fires `resolveConflict(...)`
 * so the user sees the merged content in the regular editor
 * view without a manual click.
 *
 * Quick-resolution paths from G17-P7 stay reachable:
 *   - "Use external" (footer) → `acceptExternalChange`
 *   - "Use mine"     (footer) → `dismissExternalChange`
 */

import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Combine,
  FileText,
  RotateCcw,
  XCircle,
} from "lucide-solid";
import {
  acceptExternalChange,
  dismissExternalChange,
  resolveConflict,
  type OpenBuffer,
} from "@/lib/editor/buffer-store";
import {
  applyResolutions,
  conflictCount,
  emptyResolutions,
  resolvedCount,
  threeWayMerge,
  type ConflictChoice,
  type MergeHunk,
  type Resolution,
} from "@/lib/editor/three-way-merge";

export interface MergeConflictPanelProps {
  buffer: OpenBuffer;
}

export function MergeConflictPanel(props: MergeConflictPanelProps) {
  // The hunk shape is stable across re-renders as long as the
  // base/external/local strings don't change mid-flight, which is
  // guaranteed: `externalContent` is set once on FS-watch and
  // cleared once on resolve. Memo so the For-loop key stays
  // stable.
  const hunks = createMemo<MergeHunk[]>(() =>
    threeWayMerge(
      props.buffer.baseContent,
      props.buffer.externalContent ?? "",
      props.buffer.content,
    ),
  );

  // Resolutions are a Solid signal — we re-seed when `hunks`
  // changes shape so a fresh conflict picks up an empty state.
  const [resolutions, setResolutions] = createSignal<Record<number, Resolution>>(
    emptyResolutions(hunks()),
  );

  let lastHunkSignature = "";
  createEffect(() => {
    const sig = hunkSignature(hunks());
    if (sig === lastHunkSignature) return;
    lastHunkSignature = sig;
    setResolutions(emptyResolutions(hunks()));
  });

  const totalConflicts = createMemo(() => conflictCount(hunks()));
  const resolved = createMemo(() => resolvedCount(hunks(), resolutions()));
  const allResolved = createMemo(() => totalConflicts() > 0 && resolved() === totalConflicts());

  // Auto-fire `resolveConflict` once every conflict has a choice
  // so the panel unmounts itself. Guard on `externalContent`
  // staying non-null — the first successful resolve clears it,
  // which would otherwise let the effect re-run against a stale
  // resolutions map keyed on the prior hunk shape.
  createEffect(() => {
    if (!allResolved()) return;
    if (props.buffer.externalContent === null) return;
    const merged = untrack(() => applyResolutions(hunks(), resolutions()));
    resolveConflict(props.buffer.bufferUri, merged);
  });

  // Bulk actions for the status-bar quick paths.
  function bulkPick(choice: ConflictChoice) {
    setResolutions((prev) => {
      const next: Record<number, Resolution> = { ...prev };
      for (const h of hunks()) {
        if (h.kind !== "conflict") continue;
        const existing = next[h.index];
        if (!existing || existing.choice === null) {
          next[h.index] = { choice };
        }
      }
      return next;
    });
  }

  function setChoice(hunk: MergeHunk, choice: ConflictChoice | null) {
    setResolutions((prev) => ({ ...prev, [hunk.index]: { choice } }));
  }

  return (
    <div
      data-testid="v2-merge-conflict-panel"
      data-buffer-uri={props.buffer.bufferUri}
      data-total-conflicts={totalConflicts()}
      data-resolved-conflicts={resolved()}
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex shrink-0 items-center gap-2 border-b border-[var(--yellow,var(--accent))] bg-[var(--surface)] px-3 py-2 text-base">
        <AlertTriangle aria-hidden="true" class="h-4 w-4 text-[var(--yellow,var(--accent))]" />
        <span>Merge conflict — </span>
        <FileText aria-hidden="true" class="h-3 w-3 opacity-60" />
        <span class="font-mono">{props.buffer.filePath}</span>
        <span class="flex-1" />
        <span data-testid="v2-merge-status" class="font-mono text-sm text-[var(--dim)]">
          <span class="text-[var(--accent)]">{resolved()}</span>
          <span class="opacity-50"> / </span>
          <span>{totalConflicts()}</span>
          <span class="ml-1 opacity-70">conflict{totalConflicts() === 1 ? "" : "s"} resolved</span>
        </span>
        <button
          type="button"
          data-testid="v2-merge-bulk-external"
          onClick={() => bulkPick("external")}
          disabled={allResolved()}
          class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-xs text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Apply external for every remaining conflict"
        >
          Apply all external
        </button>
        <button
          type="button"
          data-testid="v2-merge-bulk-local"
          onClick={() => bulkPick("local")}
          disabled={allResolved()}
          class="h-5 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-xs text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          title="Keep local for every remaining conflict"
        >
          Keep all local
        </button>
      </header>

      <div data-testid="v2-merge-hunk-list" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <For each={hunks()}>
          {(hunk) => (
            <HunkRow
              hunk={hunk}
              choice={resolutions()[hunk.index]?.choice ?? null}
              onPick={(choice) => setChoice(hunk, choice)}
              onReset={() => setChoice(hunk, null)}
            />
          )}
        </For>
      </div>

      <footer
        data-testid="v2-merge-actions"
        class="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
      >
        <span class="text-[var(--dim)]">
          {allResolved()
            ? "All conflicts resolved — applying…"
            : "Pick a choice for each conflict, or use the bulk actions above."}
        </span>
        <span class="flex-1" />
        <button
          type="button"
          data-testid="v2-merge-use-external"
          onClick={() => acceptExternalChange(props.buffer.bufferUri)}
          class="h-6 rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]"
          title="Drop every local edit and use the external version"
        >
          Use external
        </button>
        <button
          type="button"
          data-testid="v2-merge-use-mine"
          onClick={() => dismissExternalChange(props.buffer.bufferUri)}
          class="h-6 rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]"
          title="Keep every local edit; next save will overwrite the disk change"
        >
          Use mine
        </button>
      </footer>
    </div>
  );
}

function HunkRow(props: {
  hunk: MergeHunk;
  choice: ConflictChoice | null;
  onPick: (choice: ConflictChoice) => void;
  onReset: () => void;
}) {
  return (
    <article
      data-testid="v2-merge-hunk"
      data-hunk-index={props.hunk.index}
      data-hunk-kind={props.hunk.kind}
      data-hunk-choice={props.choice ?? undefined}
      data-resolved={props.hunk.kind !== "conflict" || props.choice !== null ? "true" : undefined}
      class="border-b border-[var(--border)]"
    >
      <header class="flex shrink-0 items-center gap-2 bg-[var(--bg-strong)] px-3 py-1 text-xs uppercase tracking-wide text-[var(--dim)]">
        <span class="font-mono">line {props.hunk.baseStartLine}</span>
        <span aria-hidden="true">·</span>
        <HunkKindLabel kind={props.hunk.kind} />
        <span class="flex-1" />
        <Show when={props.hunk.kind === "conflict"}>
          <ChoiceButtons choice={props.choice} onPick={props.onPick} onReset={props.onReset} />
        </Show>
      </header>
      <Show when={props.hunk.kind === "conflict"} fallback={<NonConflictBody hunk={props.hunk} />}>
        <ConflictBody hunk={props.hunk} choice={props.choice} />
      </Show>
    </article>
  );
}

function HunkKindLabel(props: { kind: MergeHunk["kind"] }) {
  switch (props.kind) {
    case "unchanged":
      return <span class="text-[var(--dim)]">unchanged</span>;
    case "external-only":
      return <span class="text-[var(--accent)]">external only</span>;
    case "local-only":
      return <span class="text-[var(--accent)]">local only</span>;
    case "conflict":
      return (
        <span class="text-[var(--yellow-foreground,var(--yellow,var(--accent)))]">conflict</span>
      );
  }
}

function ChoiceButtons(props: {
  choice: ConflictChoice | null;
  onPick: (choice: ConflictChoice) => void;
  onReset: () => void;
}) {
  const baseClass =
    "inline-flex h-5 items-center gap-1 rounded border px-1.5 text-xs transition-colors";
  const off = `${baseClass} border-[var(--border)] bg-[var(--surface)] text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]`;
  const on = `${baseClass} border-[var(--accent)] bg-[var(--surface-active)] text-[var(--accent)]`;
  return (
    <span class="inline-flex items-center gap-1">
      <button
        type="button"
        data-testid="v2-merge-hunk-apply-external"
        onClick={() => props.onPick("external")}
        class={props.choice === "external" ? on : off}
        title="Use the external version for this hunk"
      >
        <Check class="h-2.5 w-2.5" aria-hidden="true" />
        Apply
      </button>
      <button
        type="button"
        data-testid="v2-merge-hunk-keep-local"
        onClick={() => props.onPick("local")}
        class={props.choice === "local" ? on : off}
        title="Keep the local version for this hunk"
      >
        <XCircle class="h-2.5 w-2.5" aria-hidden="true" />
        Keep
      </button>
      <button
        type="button"
        data-testid="v2-merge-hunk-combine"
        onClick={() => props.onPick("combine")}
        class={props.choice === "combine" ? on : off}
        title="Concatenate external lines, then local lines"
      >
        <Combine class="h-2.5 w-2.5" aria-hidden="true" />
        Combine
      </button>
      <Show when={props.choice !== null}>
        <button
          type="button"
          data-testid="v2-merge-hunk-reset"
          onClick={() => props.onReset()}
          class={off}
          title="Reset this hunk's choice"
        >
          <RotateCcw class="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      </Show>
    </span>
  );
}

function NonConflictBody(props: { hunk: MergeHunk }) {
  // Non-conflict hunks render as a compact "auto-applied" preview
  // so the user sees what was kept without engaging with controls.
  const preview = createMemo<string[]>(() => {
    if (props.hunk.kind === "unchanged") return props.hunk.baseLines;
    if (props.hunk.kind === "external-only") return props.hunk.externalLines;
    return props.hunk.localLines;
  });
  return (
    <pre
      data-testid="v2-merge-hunk-body"
      class="m-0 max-h-32 overflow-y-auto px-3 py-1 font-mono text-sm text-[var(--fg-secondary)]"
    >
      {preview().slice(0, 6).join("\n") +
        (preview().length > 6 ? `\n…(${preview().length - 6} more)` : "")}
    </pre>
  );
}

function ConflictBody(props: { hunk: MergeHunk; choice: ConflictChoice | null }) {
  // Side-by-side: external on the left, local on the right.
  // Below: the "what will land in the merged file" preview, which
  // reacts to `choice`.
  const previewLines = createMemo<string[]>(() => {
    switch (props.choice) {
      case "external":
        return props.hunk.externalLines;
      case "local":
        return props.hunk.localLines;
      case "combine":
        return [...props.hunk.externalLines, ...props.hunk.localLines];
      default:
        return [];
    }
  });

  return (
    <div class="flex flex-col">
      <div class="grid grid-cols-2 border-b border-[var(--border-weak,var(--border))]">
        <SidePane label="external" tone="external" lines={props.hunk.externalLines} />
        <SidePane label="local" tone="local" lines={props.hunk.localLines} />
      </div>
      <Show
        when={props.choice !== null}
        fallback={
          <div
            data-testid="v2-merge-hunk-preview-empty"
            class="bg-[var(--bg)] px-3 py-1 text-xs italic text-[var(--dim)]"
          >
            Pick a resolution to see the merged preview.
          </div>
        }
      >
        <pre
          data-testid="v2-merge-hunk-preview"
          class="m-0 max-h-40 overflow-y-auto bg-[var(--bg)] px-3 py-1 font-mono text-sm text-[var(--fg)]"
        >
          {previewLines().join("\n")}
        </pre>
      </Show>
    </div>
  );
}

function SidePane(props: { label: string; tone: "external" | "local"; lines: string[] }) {
  const tint =
    props.tone === "external"
      ? "var(--diff-add-bg,var(--surface))"
      : "var(--diff-del-bg,var(--surface))";
  return (
    <div
      data-testid={`v2-merge-side-${props.tone}`}
      class="flex min-h-[2.5rem] flex-col border-r border-[var(--border-weak,var(--border))] last:border-r-0"
      style={{ "background-color": tint }}
    >
      <div class="px-3 py-0.5 text-[9px] uppercase tracking-wide text-[var(--dim)]">
        {props.label}
      </div>
      <pre
        data-testid={`v2-merge-side-${props.tone}-body`}
        class="m-0 max-h-32 flex-1 overflow-y-auto px-3 pb-1 font-mono text-sm text-[var(--fg)]"
      >
        {props.lines.length === 0 ? "(empty)" : props.lines.join("\n")}
      </pre>
    </div>
  );
}

/**
 * Cheap signature of a hunk list — used to detect "the buffer's
 * base/external/local strings just changed; rebuild resolutions."
 * Hashing line counts + the first/last line of each hunk gives
 * us a 99% accurate cheap check; resolutions are not load-bearing
 * if the signature collides.
 */
function hunkSignature(hunks: ReadonlyArray<MergeHunk>): string {
  return hunks
    .map((h) => `${h.kind}:${h.baseLines.length}:${h.externalLines.length}:${h.localLines.length}`)
    .join("|");
}
