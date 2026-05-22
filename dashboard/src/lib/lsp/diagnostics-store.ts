/**
 * LSP diagnostics store — Solid-signal map keyed by buffer URI.
 *
 * Two consumers:
 *   - The CodeEditor's LSP integration pushes a fresh list whenever
 *     it polls `/lsp/diagnostics` for an open buffer.
 *   - The Problems tab in BottomPanelView reads the store to render
 *     the cross-buffer list + drives `openFileAt` on click.
 */

import { createStore } from "solid-js/store";
import type { LspDiagnostic } from "./api";

export interface BufferDiagnostics {
  bufferUri: string;
  sessionName: string;
  rootPath: string;
  filePath: string;
  language: string;
  diagnostics: LspDiagnostic[];
  /** ms since epoch — drives staleness UI. */
  fetchedAt: number;
}

interface DiagnosticsStoreState {
  byBuffer: Record<string, BufferDiagnostics>;
}

const [state, setState] = createStore<DiagnosticsStoreState>({ byBuffer: {} });

export const diagnosticsState = state;

export function setDiagnosticsForBuffer(entry: BufferDiagnostics): void {
  setState("byBuffer", entry.bufferUri, entry);
}

export function clearDiagnosticsForBuffer(bufferUri: string): void {
  setState("byBuffer", bufferUri, undefined as unknown as BufferDiagnostics);
}

/** Snapshot list — order is stable across calls for a given input. */
export function allBufferDiagnostics(): BufferDiagnostics[] {
  return Object.values(state.byBuffer).filter(Boolean) as BufferDiagnostics[];
}

/** Count problems at or above the given severity (defaults to errors+warnings). */
export function totalDiagnosticsCount(minSeverity: 1 | 2 | 3 | 4 = 2): number {
  let total = 0;
  for (const entry of allBufferDiagnostics()) {
    for (const d of entry.diagnostics) {
      const sev = d.severity ?? 1;
      if (sev <= minSeverity) total += 1;
    }
  }
  return total;
}

/** Test helper — wipes the store. */
export function __resetDiagnosticsStoreForTests(): void {
  for (const uri of Object.keys(state.byBuffer)) {
    setState("byBuffer", uri, undefined as unknown as BufferDiagnostics);
  }
}
