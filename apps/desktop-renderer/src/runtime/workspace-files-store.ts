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

import {
  defaultWorkspaceResourceClock,
  sameDaemonGeneration,
  validateWorkspaceResourceTarget,
  type WorkspaceResourceClock,
  type WorkspaceResourceSlot,
  type WorkspaceResourceTarget,
} from "./workspace-resource-store.ts";

type DaemonReads = Pick<HostCapabilities, "daemon">["daemon"];

interface WorkspaceFilesStoreOptionsBase {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly target: unknown;
  readonly clock?: WorkspaceResourceClock;
}

function errorSlot(
  code: DesktopDaemonCapabilityErrorCode,
  reason: string,
): WorkspaceResourceSlot<never> {
  return { status: "error", code, reason };
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
  subscribe(listener: (state: WorkspaceFilesCatalogState) => void): () => void;
  setTarget(target: unknown): void;
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
  loadRoot(): void;
  loadDirectory(directoryId: string): void;
  dropDirectory(directoryId: string): void;
  refresh(): void;
  dispose(): void;
}

const ROOT_KEY = "__root__";

export function createWorkspaceFilesCatalogStore(
  options: WorkspaceFilesStoreOptionsBase,
): WorkspaceFilesCatalogStore {
  const daemon: DaemonReads = options.host.daemon;
  const clock = options.clock ?? defaultWorkspaceResourceClock;
  const listeners = new Set<(state: WorkspaceFilesCatalogState) => void>();

  let disposed = false;
  let generation = 0;
  let target: WorkspaceResourceTarget | null = null;
  let targetKey = "";
  let rootId: WorkspaceFileResourceId | null = null;
  let root: WorkspaceFilesCatalogSlot | null = null;
  const directories = new Map<WorkspaceFileResourceId, WorkspaceFilesCatalogSlot>();
  // Latest request token per directory key (ROOT_KEY for the workspace root).
  const activeRequests = new Map<string, symbol>();

  const snapshot = (): WorkspaceFilesCatalogState => ({
    generation,
    target,
    rootId,
    root,
    directories: new Map(directories),
  });

  const emit = (): void => {
    if (disposed) return;
    const state = snapshot();
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Store observers are untrusted application code; one cannot break another.
      }
    }
  };

  const setSlot = (key: string, slot: WorkspaceFilesCatalogSlot): void => {
    if (key === ROOT_KEY) root = slot;
    else directories.set(key, slot);
  };

  const fetchDirectory = (key: string, expectedGeneration: number): void => {
    if (disposed || generation !== expectedGeneration || target === null) return;
    const token = Symbol("files-request");
    activeRequests.set(key, token);
    setSlot(key, { status: "loading" });
    emit();
    const request =
      key === ROOT_KEY
        ? { workspaceName: target.workspaceName }
        : { workspaceName: target.workspaceName, directoryId: key };
    const expectedTarget = target;
    void daemon
      .fetchWorkspaceFiles(request)
      .then((result) => {
        if (disposed || generation !== expectedGeneration || activeRequests.get(key) !== token) {
          return;
        }
        activeRequests.delete(key);
        if (result.status === "error") {
          setSlot(key, errorSlot(result.error.code, result.error.reason));
          emit();
          return;
        }
        const parsed = WorkspaceFilesCatalogEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          setSlot(key, errorSlot("invalid-response", "Daemon returned an invalid files catalog."));
          emit();
          return;
        }
        if (!sameDaemonGeneration(expectedTarget.daemon, parsed.data.daemon)) {
          setSlot(
            key,
            errorSlot(
              "daemon-identity-mismatch",
              "Files catalog came from another daemon generation.",
            ),
          );
          emit();
          return;
        }
        const resource = parsed.data.resource;
        if (key === ROOT_KEY && resource.status === "ready") rootId = resource.rootId;
        setSlot(key, { status: "loaded", resource, updatedAt: clock.now() });
        emit();
      })
      .catch(() => {
        if (disposed || generation !== expectedGeneration || activeRequests.get(key) !== token) {
          return;
        }
        activeRequests.delete(key);
        setSlot(key, errorSlot("request-failed", "The files catalog request failed."));
        emit();
      });
  };

  const startTarget = (untrusted: unknown): void => {
    const validation = validateWorkspaceResourceTarget(untrusted);
    if (validation.ok && target !== null && validation.key === targetKey) return;
    generation += 1;
    directories.clear();
    activeRequests.clear();
    rootId = null;
    if (!validation.ok) {
      target = null;
      targetKey = `invalid:${generation}`;
      root = errorSlot("invalid-request", validation.reason);
      emit();
      return;
    }
    target = validation.target;
    targetKey = validation.key;
    root = { status: "loading" };
    emit();
    fetchDirectory(ROOT_KEY, generation);
  };

  const store: WorkspaceFilesCatalogStore = {
    getState: snapshot,
    subscribe(listener) {
      if (disposed) {
        try {
          listener(snapshot());
        } catch {
          // ignore observer failure on a disposed store
        }
        return () => undefined;
      }
      listeners.add(listener);
      try {
        listener(snapshot());
      } catch {
        // ignore observer failure
      }
      return () => listeners.delete(listener);
    },
    setTarget(next) {
      if (disposed) return;
      startTarget(next);
    },
    loadRoot() {
      if (disposed || target === null) return;
      fetchDirectory(ROOT_KEY, generation);
    },
    loadDirectory(directoryId) {
      if (disposed || target === null || typeof directoryId !== "string" || directoryId === "") {
        return;
      }
      fetchDirectory(directoryId, generation);
    },
    dropDirectory(directoryId) {
      if (disposed) return;
      activeRequests.delete(directoryId);
      if (directories.delete(directoryId as WorkspaceFileResourceId)) emit();
    },
    refresh() {
      if (disposed || target === null) return;
      const keys = [ROOT_KEY, ...directories.keys()];
      for (const key of keys) fetchDirectory(key, generation);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRequests.clear();
      listeners.clear();
    },
  };

  startTarget(options.target);
  return store;
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
    }
  | {
      readonly status: "error";
      /** Null when the failure is target-level (e.g. an invalid target) rather than per-file. */
      readonly fileId: WorkspaceFileResourceId | null;
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
    }
);

