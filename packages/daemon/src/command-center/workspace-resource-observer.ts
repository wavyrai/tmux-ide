import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import type { DaemonEventResourceKind } from "@tmux-ide/contracts";

import { watchDirectory } from "../widgets/lib/watcher.ts";
import type { WorkspaceRegistry } from "../lib/workspace-registry.ts";

export type ObservableWorkspaceResource =
  | "workspace-files"
  | "workspace-changes"
  | "workspace-missions";

export interface WorkspaceWatchCallbacks {
  readonly onWorkspaceChanged: () => void;
  readonly onGitChanged: () => void;
}

export type StopWorkspaceWatch = () => void | Promise<void>;
export type StartWorkspaceWatch = (
  projectDir: string,
  callbacks: WorkspaceWatchCallbacks,
) => Promise<StopWorkspaceWatch>;

export interface WorkspaceResourceObserverOptions {
  readonly registry: Pick<WorkspaceRegistry, "get" | "on">;
  readonly emit: (change: {
    readonly workspaceName: string;
    readonly resource: ObservableWorkspaceResource;
  }) => void;
  readonly startWatch?: StartWorkspaceWatch;
  readonly debounceMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

interface WorkspaceEntry {
  readonly workspaceName: string;
  readonly refs: Map<ObservableWorkspaceResource, number>;
  epoch: number;
  projectDir: string | null;
  startPromise: Promise<void> | null;
  stop: StopWorkspaceWatch | null;
  timer: ReturnType<typeof setTimeout> | null;
  workspaceDirty: boolean;
  gitDirty: boolean;
}

function resolveGitDirectory(projectDir: string): string | null {
  try {
    const value = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    if (value.length === 0) return null;
    return isAbsolute(value) ? value : resolve(projectDir, value);
  } catch {
    return null;
  }
}

/**
 * Production watcher: one recursive project subscription plus one recursive
 * git-metadata subscription. Git discovery happens once when demand starts;
 * filesystem bursts never spawn git and are coalesced by the observer below.
 */
export const startWorkspaceResourceWatch: StartWorkspaceWatch = async (projectDir, callbacks) => {
  const stops: StopWorkspaceWatch[] = [];
  stops.push(
    await watchDirectory(projectDir, callbacks.onWorkspaceChanged, {
      debounceMs: 40,
      ignore: ["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage"],
    }),
  );

  const gitDir = resolveGitDirectory(projectDir);
  if (gitDir) {
    stops.push(
      await watchDirectory(gitDir, callbacks.onGitChanged, {
        debounceMs: 40,
        // Object and log churn cannot affect the Files/Changes projections.
        // HEAD, index, refs, packed-refs and worktree metadata remain visible.
        ignore: ["objects", "logs"],
      }),
    );
  }

  return async () => {
    await Promise.allSettled(stops.map(async (stop) => stop()));
  };
};

function refCount(entry: WorkspaceEntry): number {
  let total = 0;
  for (const count of entry.refs.values()) total += count;
  return total;
}

/**
 * Daemon-owned, demand-driven filesystem authority. N clients and both Files
 * + Changes projections share one physical watcher per workspace. A watcher
 * that resolves after its last subscriber left is retired immediately, which
 * closes the common async-start leak.
 */
export class WorkspaceResourceObserver {
  readonly #registry: WorkspaceResourceObserverOptions["registry"];
  readonly #emit: WorkspaceResourceObserverOptions["emit"];
  readonly #startWatch: StartWorkspaceWatch;
  readonly #debounceMs: number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #entries = new Map<string, WorkspaceEntry>();
  readonly #pendingStarts = new Set<Promise<void>>();
  readonly #pendingStops = new Set<Promise<unknown>>();
  readonly #unsubscribeAdded: () => void;
  readonly #unsubscribeRemoved: () => void;
  #disposed = false;

