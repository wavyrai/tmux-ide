import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import type { DaemonEventResourceKind } from "@tmux-ide/contracts";

import { openProjectRuntimeRepository } from "../lib/project-runtime-repository.ts";
import type { WorkspaceRegistry } from "../lib/workspace-registry.ts";
import { watchDirectory } from "../lib/directory-watcher.ts";

export type ObservableWorkspaceResource =
  | "workspace-files"
  | "workspace-changes"
  | "workspace-missions";

export type StopWorkspaceWatch = () => void | Promise<void>;
export type StartPathWatch = (
  path: string,
  onChanged: () => void,
  onUnavailable: (error: Error) => void,
) => Promise<StopWorkspaceWatch>;

export interface WorkspaceObservationReady {
  readonly status: "installed" | "unavailable";
}

export interface WorkspaceObservationHandle {
  readonly release: () => void;
  readonly ready: Promise<WorkspaceObservationReady>;
}

export interface WorkspaceResourceObserverOptions {
  readonly registry: Pick<WorkspaceRegistry, "get" | "on">;
  readonly emit: (change: {
    readonly workspaceName: string;
    readonly resource: ObservableWorkspaceResource;
  }) => void;
  readonly startProjectWatch?: StartPathWatch;
  readonly startGitWatch?: StartPathWatch;
  readonly startMissionWatch?: StartPathWatch;
  readonly resolveMissionRoot?: (projectDir: string) => Promise<string>;
  readonly resolveGitRoot?: (projectDir: string) => string | null;
  readonly debounceMs?: number;
  readonly retryMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

type Channel = "project" | "git" | "missions";

interface WatchSlot {
  epoch: number;
  source: string | null;
  path: string | null;
  start: Promise<WorkspaceObservationReady> | null;
  stop: StopWorkspaceWatch | null;
  status: WorkspaceObservationReady["status"] | null;
  retry: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
}

interface WorkspaceEntry {
  readonly workspaceName: string;
  readonly refs: Map<ObservableWorkspaceResource, number>;
  readonly slots: Record<Channel, WatchSlot>;
  timer: ReturnType<typeof setTimeout> | null;
  projectDirty: boolean;
  gitDirty: boolean;
  missionsDirty: boolean;
}

function slot(): WatchSlot {
  return {
    epoch: 0,
    source: null,
    path: null,
    start: null,
    stop: null,
    status: null,
    retry: null,
    retryAttempt: 0,
  };
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
    if (!value) return null;
    return isAbsolute(value) ? value : resolve(projectDir, value);
  } catch {
    return null;
  }
}

export const startProjectResourceWatch: StartPathWatch = async (
  projectDir,
  onChanged,
  onUnavailable,
) =>
  watchDirectory(projectDir, onChanged, {
    debounceMs: 40,
    ignore: ["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage"],
    requireInstalled: true,
    onUnavailable,
  });

export const startGitResourceWatch: StartPathWatch = async (gitDir, onChanged, onUnavailable) =>
  watchDirectory(gitDir, onChanged, {
    debounceMs: 40,
    ignore: ["objects", "logs"],
    requireInstalled: true,
    onUnavailable,
  });

export const startMissionResourceWatch: StartPathWatch = async (
  runtimeRoot,
  onChanged,
  onUnavailable,
) =>
  watchDirectory(runtimeRoot, onChanged, {
    debounceMs: 40,
    requireInstalled: true,
    onUnavailable,
  });

function refCount(entry: WorkspaceEntry, resource?: ObservableWorkspaceResource): number {
  if (resource) return entry.refs.get(resource) ?? 0;
  let total = 0;
  for (const count of entry.refs.values()) total += count;
  return total;
}

/**
 * Demand-owned watcher topology. Files and Changes share the project watcher;
 * only Changes owns git metadata, and Missions watches the daemon runtime root
 * rather than source. Every acquisition has an honest installation barrier.
 */
export class WorkspaceResourceObserver {
  readonly #registry: WorkspaceResourceObserverOptions["registry"];
  readonly #emit: WorkspaceResourceObserverOptions["emit"];
  readonly #startProjectWatch: StartPathWatch;
  readonly #startGitWatch: StartPathWatch;
  readonly #startMissionWatch: StartPathWatch;
  readonly #resolveMissionRoot: (projectDir: string) => Promise<string>;
  readonly #resolveGitRoot: (projectDir: string) => string | null;
  readonly #debounceMs: number;
  readonly #retryMs: number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #entries = new Map<string, WorkspaceEntry>();
  readonly #pendingStarts = new Set<Promise<unknown>>();
  readonly #pendingStops = new Set<Promise<unknown>>();
  readonly #unsubscribeAdded: () => void;
  readonly #unsubscribeRemoved: () => void;
  #disposed = false;

