/**
 * G14-T101 — turn-diff projection.
 *
 * Per-turn file-diff aggregate, projected from the chat event log (T090).
 * Mirrors T091's in-memory + cursor-store shape so the runtime layer
 * (T093) can compose both projections from one ChatEventReader.
 *
 * Source event: `chat.checkpoint.created` (CheckpointSummary.files).
 * Each CheckpointFile becomes one TurnDiffEntry keyed on `(turnId,
 * fileIndex)` — preserving the order the producer recorded so the
 * dashboard's "changed files" panel can render them deterministically.
 *
 * Why checkpoint events and not raw tool calls:
 *   - The contract today ships a single diff-bearing event:
 *     `chat.checkpoint.created`. Per-file additions / deletions / kind
 *     all live there. Synthesising a TurnDiff from individual edit
 *     tool calls would mean re-implementing the checkpoint pipeline's
 *     git-diff arithmetic; the checkpoint summary is already the
 *     authoritative figure.
 *   - When the contract grows finer-grained edit events (G14-T13
 *     territory), this projection can additionally consume them by
 *     extending `project()` without touching the read API.
 *
 * Why an in-memory Map + cursor-store, not a sqlite read-side table:
 *   - Mirrors T091 exactly. The cursor lives in `projection_state`
 *     (sqlite via the cursorStore), the read model rebuilds from the
 *     event log on boot. Aggregations are cheap (a few thousand files
 *     per active thread max).
 *   - A future scale push that materialises a `projection_turn_diffs`
 *     table is a drop-in extension — the public read API stays the same.
 *
 * Status normalisation:
 *   - The `kind` field on CheckpointFile is `TrimmedNonEmptyStringZ` —
 *     producers emit whatever the underlying tool reported. We map the
 *     common git-porcelain shorthand to a stable discriminator so
 *     callers don't have to special-case "A"/"added"/"create".
 */

import type { CheckpointFile, ChatThreadEvent } from "@tmux-ide/contracts";

import type { ChatEventReader, PersistedChatEvent, ProjectionCursorStore } from "../types.ts";
import { ProjectionGapError } from "../types.ts";

/** Normalised file change category. */
export type TurnDiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface TurnDiffEntry {
  threadId: string;
  turnId: string;
  /** Order within the turn's checkpoint file list. Stable across reads. */
  fileIndex: number;
  path: string;
  status: TurnDiffStatus;
  additions: number;
  deletions: number;
  /** Raw `kind` value the producer emitted — preserved for callers that
   *  want richer detail than the four-state status discriminator. */
  rawKind: string;
}

export interface TurnDiffAggregate {
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: number;
}

export interface TurnDiffProjection {
  /** Bootstrap from cursor + subscribe to new events. Idempotent. */
  start(): void;
  /** Drop the subscription; read methods stay queryable. */
  stop(): void;
  /** Highest sequence the projection has applied. */
  cursor(): number;

  // -- read API --

  /** All diff entries for one turn, in producer order. */
  listForTurn(turnId: string): TurnDiffEntry[];
  /** Map of `turnId → diff entries` for every turn in the thread. */
  listForThread(threadId: string): Record<string, TurnDiffEntry[]>;
  /** Lines + file counts summed across every turn in the thread. */
  aggregateForThread(threadId: string): TurnDiffAggregate;
}

export interface MakeTurnDiffProjectionOptions {
  reader: ChatEventReader;
  cursorStore: ProjectionCursorStore;
  /** Projection name; defaults to "turn-diff". Persisted in `projection_state`. */
  name?: string;
  /** Batch size for the bootstrap replay loop. Defaults to 1000. */
  batchSize?: number;
  /** Logger; defaults to no-op. */
  logger?: (entry: { level: "info" | "warn" | "error"; msg: string }) => void;
}

const DEFAULT_NAME = "turn-diff";
const DEFAULT_BATCH_SIZE = 1000;

/**
 * Map producer-supplied `kind` strings to the public TurnDiffStatus
 * discriminator. Tolerant of git-porcelain single letters, common
 * lowercase verbs, and a few "create/remove" variants. Unknown values
 * fall back to "modified" — the most common bucket, and the one most
 * UIs default to colour-wise.
 */
