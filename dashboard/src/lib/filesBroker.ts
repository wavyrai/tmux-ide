/**
 * Files broker — cross-surface coordination for the Files explorer.
 *
 * Mirrors the `searchBroker` pattern. Other surfaces (the context
 * menu, future command-palette entries, deep-link routes) publish a
 * `PendingFileRequest`; the FilesSurface drains it on mount and reacts
 * to it while mounted so the same path covers both "panel was closed"
 * and "panel is already open".
 */

import { createSignal, type Accessor } from "solid-js";

export interface PendingFileRequest {
  /** Workspace-relative path of the file to open. */
  filePath: string;
  /** Free-form provenance label — only used for logging right now. */
  source?: string;
}

const [pendingOpen, setPendingOpenSignal] = createSignal<PendingFileRequest | null>(null);

export const pendingFileOpen: Accessor<PendingFileRequest | null> = pendingOpen;

export function requestOpenFile(req: PendingFileRequest): void {
  setPendingOpenSignal(req);
}

export function consumePendingFileOpen(): PendingFileRequest | null {
  const current = pendingOpen();
  if (!current) return null;
  setPendingOpenSignal(null);
  return current;
}
