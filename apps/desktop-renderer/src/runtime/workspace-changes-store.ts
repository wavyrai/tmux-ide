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
  createTargetPinnedStore,
  sameDaemonGeneration,
  type TargetPinnedFetchResult,
  type TargetPinnedView,
  type WorkspaceResourceClock,
  type WorkspaceResourceSnapshot,
  type WorkspaceResourceTarget,
} from "./target-pinned-store.ts";

/**
 * The Changes catalog and the change Diff, both on the shared target-pinned
 * engine in {@link ./target-pinned-store.ts}. What is unique to each is its
 * envelope schema, its wording, and the projection onto its public state.
 */

interface WorkspaceChangesStoreOptionsBase {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly target: unknown;
  readonly clock?: WorkspaceResourceClock;
  readonly active?: boolean;
}

const CATALOG_KEY = "__changes__";

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
      /** A read is in flight that will replace this one; the content stands. */
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      /** The last good read, retained so a transient failure blanks nothing. */
      readonly stale: WorkspaceResourceSnapshot<WorkspaceChangesCatalogResourceV1> | null;
    }
);

export interface WorkspaceChangesCatalogStore {
  getState(): WorkspaceChangesCatalogState;
  subscribe(listener: (state: WorkspaceChangesCatalogState) => void): () => void;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  refresh(): void;
  dispose(): void;
}

export interface SolidWorkspaceChangesCatalogStore {
  readonly state: Accessor<WorkspaceChangesCatalogState>;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  refresh(): void;
  dispose(): void;
}

export function createWorkspaceChangesCatalogStore(
  options: WorkspaceChangesStoreOptionsBase,
): WorkspaceChangesCatalogStore {
  const store = createTargetPinnedStore<
    WorkspaceChangesCatalogResourceV1,
    WorkspaceChangesCatalogState
  >(
    {
      host: options.host,
      eagerKey: CATALOG_KEY,
      invalidatesOn: ["workspace-changes.changed"],
      resourceInterest: "workspace-changes",
      async fetch(target): Promise<TargetPinnedFetchResult<WorkspaceChangesCatalogResourceV1>> {
        const result = await options.host.daemon.fetchWorkspaceChanges({
          workspaceName: target.workspaceName,
        });
        if (result.status === "error") {
          return { status: "failed", code: result.error.code, reason: result.error.reason };
        }
        const parsed = WorkspaceChangesCatalogEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          return {
            status: "failed",
            code: "invalid-response",
            reason: "Daemon returned an invalid changes catalog.",
          };
        }
        if (!sameDaemonGeneration(target.daemon, parsed.data.daemon)) {
          return {
            status: "failed",
            code: "daemon-identity-mismatch",
            reason: "Changes catalog came from another daemon generation.",
          };
        }
        return { status: "ok", resource: parsed.data.resource };
      },
      project(view) {
        const { generation, target } = view;
        if (view.disposed) {
          return {
            generation,
            target: null,
            status: "error",
            code: "disposed",
            reason: "The changes catalog store was disposed.",
            stale: null,
          };
        }
        if (view.targetError !== null) {
          return {
            generation,
            target: null,
            status: "error",
            code: "invalid-request",
            reason: view.targetError.reason,
            stale: null,
          };
        }
        const slot = view.slots.get(CATALOG_KEY);
        if (slot === undefined || slot.status === "loading") {
          return { generation, target, status: "loading" };
        }
        if (slot.status === "loaded") {
          return {
            generation,
            target,
            status: "loaded",
            resource: slot.resource,
            updatedAt: slot.updatedAt,
            refreshing: slot.refreshing,
          };
        }
        return {
          generation,
          target,
          status: "error",
          code: slot.code,
          reason: slot.reason,
          stale: slot.stale,
        };
      },
    },
    options.target,
    { clock: options.clock, active: options.active },
  );
  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    setTarget: (next) => store.setTarget(next),
    setActive: (active) => store.setActive(active),
    refresh: () => store.refresh(),
    dispose: () => store.dispose(),
  };
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
    setActive: (active) => store.setActive(active),
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
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      /** Null when the failure is target-level rather than per-change. */
      readonly changeId: WorkspaceChangeResourceId | null;
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      readonly stale: WorkspaceResourceSnapshot<WorkspaceChangeDiffResourceV1> | null;
    }
);

export interface WorkspaceChangeDiffStore {
  getState(): WorkspaceChangeDiffState;
  subscribe(listener: (state: WorkspaceChangeDiffState) => void): () => void;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  load(changeId: string): void;
  clear(): void;
  dispose(): void;
}

