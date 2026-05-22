/**
 * Concrete pool for single-file Monaco code editors. Mirrors emdash's
 * `monaco-code-pool.ts`: wires the generic `MonacoPool` against the
 * dashboard's TS/JS language defaults, custom themes, and registry
 * readiness signal.
 */

import type * as monaco from "monaco-editor";
import { MonacoPool, type PoolEntry } from "./pool";
import { CODE_EDITOR_BASE_OPTIONS } from "./editor-config";
import { configureMonacoTypeScript } from "./config";
import { defineMonacoThemes, getMonacoThemeForId } from "./themes";
import { modelRegistry } from "./model-registry";
import { settings } from "@/lib/settings";

export type CodePoolEntry = PoolEntry<monaco.editor.IStandaloneCodeEditor>;

export const codeEditorPool = new MonacoPool<monaco.editor.IStandaloneCodeEditor>({
  poolId: "monaco-code-pool",
  reserveTarget: 1,
  createEditor: (m, container) =>
    m.editor.create(container, {
      ...CODE_EDITOR_BASE_OPTIONS,
      theme: getMonacoThemeForId(settings().themeId),
    }),
  cleanupOnRelease: (editor) => {
    editor.updateOptions({ readOnly: true, glyphMargin: false });
    editor.setModel(null);
  },
  onInit: async (m) => {
    modelRegistry.notifyMonacoReady(m);
    defineMonacoThemes(m);
    configureMonacoTypeScript(m);
    // Apply the dashboard's current theme on boot.
    m.editor.setTheme(getMonacoThemeForId(settings().themeId));
  },
});
