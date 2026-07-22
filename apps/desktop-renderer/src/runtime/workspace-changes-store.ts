import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  type DesktopDaemonCapabilityErrorCode,
  type HostCapabilities,
  type WorkspaceChangeDiffResourceV1,
  type WorkspaceChangeResourceId,
  type WorkspaceChangesCatalogResourceV1,
} from "@tmux-ide/contracts";

import {
  defaultWorkspaceResourceClock,
  sameDaemonGeneration,
  validateWorkspaceResourceTarget,
  type WorkspaceResourceClock,
  type WorkspaceResourceTarget,
} from "./workspace-resource-store.ts";

type DaemonReads = Pick<HostCapabilities, "daemon">["daemon"];

interface WorkspaceChangesStoreOptionsBase {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly target: unknown;
  readonly clock?: WorkspaceResourceClock;
}

/* ------------------------------------------------------------------------- *
 * Changes catalog — a single target-driven slot                              *
 * ------------------------------------------------------------------------- */

export type WorkspaceChangesCatalogState = {
  readonly generation: number;
  readonly target: WorkspaceResourceTarget | null;
} & (
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly resource: WorkspaceChangesCatalogResourceV1;
      readonly updatedAt: number;
    }
  | {
      readonly status: "error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
    }
);

export interface WorkspaceChangesCatalogStore {
  getState(): WorkspaceChangesCatalogState;
  subscribe(listener: (state: WorkspaceChangesCatalogState) => void): () => void;
  setTarget(target: unknown): void;
  refresh(): void;
  dispose(): void;
}

export interface SolidWorkspaceChangesCatalogStore {
  readonly state: Accessor<WorkspaceChangesCatalogState>;
  setTarget(target: unknown): void;
  refresh(): void;
  dispose(): void;
}

