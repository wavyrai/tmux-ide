/**
 * Checkpoint store — pure record store for CheckpointSummary objects
 * (Thread → Turn → CheckpointSummary). The actual git snapshot mechanism
 * lives in checkpoint-engine.ts (T073/T075); this store only persists the
 * resulting summaries so the dashboard can render the turn's diff
 * statistics, ref, and current readiness status.
 *
 * Schema comes from @tmux-ide/contracts/chat-thread (T070):
 *   - CheckpointSummary (turnId, checkpointTurnCount, checkpointRef,
 *     status, files, assistantMessageId, completedAt)
 *   - CheckpointStatus ("ready" | "missing" | "error")
 *   - CheckpointFile (path, kind, additions, deletions)
 */

import type { ChatThreadEvent, CheckpointStatus, CheckpointSummary } from "@tmux-ide/contracts";

export interface CheckpointStore {
  upsert(threadId: string, summary: CheckpointSummary): CheckpointSummary;
  get(threadId: string, turnId: string): CheckpointSummary | null;
  list(threadId: string): CheckpointSummary[];
  remove(threadId: string, turnId: string): boolean;
  /** Update only the status — leaves files/ref/etc untouched. */
  updateStatus(threadId: string, turnId: string, status: CheckpointStatus): CheckpointSummary;
  /** Clear all checkpoints for a thread (used on thread.delete). */
  clear(threadId: string): void;
}

export class CheckpointStoreError extends Error {
  constructor(
    message: string,
    readonly code: "not_found",
  ) {
    super(message);
    this.name = "CheckpointStoreError";
  }
}

export interface MakeCheckpointStoreOptions {
  /**
   * Emit `chat.checkpoint.created` on upsert of a previously-unseen
   * turn's checkpoint. Updates to an existing summary stay silent —
   * the dashboard subscribes to status changes via a separate channel.
   */
  emit?: (event: ChatThreadEvent) => void;
}

export function makeCheckpointStore(opts: MakeCheckpointStoreOptions = {}): CheckpointStore {
  const byThread = new Map<string, Map<string, CheckpointSummary>>();
  const emit = opts.emit ?? (() => undefined);

  function bucket(threadId: string): Map<string, CheckpointSummary> {
    let b = byThread.get(threadId);
    if (!b) {
      b = new Map();
      byThread.set(threadId, b);
    }
    return b;
  }

  return {
    upsert(threadId, summary) {
      const b = bucket(threadId);
      const existed = b.has(summary.turnId);
      b.set(summary.turnId, summary);
      if (!existed) {
        emit({ type: "chat.checkpoint.created", threadId, checkpoint: summary });
      }
      return summary;
    },
    get(threadId, turnId) {
      return byThread.get(threadId)?.get(turnId) ?? null;
    },
    list(threadId) {
      const b = byThread.get(threadId);
      if (!b) return [];
      // Sort by checkpointTurnCount for deterministic ordering — that's
      // the natural per-thread sequence the t3 schema imposes.
      return [...b.values()].sort((a, b2) => a.checkpointTurnCount - b2.checkpointTurnCount);
    },
    remove(threadId, turnId) {
      const b = byThread.get(threadId);
      if (!b) return false;
      return b.delete(turnId);
    },
    updateStatus(threadId, turnId, status) {
      const b = bucket(threadId);
      const existing = b.get(turnId);
      if (!existing) {
        throw new CheckpointStoreError(
          `Checkpoint for turn ${turnId} not found in thread ${threadId}`,
          "not_found",
        );
      }
      const next: CheckpointSummary = { ...existing, status };
      b.set(turnId, next);
      return next;
    },
    clear(threadId) {
      byThread.delete(threadId);
    },
  };
}
