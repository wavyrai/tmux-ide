import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { terminalReplicaRowsEqual } from "@tmux-ide/core";
import { encodeNativeGridCapture, type NativeGridCapture } from "../mirror/native-grid-capture.ts";
import type { TerminalReplicaNativeBackingResult } from "./terminal-replica-owner.ts";
import { projectNativeGridRow } from "../mirror/native-grid-projection.ts";

/** Encoded payload bytes plus fixed metadata, not an RSS measurement. */
export const MAX_RETAINED_NATIVE_BACKING_BYTES = 64 * 1024 * 1024;
export interface VerifiedNativeSeedBacking {
  readonly encoded: Uint8Array;
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
  const serialized = encodeNativeGridCapture(native);
  if (serialized === null) return false;
  const encoded = new TextEncoder().encode(serialized);
  const chargedBytes = encoded.byteLength + 256;
  if (chargedBytes > MAX_RETAINED_NATIVE_BACKING_BYTES) return false;
  handoff.set(canonical, Object.freeze({ encoded, chargedBytes }));
  return true;
}

export function takeNativeSeedBacking(
  canonical: TerminalReplicaSnapshot,
): VerifiedNativeSeedBacking | undefined {
  const backing = handoff.get(canonical);
  handoff.delete(canonical);
  return backing;
}

/** Encoded backing never exposes its retained buffer to a response consumer. */
export interface RetainedNativeBackingResult {
  readonly status: "retained";
  readonly authority: Extract<
    TerminalReplicaNativeBackingResult,
    { status: "captured" }
  >["authority"];
  readonly isCurrent: () => boolean;
  /** Returns fresh response-owned bytes; mutating or transferring them is safe. */
  readonly encodeBody: (prefix: Uint8Array) => Uint8Array<ArrayBuffer>;
}
export type TerminalNativeBackingResponse =
  | TerminalReplicaNativeBackingResult
  | RetainedNativeBackingResult;