export interface WorkspaceFilePreviewStore {
  getState(): WorkspaceFilePreviewState;
  subscribe(listener: (state: WorkspaceFilePreviewState) => void): () => void;
  setTarget(target: unknown): void;
  load(fileId: string): void;
  clear(): void;
  dispose(): void;
}

export interface SolidWorkspaceFilePreviewStore {
  readonly state: Accessor<WorkspaceFilePreviewState>;
  setTarget(target: unknown): void;
  load(fileId: string): void;
  clear(): void;
  dispose(): void;
}

export function createWorkspaceFilePreviewStore(
  options: WorkspaceFilesStoreOptionsBase,
): WorkspaceFilePreviewStore {
  const daemon: DaemonReads = options.host.daemon;
  const clock = options.clock ?? defaultWorkspaceResourceClock;
  const listeners = new Set<(state: WorkspaceFilePreviewState) => void>();

  let disposed = false;
  let generation = 0;
  let target: WorkspaceResourceTarget | null = null;
  let targetKey = "";
  let activeRequest: symbol | null = null;
  let state: WorkspaceFilePreviewState = {
    generation,
    target: null,
    status: "idle",
    fileId: null,
  };

  const emit = (next: WorkspaceFilePreviewState): void => {
    if (disposed) return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // one observer cannot break another
      }
    }
  };

  const startTarget = (untrusted: unknown): void => {
    const validation = validateWorkspaceResourceTarget(untrusted);
    activeRequest = null;
    if (!validation.ok) {
      generation += 1;
      target = null;
      targetKey = `invalid:${generation}`;
      emit({
        generation,
        target: null,
        status: "error",
        fileId: null,
        code: "invalid-request",
        reason: validation.reason,
      });
      return;
    }
    if (target !== null && validation.key === targetKey) return;
    generation += 1;
    target = validation.target;
    targetKey = validation.key;
    emit({ generation, target, status: "idle", fileId: null });
  };

  const store: WorkspaceFilePreviewStore = {
    getState: () => state,
    subscribe(listener) {
      if (disposed) {
        try {
          listener(state);
        } catch {
          // ignore
        }
        return () => undefined;
      }
      listeners.add(listener);
      try {
        listener(state);
      } catch {
        // ignore
      }
      return () => listeners.delete(listener);
    },
    setTarget(next) {
      if (disposed) return;
      startTarget(next);
    },
    load(rawFileId) {
      if (disposed || target === null || typeof rawFileId !== "string" || rawFileId === "") return;
      const fileId = rawFileId as WorkspaceFileResourceId;
      const expectedGeneration = generation;
      const expectedTarget = target;
      const token = Symbol("preview-request");
      activeRequest = token;
      emit({ generation, target, status: "loading", fileId });
      void daemon
        .fetchWorkspaceFilePreview({ workspaceName: target.workspaceName, fileId })
        .then((result) => {
          if (disposed || generation !== expectedGeneration || activeRequest !== token) return;
          activeRequest = null;
          if (result.status === "error") {
            emit({
              generation,
              target,
              status: "error",
              fileId,
              code: result.error.code,
              reason: result.error.reason,
            });
            return;
          }
          const parsed = WorkspaceFilePreviewEnvelopeV1SchemaZ.safeParse(result.envelope);
          if (!parsed.success) {
            emit({
              generation,
              target,
              status: "error",
              fileId,
              code: "invalid-response",
              reason: "Daemon returned an invalid file preview.",
            });
            return;
          }
          if (!sameDaemonGeneration(expectedTarget.daemon, parsed.data.daemon)) {
            emit({
              generation,
              target,
              status: "error",
              fileId,
              code: "daemon-identity-mismatch",
              reason: "File preview came from another daemon generation.",
            });
            return;
          }
          emit({
            generation,
            target,
            status: "loaded",
            fileId,
            resource: parsed.data.resource,
            updatedAt: clock.now(),
          });
        })
        .catch(() => {
          if (disposed || generation !== expectedGeneration || activeRequest !== token) return;
          activeRequest = null;
          emit({
            generation,
            target,
            status: "error",
            fileId,
            code: "request-failed",
            reason: "The file preview request failed.",
          });
        });
    },
    clear() {
      if (disposed || target === null) return;
      activeRequest = null;
      emit({ generation, target, status: "idle", fileId: null });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRequest = null;
      listeners.clear();
    },
  };

  startTarget(options.target);
  return store;
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
    load: (fileId) => store.load(fileId),
    clear: () => store.clear(),
    dispose,
  };
}
