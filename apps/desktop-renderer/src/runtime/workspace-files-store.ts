import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  type DesktopDaemonCapabilityErrorCode,
  type HostCapabilities,
  type WorkspaceFilePreviewResourceV1,
  type WorkspaceFileResourceId,
  type WorkspaceFilesCatalogResourceV1,
} from "@tmux-ide/contracts";

import { projectSingleIdSlot } from "./workspace-changes-store.ts";
import {
  createTargetPinnedStore,
  sameDaemonGeneration,
  type TargetPinnedFetchResult,
  type TargetPinnedStoreMetrics,
  type WorkspaceResourceClock,
  type WorkspaceResourceSlot,
  type WorkspaceResourceSnapshot,
  type WorkspaceResourceTarget,
} from "./target-pinned-store.ts";

/**
 * The Files catalog and the file Preview, both on the shared target-pinned
 * engine in {@link ./target-pinned-store.ts}. The Files catalog is the one
 * store that keeps MANY slots at once: one per directory, so tree expansion
 * loads incrementally instead of refetching the whole tree.
 */

interface WorkspaceFilesStoreOptionsBase {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly target: unknown;
  readonly clock?: WorkspaceResourceClock;
  readonly active?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Files catalog set — one slot per directory, incremental for tree expansion *
 * ------------------------------------------------------------------------- */

export type WorkspaceFilesCatalogSlot = WorkspaceResourceSlot<WorkspaceFilesCatalogResourceV1>;

export interface WorkspaceFilesCatalogState {
  readonly generation: number;
  readonly target: WorkspaceResourceTarget | null;
  /** Known once the root catalog resolves ready; the tree projection root. */
  readonly rootId: WorkspaceFileResourceId | null;
  /** Null until the root load starts; otherwise the root directory's slot. */
  readonly root: WorkspaceFilesCatalogSlot | null;
  /** Loaded (or in-flight) child directories, keyed by requested directory id. */
  readonly directories: ReadonlyMap<WorkspaceFileResourceId, WorkspaceFilesCatalogSlot>;
}

export interface WorkspaceFilesCatalogStore {
  getState(): WorkspaceFilesCatalogState;
  getMetrics(): TargetPinnedStoreMetrics;
  subscribe(listener: (state: WorkspaceFilesCatalogState) => void): () => void;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  /** Load the workspace root catalog (also triggered automatically on a new target). */
  loadRoot(): void;
  /** Load a child directory's catalog for tree expansion. */
  loadDirectory(directoryId: string): void;
  /** Forget a previously loaded child directory (collapse). */
  dropDirectory(directoryId: string): void;
  /** Reload the root and every currently tracked child directory. */
  refresh(): void;
  dispose(): void;
}

export interface SolidWorkspaceFilesCatalogStore {
  readonly state: Accessor<WorkspaceFilesCatalogState>;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  loadRoot(): void;
  loadDirectory(directoryId: string): void;
  dropDirectory(directoryId: string): void;
  refresh(): void;
  dispose(): void;
}

const ROOT_KEY = "__root__";

function errorSlot(
  code: DesktopDaemonCapabilityErrorCode,
  reason: string,
): WorkspaceFilesCatalogSlot {
  return { status: "error", code, reason, stale: null };
}

/** The root id survives a failed refresh, because the retained read still names it. */
function rootIdOf(slot: WorkspaceFilesCatalogSlot | undefined): WorkspaceFileResourceId | null {
  const resource =
    slot?.status === "loaded"
      ? slot.resource
      : slot?.status === "error"
        ? (slot.stale?.resource ?? null)
        : null;
  return resource !== null && resource.status === "ready" ? resource.rootId : null;
}

export function createWorkspaceFilesCatalogStore(
  options: WorkspaceFilesStoreOptionsBase,
): WorkspaceFilesCatalogStore {
  const store = createTargetPinnedStore<
    WorkspaceFilesCatalogResourceV1,
    WorkspaceFilesCatalogState
  >(
    {
      host: options.host,
      eagerKey: ROOT_KEY,
      invalidatesOn: ["workspace-files.changed"],
      resourceInterest: "workspace-files",
      async fetch(target, key): Promise<TargetPinnedFetchResult<WorkspaceFilesCatalogResourceV1>> {
        const result = await options.host.daemon.fetchWorkspaceFiles(
          key === ROOT_KEY
            ? { workspaceName: target.workspaceName }
            : { workspaceName: target.workspaceName, directoryId: key },
        );
        if (result.status === "error") {
          return { status: "failed", code: result.error.code, reason: result.error.reason };
        }
        const parsed = WorkspaceFilesCatalogEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          return {
            status: "failed",
            code: "invalid-response",
            reason: "Daemon returned an invalid files catalog.",
          };
        }
        if (!sameDaemonGeneration(target.daemon, parsed.data.daemon)) {
          return {
            status: "failed",
            code: "daemon-identity-mismatch",
            reason: "Files catalog came from another daemon generation.",
          };
        }
        return { status: "ok", resource: parsed.data.resource };
      },
      project(view): WorkspaceFilesCatalogState {
        const generation = view.generation;
        if (view.disposed) {
          return {
            generation,
            target: null,
            rootId: null,
            root: errorSlot("disposed", "The files catalog store was disposed."),
            directories: new Map(),
          };
        }
        if (view.targetError !== null) {
          return {
            generation,
            target: null,
            rootId: null,
            root: errorSlot("invalid-request", view.targetError.reason),
            directories: new Map(),
          };
        }
        const directories = new Map<WorkspaceFileResourceId, WorkspaceFilesCatalogSlot>();
        for (const [key, slot] of view.slots) {
          if (key === ROOT_KEY) continue;
          directories.set(key as WorkspaceFileResourceId, slot);
        }
        const root = view.slots.get(ROOT_KEY) ?? null;
        return {
          generation,
          target: view.target,
          rootId: rootIdOf(root ?? undefined),
          root,
          directories,
        };
      },
    },
    options.target,
    { clock: options.clock, active: options.active },
  );
  return {
    getState: () => store.getState(),
    getMetrics: () => store.getMetrics(),
    subscribe: (listener) => store.subscribe(listener),
    setTarget: (next) => store.setTarget(next),
    setActive: (active) => store.setActive(active),
    loadRoot: () => store.load(ROOT_KEY),
    loadDirectory: (directoryId) => store.load(directoryId),
    dropDirectory: (directoryId) => {
      if (directoryId === ROOT_KEY) return;
      store.drop(directoryId);
    },
    refresh: () => store.refresh(),
    dispose: () => store.dispose(),
  };
}

