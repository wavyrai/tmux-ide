/**
 * Concrete pool for Monaco diff editors. Pre-warms `reserveTarget`
 * instances so opening a file's diff is a DOM reparent (~ms) rather
 * than a 200-400 ms cold create.
 *
 * Diff editors are heavier than single-file editors (two editors +
 * a side-by-side layout), so the reserve target is 3 instead of 1.
 *
 * `applyContent` mirrors emdash's helper: resolve both URIs through
 * the registry, fall through to empty `inmemory://` models if
 * either side isn't registered yet (the diff still mounts; the
 * `setModel` will re-fire when `modelStatus` flips to `'ready'`).
 */

import type * as monaco from "monaco-editor";
import { MonacoPool, type PoolEntry } from "./pool";
import { DIFF_EDITOR_BASE_OPTIONS } from "./editor-config";
import { defineMonacoThemes, getMonacoThemeForId } from "./themes";
import { modelRegistry } from "./model-registry";
import { settings } from "@/lib/settings";

export type DiffPoolEntry = PoolEntry<monaco.editor.IStandaloneDiffEditor>;

const diffPool = new MonacoPool<monaco.editor.IStandaloneDiffEditor>({
  poolId: "monaco-diff-pool",
  reserveTarget: 3,
  createEditor: (m, container) =>
    m.editor.createDiffEditor(container, {
      ...DIFF_EDITOR_BASE_OPTIONS,
      renderSideBySide: true,
      theme: getMonacoThemeForId(settings().themeId),
    }),
  cleanupOnRelease: (editor) => {
    try {
      const model = editor.getModel();
      editor.setModel(null);
      // Only dispose `inmemory://` models the pool created itself —
      // registry-owned models (file://, disk://, git://) survive.
      if (model?.original.uri.scheme === "inmemory") model.original.dispose();
      if (model?.modified.uri.scheme === "inmemory") model.modified.dispose();
    } catch (err) {
      console.warn("[monaco-diff-pool] model disposal error (suppressed):", err);
    }
  },
  onInit: async (m) => {
    modelRegistry.notifyMonacoReady(m);
    defineMonacoThemes(m);
    m.editor.setTheme(getMonacoThemeForId(settings().themeId));
  },
});

export const diffEditorPool = {
  init(reserveTarget?: number): Promise<void> {
    return diffPool.init(reserveTarget);
  },
  lease(): Promise<DiffPoolEntry> {
    return diffPool.lease();
  },
  release(entry: DiffPoolEntry): void {
    diffPool.release(entry);
  },
  setTheme(themeName: string): void {
    diffPool.setTheme(themeName);
  },
  getMonaco(): typeof monaco | null {
    return diffPool.getMonaco();
  },
  _entriesForTests(): ReadonlyArray<DiffPoolEntry> {
    return diffPool._entriesForTests();
  },
  /**
   * Hand the diff editor two registry-backed models. Falls through
   * to empty `inmemory://` stand-ins when either side hasn't loaded
   * yet — the diff still mounts; the host's `createEffect` re-runs
   * `setModel` when the registry's status flips to `'ready'`.
   */
  applyContent(
    entry: DiffPoolEntry,
    originalUri: string,
    modifiedUri: string,
    language: string,
  ): void {
    const m = diffPool.getMonaco();
    if (!m) return;

    const prev = entry.editor.getModel();
    if (prev) {
      entry.editor.setModel(null);
      if (prev.original.uri.scheme === "inmemory") prev.original.dispose();
      if (prev.modified.uri.scheme === "inmemory") prev.modified.dispose();
    }

    const originalModel =
      modelRegistry.getModelByUri(originalUri) ?? m.editor.createModel("", language);
    const modifiedModel =
      modelRegistry.getModelByUri(modifiedUri) ?? m.editor.createModel("", language);
    entry.editor.setModel({ original: originalModel, modified: modifiedModel });
  },
};
