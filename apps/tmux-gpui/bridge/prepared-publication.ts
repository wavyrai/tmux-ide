import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/terminal-replica.ts";
import type { RetainedSnapshotJson } from "./retained-frame-cache.ts";

export type PreparedPublication = {
  readonly snapshot: TerminalReplicaSnapshot | null;
  readonly before: string;
  readonly after: string;
  readonly controlIdentity: string;
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
  const prefixFields: string[] = [],
    identityFields: string[] = [];
  for (const [key, value] of Object.entries(prefix)) {
    if (value === undefined) continue;
    const field = `${JSON.stringify(key)}:${JSON.stringify(value)}`;
    prefixFields.push(field);
    if (key !== "sequence") identityFields.push(field);
  }
  const retainedText = retained === null ? "null" : '{"snapshot":' + retained + "}";
  return {
    snapshot: suffix.snapshot,
    controlIdentity:
      "{" +
      identityFields.join(",") +
      ',"retainedPreview":' +
      retainedText +
      "," +
      (before.length ? before.join(",") + "," : "") +
      '"snapshot":null' +
      (after.length ? "," + after.join(",") : "") +
      "}",
    before:
      "{" +
      prefixFields.join(",") +
      ',"retainedPreview":' +
      retainedText +
      "," +
      (before.length ? before.join(",") + "," : "") +
      '"snapshot":',
    after: (after.length ? "," + after.join(",") : "") + "}\n",
  };
}

export function renderPreparedPublication(publication: PreparedPublication, snapshotJson: string) {
  return publication.before + snapshotJson + publication.after;
}

/** Suppress only identical requested states; an overwritten pending state still replaces its predecessor. */
export function createPublicationDeduplicator() {
  let previous: PreparedPublication | null = null;
  return (publication: PreparedPublication): boolean => {
    if (
      previous?.snapshot === publication.snapshot &&
      previous.controlIdentity === publication.controlIdentity
    )
      return false;
    previous = publication;
    return true;
  };
}
