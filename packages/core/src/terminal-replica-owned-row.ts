import type {
  TerminalReplicaCell,
  TerminalReplicaColor,
  TerminalReplicaRow,
} from "@tmux-ide/contracts";

// Ownership proves immutable, ordinary data properties, not schema validity.
// There is no registration API: callers can only obtain ownership by copying.
const OWNED_ROWS = new WeakSet<TerminalReplicaRow>();

export const TERMINAL_REPLICA_DEFAULT_COLOR = Object.freeze({ kind: "default" } as const);

// Trusted immutable producer values only. Empty storage and a literal space
// remain distinct for reflow; foreign equivalent cells are still copied.
export const TERMINAL_REPLICA_EMPTY_CELL: Readonly<TerminalReplicaCell> = Object.freeze({
  grapheme: "",
  width: 1,
  attributes: 0,
  foreground: TERMINAL_REPLICA_DEFAULT_COLOR,
  background: TERMINAL_REPLICA_DEFAULT_COLOR,
});
export const TERMINAL_REPLICA_SPACE_CELL: Readonly<TerminalReplicaCell> = Object.freeze({
  ...TERMINAL_REPLICA_EMPTY_CELL,
  grapheme: " ",
});

function freezeColor(color: TerminalReplicaColor): TerminalReplicaColor {
  if (color === TERMINAL_REPLICA_DEFAULT_COLOR) return color;
  // Copy first: external objects (including getters) keep the existing detached
  // data contract. Share only the exact default shape, without erasing fields.
  const copy = { ...color };
  return copy.kind === "default" && Reflect.ownKeys(copy).length === 1
    ? TERMINAL_REPLICA_DEFAULT_COLOR
    : Object.freeze(copy);
}

// Internal copy seam shared by row ownership and cooperative seed admission.
// Exact trusted values may be shared; foreign objects always remain detached.
export function freezeOwnedTerminalReplicaCell(cell: TerminalReplicaCell): TerminalReplicaCell {
  return cell === TERMINAL_REPLICA_EMPTY_CELL || cell === TERMINAL_REPLICA_SPACE_CELL
    ? cell
    : Object.freeze({
        ...cell,
        foreground: freezeColor(cell.foreground),
        background: freezeColor(cell.background),
      });
}

export function isOwnedTerminalReplicaRow(row: unknown): row is TerminalReplicaRow {
  return typeof row === "object" && row !== null && OWNED_ROWS.has(row as TerminalReplicaRow);
}

export function freezeOwnedTerminalReplicaRow(row: TerminalReplicaRow): TerminalReplicaRow {
  if (OWNED_ROWS.has(row)) return row;
  const frozen = Object.freeze({
    wrapped: row.wrapped,
    cells: Object.freeze(Array.from(row.cells, freezeOwnedTerminalReplicaCell)),
  }) as unknown as TerminalReplicaRow;
  OWNED_ROWS.add(frozen);
  return frozen;
}
