/**
 * StickyDiffEditor — Solid port.
 *
 * Mounts a Monaco diff editor directly into a `<div>` (no pool
 * lease/release). The editor instance lives for the lifetime of the
 * component; content is swapped in-place via a `createEffect` when
 * the URIs change or the registry's `modelStatus` flips to `'ready'`.
 *
 * Use this for sticky surfaces where the diff *is* the panel — the
 * Diffs widget in the Files view, PR-style standalone diffs, etc.
 * For ephemeral / leased surfaces (multi-tab diff lists), call
 * `diffEditorPool.lease()` instead.
 *
 * Per-hunk Accept / Reject UI: the component subscribes to the
 * Monaco diff editor's `onDidUpdateDiff` and reads
 * `getLineChanges()` to surface each hunk. Buttons fire
 * `onAcceptHunk` / `onRejectHunk` with the typed line ranges. The
 * host owns what those callbacks do (typically: write through to
 * the modified buffer or revert via the registry's `saveFileToDisk`
 * once that lands in G17-P5).
 */

import { Check, X, ChevronDown, ChevronUp } from "lucide-solid";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type * as monaco from "monaco-editor";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { DIFF_EDITOR_BASE_OPTIONS } from "@/lib/monaco/editor-config";
import { getMonacoFromGlobal } from "@/lib/monaco/pool";
import { diffEditorPool } from "@/lib/monaco/diff-pool";

export type DiffStyle = "unified" | "split";

export interface DiffHunk {
  /** 1-based line numbers, inclusive. May be 0 when one side is empty. */
  originalStartLine: number;
  originalEndLine: number;
  modifiedStartLine: number;
  modifiedEndLine: number;
}

export interface StickyDiffEditorProps {
  /** URI for the left (original/before) side — typically `git://...`. */
  originalUri: string;
  /** URI for the right (modified/after) side — `disk://` / `file://`. */
  modifiedUri: string;
  /** Inline (unified) vs side-by-side. Defaults to split. */
  diffStyle?: DiffStyle;
  /** Hide the per-hunk Accept / Reject affordances when unset. */
  onAcceptHunk?: (hunk: DiffHunk) => void;
  onRejectHunk?: (hunk: DiffHunk) => void;
  /** Notification when the editor instance is created or disposed. */
  onEditorChange?: (editor: monaco.editor.IStandaloneDiffEditor | null) => void;
  /** Notification when the diff height changes (for auto-sized parents). */
  onHeightChange?: (height: number) => void;
}

function rangeFromLineChange(change: monaco.editor.ILineChange): DiffHunk {
  return {
    originalStartLine: change.originalStartLineNumber,
    originalEndLine: change.originalEndLineNumber,
    modifiedStartLine: change.modifiedStartLineNumber,
    modifiedEndLine: change.modifiedEndLineNumber,
  };
}

export function StickyDiffEditor(props: StickyDiffEditorProps) {
  let mountRef!: HTMLDivElement;
  const [editor, setEditor] = createSignal<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [hunks, setHunks] = createSignal<DiffHunk[]>([]);
  const [showHunkList, setShowHunkList] = createSignal(true);
  const diffStyle = () => props.diffStyle ?? "split";

  onMount(() => {
    const m = getMonacoFromGlobal();
    if (!m) {
      // Diff pool's `init()` resolves Monaco then stashes it on
      // `globalThis.__monaco`. Kick that off, then retry on the
      // next microtask. Tests bypass this by setting __monaco
      // directly.
      void diffEditorPool.init().then(() => {
        mountEditor();
      });
      return;
    }
    mountEditor();
  });

  function mountEditor() {
    const m = getMonacoFromGlobal();
    if (!m || !mountRef) return;

    const next = m.editor.createDiffEditor(mountRef, {
      ...DIFF_EDITOR_BASE_OPTIONS,
      readOnly: !props.modifiedUri.startsWith("file://"),
      renderSideBySide: diffStyle() === "split",
    });
    setEditor(next);
    props.onEditorChange?.(next);

    const modifiedEditor = next.getModifiedEditor();

    const heightDisposable = modifiedEditor.onDidContentSizeChange((e) => {
      if (e.contentHeightChanged) props.onHeightChange?.(e.contentHeight);
    });

    const updateDisposable = next.onDidUpdateDiff(() => {
      const changes = next.getLineChanges() ?? [];
      setHunks(changes.map(rangeFromLineChange));
    });

    onCleanup(() => {
      props.onEditorChange?.(null);
      heightDisposable.dispose();
      updateDisposable.dispose();
      try {
        next.dispose();
      } catch {
        /* ignore */
      }
      setEditor(null);
    });
  }

  // Sync diffStyle changes to the mounted editor in-place.
  createEffect(() => {
    editor()?.updateOptions({ renderSideBySide: diffStyle() === "split" });
  });

  // Sync readOnly based on the modified URI's scheme.
  createEffect(() => {
    editor()?.updateOptions({ readOnly: !props.modifiedUri.startsWith("file://") });
  });

  // Reactive content application — runs when either URI flips to
  // `'ready'` in the registry. Mirrors emdash's MobX autorun.
  createEffect(() => {
    const e = editor();
    if (!e) return;
    const origStatus = modelRegistry.modelStatus(props.originalUri);
    const modStatus = modelRegistry.modelStatus(props.modifiedUri);
    if (origStatus !== "ready" || modStatus !== "ready") return;

    const origModel = modelRegistry.getModelByUri(props.originalUri);
    const modModel = modelRegistry.getModelByUri(props.modifiedUri);
    if (!origModel || !modModel) return;

    // Drop the previous model + clean up any inmemory:// scratch
    // models the pool created — mirrors `applyContent`.
    const prev = e.getModel();
    if (prev) {
      e.setModel(null);
      if (prev.original.uri.scheme === "inmemory") prev.original.dispose();
      if (prev.modified.uri.scheme === "inmemory") prev.modified.dispose();
    }

    e.setModel({ original: origModel, modified: modModel });
    e.layout();
    const h = e.getModifiedEditor().getContentHeight();
    props.onHeightChange?.(h);
  });

  function focusHunk(hunk: DiffHunk) {
    const e = editor();
    if (!e) return;
    const me = e.getModifiedEditor();
    const line = Math.max(hunk.modifiedStartLine, 1);
    me.revealLineNearTop(line);
    me.setPosition({ lineNumber: line, column: 1 });
    me.focus();
  }

  return (
    <div data-testid="sticky-diff-editor" class="relative flex h-full min-h-0 flex-col">
      <Show when={(props.onAcceptHunk || props.onRejectHunk) && hunks().length > 0}>
        <HunkList
          hunks={hunks()}
          collapsed={!showHunkList()}
          onToggle={() => setShowHunkList((v) => !v)}
          onAccept={(h) => props.onAcceptHunk?.(h)}
          onReject={(h) => props.onRejectHunk?.(h)}
          onFocus={focusHunk}
        />
      </Show>
      <div ref={mountRef} data-testid="sticky-diff-editor-mount" class="min-h-0 flex-1" />
    </div>
  );
}