export function createSolidWorkspaceFilesCatalogStore(
  options: WorkspaceFilesStoreOptionsBase,
): SolidWorkspaceFilesCatalogStore {
  const store = createWorkspaceFilesCatalogStore(options);
  const [state, setState] = createSignal(store.getState(), { equals: false });
  const unsubscribe = store.subscribe(setState);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    store.dispose();
  };
  onCleanup(dispose);
  return {
    state,
    setTarget: (next) => store.setTarget(next),
    setActive: (active) => store.setActive(active),
    loadRoot: () => store.loadRoot(),
    loadDirectory: (directoryId) => store.loadDirectory(directoryId),
    dropDirectory: (directoryId) => store.dropDirectory(directoryId),
    refresh: () => store.refresh(),
    dispose,
  };
}

/* ------------------------------------------------------------------------- *
 * File preview — a single id-driven slot                                     *
 * ------------------------------------------------------------------------- */

export type WorkspaceFilePreviewState = {
  readonly generation: number;
  readonly target: WorkspaceResourceTarget | null;
} & (
  | { readonly status: "idle"; readonly fileId: null }
  | { readonly status: "loading"; readonly fileId: WorkspaceFileResourceId }
  | {
      readonly status: "loaded";
      readonly fileId: WorkspaceFileResourceId;
      readonly resource: WorkspaceFilePreviewResourceV1;
      readonly updatedAt: number;
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      /** Null when the failure is target-level (e.g. an invalid target) rather than per-file. */
      readonly fileId: WorkspaceFileResourceId | null;
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      readonly stale: WorkspaceResourceSnapshot<WorkspaceFilePreviewResourceV1> | null;
    }
);

