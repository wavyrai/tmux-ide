/**
 * Per-session filesystem watcher — fans `file.changed` events to
 * the dashboard so open buffers can reseed when files are
 * rewritten externally (terminal, sibling agent, etc.).
 *
 * Built on `@parcel/watcher` (the same library emdash uses): one
 * recursive native-OS subscription per session (FSEvents on macOS,
 * inotify on Linux, ReadDirectoryChangesW on Windows). Unlike
 * chokidar's stat-probe model, parcel/watcher does NOT open per-file
 * descriptors, so watching a project that vendors reference
 * codebases under `context/` no longer exhausts the per-process fd
 * limit and cascades into `EBADF` for every spawnSync(tmux, …).
 *
 * Wiring:
 *   - `subscribe(sessionDir, listener)` starts (or refcount-
 *     increments) the watcher and registers a listener. Returns
 *     `unsubscribe()`.
 *   - On any create / update / delete event under the sandboxed
 *     directory, listeners fire with a workspace-relative path +
 *     event kind. The kind matches the dashboard's reseed
 *     contract: 'modify' for create/update, 'delete' for delete.
 */

import parcelWatcher, { type AsyncSubscription } from "@parcel/watcher";
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
  /** Resolved subscription handle, or null while the async subscribe is in flight. */
  subscription: AsyncSubscription | null;
  /** True if `unsubscribe()` was called before the subscribe promise resolved. */
  closed: boolean;
  resolvedRoot: string;
  listeners: Set<Listener>;
}

// Keyed by the realpath-resolved session directory so multiple
// sessions pointing at the same tree share one watcher.
const watchers = new Map<string, WatcherEntry>();

// Directory names that should never be watched. Mirrors emdash's
// WATCH_IGNORED_NAMES plus tmux-ide-specific paths (`.tmux-ide`,
// `.tasks`, `context` for vendored reference codebases).
const WATCH_IGNORED_NAMES = [
  ".svn",
  ".hg",
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "release",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".svelte-kit",
  ".output",
  ".expo",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv",
  "target",
  ".terraform",
  ".serverless",
  "worktrees",
  ".tmux-ide",
  ".tasks",
  ".claude",
  ".cursor",
  ".aider",
  ".continue",
  "context",
];

const WATCH_IGNORE_GLOBS = WATCH_IGNORED_NAMES.map((n) => `**/${n}/**`);

function buildRelativePath(resolvedRoot: string, absPath: string): string | null {
  const rel = relative(resolvedRoot, absPath);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split("\\").join("/");
}

/**
 * Subscribe to FS-change events for `sessionDir`. Returns an
 * unsubscribe function. When the last listener for a directory
 * unsubscribes, the parcel/watcher subscription is closed.
 */
export function subscribeFsChanges(sessionDir: string, listener: Listener): () => void {
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
    entry = { subscription: null, closed: false, resolvedRoot, listeners: new Set() };
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

    void parcelWatcher
      .subscribe(
        resolvedRoot,
        (err, events) => {
          if (err) return;
          for (const e of events) {
            // parcel/watcher event types: 'create' | 'update' | 'delete'
            if (e.type === "delete") fire("delete", e.path);
            else fire("modify", e.path);
          }
        },
        { ignore: WATCH_IGNORE_GLOBS },
      )
      .then((sub) => {
        const current = watchers.get(resolvedRoot);
        if (!current || current.closed) {
          void sub.unsubscribe().catch(() => {});
          return;
        }
        current.subscription = sub;
      })
      .catch(() => {
        // Subscription failed (e.g. project path removed before watch started).
      });
  }

  entry.listeners.add(listener);
  return () => {
    const current = watchers.get(resolvedRoot);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.closed = true;
      const sub = current.subscription;
      watchers.delete(resolvedRoot);
      if (sub) void sub.unsubscribe().catch(() => {});
    }
  };
}

/** Test-only: tear every active watcher down + clear listeners. */
export function _resetFsWatchForTests(): void {
  for (const entry of watchers.values()) {
    entry.listeners.clear();
    entry.closed = true;
    if (entry.subscription) void entry.subscription.unsubscribe().catch(() => {});
  }
  watchers.clear();
}

/** Test-only: snapshot the active watcher set. */
export function _activeWatchedDirsForTests(): string[] {
  return Array.from(watchers.keys()).sort();
}
