import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { terminalReplicaRowsEqual } from "@tmux-ide/core";
import type { NativeGridCapture } from "../mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../mirror/native-grid-projection.ts";

/** Conservative retained object accounting, not an RSS measurement. */
export const MAX_RETAINED_NATIVE_BACKING_BYTES = 64 * 1024 * 1024;
export interface VerifiedNativeSeedBacking {
  readonly snapshot: NativeGridCapture;
  readonly chargedBytes: number;
}
export interface NativeBackingIdentity {
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
}
// Single-consumer handoff: the hub takes ownership synchronously before any
// cooperative reduction. No revision-indexed history is kept outside the hub.
const handoff = new WeakMap<TerminalReplicaSnapshot, VerifiedNativeSeedBacking>();

export function rememberNativeSeedBacking(
  canonical: TerminalReplicaSnapshot,
  native: NativeGridCapture,
): boolean {
  if (
    native.version !== 2 ||
    native.cols !== canonical.cols ||
    native.rows !== canonical.rows ||
    native.history !== canonical.history.length ||
    Math.min(native.cursor[0], native.cols - 1) !== canonical.cursor.x ||
    native.cursor[1] !== canonical.cursor.y
  )
    return false;
  let chargedBytes = 256;
  for (const row of native.grid) {
    chargedBytes += 96;
    for (const cell of row.cells)
      chargedBytes += 128 + 2 * (cell.text.length + cell.bytesHex.length);
    if (chargedBytes > MAX_RETAINED_NATIVE_BACKING_BYTES) return false;
  }
  if (native.grid.length !== canonical.history.length + canonical.grid.length) return false;
  for (let index = 0; index < native.grid.length; index++) {
    const row =
      index < canonical.history.length
        ? canonical.history[index]!
        : canonical.grid[index - canonical.history.length]!;
    const projected = projectNativeGridRow(
      native.grid[index],
      native.cols,
      0,
      index > 0 && (native.grid[index - 1]!.flags & 1) !== 0,
    );
    if (!projected || !terminalReplicaRowsEqual(row, projected)) return false;
  }
  handoff.set(canonical, Object.freeze({ snapshot: native, chargedBytes }));
  return true;
}

export function takeNativeSeedBacking(
  canonical: TerminalReplicaSnapshot,
): VerifiedNativeSeedBacking | undefined {
  const backing = handoff.get(canonical);
  handoff.delete(canonical);
  return backing;
}
