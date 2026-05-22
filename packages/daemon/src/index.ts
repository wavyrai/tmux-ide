export {
  startEmbeddedDaemon,
  type EmbeddedDaemonHandle,
  type EmbeddedDaemonOptions,
} from "./embed.ts";
export * from "./chat/index.ts";
export {
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
} from "./canonical.ts";
export type { CanonicalDaemonInfo } from "./canonical.ts";
export { appCommand } from "./app-cli.ts";
export { uiCommand, openInBrowser } from "./ui.ts";
export { chatCommand, type ChatCommandArgs } from "./chat.ts";
