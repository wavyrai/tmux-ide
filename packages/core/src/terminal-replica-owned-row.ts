import type {
  TerminalReplicaCell,
  TerminalReplicaColor,
  TerminalReplicaRow,
} from "@tmux-ide/contracts";

// Ownership proves immutable, ordinary data properties, not schema validity.
// There is no registration API: callers can only obtain ownership by copying.
const OWNED_ROWS = new WeakSet<TerminalReplicaRow>();
// Earned only by exact scalar construction, never by immutable foreign copies.
const SCHEMA_VALID_PROJECTED_ROWS = new WeakSet<TerminalReplicaRow>();

export function isSchemaValidProjectedTerminalReplicaRow(row: unknown): boolean {
  return (
    typeof row === "object" &&
    row !== null &&
    SCHEMA_VALID_PROJECTED_ROWS.has(row as TerminalReplicaRow)
  );
}

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

/** Internal incremental copy seam. No caller-owned array or row can be branded.
 * Ownership establishes detached immutable data, never schema validity. */
export function createOwnedTerminalReplicaRowBuilder() {
  const cells: TerminalReplicaCell[] = [];
  let finished = false;
  const assertOpen = () => {
    if (finished) throw new Error("Terminal replica row builder already finished");
  };
  return Object.freeze({
    append(source: TerminalReplicaCell): TerminalReplicaCell {
      assertOpen();
      const cell = freezeOwnedTerminalReplicaCell(source);
      cells.push(cell);
      return cell;
    },
    finish(source: TerminalReplicaRow, wrapped: boolean): TerminalReplicaRow {
      assertOpen();
      finished = true;
      const row = Object.freeze({
        ...source,
        wrapped,
        cells: Object.freeze(cells),
      }) as unknown as TerminalReplicaRow;
      OWNED_ROWS.add(row);
      return row;
    },
  });
}

/** Parser construction seam: accepts primitives, never caller-owned objects or
 * arrays. Ownership proves detached immutable data, not schema validity. */
class ProjectedTerminalReplicaRowBuilder {
  readonly #cells: TerminalReplicaCell[] = [];
  #finished = false;
  #schemaValid = true;

  append(
    grapheme: string,
    width: 0 | 1 | 2,
    attributes: number,
    foregroundKind: TerminalReplicaColor["kind"],
    foregroundValue: number,
    backgroundKind: TerminalReplicaColor["kind"],
    backgroundValue: number,
  ): void {
    this.#assertOpen();
    if (typeof grapheme !== "string" || typeof width !== "number" || typeof attributes !== "number")
      throw new TypeError("Projected terminal cell values must be primitive");
    const foreground = projectedColor(foregroundKind, foregroundValue);
    const background = projectedColor(backgroundKind, backgroundValue);
    const cell =
      width === 1 &&
      attributes === 0 &&
      foreground === TERMINAL_REPLICA_DEFAULT_COLOR &&
      background === TERMINAL_REPLICA_DEFAULT_COLOR &&
      (grapheme === "" || grapheme === " ")
        ? grapheme === ""
          ? TERMINAL_REPLICA_EMPTY_CELL
          : TERMINAL_REPLICA_SPACE_CELL
        : Object.freeze({ grapheme, width, foreground, background, attributes });
    this.#cells.push(cell);
    // Describe the emitted exact-key cell, preserving all original throws and
    // invalid-but-owned construction. Default color does not emit its value.
    this.#schemaValid =
      this.#schemaValid &&
      (width === 0 || width === 1 || width === 2) &&
      Number.isInteger(attributes) &&
      attributes >= 0 &&
      attributes <= 0xff &&
      projectedColorIsSchemaValid(foregroundKind, foregroundValue) &&
      projectedColorIsSchemaValid(backgroundKind, backgroundValue);
  }

  finish(wrapped: boolean): TerminalReplicaRow {
    this.#assertOpen();
    if (typeof wrapped !== "boolean") throw new TypeError("Projected row wrapped must be boolean");
    this.#finished = true;
    const row = Object.freeze({
      wrapped,
      cells: Object.freeze(this.#cells),
    }) as unknown as TerminalReplicaRow;
    OWNED_ROWS.add(row);
    if (this.#schemaValid) SCHEMA_VALID_PROJECTED_ROWS.add(row);
    return row;
  }

  #assertOpen(): void {
    if (this.#finished) throw new Error("Projected terminal row already finished");
  }
}

function projectedColorIsSchemaValid(kind: TerminalReplicaColor["kind"], value: number): boolean {
  return (
    kind === "default" ||
    (Number.isInteger(value) && value >= 0 && value <= (kind === "indexed" ? 255 : 0xffffff))
  );
}

function projectedColor(kind: TerminalReplicaColor["kind"], value: number): TerminalReplicaColor {
  if (typeof value !== "number")
    throw new TypeError("Projected terminal color value must be primitive");
  if (kind === "default") return TERMINAL_REPLICA_DEFAULT_COLOR;
  if (kind === "indexed") return Object.freeze({ kind, index: value });
  if (kind === "rgb") return Object.freeze({ kind, value });
  throw new TypeError("Unknown projected terminal color kind");
}

export function createProjectedTerminalReplicaRowBuilder() {
  return new ProjectedTerminalReplicaRowBuilder();
}
