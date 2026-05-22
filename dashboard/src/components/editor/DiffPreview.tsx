/**
 * DiffPreview — minimal Monaco diff editor for transient,
 * in-component content. Different from `<StickyDiffEditor>` which
 * binds to registry-tracked `disk://` / `file://` / `git://` URIs:
 * this one wraps arbitrary string content (no registry, no fetch)
 * and disposes its models on cleanup.
 *
 * Used by `<MergeConflictPanel>` to show "base vs external"
 * (their changes) and "base vs local" (your changes) without
 * polluting the model registry with throwaway models.
 *
 * Implementation notes:
 *   - Reuses the diff-pool's `init()` to ensure Monaco is loaded
 *     before we touch `monaco.editor.createDiffEditor` directly.
 *   - Always renders read-only — the merged result is a separate
 *     editable surface inside the panel.
 *   - Uses `inmemory://` URIs derived from `id` so concurrent
 *     panels don't collide on the Monaco model cache.
 */

import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import type * as monaco from "monaco-editor";
import { DIFF_EDITOR_BASE_OPTIONS } from "@/lib/monaco/editor-config";
import { diffEditorPool } from "@/lib/monaco/diff-pool";
import { getMonacoFromGlobal } from "@/lib/monaco/pool";

export interface DiffPreviewProps {
  /** Stable identifier for the `inmemory://` URI pair. */
  id: string;
  language: string;
  /** Left-side content — the unchanged base. */
  original: string;
  /** Right-side content — the variant being compared. */
  modified: string;
  /** Inline vs side-by-side. Defaults to side-by-side. */
  inline?: boolean;
}

export function DiffPreview(props: DiffPreviewProps) {
  let host!: HTMLDivElement;
  const [editor, setEditor] = createSignal<monaco.editor.IStandaloneDiffEditor | null>(null);
  let originalModel: monaco.editor.ITextModel | null = null;
  let modifiedModel: monaco.editor.ITextModel | null = null;

  function buildModels(m: typeof monaco) {
    const originalUri = m.Uri.parse(
      `inmemory://diff-preview/${encodeURIComponent(props.id)}/original`,
    );
    const modifiedUri = m.Uri.parse(
      `inmemory://diff-preview/${encodeURIComponent(props.id)}/modified`,
    );
    // Dispose stale models if id collisions ever land us here.
    m.editor.getModel(originalUri)?.dispose();
    m.editor.getModel(modifiedUri)?.dispose();
    originalModel = m.editor.createModel(props.original, props.language, originalUri);
    modifiedModel = m.editor.createModel(props.modified, props.language, modifiedUri);
  }

  function mount() {
    const m = getMonacoFromGlobal();
    if (!m || !host) return;
    buildModels(m);
    const next = m.editor.createDiffEditor(host, {
      ...DIFF_EDITOR_BASE_OPTIONS,
      readOnly: true,
      renderSideBySide: !props.inline,
    });
    if (originalModel && modifiedModel) {
      next.setModel({ original: originalModel, modified: modifiedModel });
    }
    setEditor(next);
  }

  onMount(() => {
    if (getMonacoFromGlobal()) {
      mount();
    } else {
      void diffEditorPool.init().then(() => {
        if (host) mount();
      });
    }
  });

  // React to content / language changes in place.
  createEffect(() => {
    const m = getMonacoFromGlobal();
    if (!m || !editor()) return;
    if (originalModel && originalModel.getValue() !== props.original) {
      originalModel.setValue(props.original);
    }
    if (modifiedModel && modifiedModel.getValue() !== props.modified) {
      modifiedModel.setValue(props.modified);
    }
  });

  createEffect(() => {
    editor()?.updateOptions({ renderSideBySide: !props.inline });
  });

  onCleanup(() => {
    const e = editor();
    try {
      e?.setModel(null);
    } catch {
      /* ignore */
    }
    try {
      e?.dispose();
    } catch {
      /* ignore */
    }
    try {
      originalModel?.dispose();
    } catch {
      /* ignore */
    }
    try {
      modifiedModel?.dispose();
    } catch {
      /* ignore */
    }
    originalModel = null;
    modifiedModel = null;
  });

  return (
    <div
      ref={host}
      data-testid="diff-preview"
      data-diff-preview-id={props.id}
      class="h-full min-h-0 w-full"
    />
  );
}
