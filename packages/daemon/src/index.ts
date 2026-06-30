export {
  startEmbeddedDaemon,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "./embed.ts";
export {
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
} from "./canonical.ts";
export type { CanonicalDaemonInfo } from "./canonical.ts";
