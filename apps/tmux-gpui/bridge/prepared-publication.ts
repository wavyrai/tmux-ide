import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import type { RetainedSnapshotJson } from "./retained-frame-cache.ts";

export type PreparedPublication = {
  readonly snapshot: TerminalReplicaSnapshot | null;
  readonly before: string;
  readonly after: string;
};

/** Freeze mutable control metadata now; defer the immutable terminal body until write admission. */
export function preparePublication(
  prefix: Record<string, unknown>,
  suffix: Record<string, unknown> & { snapshot: TerminalReplicaSnapshot | null },
  retained: RetainedSnapshotJson | null,
): PreparedPublication {
  const before: string[] = [],
    after: string[] = [];
  let found = false;
  for (const [key, value] of Object.entries(suffix)) {
    if (key === "snapshot") {
      found = true;
      continue;
    }
    if (value !== undefined)
      (found ? after : before).push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }
  return {
    snapshot: suffix.snapshot,
    before:
      JSON.stringify(prefix).slice(0, -1) +
      ',"retainedPreview":' +
      (retained === null ? "null" : '{"snapshot":' + retained + "}") +
      "," +
      (before.length ? before.join(",") + "," : "") +
      '"snapshot":',
    after: (after.length ? "," + after.join(",") : "") + "}\n",
  };
}

export function renderPreparedPublication(publication: PreparedPublication, snapshotJson: string) {
  return publication.before + snapshotJson + publication.after;
}
