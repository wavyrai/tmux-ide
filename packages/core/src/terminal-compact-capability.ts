import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";

interface CompactReplicaCapability {
  readonly baseline: TerminalReplicaSnapshot | null;
  readonly snapshot: TerminalReplicaSnapshot | null;
  readonly hash: string;
  readonly tombstoneInterval?: Readonly<{ baseRevision: number; revision: number }>;
}

const compactReplicaCapabilities = new WeakMap<object, CompactReplicaCapability>();

/** Package-private grant: only a structurally validating, hash-verifying decoder calls this. */
export function grantCompactReplicaCapability(
  owner: object,
  baseline: TerminalReplicaSnapshot | null,
  snapshot: TerminalReplicaSnapshot | null,
  hash: string,
  tombstoneInterval?: Readonly<{ baseRevision: number; revision: number }>,
): void {
  compactReplicaCapabilities.set(
    owner,
    Object.freeze({
      baseline,
      snapshot,
      hash,
      ...(tombstoneInterval ? { tombstoneInterval: Object.freeze({ ...tombstoneInterval }) } : {}),
    }),
  );
}

/** Package-private one-shot adoption: ordinary objects cannot manufacture this grant. */
export function consumeCompactReplicaCapability(
  owner: object,
  baseline: TerminalReplicaSnapshot | null,
  hash: string,
): TerminalReplicaSnapshot | null | undefined {
  const capability = compactReplicaCapabilities.get(owner);
  compactReplicaCapabilities.delete(owner);
  if (!capability || capability.baseline !== baseline || capability.hash !== hash) return undefined;
  return capability.snapshot;
}

/** Only an exact hash-verified decoded tombstone interval can bridge canonical revisions. */
export function consumeVerifiedTombstoneInterval(
  owner: object,
  baseline: TerminalReplicaSnapshot | null,
  hash: string,
  baseRevision: number,
  revision: number,
): boolean {
  const capability = compactReplicaCapabilities.get(owner);
  compactReplicaCapabilities.delete(owner);
  return (
    capability !== undefined &&
    capability.baseline === baseline &&
    capability.snapshot === null &&
    capability.hash === hash &&
    capability.tombstoneInterval?.baseRevision === baseRevision &&
    capability.tombstoneInterval.revision === revision
  );
}
