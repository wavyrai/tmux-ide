export {
  canonicalDaemonUrl,
  clearCanonicalDaemonInfoIfOwned,
  clearCanonicalDaemonInfoIfUnchanged,
  getCanonicalDaemonClaimPath,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  readCanonicalDaemonInfo,
  releaseCanonicalDaemonClaim,
  tryAcquireCanonicalDaemonClaim,
  writeCanonicalDaemonInfo,
} from "./lib/canonical-daemon.ts";
export type {
  CanonicalDaemonInfo,
  CanonicalDaemonInfoInvalidReason,
  CanonicalDaemonInfoObservation,
  CanonicalDaemonInfoState,
  CanonicalDaemonClaim,
  CanonicalDaemonClaimAttempt,
} from "./lib/canonical-daemon.ts";