export interface WorkspaceFilePreviewStore {
  getState(): WorkspaceFilePreviewState;
  getMetrics(): TargetPinnedStoreMetrics;
  subscribe(listener: (state: WorkspaceFilePreviewState) => void): () => void;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  load(fileId: string): void;
  clear(): void;
  dispose(): void;
}

export interface SolidWorkspaceFilePreviewStore {
  readonly state: Accessor<WorkspaceFilePreviewState>;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  load(fileId: string): void;
  clear(): void;
  dispose(): void;
}

export function createWorkspaceFilePreviewStore(
  options: WorkspaceFilesStoreOptionsBase,
): WorkspaceFilePreviewStore {
  const store = createTargetPinnedStore<WorkspaceFilePreviewResourceV1, WorkspaceFilePreviewState>(
    {
      host: options.host,
      singleSlot: true,
      invalidatesOn: ["workspace-files.changed"],
      resourceInterest: "workspace-files",
      async fetch(
        target,
        fileId,
      ): Promise<TargetPinnedFetchResult<WorkspaceFilePreviewResourceV1>> {
        const result = await options.host.daemon.fetchWorkspaceFilePreview({
          workspaceName: target.workspaceName,
          fileId: fileId as WorkspaceFileResourceId,
        });
        if (result.status === "error") {
          return { status: "failed", code: result.error.code, reason: result.error.reason };
        }
        const parsed = WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          return {
            status: "failed",
            code: "invalid-response",
            reason: "Daemon returned an invalid file preview.",
          };
        }
        if (!sameDaemonGeneration(target.daemon, parsed.data.daemon)) {
          return {
            status: "failed",
            code: "daemon-identity-mismatch",
            reason: "File preview came from another daemon generation.",
          };
        }
        return { status: "ok", resource: parsed.data.resource };
      },
      project(view): WorkspaceFilePreviewState {
        const generation = view.generation;
        const projected = projectSingleIdSlot<
          WorkspaceFilePreviewResourceV1,
          WorkspaceFileResourceId
        >(view, "The file preview store was disposed.");
        switch (projected.kind) {
          case "target-error":
            return {
              generation,
              target: null,
              status: "error",
              fileId: null,
              code: projected.code,
              reason: projected.reason,
              stale: null,
            };
          case "idle":
            return { generation, target: view.target, status: "idle", fileId: null };
          case "loading":
            return { generation, target: view.target, status: "loading", fileId: projected.id };
          case "loaded":
            return {
              generation,
              target: view.target,
              status: "loaded",
              fileId: projected.id,
              resource: projected.resource,
              updatedAt: projected.updatedAt,
              refreshing: projected.refreshing,
            };
          case "error":
            return {
              generation,
              target: view.target,
              status: "error",
              fileId: projected.id,
              code: projected.code,
              reason: projected.reason,
              stale: projected.stale,
            };
        }
      },
    },
    options.target,
    { clock: options.clock, active: options.active },
  );
  return {
    getState: () => store.getState(),
    getMetrics: () => store.getMetrics(),
    subscribe: (listener) => store.subscribe(listener),
    setTarget: (next) => store.setTarget(next),
    setActive: (active) => store.setActive(active),
    load: (fileId) => store.load(fileId),
    clear: () => {
      const fileId = store.getState().fileId;
      if (fileId !== null) store.drop(fileId);
    },
    dispose: () => store.dispose(),
  };
}

export function createSolidWorkspaceFilePreviewStore(
  options: WorkspaceFilesStoreOptionsBase,
): SolidWorkspaceFilePreviewStore {
  const store = createWorkspaceFilePreviewStore(options);
  const [state, setState] = createSignal(store.getState(), { equals: false });
  const unsubscribe = store.subscribe(setState);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    store.dispose();
  };
  onCleanup(dispose);
  return {
    state,
    setTarget: (next) => store.setTarget(next),
    setActive: (active) => store.setActive(active),
    load: (fileId) => store.load(fileId),
    clear: () => store.clear(),
    dispose,
  };
}
