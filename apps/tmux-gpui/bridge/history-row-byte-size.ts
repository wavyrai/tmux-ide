import type { TerminalReplicaRow } from "../../../packages/contracts/src/terminal-replica.ts";
import { isOwnedTerminalReplicaRow } from "../../../packages/core/src/terminal-replica-owned-row.ts";

// Ownership can retain foreign extra fields. Admit only frozen ordinary data
// graphs without hooks/accessors; never mistake a shallow freeze for stability.
function serializationStable(root: object): boolean {
  const pending = [root];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !Object.isFrozen(value) ||
      (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) ||
      "toJSON" in value
    )
      return false;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor)) return false;
      const child: unknown = descriptor.value;
      if (child !== null && typeof child === "object") pending.push(child);
      else if (!["string", "number", "boolean"].includes(typeof child) && child !== null)
        return false;
    }
  }
  return true;
}

/** Exact legacy UTF-8 JSON cost. Weak keys cannot retain retired history rows. */
export function createHistoryRowByteSizer() {
  const sizes = new WeakMap<TerminalReplicaRow, number>();
  return (row: TerminalReplicaRow): number => {
    const cached = sizes.get(row);
    if (cached !== undefined) return cached;
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (isOwnedTerminalReplicaRow(row) && serializationStable(row)) sizes.set(row, bytes);
    return bytes;
  };
}
