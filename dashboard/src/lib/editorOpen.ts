/**
 * Open-at-line broker — G19-P3.
 *
 * Bridges the search panel (and any future "go to file") surface to
 * the Monaco editor without coupling either side to the buffer
 * store's internals. Two halves:
 *
 *   - `openFileAt(...)` opens (or focuses) a buffer using the
 *     same `openBuffer + fetchFilePreview + markReady` pattern the
 *     Files surface uses, then publishes a `pendingReveal` signal so
 *     the next-rendered CodeEditor (or an existing one whose URI
 *     matches) can apply Monaco's `revealLineInCenter` + cursor
 *     selection on the match range. This module is the publisher;
 *     pane 1's CodeEditor in G17-P6 wires the consumer.
 *
 *   - `consumeReveal(bufferUri)` drains the pending signal IF it
 *     matches the given URI. Returns the reveal payload (line +
 *     optional column / length) or null. Used by editor mounts to
 *     pick up the cursor position the moment the editor attaches —
 *     exposed here so test code + future surfaces can drain it too.
 *
 * The signal is intentionally module-global: only one buffer can be
 * "the one I just clicked to reveal" at a time. Stale entries are
 * harmless — they only fire on the next render of the matching
 * editor.
 *
 * Stays out of `lib/editor/` + `lib/monaco/` per the G19-P3 task
 * boundary — pane 1's territory. Callers there can `import` from
 * this module without circularity.
 */

import { createSignal, batch, type Accessor } from "solid-js";
import { Effect } from "effect";
import { fetchFilePreview } from "@/lib/api";
import { bufferState, markError, markReady, openBuffer } from "@/lib/editor/buffer-store";
import { buildMonacoModelPath } from "@/lib/monaco/model-path";

// ---------------------------------------------------------------------
// Pending-reveal signal
// ---------------------------------------------------------------------

export interface PendingReveal {
  /** Buffer URI to match against — `file://…` from `buildMonacoModelPath`. */
  bufferUri: string;
  /** Workspace-relative file path. Kept for debug + consumers that
   *  don't have the registry layer wired (tests). */
  filePath: string;
  /** 1-based line number, matches ripgrep / Monaco conventions. */
  line: number;
  /** 0-based column. Defaults to 0. */
  column?: number;
  /** Length of the highlighted range; pairs with `column` to drive
   *  `editor.setSelection`. Defaults to 0 (no selection — just
   *  cursor + reveal). */
  length?: number;
}

const [pendingReveal, setPendingRevealSignal] = createSignal<PendingReveal | null>(null);

/** Read the latest pending reveal. Null when nothing is queued. */
export const pendingRevealSignal: Accessor<PendingReveal | null> = pendingReveal;

/** Set a new pending reveal. Replaces any prior unconsumed entry. */
export function setPendingReveal(next: PendingReveal | null): void {
  setPendingRevealSignal(next);
}

/**
 * Drain the pending reveal if it targets `bufferUri`. Returns the
 * reveal payload + clears the signal in the same microtask.
 *
 * Editor consumers should call this:
 *   - on mount, once the model is attached + `modelStatus === 'ready'`,
 *   - on every `props.uri` change.
 */
export function consumeReveal(bufferUri: string): PendingReveal | null {
  const current = pendingReveal();
  if (!current || current.bufferUri !== bufferUri) return null;
  setPendingRevealSignal(null);
  return current;
}

// ---------------------------------------------------------------------
// openFileAt — public driver
// ---------------------------------------------------------------------

export interface OpenFileAtInput {
  sessionName: string;
  /** Project root used to build the Monaco model URI. Mirror what
   *  `FilesSurface` uses (`props.modelRootPath ?? "/"`). */
  rootPath: string;
  filePath: string;
  /** Monaco language id; pass `'plaintext'` when unknown. */
  language: string;
  /** 1-based line. */
  line: number;
  /** 0-based column. Optional — defaults to 0. */
  column?: number;
  /** Length of the highlighted range. Optional — defaults to 0. */
  length?: number;
}

/**
 * Open `filePath` in the editor and queue a reveal-at-line request.
 *
 * Semantics mirror `FilesSurface.openFile` for the `text` case:
 *   1. `openBuffer({...})` flips the buffer store's `activeUri`
 *      (creating a `loading` entry on first open).
 *   2. When new, fetch via `/api/project/:name/preview/:path` and
 *      call `markReady` (or `markError` on failure).
 *   3. Publish `pendingReveal` so the matching CodeEditor mount
 *      reveals the line + selects the match range.
 *
 * Idempotent for re-opens — when the buffer already exists, just
 * refreshes the pending-reveal signal.
 */
export function openFileAt(input: OpenFileAtInput): { bufferUri: string; existed: boolean } {
  const { sessionName, rootPath, filePath, language, line, column, length } = input;
  const { bufferUri, existed } = openBuffer({ sessionName, rootPath, filePath, language });

  // Always publish a fresh pending-reveal — re-clicking the same file
  // at a different line must move the cursor.
  batch(() => {
    setPendingReveal({
      bufferUri,
      filePath,
      line,
      ...(column !== undefined ? { column } : {}),
      ...(length !== undefined ? { length } : {}),
    });
  });

  if (existed) {
    // Already in the store; nothing to fetch. If the buffer is in an
    // error state, leave that alone — surfacing the prior error is
    // more honest than silently retrying.
    return { bufferUri, existed: true };
  }

  void Effect.runPromise(fetchFilePreview(sessionName, filePath))
    .then(async (preview) => {
      if (!preview.exists) {
        markError(bufferUri, "File not found");
        return;
      }
      await markReady(bufferUri, preview.content);
    })
    .catch((err) => {
      markError(bufferUri, err instanceof Error ? err.message : String(err));
    });
  return { bufferUri, existed: false };
}

// ---------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------

/** Pure helper exposed for test isolation — clears the pending signal. */
export function __resetPendingRevealForTests(): void {
  setPendingRevealSignal(null);
}

/** Pure helper exposed for test isolation — looks up a buffer URI
 *  the same way `openFileAt` does, without side effects. */
export function bufferUriFor(rootPath: string, filePath: string): string {
  return buildMonacoModelPath(rootPath, filePath);
}

// Re-export the live store for consumers that want to gate the
// reveal on `bufferState.buffers[uri]?.status === 'ready'` without
// importing two modules.
export { bufferState };