export interface SolidWorkspaceChangeDiffStore {
  readonly state: Accessor<WorkspaceChangeDiffState>;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  load(changeId: string): void;
  clear(): void;
  dispose(): void;
}

/**
 * The projection shared by the diff and the file preview: one id-driven slot,
 * where the absence of a slot is the surface's idle state and a target-level
 * failure is an error with no id.
 */
export type SingleIdSlotProjection<TResource, TId extends string> =
  | { readonly kind: "idle" }
  | {
      readonly kind: "target-error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
    }
  | { readonly kind: "loading"; readonly id: TId }
  | {
      readonly kind: "loaded";
      readonly id: TId;
      readonly resource: TResource;
      readonly updatedAt: number;
      readonly refreshing: boolean;
    }
  | {
      readonly kind: "error";
      readonly id: TId;
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      readonly stale: WorkspaceResourceSnapshot<TResource> | null;
    };

export function projectSingleIdSlot<TResource, TId extends string>(
  view: TargetPinnedView<TResource>,
  disposedReason: string,
): SingleIdSlotProjection<TResource, TId> {
  if (view.disposed) {
    return { kind: "target-error", code: "disposed", reason: disposedReason };
  }
  if (view.targetError !== null) {
    return { kind: "target-error", code: "invalid-request", reason: view.targetError.reason };
  }
  const entry = [...view.slots.entries()][0];
  if (entry === undefined) return { kind: "idle" };
  const [rawId, slot] = entry;
  const id = rawId as TId;
  if (slot.status === "loading") return { kind: "loading", id };
  if (slot.status === "loaded") {
    return {
      kind: "loaded",
      id,
      resource: slot.resource,
      updatedAt: slot.updatedAt,
      refreshing: slot.refreshing,
    };
  }
  return { kind: "error", id, code: slot.code, reason: slot.reason, stale: slot.stale };
}

export function createWorkspaceChangeDiffStore(
  options: WorkspaceChangesStoreOptionsBase,
): WorkspaceChangeDiffStore {
  const store = createTargetPinnedStore<WorkspaceChangeDiffResourceV1, WorkspaceChangeDiffState>(
    {
      host: options.host,
      singleSlot: true,
      invalidatesOn: ["workspace-changes.changed"],
      resourceInterest: "workspace-changes",
      async fetch(
        target,
        changeId,
      ): Promise<TargetPinnedFetchResult<WorkspaceChangeDiffResourceV1>> {
        const result = await options.host.daemon.fetchWorkspaceChangeDiff({
          workspaceName: target.workspaceName,
          changeId: changeId as WorkspaceChangeResourceId,
        });
        if (result.status === "error") {
          return { status: "failed", code: result.error.code, reason: result.error.reason };
        }
        const parsed = WorkspaceChangeDiffEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          return {
            status: "failed",
            code: "invalid-response",
            reason: "Daemon returned an invalid change diff.",
          };
        }
        if (!sameDaemonGeneration(target.daemon, parsed.data.daemon)) {
          return {
            status: "failed",
            code: "daemon-identity-mismatch",
            reason: "Change diff came from another daemon generation.",
          };
        }
        return { status: "ok", resource: parsed.data.resource };
      },
      project(view): WorkspaceChangeDiffState {
        const generation = view.generation;
        const projected = projectSingleIdSlot<
          WorkspaceChangeDiffResourceV1,
          WorkspaceChangeResourceId
        >(view, "The change diff store was disposed.");
        switch (projected.kind) {
          case "target-error":
            return {
              generation,
              target: null,
              status: "error",
              changeId: null,
              code: projected.code,
              reason: projected.reason,
              stale: null,
            };
          case "idle":
            return { generation, target: view.target, status: "idle", changeId: null };
          case "loading":
            return {
              generation,
              target: view.target,
              status: "loading",
              changeId: projected.id,
            };
          case "loaded":
            return {
              generation,
              target: view.target,
              status: "loaded",
              changeId: projected.id,
              resource: projected.resource,
              updatedAt: projected.updatedAt,
              refreshing: projected.refreshing,
            };
          case "error":
            return {
              generation,
              target: view.target,
              status: "error",
              changeId: projected.id,
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
    subscribe: (listener) => store.subscribe(listener),
    setTarget: (next) => store.setTarget(next),
    setActive: (active) => store.setActive(active),
    load: (changeId) => store.load(changeId),
    clear: () => {
      const changeId = store.getState().changeId;
      if (changeId !== null) store.drop(changeId);
    },
    dispose: () => store.dispose(),
  };
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
    setActive: (active) => store.setActive(active),
    load: (changeId) => store.load(changeId),
    clear: () => store.clear(),
    dispose,
  };
}
