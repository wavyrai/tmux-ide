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
): string {
  if (retainedSnapshot === null)
    return JSON.stringify({ ...prefix, retainedPreview: null, ...suffix }) + "\n";
  // These fixed-schema objects are nonempty; strip only their outer braces.
  return (
    JSON.stringify(prefix).slice(0, -1) +
    ',"retainedPreview":{"snapshot":' +
    retainedSnapshot +
    "}," +
    JSON.stringify(suffix).slice(1) +
    "\n"
  );
}
