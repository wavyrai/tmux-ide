/**
 * Public surface for the Monaco subsystem. G17-P1 ships:
 *
 *   - `codeEditorPool`        — singleton pool for the IDE Files view
 *   - `modelRegistry`         — ref-counted model lifecycle + Solid stores
 *   - `useMonacoLease`        — Solid hook for leasing a code editor
 *   - `useModelStatus` / `useIsDirty` / `useBufferVersion` — reactive accessors
 *   - `buildMonacoModelPath` / `toDiskUri` / `toGitUri` — pure URI helpers
 *   - `defineMonacoThemes` / `getMonacoThemeForId` — theme registration
 *   - `CODE_EDITOR_BASE_OPTIONS` / `DIFF_EDITOR_BASE_OPTIONS` — shared options
 *
 * Diff pool + sticky diff editor land in G17-P3.
 */

export { MonacoPool, getMonacoFromGlobal } from "./pool";
export type { PoolEntry, MonacoPoolOptions } from "./pool";

export { codeEditorPool } from "./code-pool";
export type { CodePoolEntry } from "./code-pool";

export { diffEditorPool } from "./diff-pool";
export type { DiffPoolEntry } from "./diff-pool";

export { modelRegistry, MonacoModelRegistry, ModelRegistryError } from "./model-registry";
export type { ModelStatus, ModelType } from "./model-registry";

export { useMonacoLease } from "./use-lease";
export { useModelStatus, useIsDirty, useBufferVersion } from "./use-model";

export { buildMonacoModelPath, toDiskUri, toGitUri } from "./model-path";
export { defineMonacoThemes, getMonacoThemeForId } from "./themes";
export {
  configureMonacoTypeScript,
  configureMonacoEditor,
  addMonacoKeyboardShortcuts,
} from "./config";
export { CODE_EDITOR_BASE_OPTIONS, DIFF_EDITOR_BASE_OPTIONS } from "./editor-config";
