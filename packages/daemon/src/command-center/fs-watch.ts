/**
 * Per-session filesystem watcher — fans `file.changed` events to
 * the dashboard so open buffers can reseed when files are
 * rewritten externally (terminal, sibling agent, etc.).
 *
 * Built on `chokidar` (already an ambient daemon dep via
 * `lib/task-store.ts`). Each session gets one chokidar instance,
 * ref-counted by the number of active WS subscribers. The
 * watcher ignores `.git`, `node_modules`, and dotfile-prefixed
 * paths so the noise stays bounded.
 *
 * Wiring:
 *   - `subscribe(sessionDir, listener)` starts (or refcount-
 *     increments) the watcher and registers a listener. Returns
 *     `unsubscribe()`.
 *   - On any add / change / unlink event under the sandboxed
 *     directory, listeners fire with a workspace-relative path +
 *     event kind. The kind matches the dashboard's reseed
 *     contract: 'modify' for change/add, 'delete' for unlink.
 */

import { watch, type FSWatcher } from "chokidar";
import { realpathSync } from "node:fs";
import { relative } from "node:path";

export type FsChangeKind = "modify" | "delete";

export interface FsChangeEvent {
  /** Workspace-relative POSIX path. */
  path: string;
  kind: FsChangeKind;
}

type Listener = (event: FsChangeEvent) => void;

interface WatcherEntry {
  watcher: FSWatcher;
  resolvedRoot: string;
  listeners: Set<Listener>;
}

// Keyed by the realpath-resolved session directory so multiple
// sessions pointing at the same tree share one watcher.
const watchers = new Map<string, WatcherEntry>();

const IGNORE_PATTERNS = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.next([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  /(^|[\\/])\.DS_Store$/,
];

function shouldIgnore(absPath: string): boolean {
  return IGNORE_PATTERNS.some((re) => re.test(absPath));
}

function buildRelativePath(resolvedRoot: string, absPath: string): string | null {
  const rel = relative(resolvedRoot, absPath);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split("\\").join("/");
}

/**
 * Subscribe to FS-change events for `sessionDir`. Returns an
 * unsubscribe function. When the last listener for a directory
 * unsubscribes, the chokidar watcher is closed.
 */
export function subscribeFsChanges(
  sessionDir: string,
  listener: Listener,
): () => void {
  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(sessionDir);
  } catch {
    // Directory not accessible — return a no-op so the WS handler
    // doesn't crash.
    return () => {};
  }

  let entry = watchers.get(resolvedRoot);
  if (!entry) {
    const watcher = watch(resolvedRoot, {
      ignored: (absPath) => shouldIgnore(absPath),
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      // Debounce + atomic-write awareness so a vim `:w` (write to
      // tempfile + rename) shows up as one event.
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 30 },
    });
    entry = { watcher, resolvedRoot, listeners: new Set() };
    watchers.set(resolvedRoot, entry);

    const fire = (kind: FsChangeKind, abs: string) => {
      const localEntry = watchers.get(resolvedRoot);
      if (!localEntry) return;
      const rel = buildRelativePath(resolvedRoot, abs);
      if (!rel) return;
      const event: FsChangeEvent = { path: rel, kind };
      for (const l of localEntry.listeners) {
        try {
          l(event);
        } catch {
          /* listener failures must not break the watcher */
        }
      }
    };
    watcher.on("add", (abs) => fire("modify", abs));
    watcher.on("change", (abs) => fire("modify", abs));
    watcher.on("unlink", (abs) => fire("delete", abs));
    watcher.on("error", () => {
      /* swallow — losing the watcher is a soft failure */
    });
  }

  entry.listeners.add(listener);
  return () => {
    const current = watchers.get(resolvedRoot);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      void current.watcher.close().catch(() => {});
      watchers.delete(resolvedRoot);
    }
  };
}

/** Test-only: tear every active watcher down + clear listeners. */
export function _resetFsWatchForTests(): void {
  for (const entry of watchers.values()) {
    entry.listeners.clear();
    void entry.watcher.close().catch(() => {});
  }
  watchers.clear();
}

/** Test-only: snapshot the active watcher set. */
export function _activeWatchedDirsForTests(): string[] {
  return Array.from(watchers.keys()).sort();
}
