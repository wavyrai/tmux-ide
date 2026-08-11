/**
 * Adapter compatibility export. Watcher ownership lives in the daemon engine;
 * widget surfaces consume it without becoming a dependency of command-center.
 */
export {
  watchDirectory,
  watchGitHead,
  type WatchEvent,
} from "../../lib/directory-watcher.ts";