export function createWorkspaceChangesCatalogStore(
  options: WorkspaceChangesStoreOptionsBase,
): WorkspaceChangesCatalogStore {
  const daemon: DaemonReads = options.host.daemon;
  const clock = options.clock ?? defaultWorkspaceResourceClock;
  const listeners = new Set<(state: WorkspaceChangesCatalogState) => void>();

  let disposed = false;
  let generation = 0;
  let target: WorkspaceResourceTarget | null = null;
  let targetKey = "";
  let activeRequest: symbol | null = null;
  let state: WorkspaceChangesCatalogState = { generation, target: null, status: "loading" };

  const emit = (next: WorkspaceChangesCatalogState): void => {
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

  const fetchCatalog = (expectedGeneration: number): void => {
    if (disposed || generation !== expectedGeneration || target === null) return;
    const token = Symbol("changes-request");
    activeRequest = token;
    const expectedTarget = target;
    emit({ generation, target, status: "loading" });
    void daemon
      .fetchWorkspaceChanges({ workspaceName: target.workspaceName })
      .then((result) => {
        if (disposed || generation !== expectedGeneration || activeRequest !== token) return;
        activeRequest = null;
        if (result.status === "error") {
          emit({
            generation,
            target,
            status: "error",
            code: result.error.code,
            reason: result.error.reason,
          });
          return;
        }
        const parsed = WorkspaceChangesCatalogEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          emit({
            generation,
            target,
            status: "error",
            code: "invalid-response",
            reason: "Daemon returned an invalid changes catalog.",
          });
          return;
        }
        if (!sameDaemonGeneration(expectedTarget.daemon, parsed.data.daemon)) {
          emit({
            generation,
            target,
            status: "error",
            code: "daemon-identity-mismatch",
            reason: "Changes catalog came from another daemon generation.",
          });
          return;
        }
        emit({
          generation,
          target,
          status: "loaded",
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
          code: "request-failed",
          reason: "The changes catalog request failed.",
        });
      });
  };

  const startTarget = (untrusted: unknown): void => {
    const validation = validateWorkspaceResourceTarget(untrusted);
    if (validation.ok && target !== null && validation.key === targetKey) return;
    generation += 1;
    activeRequest = null;
    if (!validation.ok) {
      target = null;
      targetKey = `invalid:${generation}`;
      emit({
        generation,
        target: null,
        status: "error",
        code: "invalid-request",
        reason: validation.reason,
      });
      return;
    }
    target = validation.target;
    targetKey = validation.key;
    emit({ generation, target, status: "loading" });
    fetchCatalog(generation);
  };

  const store: WorkspaceChangesCatalogStore = {
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
    refresh() {
      if (disposed || target === null) return;
      fetchCatalog(generation);
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

export function createSolidWorkspaceChangesCatalogStore(
  options: WorkspaceChangesStoreOptionsBase,
): SolidWorkspaceChangesCatalogStore {
  const store = createWorkspaceChangesCatalogStore(options);
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
    refresh: () => store.refresh(),
    dispose,
  };
}

/* ------------------------------------------------------------------------- *
 * Change diff — a single id-driven slot                                      *
 * ------------------------------------------------------------------------- */

export type WorkspaceChangeDiffState = {
  readonly generation: number;
  readonly target: WorkspaceResourceTarget | null;
} & (
  | { readonly status: "idle"; readonly changeId: null }
  | { readonly status: "loading"; readonly changeId: WorkspaceChangeResourceId }
  | {
      readonly status: "loaded";
      readonly changeId: WorkspaceChangeResourceId;
      readonly resource: WorkspaceChangeDiffResourceV1;
      readonly updatedAt: number;
    }
  | {
      readonly status: "error";
      /** Null when the failure is target-level rather than per-change. */
      readonly changeId: WorkspaceChangeResourceId | null;
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
    }
);

export interface WorkspaceChangeDiffStore {
  getState(): WorkspaceChangeDiffState;
  subscribe(listener: (state: WorkspaceChangeDiffState) => void): () => void;
  setTarget(target: unknown): void;
  load(changeId: string): void;
  clear(): void;
  dispose(): void;
}

export interface SolidWorkspaceChangeDiffStore {
  readonly state: Accessor<WorkspaceChangeDiffState>;
  setTarget(target: unknown): void;
  load(changeId: string): void;
  clear(): void;
  dispose(): void;
}

export function createWorkspaceChangeDiffStore(
  options: WorkspaceChangesStoreOptionsBase,
): WorkspaceChangeDiffStore {
  const daemon: DaemonReads = options.host.daemon;
  const clock = options.clock ?? defaultWorkspaceResourceClock;
  const listeners = new Set<(state: WorkspaceChangeDiffState) => void>();

  let disposed = false;
  let generation = 0;
  let target: WorkspaceResourceTarget | null = null;
  let targetKey = "";
  let activeRequest: symbol | null = null;
  let state: WorkspaceChangeDiffState = {
    generation,
    target: null,
    status: "idle",
    changeId: null,
  };

  const emit = (next: WorkspaceChangeDiffState): void => {
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
    if (validation.ok && target !== null && validation.key === targetKey) return;
    generation += 1;
    activeRequest = null;
    if (!validation.ok) {
      target = null;
      targetKey = `invalid:${generation}`;
      emit({
        generation,
        target: null,
        status: "error",
        changeId: null,
        code: "invalid-request",
        reason: validation.reason,
      });
      return;
    }
    target = validation.target;
    targetKey = validation.key;
    emit({ generation, target, status: "idle", changeId: null });
  };

  const store: WorkspaceChangeDiffStore = {
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
    load(rawChangeId) {
      if (disposed || target === null || typeof rawChangeId !== "string" || rawChangeId === "") {
        return;
      }
      const changeId = rawChangeId as WorkspaceChangeResourceId;
      const expectedGeneration = generation;
      const expectedTarget = target;
      const token = Symbol("diff-request");
      activeRequest = token;
      emit({ generation, target, status: "loading", changeId });
      void daemon
        .fetchWorkspaceChangeDiff({ workspaceName: target.workspaceName, changeId })
        .then((result) => {
          if (disposed || generation !== expectedGeneration || activeRequest !== token) return;
          activeRequest = null;
          if (result.status === "error") {
            emit({
              generation,
              target,
              status: "error",
              changeId,
              code: result.error.code,
              reason: result.error.reason,
            });
            return;
          }
          const parsed = WorkspaceChangeDiffEnvelopeV1SchemaZ.safeParse(result.envelope);
          if (!parsed.success) {
            emit({
              generation,
              target,
              status: "error",
              changeId,
              code: "invalid-response",
              reason: "Daemon returned an invalid change diff.",
            });
            return;
          }
          if (!sameDaemonGeneration(expectedTarget.daemon, parsed.data.daemon)) {
            emit({
              generation,
              target,
              status: "error",
              changeId,
              code: "daemon-identity-mismatch",
              reason: "Change diff came from another daemon generation.",
            });
            return;
          }
          emit({
            generation,
            target,
            status: "loaded",
            changeId,
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
            changeId,
            code: "request-failed",
            reason: "The change diff request failed.",
          });
        });
    },
    clear() {
      if (disposed || target === null) return;
      activeRequest = null;
      emit({ generation, target, status: "idle", changeId: null });
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

export function createSolidWorkspaceChangeDiffStore(
  options: WorkspaceChangesStoreOptionsBase,
): SolidWorkspaceChangeDiffStore {
  const store = createWorkspaceChangeDiffStore(options);
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
    load: (changeId) => store.load(changeId),
    clear: () => store.clear(),
    dispose,
  };
}