function HunkList(props: {
  hunks: DiffHunk[];
  collapsed: boolean;
  onToggle: () => void;
  onAccept: (h: DiffHunk) => void;
  onReject: (h: DiffHunk) => void;
  onFocus: (h: DiffHunk) => void;
}) {
  return (
    <div
      data-testid="sticky-diff-hunk-list"
      class="shrink-0 border-b border-[var(--border)] bg-[var(--bg-strong)] text-sm"
    >
      <button
        type="button"
        data-testid="sticky-diff-hunk-toggle"
        onClick={props.onToggle}
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]"
      >
        <Show when={props.collapsed} fallback={<ChevronDown class="h-3 w-3" aria-hidden="true" />}>
          <ChevronUp class="h-3 w-3" aria-hidden="true" />
        </Show>
        <span class="font-mono text-xs uppercase tracking-wider text-[var(--dim)]">
          {props.hunks.length} {props.hunks.length === 1 ? "hunk" : "hunks"}
        </span>
      </button>
      <Show when={!props.collapsed}>
        <ul
          data-testid="sticky-diff-hunk-items"
          class="max-h-48 list-none overflow-y-auto border-t border-[var(--border)] p-0"
        >
          <For each={props.hunks}>
            {(hunk, i) => (
              <li
                data-testid="sticky-diff-hunk-item"
                data-hunk-index={i()}
                class="flex items-center gap-2 px-3 py-1.5 even:bg-[var(--surface)]"
              >
                <button
                  type="button"
                  data-testid="sticky-diff-hunk-focus"
                  onClick={() => props.onFocus(hunk)}
                  class="flex-1 text-left font-mono text-xs text-[var(--fg-secondary)] hover:text-[var(--accent)]"
                >
                  Hunk #{i() + 1} ·{" "}
                  <span class="text-[var(--diff-del-text,var(--red))]">
                    -{hunk.originalStartLine}
                    {hunk.originalEndLine > hunk.originalStartLine
                      ? `–${hunk.originalEndLine}`
                      : ""}
                  </span>{" "}
                  <span class="text-[var(--diff-add-text,var(--green))]">
                    +{hunk.modifiedStartLine}
                    {hunk.modifiedEndLine > hunk.modifiedStartLine
                      ? `–${hunk.modifiedEndLine}`
                      : ""}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="sticky-diff-hunk-accept"
                  onClick={() => props.onAccept(hunk)}
                  class="inline-flex h-5 items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-xs text-[var(--green,var(--accent))] hover:bg-[var(--surface-active)]"
                  title="Accept this hunk"
                >
                  <Check class="h-3 w-3" aria-hidden="true" />
                  Accept
                </button>
                <button
                  type="button"
                  data-testid="sticky-diff-hunk-reject"
                  onClick={() => props.onReject(hunk)}
                  class="inline-flex h-5 items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-xs text-[var(--red,var(--accent))] hover:bg-[var(--surface-active)]"
                  title="Reject this hunk"
                >
                  <X class="h-3 w-3" aria-hidden="true" />
                  Reject
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
