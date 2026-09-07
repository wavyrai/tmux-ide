import type { TerminalReplicaCell, TerminalReplicaRow } from "@tmux-ide/contracts";

// Client-local frozen backing. A one-column paint row cannot contain a valid
// width-two pair, but copying and subsequent widening must retain its owner.
// Only newly projected frozen rows enter this map; live canonical rows do not.
const clippedWideOwners = new WeakMap<
  TerminalReplicaRow,
  readonly (TerminalReplicaCell | undefined)[]
>();

export function retainClippedWideOwner(
  row: TerminalReplicaRow,
  cell: TerminalReplicaCell,
  continuation: TerminalReplicaCell | undefined,
): void {
  clippedWideOwners.set(row, Object.freeze([cell, continuation]));
}

export function retainedTerminalCell(
  row: TerminalReplicaRow,
  column: number,
): TerminalReplicaCell | undefined {
  return clippedWideOwners.get(row)?.[column] ?? row.cells[column];
}
