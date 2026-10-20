import { Buffer } from "node:buffer";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";

declare const retainedSnapshotJson: unique symbol;
/** Immutable JSON produced by this bounded cache, never caller-provided JSON. */
export type RetainedSnapshotJson = string & { readonly [retainedSnapshotJson]: true };

const MAX_ENTRIES = 8;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Pixels only. Caller must prove route incarnation and keep all input authority fresh. */
export function createRetainedFrameCache() {
  const entries = new Map<string, { proof: string; json: RetainedSnapshotJson; bytes: number }>();
  let total = 0;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) {
      total -= entry.bytes;
      entries.delete(key);
    }
  };
  return {
    remember(key: string, proof: string, snapshot: TerminalReplicaSnapshot): boolean {
      remove(key);
      if (!key || !proof || key.length > 16384 || proof.length > 16384) return false;
      let json: string;
      try {
        json = JSON.stringify(snapshot);
      } catch {
        return false;
      }
      const bytes = Buffer.byteLength(json);
      if (bytes > MAX_ENTRY_BYTES) return false;
      while (entries.size >= MAX_ENTRIES || total + bytes > MAX_TOTAL_BYTES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) return false;
        remove(oldest);
      }
      entries.set(key, { proof, json: json as RetainedSnapshotJson, bytes });
      total += bytes;
      return true;
    },
    preview(key: string, proof: string): RetainedSnapshotJson | null {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.proof !== proof) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.json;
    },
    retain(keys: Iterable<string>): void {
      const allowed = new Set(keys);
      for (const key of entries.keys()) if (!allowed.has(key)) remove(key);
    },
    clear(): void {
      entries.clear();
      total = 0;
    },
  };
}
