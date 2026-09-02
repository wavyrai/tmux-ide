import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";

interface CompactReplicaCapability {
  readonly baseline: TerminalReplicaSnapshot | null;
  readonly snapshot: TerminalReplicaSnapshot | null;
  readonly hash: string;
}

const compactReplicaCapabilities = new WeakMap<object, CompactReplicaCapability>();

/** Package-private grant: only a structurally validating, hash-verifying decoder calls this. */
export function grantCompactReplicaCapability(
  owner: object,
  baseline: TerminalReplicaSnapshot | null,
  snapshot: TerminalReplicaSnapshot | null,
  hash: string,
): void {
  compactReplicaCapabilities.set(owner, Object.freeze({ baseline, snapshot, hash }));
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
