import type {
  TerminalDeliveryHistoryCommitment,
  TerminalReplicaRow,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import {
  concatTerminalReplicaRowsDigest,
  hashTerminalReplicaRows,
  hashTerminalReplicaSnapshotWithHistoryDigest,
} from "./terminal-replica.ts";

/**
 * History on demand (capability 122). A client holds the newest history rows
 * and a commitment `{rows, digest}` to the older rows it has not loaded. The
 * rows digest is a polynomial fold, so the commitment plus the loaded rows give
 * the whole history's digest and the snapshot verifies against the full
 * canonical state hash.
 */

/** H(A ++ B) from H(A) and B. */
export function concatTerminalHistoryDigest(
  prefixDigest: string,
  suffix: readonly TerminalReplicaRow[],
): string {
  return concatTerminalReplicaRowsDigest(prefixDigest, suffix);
}

/** The commitment to the oldest `unloadedRows` rows of a history. */
export function terminalHistoryPrefixCommitment(
  history: readonly TerminalReplicaRow[],
  unloadedRows: number,
): TerminalDeliveryHistoryCommitment {
  if (!Number.isSafeInteger(unloadedRows) || unloadedRows < 0 || unloadedRows > history.length)
    throw new RangeError("Unloaded rows outside the history");
  return Object.freeze({
    rows: unloadedRows,
    digest: hashTerminalReplicaRows(
      unloadedRows === history.length ? history : history.slice(0, unloadedRows),
    ),
  });
}

/** The canonical hash of a snapshot holding only its loaded history rows. */
export function hashPartialTerminalReplicaSnapshot(
  snapshot: TerminalReplicaSnapshot,
  unloaded: TerminalDeliveryHistoryCommitment,
): string {
  return hashTerminalReplicaSnapshotWithHistoryDigest(
    snapshot,
    concatTerminalHistoryDigest(unloaded.digest, snapshot.history),
  );
}

/** Keep the newest `tailRows` history rows; commit to the rest. */
export function splitTerminalHistory(
  snapshot: TerminalReplicaSnapshot,
  tailRows: number,
): { snapshot: TerminalReplicaSnapshot; unloaded: TerminalDeliveryHistoryCommitment } {
  const unloadedRows = Math.max(0, snapshot.history.length - Math.max(0, Math.floor(tailRows)));
  return {
    snapshot:
      unloadedRows === 0
        ? snapshot
        : { ...snapshot, history: snapshot.history.slice(unloadedRows) },
    unloaded: terminalHistoryPrefixCommitment(snapshot.history, unloadedRows),
  };
}

/** The newest `maxRows` rows of the unloaded part, oldest first, and what stays unloaded. */
export function takeTerminalHistoryChunk(
  history: readonly TerminalReplicaRow[],
  unloadedRows: number,
  maxRows: number,
): { rows: readonly TerminalReplicaRow[]; unloaded: TerminalDeliveryHistoryCommitment } {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new RangeError("Invalid chunk size");
  const remaining = Math.max(0, unloadedRows - maxRows);
  return {
    rows: history.slice(remaining, unloadedRows),
    unloaded: terminalHistoryPrefixCommitment(history, remaining),
  };
}

/**
 * Prepend a history chunk after proving it: the old commitment must equal the
 * new commitment extended by exactly these rows.
 */
export function prependVerifiedTerminalHistory(
  snapshot: TerminalReplicaSnapshot,
  unloaded: TerminalDeliveryHistoryCommitment,
  rows: readonly TerminalReplicaRow[],
  next: TerminalDeliveryHistoryCommitment,
): TerminalReplicaSnapshot {
  if (
    rows.length === 0 ||
    next.rows + rows.length !== unloaded.rows ||
    concatTerminalHistoryDigest(next.digest, rows) !== unloaded.digest
  )
    throw new TypeError("The history chunk does not match the unloaded commitment");
  return { ...snapshot, history: [...rows, ...snapshot.history] };
}
