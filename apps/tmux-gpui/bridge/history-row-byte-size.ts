import type {
  TerminalReplicaRow,
  TerminalReplicaColor,
} from "../../../packages/contracts/src/terminal-replica.ts";
import { isOwnedTerminalReplicaRow } from "../../../packages/core/src/terminal-replica-owned-row.ts";

function exactKeys(value: object, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
function canonicalColor(color: TerminalReplicaColor): boolean {
  if (color.kind === "default") return exactKeys(color, ["kind"]);
  if (color.kind === "indexed")
    return exactKeys(color, ["kind", "index"]) && typeof color.index === "number";
  return (
    color.kind === "rgb" && exactKeys(color, ["kind", "value"]) && typeof color.value === "number"
  );
}
// Core ownership constructors copy structural row/cell/color objects into plain
// frozen data. They can retain extra fields: reject those keys without traversing
// their values (even a frozen foreign Proxy can implement dynamic serialization).
function canonicalShape(row: TerminalReplicaRow): boolean {
  return (
    exactKeys(row, ["wrapped", "cells"]) &&
    typeof row.wrapped === "boolean" &&
    row.cells.every(
      (cell) =>
        exactKeys(cell, ["grapheme", "width", "attributes", "foreground", "background"]) &&
        typeof cell.grapheme === "string" &&
        typeof cell.width === "number" &&
        typeof cell.attributes === "number" &&
        canonicalColor(cell.foreground) &&
        canonicalColor(cell.background),
    )
  );
}

/** Exact legacy UTF-8 JSON cost. Weak keys cannot retain retired history rows. */
export function createHistoryRowByteSizer() {
  const sizes = new WeakMap<TerminalReplicaRow, number>();
  return (row: TerminalReplicaRow): number => {
    const cached = sizes.get(row);
    if (cached !== undefined) return cached;
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (isOwnedTerminalReplicaRow(row) && canonicalShape(row)) sizes.set(row, bytes);
    return bytes;
  };
}