export function normaliseDiffStatus(kind: string): TurnDiffStatus {
  const k = kind.trim().toLowerCase();
  if (
    k === "added" ||
    k === "add" ||
    k === "create" ||
    k === "created" ||
    k === "a" ||
    k === "new"
  ) {
    return "added";
  }
  if (k === "deleted" || k === "delete" || k === "remove" || k === "removed" || k === "d") {
    return "deleted";
  }
  if (k === "renamed" || k === "rename" || k === "moved" || k === "r" || k === "moved-to") {
    return "renamed";
  }
  return "modified";
}

function makeEntry(
  threadId: string,
  turnId: string,
  fileIndex: number,
  file: CheckpointFile,
): TurnDiffEntry {
  return {
    threadId,
    turnId,
    fileIndex,
    path: file.path,
    status: normaliseDiffStatus(file.kind),
    additions: file.additions,
    deletions: file.deletions,
    rawKind: file.kind,
  };
}

export function makeTurnDiffProjection(opts: MakeTurnDiffProjectionOptions): TurnDiffProjection {
  const name = opts.name ?? DEFAULT_NAME;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = opts.logger ?? (() => undefined);

  // turnId → entries (in fileIndex order); plus a thread-side index
  // that lets thread-level reads iterate turns without scanning every
  // turn map. Both maps stay coherent: write-side touches both.
  const byTurn = new Map<string, TurnDiffEntry[]>();
  const turnsByThread = new Map<string, Set<string>>();

  let cursor = 0;
  let unsubscribe: (() => void) | null = null;
  let started = false;

  function applyCheckpointCreated(
    threadId: string,
    turnId: string,
    files: ReadonlyArray<CheckpointFile>,
  ): void {
    // First-write-wins: ignore duplicate `chat.checkpoint.created` for
    // the same (thread, turn). Reactor retries or replay paths can
    // surface a duplicate; the first emission is canonical.
    if (byTurn.has(turnId)) {
      log({
        level: "warn",
        msg: `turn-diff projection: duplicate chat.checkpoint.created for ${threadId}/${turnId}; ignoring`,
      });
      return;
    }
    const entries = files.map((file, index) => makeEntry(threadId, turnId, index, file));
    byTurn.set(turnId, entries);
    let set = turnsByThread.get(threadId);
    if (!set) {
      set = new Set();
      turnsByThread.set(threadId, set);
    }
    set.add(turnId);
  }

  function project(event: ChatThreadEvent): void {
    if (event.type === "chat.checkpoint.created") {
      applyCheckpointCreated(event.threadId, event.checkpoint.turnId, event.checkpoint.files);
      return;
    }
    // All other event types are irrelevant — the projection ignores them
    // but still advances `cursor` via the surrounding `ingest()` path so
    // it cannot deadlock on a gap-detection check.
  }

  function ingest(persisted: PersistedChatEvent): void {
    if (persisted.sequence !== cursor + 1) {
      throw new ProjectionGapError(name, cursor + 1, persisted.sequence);
    }
    project(persisted.event);
    cursor = persisted.sequence;
    opts.cursorStore.save(name, cursor);
  }

  function bootstrap(): void {
    cursor = opts.cursorStore.load(name);
    let batch = opts.reader.readFromSequence(cursor, batchSize);
    while (batch.length > 0) {
      for (const persisted of batch) ingest(persisted);
      batch = opts.reader.readFromSequence(cursor, batchSize);
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      bootstrap();
      unsubscribe = opts.reader.subscribe((event) => {
        ingest(event);
      });
    },
    stop() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      started = false;
    },
    cursor() {
      return cursor;
    },
    listForTurn(turnId) {
      const entries = byTurn.get(turnId);
      return entries ? entries.slice() : [];
    },
    listForThread(threadId) {
      const result: Record<string, TurnDiffEntry[]> = {};
      const turnIds = turnsByThread.get(threadId);
      if (!turnIds) return result;
      for (const turnId of turnIds) {
        const entries = byTurn.get(turnId);
        if (entries) result[turnId] = entries.slice();
      }
      return result;
    },
    aggregateForThread(threadId) {
      const turnIds = turnsByThread.get(threadId);
      if (!turnIds || turnIds.size === 0) {
        return { totalAdditions: 0, totalDeletions: 0, filesChanged: 0 };
      }
      let totalAdditions = 0;
      let totalDeletions = 0;
      let filesChanged = 0;
      for (const turnId of turnIds) {
        const entries = byTurn.get(turnId);
        if (!entries) continue;
        for (const entry of entries) {
          totalAdditions += entry.additions;
          totalDeletions += entry.deletions;
          filesChanged += 1;
        }
      }
      return { totalAdditions, totalDeletions, filesChanged };
    },
  };
}
