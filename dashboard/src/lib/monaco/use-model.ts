/**
 * Solid accessors over the model registry — drop-in replacements for
 * emdash's React `useModelStatus` / `useIsDirty` hooks.
 *
 * Each returns a Solid accessor (a thunk) rather than a value, so
 * components track changes to the specific URI without re-rendering
 * on every registry mutation. The thunk-based shape matches the
 * convention used by `useViewParam`, `useChromeLayout`, etc.
 */

import { modelRegistry, type ModelStatus } from "./model-registry";

/** Live status accessor for a model URI. Defaults to `'loading'` pre-registration. */
export function useModelStatus(uri: string): () => ModelStatus {
  return () => modelRegistry.modelStatus(uri);
}

/** Live dirty-flag accessor for a buffer URI. */
export function useIsDirty(bufferUri: string): () => boolean {
  return () => modelRegistry.isDirty(bufferUri);
}

/** Live buffer-version accessor — reads of buffer text gate on this. */
export function useBufferVersion(bufferUri: string): () => number {
  return () => modelRegistry.bufferVersion(bufferUri);
}