  constructor(options: WorkspaceResourceObserverOptions) {
    this.#registry = options.registry;
    this.#emit = options.emit;
    this.#startProjectWatch = options.startProjectWatch ?? startProjectResourceWatch;
    this.#startGitWatch = options.startGitWatch ?? startGitResourceWatch;
    this.#startMissionWatch = options.startMissionWatch ?? startMissionResourceWatch;
    this.#resolveMissionRoot =
      options.resolveMissionRoot ??
      (async (projectDir) => (await openProjectRuntimeRepository(projectDir)).runtimeRoot);
    this.#resolveGitRoot = options.resolveGitRoot ?? resolveGitDirectory;
    this.#debounceMs = options.debounceMs ?? 75;
    this.#retryMs = options.retryMs ?? 250;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.#unsubscribeAdded = this.#registry.on("workspace.added", (workspace) => {
      this.#reconcile(workspace.name);
    });
    this.#unsubscribeRemoved = this.#registry.on("workspace.removed", (name) => {
      const entry = this.#entries.get(name);
      if (entry) this.#retireAll(entry);
    });
  }

  acquire(
    workspaceName: string,
    resource: ObservableWorkspaceResource,
  ): WorkspaceObservationHandle {
    if (this.#disposed) {
      return {
        release: () => undefined,
        ready: Promise.resolve({ status: "unavailable" }),
      };
    }
    let entry = this.#entries.get(workspaceName);
    if (!entry) {
      entry = {
        workspaceName,
        refs: new Map(),
        slots: { project: slot(), git: slot(), missions: slot() },
        timer: null,
        projectDirty: false,
        gitDirty: false,
        missionsDirty: false,
      };
      this.#entries.set(workspaceName, entry);
    }
    entry.refs.set(resource, refCount(entry, resource) + 1);
    const ready = this.#reconcile(workspaceName, resource);
    let released = false;
    return {
      ready,
      release: () => {
        if (released) return;
        released = true;
        const current = this.#entries.get(workspaceName);
        if (!current) return;
        const next = refCount(current, resource) - 1;
        if (next > 0) current.refs.set(resource, next);
        else current.refs.delete(resource);
        this.#reconcile(workspaceName);
        if (refCount(current) === 0) {
          this.#entries.delete(workspaceName);
          this.#retireEntry(current);
        }
      },
    };
  }

  state(): ReadonlyArray<{
    readonly workspaceName: string;
    readonly references: number;
    readonly projectWatching: boolean;
    readonly gitWatching: boolean;
    readonly missionsWatching: boolean;
  }> {
    const active = (watch: WatchSlot) => watch.stop !== null || watch.start !== null;
    return [...this.#entries.values()].map((entry) => ({
      workspaceName: entry.workspaceName,
      references: refCount(entry),
      projectWatching: active(entry.slots.project),
      gitWatching: active(entry.slots.git),
      missionsWatching: active(entry.slots.missions),
    }));
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeAdded();
    this.#unsubscribeRemoved();
    for (const entry of this.#entries.values()) this.#retireEntry(entry);
    this.#entries.clear();
    while (this.#pendingStarts.size || this.#pendingStops.size) {
      await Promise.allSettled([...this.#pendingStarts, ...this.#pendingStops]);
    }
  }

  async #reconcile(
    workspaceName: string,
    waitingFor?: ObservableWorkspaceResource,
  ): Promise<WorkspaceObservationReady> {
    const entry = this.#entries.get(workspaceName);
    if (!entry || this.#disposed) return { status: "unavailable" };
    const workspace = this.#registry.get(workspaceName);
    if (!workspace) {
      this.#retireAll(entry);
      return { status: "unavailable" };
    }

    const needProject =
      refCount(entry, "workspace-files") > 0 || refCount(entry, "workspace-changes") > 0;
    const needGit = refCount(entry, "workspace-changes") > 0;
    const needMissions = refCount(entry, "workspace-missions") > 0;

    const waits: Promise<WorkspaceObservationReady>[] = [];
    if (needProject) {
      waits.push(this.#ensureSlot(entry, "project", workspace.projectDir, this.#startProjectWatch));
    } else this.#retireSlot(entry.slots.project);

    if (needGit) {
      const gitDir = this.#resolveGitRoot(workspace.projectDir);
      if (gitDir) waits.push(this.#ensureSlot(entry, "git", gitDir, this.#startGitWatch));
      else {
        this.#retireSlot(entry.slots.git);
        entry.slots.git.status = "installed";
      }
    } else this.#retireSlot(entry.slots.git);

    if (needMissions) {
      const missionReady = this.#ensureMissionSlot(entry, workspace.projectDir);
      waits.push(missionReady);
    } else this.#retireSlot(entry.slots.missions);

    if (!waitingFor) return { status: "installed" };
    const relevant =
      waitingFor === "workspace-missions"
        ? [entry.slots.missions]
        : waitingFor === "workspace-changes"
          ? [entry.slots.project, entry.slots.git]
          : [entry.slots.project];
    await Promise.all(waits);
    return {
      status: relevant.every((watch) => watch.status === "installed") ? "installed" : "unavailable",
    };
  }

  #ensureMissionSlot(
    entry: WorkspaceEntry,
    projectDir: string,
  ): Promise<WorkspaceObservationReady> {
    const current = entry.slots.missions;
    if (current.source === projectDir && (current.start || current.stop)) {
      return current.start ?? Promise.resolve({ status: current.status ?? "installed" });
    }
    this.#retireSlot(current);
    const epoch = ++current.epoch;
    current.source = projectDir;
    current.path = null;
    const pending = this.#resolveMissionRoot(projectDir)
      .then((runtimeRoot) => {
        if (current.epoch !== epoch || this.#disposed) throw new Error("retired");
        current.path = runtimeRoot;
        return this.#openSlot(entry, "missions", runtimeRoot, this.#startMissionWatch, epoch);
      })
      .then((result) => result)
      .catch(() => {
        if (current.epoch === epoch) {
          current.status = "unavailable";
          this.#scheduleRetry(entry, "missions");
        }
        return { status: "unavailable" } as const;
      })
      .finally(() => {
        if (current.epoch === epoch) current.start = null;
        this.#pendingStarts.delete(pending);
      });
    current.start = pending;
    this.#pendingStarts.add(pending);
    return pending;
  }

  #ensureSlot(
    entry: WorkspaceEntry,
    channel: Channel,
    path: string,
    startWatch: StartPathWatch,
  ): Promise<WorkspaceObservationReady> {
    const current = entry.slots[channel];
    if (current.path === path) {
      if (current.start) return current.start;
      if (current.stop) return Promise.resolve({ status: "installed" });
      // A later reconciliation retries one serialized physical start even if
      // another client still holds the failed slot. Returning the cached
      // unavailable verdict here made N-client recovery impossible.
    }
    this.#retireSlot(current);
    const epoch = ++current.epoch;
    current.path = path;
    current.source = path;
    return this.#openSlot(entry, channel, path, startWatch, epoch);
  }

  #openSlot(
    entry: WorkspaceEntry,
    channel: Channel,
    path: string,
    startWatch: StartPathWatch,
    epoch: number,
  ): Promise<WorkspaceObservationReady> {
    const current = entry.slots[channel];
    let pending!: Promise<WorkspaceObservationReady>;
    pending = Promise.resolve()
      .then(() =>
        startWatch(
          path,
          () => this.#markDirty(entry, channel, epoch),
          (error) => this.#watchUnavailable(entry, channel, epoch, error),
        ),
      )
      .then(async (stop) => {
        if (
          this.#disposed ||
          current.epoch !== epoch ||
          this.#entries.get(entry.workspaceName) !== entry
        ) {
          await stop();
          return { status: "unavailable" } as const;
        }
        current.stop = stop;
        current.status = "installed";
        current.retryAttempt = 0;
        return { status: "installed" } as const;
      })
      .catch(() => {
        if (current.epoch === epoch) {
          current.status = "unavailable";
          this.#scheduleRetry(entry, channel);
        }
        return { status: "unavailable" } as const;
      })
      .finally(() => {
        if (current.epoch === epoch) current.start = null;
        this.#pendingStarts.delete(pending);
      });
    current.start = pending;
    current.status = null;
    this.#pendingStarts.add(pending);
    return pending;
  }

  #markDirty(entry: WorkspaceEntry, channel: Channel, epoch: number): void {
    if (this.#disposed || this.#entries.get(entry.workspaceName) !== entry) return;
    if (entry.slots[channel].epoch !== epoch) return;
    if (channel === "project") entry.projectDirty = true;
    else if (channel === "git") entry.gitDirty = true;
    else entry.missionsDirty = true;
    if (entry.timer) return;
    entry.timer = this.#setTimeout(() => {
      entry.timer = null;
      const projectDirty = entry.projectDirty;
      const gitDirty = entry.gitDirty;
      const missionsDirty = entry.missionsDirty;
      entry.projectDirty = entry.gitDirty = entry.missionsDirty = false;
      if (projectDirty && refCount(entry, "workspace-files")) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-files" });
      }
      if ((projectDirty || gitDirty) && refCount(entry, "workspace-changes")) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-changes" });
      }
      if (missionsDirty && refCount(entry, "workspace-missions")) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-missions" });
      }
    }, this.#debounceMs);
    entry.timer.unref?.();
  }

  #watchUnavailable(entry: WorkspaceEntry, channel: Channel, epoch: number, _error: Error): void {
    if (this.#disposed || this.#entries.get(entry.workspaceName) !== entry) return;
    const current = entry.slots[channel];
    if (current.epoch !== epoch) return;
    this.#retireSlot(current);
    current.status = "unavailable";
    this.#scheduleRetry(entry, channel);
  }

  #channelNeeded(entry: WorkspaceEntry, channel: Channel): boolean {
    if (channel === "project") {
      return refCount(entry, "workspace-files") > 0 || refCount(entry, "workspace-changes") > 0;
    }
    if (channel === "git") return refCount(entry, "workspace-changes") > 0;
    return refCount(entry, "workspace-missions") > 0;
  }

  #scheduleRetry(entry: WorkspaceEntry, channel: Channel): void {
    const current = entry.slots[channel];
    if (
      this.#disposed ||
      this.#entries.get(entry.workspaceName) !== entry ||
      !this.#channelNeeded(entry, channel) ||
      current.retry
    ) {
      return;
    }
    const delay = Math.min(4_000, this.#retryMs * 2 ** current.retryAttempt);
    current.retryAttempt += 1;
    current.retry = this.#setTimeout(() => {
      current.retry = null;
      void this.#retryChannel(entry, channel).catch(() => this.#scheduleRetry(entry, channel));
    }, delay);
    current.retry.unref?.();
  }

  async #retryChannel(entry: WorkspaceEntry, channel: Channel): Promise<void> {
    if (
      this.#disposed ||
      this.#entries.get(entry.workspaceName) !== entry ||
      !this.#channelNeeded(entry, channel)
    ) {
      return;
    }
    const workspace = this.#registry.get(entry.workspaceName);
    if (!workspace) return;
    let ready: WorkspaceObservationReady;
    if (channel === "project") {
      ready = await this.#ensureSlot(entry, channel, workspace.projectDir, this.#startProjectWatch);
    } else if (channel === "git") {
      const gitDir = this.#resolveGitRoot(workspace.projectDir);
      if (!gitDir) {
        this.#scheduleRetry(entry, channel);
        return;
      }
      ready = await this.#ensureSlot(entry, channel, gitDir, this.#startGitWatch);
    } else {
      ready = await this.#ensureMissionSlot(entry, workspace.projectDir);
    }
    if (ready.status !== "installed") {
      this.#scheduleRetry(entry, channel);
      return;
    }
    // The watcher was blind between failure and recovery. Force the demanded
    // projections to refetch once so no change in that interval remains stale.
    if (channel === "project") {
      if (refCount(entry, "workspace-files")) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-files" });
      }
      if (refCount(entry, "workspace-changes")) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-changes" });
      }
    } else if (channel === "git") {
      if (refCount(entry, "workspace-changes")) {
        this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-changes" });
      }
    } else if (refCount(entry, "workspace-missions")) {
      this.#emit({ workspaceName: entry.workspaceName, resource: "workspace-missions" });
    }
  }

  #retireEntry(entry: WorkspaceEntry): void {
    if (entry.timer) this.#clearTimeout(entry.timer);
    entry.timer = null;
    entry.projectDirty = entry.gitDirty = entry.missionsDirty = false;
    this.#retireAll(entry);
  }

  #retireAll(entry: WorkspaceEntry): void {
    this.#retireSlot(entry.slots.project);
    this.#retireSlot(entry.slots.git);
    this.#retireSlot(entry.slots.missions);
  }

  #retireSlot(current: WatchSlot): void {
    current.epoch += 1;
    if (current.retry) this.#clearTimeout(current.retry);
    current.retry = null;
    const stop = current.stop;
    current.stop = null;
    current.start = null;
    current.path = null;
    current.source = null;
    current.status = null;
    if (!stop) return;
    let pending!: Promise<unknown>;
    pending = Promise.resolve()
      .then(() => stop())
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