  constructor(options: WorkspaceResourceObserverOptions) {
    this.#registry = options.registry;
    this.#emit = options.emit;
    this.#startWatch = options.startWatch ?? startWorkspaceResourceWatch;
    this.#debounceMs = options.debounceMs ?? 75;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.#unsubscribeAdded = this.#registry.on("workspace.added", (workspace) => {
      this.#reconcile(workspace.name);
    });
    this.#unsubscribeRemoved = this.#registry.on("workspace.removed", (name) => {
      this.#retirePhysicalWatch(name);
    });
  }

  acquire(workspaceName: string, resource: ObservableWorkspaceResource): () => void {
    if (this.#disposed) return () => undefined;
    let entry = this.#entries.get(workspaceName);
    if (!entry) {
      entry = {
        workspaceName,
        refs: new Map(),
        epoch: 0,
        projectDir: null,
        startPromise: null,
        stop: null,
        timer: null,
        workspaceDirty: false,
        gitDirty: false,
      };
      this.#entries.set(workspaceName, entry);
    }
    entry.refs.set(resource, (entry.refs.get(resource) ?? 0) + 1);
    this.#reconcile(workspaceName);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#entries.get(workspaceName);
      if (!current) return;
      const next = (current.refs.get(resource) ?? 0) - 1;
      if (next > 0) current.refs.set(resource, next);
      else current.refs.delete(resource);
      if (refCount(current) === 0) {
        this.#entries.delete(workspaceName);
        this.#retireEntry(current);
      }
    };
  }

  /** Test/diagnostic snapshot without leaking private paths. */
  state(): ReadonlyArray<{
    readonly workspaceName: string;
    readonly references: number;
    readonly watching: boolean;
  }> {
    return [...this.#entries.values()].map((entry) => ({
      workspaceName: entry.workspaceName,
      references: refCount(entry),
      watching: entry.stop !== null || entry.startPromise !== null,
    }));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeAdded();
    this.#unsubscribeRemoved();
    for (const entry of this.#entries.values()) this.#retireEntry(entry);
    this.#entries.clear();
    // A native watcher can finish opening after disposal began. Its generation
    // fence closes it immediately; await that close before daemon shutdown is
    // allowed to complete.
    while (this.#pendingStarts.size > 0 || this.#pendingStops.size > 0) {
      await Promise.allSettled([...this.#pendingStarts, ...this.#pendingStops]);
    }
  }

  #reconcile(workspaceName: string): void {
    const entry = this.#entries.get(workspaceName);
    if (!entry || refCount(entry) === 0 || this.#disposed) return;
    const workspace = this.#registry.get(workspaceName);
    if (!workspace) {
      this.#retireWatch(entry);
      entry.projectDir = null;
      return;
    }
    if (
      entry.projectDir === workspace.projectDir &&
      (entry.stop !== null || entry.startPromise !== null)
    ) {
      return;
    }
    this.#retireWatch(entry);
    const epoch = ++entry.epoch;
    entry.projectDir = workspace.projectDir;
    const start = Promise.resolve().then(() =>
      this.#startWatch(workspace.projectDir, {
        onWorkspaceChanged: () => this.#markDirty(entry!, "workspace"),
        onGitChanged: () => this.#markDirty(entry!, "git"),
      }),
    );
    let trackedStart!: Promise<void>;
    trackedStart = start
      .then(async (stop) => {
        if (
          this.#disposed ||
          entry!.epoch !== epoch ||
          this.#entries.get(workspaceName) !== entry ||
          refCount(entry!) === 0
        ) {
          await stop();
          return;
        }
        entry!.stop = stop;
      })
      .catch(() => {
        // A missing/unreadable directory is an unavailable resource, not a
        // daemon failure. A later registry event or new interest retries it.
      })
      .finally(() => {
        if (entry!.epoch === epoch) entry!.startPromise = null;
        this.#pendingStarts.delete(trackedStart);
      });
    entry.startPromise = trackedStart;
    this.#pendingStarts.add(trackedStart);
  }

  #markDirty(entry: WorkspaceEntry, kind: "workspace" | "git"): void {
    if (this.#disposed || this.#entries.get(entry.workspaceName) !== entry) return;
    if (kind === "workspace") entry.workspaceDirty = true;
    else entry.gitDirty = true;
    if (entry.timer) return;
    entry.timer = this.#setTimeout(() => {
      entry.timer = null;
      const filesInterested = (entry.refs.get("workspace-files") ?? 0) > 0;
      const changesInterested = (entry.refs.get("workspace-changes") ?? 0) > 0;
      const workspaceDirty = entry.workspaceDirty;
      const gitDirty = entry.gitDirty;
      entry.workspaceDirty = false;
      entry.gitDirty = false;
      if (workspaceDirty && filesInterested) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-files" });
      }
      if ((workspaceDirty || gitDirty) && changesInterested) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-changes" });
      }
      if (workspaceDirty && (entry.refs.get("workspace-missions") ?? 0) > 0) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-missions" });
      }
    }, this.#debounceMs);
    entry.timer.unref?.();
  }

  #retirePhysicalWatch(workspaceName: string): void {
    const entry = this.#entries.get(workspaceName);
    if (!entry) return;
    this.#retireWatch(entry);
    entry.projectDir = null;
  }

  #retireEntry(entry: WorkspaceEntry): void {
    if (entry.timer) {
      this.#clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.workspaceDirty = false;
    entry.gitDirty = false;
    this.#retireWatch(entry);
  }

  #retireWatch(entry: WorkspaceEntry): void {
    entry.epoch += 1;
    const stop = entry.stop;
    entry.stop = null;
    entry.startPromise = null;
    if (!stop) return;
    const pending = Promise.resolve()
      .then(async () => stop())
      .catch(() => undefined)
      .finally(() => this.#pendingStops.delete(pending));
    this.#pendingStops.add(pending);
  }
}

export function isObservableWorkspaceResource(
  resource: DaemonEventResourceKind,
): resource is ObservableWorkspaceResource {
  return (
    resource === "workspace-files" ||
    resource === "workspace-changes" ||
    resource === "workspace-missions"
  );
}
