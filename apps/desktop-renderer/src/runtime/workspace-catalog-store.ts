import { createSignal, onCleanup, type Accessor } from "solid-js";
import {
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopWorkspaceNameSchemaZ,
  type DaemonInstanceIdentity,
  type DesktopDaemonWorkspaceSummary,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { reconcileWorkspaceSelection } from "@tmux-ide/core";

import {
  createDaemonCatalogAdapter,
  daemonCatalogTerminalCode,
  daemonCatalogTerminalEventCode,
  daemonIdentityKey,
  validateDaemonTarget,
  type DaemonCatalogView,
} from "./daemon-catalog-store.ts";
import {
  createGenerationBoundStore,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
} from "./generation-bound-store.ts";

/**
 * Generation-bound renderer store for the workspace catalog.
 *
 * The read policy is the shared engine in {@link ./generation-bound-store.ts};
 * what is unique to this store is the SELECTION policy below — which workspace
 * the app should show, given a startup or persisted seed, a single live
 * workspace, an explicit user choice, or a workspace that disappeared. That
 * policy sits as a wrapper around the engine so the engine stays free of it.
 */

export type DesktopWorkspaceSelectionSeedSource = "startup" | "persisted";

export interface DesktopWorkspaceSelectionSeed {
  readonly source: DesktopWorkspaceSelectionSeedSource;
  readonly workspaceName: unknown;
}

export type DesktopWorkspaceSelectedReason =
  | DesktopWorkspaceSelectionSeedSource
  | "explicit"
  | "only-live-workspace";

export type DesktopWorkspaceUnselectedReason =
  | "loading"
  | "no-live-workspaces"
  | "multiple-live-workspaces"
  | "startup-selection-invalid"
  | "startup-selection-not-found"
  | "persisted-selection-invalid"
  | "persisted-selection-not-found"
  | "selected-workspace-removed"
  | "explicit-selection-cleared";

export type DesktopWorkspaceSelection =
  | {
      readonly view: "workspace";
      readonly workspaceName: string;
      readonly reason: DesktopWorkspaceSelectedReason;
    }
  | {
      readonly view: "onboarding" | "chooser";
      readonly workspaceName: null;
      readonly reason: DesktopWorkspaceUnselectedReason;
    };

export interface DesktopWorkspaceCatalogSnapshot {
  readonly daemon: DaemonInstanceIdentity;
  readonly workspaces: readonly DesktopDaemonWorkspaceSummary[];
  readonly selection: DesktopWorkspaceSelection;
  readonly updatedAt: number;
}

interface DesktopWorkspaceCatalogStateBase {
  readonly generation: number;
  readonly daemon: DaemonInstanceIdentity | null;
}

export type DesktopWorkspaceCatalogState =
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "loading";
      readonly snapshot: null;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "live";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "stale";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot;
      readonly reason: string;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "degraded";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot | null;
      readonly code:
        | "daemon-unavailable"
        | "daemon-degraded"
        | "daemon-identity-mismatch"
        | "invalid-response"
        | "event-unavailable";
      readonly reason: string;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "error";
      readonly snapshot: DesktopWorkspaceCatalogSnapshot | null;
      readonly code: "request-failed" | "retry-exhausted";
      readonly reason: string;
    })
  | (DesktopWorkspaceCatalogStateBase & {
      readonly status: "disposed";
      readonly daemon: null;
      readonly snapshot: null;
    });

export type DesktopWorkspaceCatalogClock = GenerationBoundClock;
export type DesktopWorkspaceCatalogRetryPolicy = Pick<
  GenerationBoundRetryPolicy,
  "initialDelayMs" | "maximumDelayMs" | "maximumAttempts"
>;

export interface DesktopWorkspaceCatalogStoreOptions {
  readonly host: Pick<HostCapabilities, "daemon">;
  readonly daemon: unknown;
  readonly initialSelection?: DesktopWorkspaceSelectionSeed;
  readonly clock?: DesktopWorkspaceCatalogClock;
  readonly retry?: Partial<DesktopWorkspaceCatalogRetryPolicy>;
}

export type DesktopWorkspaceCatalogStateListener = (state: DesktopWorkspaceCatalogState) => void;

