import type { TerminalReplicaRow } from "@tmux-ide/contracts";

// Ownership proves immutable, ordinary data properties, not schema validity.
// There is no registration API: callers can only obtain ownership by copying.
const OWNED_ROWS = new WeakSet<TerminalReplicaRow>();

export function isOwnedTerminalReplicaRow(row: unknown): row is TerminalReplicaRow {
  return typeof row === "object" && row !== null && OWNED_ROWS.has(row as TerminalReplicaRow);
}

export function freezeOwnedTerminalReplicaRow(row: TerminalReplicaRow): TerminalReplicaRow {
  if (OWNED_ROWS.has(row)) return row;
  const frozen = Object.freeze({
    wrapped: row.wrapped,
    cells: Object.freeze(
      Array.from(row.cells, (cell) =>
        Object.freeze({
          ...cell,
          foreground: Object.freeze({ ...cell.foreground }),
          background: Object.freeze({ ...cell.background }),
        }),
      ),
    ),
  }) as unknown as TerminalReplicaRow;
  OWNED_ROWS.add(frozen);
  return frozen;
}
