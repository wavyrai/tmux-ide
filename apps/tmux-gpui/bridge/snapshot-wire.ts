import { z } from "zod";
import {
  TerminalReplicaSnapshotSchemaZ,
  type TerminalReplicaSnapshot,
} from "../../../packages/contracts/src/terminal-replica.ts";
import { decodeCompactSnapshot, encodeCompactSnapshot } from "./compact-snapshot.ts";

export const COMPACT_HELPER_ENV = "TMUX_IDE_GUI_HELPER_ENCODING";
export const COMPACT_NATIVE_ENV = "TMUX_IDE_GUI_NATIVE_ENCODING";
export type SnapshotEncoding = "legacy" | "rle-v1";

/** Each serializer belongs to one negotiated connection. Canonical objects are immutable. */
export function createSnapshotSerializer(encoding: SnapshotEncoding) {
  const cache = new WeakMap<TerminalReplicaSnapshot, string>();
  return (snapshot: TerminalReplicaSnapshot | null): string => {
    if (snapshot === null) return "null";
    let text = cache.get(snapshot);
    if (text === undefined) {
      text = JSON.stringify(encoding === "rle-v1" ? encodeCompactSnapshot(snapshot) : snapshot);
      cache.set(snapshot, text);
    }
    return text;
  };
}

const surfaceEnvelope = z
  .array(
    z
      .object({
        paneId: z.string().min(1).max(512),
        snapshot: z.unknown(),
      })
      .strict(),
  )
  .max(24);

export function decodeSurfacePublication(value: unknown, encoding: SnapshotEncoding) {
  return surfaceEnvelope.parse(value).map(({ paneId, snapshot }) => ({
    paneId,
    snapshot:
      encoding === "rle-v1"
        ? decodeCompactSnapshot(snapshot)
        : TerminalReplicaSnapshotSchemaZ.parse(snapshot),
  }));
}
