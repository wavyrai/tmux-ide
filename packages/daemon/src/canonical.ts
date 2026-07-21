export {
  canonicalDaemonUrl,
  clearCanonicalDaemonInfo,
  clearCanonicalDaemonInfoIfUnchanged,
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
} from "./lib/canonical-daemon.ts";
export type {
  CanonicalDaemonInfo,
  CanonicalDaemonInfoInvalidReason,
  CanonicalDaemonInfoObservation,
  CanonicalDaemonInfoState,
} from "./lib/canonical-daemon.ts";
