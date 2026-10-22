import { createSnapshotSerializer, type SnapshotEncoding } from "./snapshot-wire.ts";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import type { RetainedSnapshotJson } from "./retained-frame-cache.ts";

/**
 * Fixed browser wire split: prefix ends at selectedPane, suffix begins at
 * selectionIdentity. Both objects are evaluated before serialization. Only the
 * retained cache can supply snapshot bytes; live snapshots remain ordinary JSON.
 */
export function serializeBrowserPublication(
  prefix: { version: number; selectedPane: unknown } & Record<string, unknown>,
  suffix: { selectionIdentity: unknown; machines: unknown } & Record<string, unknown>,
  retainedSnapshot: RetainedSnapshotJson | null,
  encoding: SnapshotEncoding = "legacy",
): string {
  // These fixed-schema objects are nonempty; strip only their outer braces.
  return (
    JSON.stringify(prefix).slice(0, -1) +
    ',"retainedPreview":' +
    (retainedSnapshot === null ? "null" : '{"snapshot":' + retainedSnapshot + "}") +
    "," +
    stringifySuffix(suffix, encoding).slice(1) +
    "\n"
  );
}

// Presented snapshots are replaced, never mutated: an unchanged frame serializes once.
const snapshotText = new WeakMap<object, string>();
const compactText = createSnapshotSerializer("rle-v1");
function stringifySuffix(suffix: Record<string, unknown>, encoding: SnapshotEncoding) {
  const fields = Object.entries(suffix)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      let text: string | undefined;
      if (key === "snapshot" && value !== null && typeof value === "object") {
        if (encoding === "rle-v1") text = compactText(value as TerminalReplicaSnapshot);
        else text = snapshotText.get(value);
        if (text === undefined) snapshotText.set(value, (text = JSON.stringify(value)));
      } else text = JSON.stringify(value);
      return `${JSON.stringify(key)}:${text}`;
    });
  return `{${fields.join(",")}}`;
}
