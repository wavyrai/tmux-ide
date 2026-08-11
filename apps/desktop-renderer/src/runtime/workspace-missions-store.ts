import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  WorkspaceMissionsEnvelopeV1SchemaZ,
  type DesktopDaemonCapabilityErrorCode,
  type HostCapabilities,
  type WorkspaceMissionsResourceV1,
} from "@tmux-ide/contracts";

import {
  createTargetPinnedStore,
  sameDaemonGeneration,
  type WorkspaceResourceClock,
  type WorkspaceResourceSnapshot,
  type WorkspaceResourceTarget,
} from "./target-pinned-store.ts";

const MISSIONS_KEY = "__missions__";

export type WorkspaceMissionsState = {
  readonly generation: number;
  readonly target: WorkspaceResourceTarget | null;
} & (
  | { readonly status: "inactive" }
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly resource: WorkspaceMissionsResourceV1;
      readonly updatedAt: number;
      readonly refreshing: boolean;
    }
  | {
      readonly status: "error";
      readonly code: DesktopDaemonCapabilityErrorCode;
      readonly reason: string;
      readonly stale: WorkspaceResourceSnapshot<WorkspaceMissionsResourceV1> | null;
    }
);

export interface WorkspaceMissionsStore {
  getState(): WorkspaceMissionsState;
  subscribe(listener: (state: WorkspaceMissionsState) => void): () => void;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  refresh(): void;
  dispose(): void;
}

export interface SolidWorkspaceMissionsStore {
  readonly state: Accessor<WorkspaceMissionsState>;
  setTarget(target: unknown): void;
  setActive(active: boolean): void;
  refresh(): void;
  dispose(): void;
}

export function createWorkspaceMissionsStore(options: {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly target: unknown;
  readonly active?: boolean;
  readonly clock?: WorkspaceResourceClock;
}): WorkspaceMissionsStore {
  const store = createTargetPinnedStore<WorkspaceMissionsResourceV1, WorkspaceMissionsState>(
    {
      host: options.host,
      eagerKey: MISSIONS_KEY,
      invalidatesOn: ["workspace-missions.changed"],
      resourceInterest: "workspace-missions",
      async fetch(target) {
        const result = await options.host.daemon.fetchWorkspaceMissions({
          workspaceName: target.workspaceName,
        });
        if (result.status === "error") {
          return { status: "failed", code: result.error.code, reason: result.error.reason };
        }
        const parsed = WorkspaceMissionsEnvelopeV1SchemaZ.safeParse(result.envelope);
        if (!parsed.success) {
          return {
            status: "failed",
            code: "invalid-response",
            reason: "Daemon returned an invalid missions resource.",
          };
        }
        if (!sameDaemonGeneration(target.daemon, parsed.data.daemon)) {
          return {
            status: "failed",
            code: "daemon-identity-mismatch",
            reason: "Missions resource came from another daemon generation.",
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
            reason: "The missions store was disposed.",
            stale: null,
          };
        }
        if (view.targetError) {
          return {
            generation,
            target: null,
            status: "error",
            code: "invalid-request",
            reason: view.targetError.reason,
            stale: null,
          };
        }
        const slot = view.slots.get(MISSIONS_KEY);
        if (!slot) return { generation, target, status: "inactive" };
        if (slot.status === "loading") return { generation, target, status: "loading" };
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
    { active: options.active, clock: options.clock },
  );
  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    setTarget: (target) => store.setTarget(target),
    setActive: (active) => store.setActive(active),
    refresh: () => store.refresh(),
    dispose: () => store.dispose(),
  };
}

export function createSolidWorkspaceMissionsStore(
  options: Parameters<typeof createWorkspaceMissionsStore>[0],
): SolidWorkspaceMissionsStore {
  const store = createWorkspaceMissionsStore(options);
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
    setTarget: (target) => store.setTarget(target),
    setActive: (active) => store.setActive(active),
    refresh: () => store.refresh(),
    dispose,
  };
}