export interface DesktopWorkspaceCatalogStore {
  getState(): DesktopWorkspaceCatalogState;
  subscribe(listener: DesktopWorkspaceCatalogStateListener): () => void;
  select(workspaceName: unknown): boolean;
  clearSelection(): void;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

export interface SolidDesktopWorkspaceCatalogStore {
  readonly state: Accessor<DesktopWorkspaceCatalogState>;
  select(workspaceName: unknown): boolean;
  clearSelection(): void;
  refresh(): void;
  setDaemon(daemon: unknown): void;
  dispose(): void;
}

const WORDING = {
  staleReason: "Daemon catalog events are not connected.",
  eventsUnavailable: "Daemon catalog events are unavailable.",
  eventsExhausted: "Daemon catalog event recovery attempts were exhausted.",
  requestFailed: "Desktop host workspace catalog request failed.",
  subscriptionFailed: "Desktop host catalog event subscription failed.",
} as const;

type WorkspaceList = readonly DesktopDaemonWorkspaceSummary[];

function exactWorkspaceName(value: unknown): string | null {
  const parsed = DesktopWorkspaceNameSchemaZ.safeParse(value);
  return parsed.success && parsed.data === value ? parsed.data : null;
}

function invalidSeedReason(
  source: DesktopWorkspaceSelectionSeedSource,
): DesktopWorkspaceUnselectedReason {
  return source === "startup" ? "startup-selection-invalid" : "persisted-selection-invalid";
}

function missingSeedReason(
  source: DesktopWorkspaceSelectionSeedSource,
): DesktopWorkspaceUnselectedReason {
  return source === "startup" ? "startup-selection-not-found" : "persisted-selection-not-found";
}

function selectionWithoutWorkspace(
  workspaceCount: number,
  reason: DesktopWorkspaceUnselectedReason,
): DesktopWorkspaceSelection {
  return {
    view: workspaceCount === 0 ? "onboarding" : "chooser",
    workspaceName: null,
    reason,
  };
}

function sortWorkspaceSummaries(workspaces: WorkspaceList): DesktopDaemonWorkspaceSummary[] {
  return [...workspaces].sort((left, right) =>
    left.workspaceName < right.workspaceName
      ? -1
      : left.workspaceName > right.workspaceName
        ? 1
        : 0,
  );
}

export function createDesktopWorkspaceCatalogStore(
  options: DesktopWorkspaceCatalogStoreOptions,
): DesktopWorkspaceCatalogStore {
  let selectedWorkspaceName: string | null = null;
  let selectedReason: DesktopWorkspaceSelectedReason | null = null;
  let pendingSelection: {
    readonly source: DesktopWorkspaceSelectionSeedSource;
    readonly workspaceName: string;
  } | null = null;
  let unselectedReason: DesktopWorkspaceUnselectedReason = "loading";
  let suppressAutomaticSelection = false;

  if (options.initialSelection) {
    const candidate = exactWorkspaceName(options.initialSelection.workspaceName);
    if (candidate === null) {
      unselectedReason = invalidSeedReason(options.initialSelection.source);
      suppressAutomaticSelection = true;
    } else {
      pendingSelection = { source: options.initialSelection.source, workspaceName: candidate };
    }
  }

  /**
   * The selection state machine. It ADVANCES, so it must run once per resolved
   * workspace list and once per selection command — never once per projection.
   * {@link selectionOf} enforces that with a memo keyed on the list identity
   * and a command revision.
   */
  const advanceSelection = (workspaces: WorkspaceList): DesktopWorkspaceSelection => {
    const names = new Set(workspaces.map(({ workspaceName }) => workspaceName));
    if (selectedWorkspaceName !== null) {
      if (names.has(selectedWorkspaceName)) {
        return {
          view: "workspace",
          workspaceName: selectedWorkspaceName,
          reason: selectedReason ?? "explicit",
        };
      }
      selectedWorkspaceName = null;
      selectedReason = null;
      pendingSelection = null;
      unselectedReason = "selected-workspace-removed";
      suppressAutomaticSelection = true;
    }
    if (pendingSelection !== null) {
      const resolved = reconcileWorkspaceSelection({
        liveWorkspaceIds: workspaces.map(({ workspaceName }) => workspaceName),
        persistedWorkspaceId: pendingSelection.workspaceName,
      });
      if (resolved.workspaceId !== null) {
        selectedWorkspaceName = resolved.workspaceId;
        selectedReason = pendingSelection.source;
        pendingSelection = null;
        suppressAutomaticSelection = false;
        return { view: "workspace", workspaceName: selectedWorkspaceName, reason: selectedReason };
      }
      unselectedReason = missingSeedReason(pendingSelection.source);
      pendingSelection = null;
      suppressAutomaticSelection = true;
    }
    if (workspaces.length === 1 && !suppressAutomaticSelection) {
      selectedWorkspaceName = reconcileWorkspaceSelection({
        liveWorkspaceIds: workspaces.map(({ workspaceName }) => workspaceName),
        fallback: "only-live",
      }).workspaceId;
      if (selectedWorkspaceName === null) {
        unselectedReason = "no-live-workspaces";
        return selectionWithoutWorkspace(workspaces.length, unselectedReason);
      }
      selectedReason = "only-live-workspace";
      return { view: "workspace", workspaceName: selectedWorkspaceName, reason: selectedReason };
    }
    if (unselectedReason === "loading") {
      unselectedReason =
        workspaces.length === 0 ? "no-live-workspaces" : "multiple-live-workspaces";
    } else if (
      unselectedReason === "no-live-workspaces" &&
      workspaces.length > 0 &&
      !suppressAutomaticSelection
    ) {
      unselectedReason = "multiple-live-workspaces";
    } else if (unselectedReason === "multiple-live-workspaces" && workspaces.length === 0) {
      unselectedReason = "no-live-workspaces";
    }
    return selectionWithoutWorkspace(workspaces.length, unselectedReason);
  };

  let selectionRevision = 0;
  let memoWorkspaces: WorkspaceList | null = null;
  let memoRevision = -1;
  let memoSelection: DesktopWorkspaceSelection | null = null;

  const selectionOf = (workspaces: WorkspaceList): DesktopWorkspaceSelection => {
    if (
      memoSelection !== null &&
      memoWorkspaces === workspaces &&
      memoRevision === selectionRevision
    ) {
      return memoSelection;
    }
    memoWorkspaces = workspaces;
    memoRevision = selectionRevision;
    memoSelection = advanceSelection(workspaces);
    return memoSelection;
  };

  const project = (view: DaemonCatalogView<WorkspaceList>): DesktopWorkspaceCatalogState => {
    const { generation, target: daemon, phase } = view;
    if (view.disposed) {
      return { status: "disposed", generation, daemon: null, snapshot: null };
    }
    const snapshot: DesktopWorkspaceCatalogSnapshot | null =
      view.snapshot && daemon
        ? {
            daemon,
            workspaces: view.snapshot.resource,
            selection: selectionOf(view.snapshot.resource),
            updatedAt: view.snapshot.updatedAt,
          }
        : null;
    if (phase.kind === "loading") {
      return { status: "loading", generation, daemon, snapshot: null };
    }
    if (phase.kind === "live" && snapshot) {
      return { status: "live", generation, daemon, snapshot };
    }
    if (phase.kind === "stale" && snapshot) {
      return { status: "stale", generation, daemon, snapshot, reason: WORDING.staleReason };
    }
    if (phase.kind !== "failed") {
      return { status: "loading", generation, daemon, snapshot: null };
    }
    if (phase.source === "target") {
      return {
        status: "degraded",
        generation,
        daemon: null,
        snapshot: null,
        code:
          phase.failure.code === "daemon-degraded"
            ? "daemon-degraded"
            : phase.failure.code === "invalid-response"
              ? "invalid-response"
              : "daemon-unavailable",
        reason: phase.failure.reason,
      };
    }
    if (phase.fatal) {
      return {
        status: "degraded",
        generation,
        daemon,
        snapshot,
        code: daemonCatalogTerminalCode(phase.failure),
        reason: phase.failure.reason,
      };
    }
    if (phase.source === "event") {
      const terminalCode = daemonCatalogTerminalEventCode(phase.failure);
      if (terminalCode !== null) {
        return {
          status: "degraded",
          generation,
          daemon,
          snapshot,
          code: terminalCode,
          reason: phase.failure.reason,
        };
      }
      const reason = phase.exhausted ? WORDING.eventsExhausted : phase.failure.reason;
      if (snapshot) return { status: "stale", generation, daemon, snapshot, reason };
      return {
        status: "degraded",
        generation,
        daemon,
        snapshot: null,
        code: "event-unavailable",
        reason,
      };
    }
    if (snapshot) {
      return { status: "stale", generation, daemon, snapshot, reason: phase.failure.reason };
    }
    return {
      status: "error",
      generation,
      daemon,
      snapshot: null,
      code: phase.exhausted ? "retry-exhausted" : "request-failed",
      reason: phase.failure.reason,
    };
  };

  const adapter = createDaemonCatalogAdapter<WorkspaceList, DesktopWorkspaceCatalogState>({
    host: options.host,
    invalidatesOn: ["workspaces.changed"],
    resourceInterest: { resource: "workspace-catalog", workspaceName: null },
    wording: WORDING,
    fetch: async (daemon) => {
      const raw = await options.host.daemon.listWorkspaces();
      const parsed = DesktopDaemonListWorkspacesResultSchemaZ.safeParse(raw);
      if (!parsed.success) {
        return {
          status: "failed",
          failure: {
            code: "invalid-response",
            reason: "Desktop host returned an invalid workspace catalog.",
          },
        };
      }
      if (parsed.data.status === "error") {
        return { status: "failed", failure: parsed.data.error };
      }
      if (daemonIdentityKey(parsed.data.daemon) !== daemonIdentityKey(daemon)) {
        return {
          status: "failed",
          failure: {
            code: "daemon-identity-mismatch",
            reason: "Workspace catalog came from another daemon generation.",
          },
        };
      }
      // A name the schema coerced, or a duplicate, cannot become a selection key.
      const names = new Set<string>();
      for (let index = 0; index < parsed.data.workspaces.length; index += 1) {
        const parsedName = parsed.data.workspaces[index]?.workspaceName;
        const rawName = (raw as { workspaces?: Array<{ workspaceName?: unknown }> }).workspaces?.[
          index
        ]?.workspaceName;
        if (parsedName === undefined || parsedName !== rawName || names.has(parsedName)) {
          return {
            status: "failed",
            failure: {
              code: "invalid-response",
              reason: "Desktop host returned an invalid workspace catalog.",
            },
          };
        }
        names.add(parsedName);
      }
      return { status: "ok", resource: sortWorkspaceSummaries(parsed.data.workspaces) };
    },
    project,
  });

  const store = createGenerationBoundStore(adapter, options.daemon, {
    clock: options.clock,
    retry: options.retry,
  });

  let currentDaemonKey: string | null = (() => {
    const validation = validateDaemonTarget(options.daemon);
    return validation.ok ? validation.key : null;
  })();

  /** A selection command re-projects only when a snapshot can carry it. */
  const republishSelection = (): void => {
    selectionRevision += 1;
    if (store.getState().snapshot !== null) store.republish();
  };

  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    select(value) {
      const workspaceName = exactWorkspaceName(value);
      const snapshot = store.getState().snapshot;
      if (
        workspaceName === null ||
        snapshot === null ||
        !snapshot.workspaces.some((workspace) => workspace.workspaceName === workspaceName)
      ) {
        return false;
      }
      selectedWorkspaceName = workspaceName;
      selectedReason = "explicit";
      pendingSelection = null;
      suppressAutomaticSelection = false;
      republishSelection();
      return true;
    },
    clearSelection() {
      selectedWorkspaceName = null;
      selectedReason = null;
      pendingSelection = null;
      suppressAutomaticSelection = true;
      unselectedReason = "explicit-selection-cleared";
      republishSelection();
    },
    refresh: () => store.refresh(),
    setDaemon(nextDaemon) {
      const validation = validateDaemonTarget(nextDaemon);
      const nextKey = validation.ok ? validation.key : null;
      if (nextKey === null || nextKey !== currentDaemonKey) {
        // A new daemon generation retires the selection but remembers it as a
        // seed, so the same workspace is re-chosen if it survived the restart.
        if (selectedWorkspaceName !== null) {
          pendingSelection = {
            source: selectedReason === "startup" ? "startup" : "persisted",
            workspaceName: selectedWorkspaceName,
          };
          selectedWorkspaceName = null;
          selectedReason = null;
          suppressAutomaticSelection = true;
        }
        selectionRevision += 1;
      }
      currentDaemonKey = nextKey;
      store.setTarget(nextDaemon);
    },
    dispose: () => store.dispose(),
  };
}

/** Solid lifecycle adapter; the catalog/selection policy remains framework-independent. */
export function createSolidDesktopWorkspaceCatalogStore(
  options: DesktopWorkspaceCatalogStoreOptions,
): SolidDesktopWorkspaceCatalogStore {
  const store = createDesktopWorkspaceCatalogStore(options);
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
    select: (workspaceName) => store.select(workspaceName),
    clearSelection: () => store.clearSelection(),
    refresh: () => store.refresh(),
    setDaemon: (daemon) => store.setDaemon(daemon),
    dispose,
  };
}
