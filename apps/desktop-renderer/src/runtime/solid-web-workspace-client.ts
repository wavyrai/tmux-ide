import { createSignal, onCleanup, type Accessor } from "solid-js";
import type {
  ApplicationShellProjectionInputV1,
  DesktopApplicationShellTarget,
  HostCapabilities,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthoritySnapshot,
} from "@tmux-ide/contracts";
import type { WorkspaceClientSnapshot } from "@tmux-ide/daemon-client";

import {
  createWebWorkspaceClient,
  paneStreamBridgeForWebWorkspaceClient,
  type WebWorkspaceClient,
} from "./web-workspace-client.ts";

export interface SolidWebWorkspaceClient {
  readonly client: WebWorkspaceClient;
  readonly snapshot: Accessor<WorkspaceClientSnapshot<ApplicationShellProjectionInputV1>>;
  readonly paneStreamTransport: ReturnType<typeof paneStreamBridgeForWebWorkspaceClient>;
  setTarget(target: DesktopApplicationShellTarget): Promise<void>;
  refresh(): void;
  getMetrics(): ReturnType<WebWorkspaceClient["getMetrics"]>;
  dispose(): Promise<void>;
}

type Card5WorkspaceEvidenceGlobals = typeof globalThis & {
  __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__?: () => {
    readonly snapshot: WorkspaceClientSnapshot<ApplicationShellProjectionInputV1>;
    readonly authorityRecords: readonly {
      readonly ordinal: number;
      readonly generation: string;
      readonly session: string;
      readonly revision: number;
      readonly nativeGeometryYieldUntilMs: number;
      readonly inputOwner: string | null;
      readonly focusOwner: string | null;
      readonly geometryOwner: string | null;
      readonly clients: readonly {
        readonly clientId: string;
        readonly surface: string;
        readonly state: string;
        readonly connectedRevision: number;
        readonly activityRevision: number;
      }[];
    }[];
    readonly authorityRecordCount: number;
  };
  __TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?: () => {
    readonly activeLifecycleRequests?: readonly {
      readonly generation?: string;
      readonly requestId?: string;
      readonly workspaceName?: string;
      readonly semanticPaneIds?: readonly string[];
    }[];
    readonly descriptorEvents?: readonly {
      readonly generation?: string;
      readonly requestId?: string;
    }[];
  };
  __TMUX_IDE_CARD5_AUTHORITY_CONTROL__?: {
    release(input: {
      readonly version: 1;
      readonly workspaceName: string;
      readonly generation: string;
      readonly runtimeSession: string;
      readonly semanticPaneId: string;
      readonly requestId: string;
      readonly clientId: string;
      readonly authority: SessionRuntimeAuthorityKind;
    }): Promise<{
      readonly version: 1;
      readonly status: "released";
      readonly operationOrdinal: number;
      readonly workspaceName: string;
      readonly generation: string;
      readonly runtimeSession: string;
      readonly semanticPaneId: string;
      readonly requestId: string;
      readonly clientId: string;
      readonly authority: SessionRuntimeAuthorityKind;
      readonly beforeRevision: number;
      readonly afterRevision: number;
      readonly owner: null;
    } | null>;
  };
};

/** Thin Solid subscription over the one renderer-neutral production client. */
export function createSolidWebWorkspaceClient(input: {
  readonly host: HostCapabilities;
  readonly target: DesktopApplicationShellTarget;
}): SolidWebWorkspaceClient {
  const client = createWebWorkspaceClient(input);
  const [snapshot, setSnapshot] = createSignal(client.getSnapshot(), { equals: false });
  const publish = (): void => {
    setSnapshot(client.getSnapshot());
  };
  const evidenceHost = globalThis as Card5WorkspaceEvidenceGlobals;
  const evidenceEnabled = evidenceHost.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ === true;
  const authorityRecords: Array<{
    readonly ordinal: number;
    readonly generation: string;
    readonly session: string;
    readonly revision: number;
    readonly nativeGeometryYieldUntilMs: number;
    readonly inputOwner: string | null;
    readonly focusOwner: string | null;
    readonly geometryOwner: string | null;
    readonly clients: readonly {
      clientId: string;
      surface: string;
      state: string;
      connectedRevision: number;
      activityRevision: number;
    }[];
  }> = [];
  let authorityRecordCount = 0;
  let authorityControlOrdinal = 0;
  const recordAuthority = (authority: SessionRuntimeAuthoritySnapshot | null): void => {
    if (!evidenceEnabled || authority === null) return;
    authorityRecordCount += 1;
    authorityRecords.push(
      Object.freeze({
        ordinal: authorityRecordCount,
        generation: authority.generation,
        session: authority.session,
        revision: authority.revision,
        nativeGeometryYieldUntilMs: authority.nativeGeometryYieldUntilMs,
        inputOwner: authority.owners.input,
        focusOwner: authority.owners.focus,
        geometryOwner: authority.owners.geometry,
        clients: Object.freeze(
          authority.clients.map(
            ({ clientId, surface, state, connectedRevision, activityRevision }) =>
              Object.freeze({
                clientId,
                surface,
                state,
                connectedRevision,
                activityRevision,
              }),
          ),
        ),
      }),
    );
    if (authorityRecords.length > 64) authorityRecords.shift();
  };
  const unsubscribe = [
    client.subscribe("lifecycle", publish),
    client.subscribe("semantic", publish),
    client.subscribe("catalog", publish),
    client.subscribe("authority", (authority) => {
      recordAuthority(authority);
      publish();
    }),
    client.subscribe("operations", publish),
  ];
  recordAuthority(client.getSnapshot().authority);
  const evidenceReader = () =>
    Object.freeze({
      snapshot: client.getSnapshot(),
      authorityRecords: Object.freeze([...authorityRecords]),
      authorityRecordCount,
    });
  if (evidenceEnabled) {
    if (evidenceHost.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__) {
      throw new Error("Card5 detailed evidence requires exactly one Web WorkspaceClient");
    }
    evidenceHost.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ = evidenceReader;
    if (evidenceHost.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__) {
      throw new Error("Card5 detailed evidence requires exactly one authority control");
    }
    evidenceHost.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__ = {
      async release(input) {
        const before = client.getSnapshot();
        const authenticatedClientId = client.runtimeAuthorityClientId?.(input.authority) ?? null;
        const envelope = evidenceHost.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?.();
        const active = envelope?.activeLifecycleRequests;
        const descriptors = envelope?.descriptorEvents;
        const requestMatches = active?.filter(
          (request) =>
            request.generation === input.generation &&
            request.requestId === input.requestId &&
            request.workspaceName === input.workspaceName &&
            request.semanticPaneIds?.includes(input.semanticPaneId),
        );
        const descriptorMatches = descriptors?.filter(
          (descriptor) =>
            descriptor.generation === input.generation && descriptor.requestId === input.requestId,
        );
        if (
          Object.keys(input).sort().join("\0") !==
            [
              "version",
              "workspaceName",
              "generation",
              "runtimeSession",
              "semanticPaneId",
              "requestId",
              "clientId",
              "authority",
            ]
              .sort()
              .join("\0") ||
          input.version !== 1 ||
          before.phase !== "live" ||
          before.target?.workspaceName !== input.workspaceName ||
          before.target.daemon.instanceId !== input.generation ||
          before.authority?.generation !== input.generation ||
          before.authority.session !== input.runtimeSession ||
          authenticatedClientId === null ||
          before.authority.owners[input.authority] !== authenticatedClientId ||
          input.clientId !== authenticatedClientId ||
          requestMatches?.length !== 1 ||
          descriptorMatches?.length !== 1
        ) {
          return null;
        }
        const operationOrdinal = ++authorityControlOrdinal;
        const released = await client.releaseAuthority(input.authority);
        const after = client.getSnapshot();
        const afterEnvelope = evidenceHost.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?.();
        const afterRequests = afterEnvelope?.activeLifecycleRequests?.filter(
          (request) =>
            request.generation === input.generation &&
            request.requestId === input.requestId &&
            request.workspaceName === input.workspaceName &&
            request.semanticPaneIds?.includes(input.semanticPaneId),
        );
        const afterDescriptors = afterEnvelope?.descriptorEvents?.filter(
          (descriptor) =>
            descriptor.generation === input.generation && descriptor.requestId === input.requestId,
        );
        if (
          released === null ||
          after.generation !== before.generation ||
          after.phase !== "live" ||
          after.target?.workspaceName !== input.workspaceName ||
          after.target.daemon.instanceId !== input.generation ||
          after.authority?.generation !== input.generation ||
          after.authority.session !== input.runtimeSession ||
          client.runtimeAuthorityClientId?.(input.authority) !== null ||
          released.generation !== input.generation ||
          released.session !== input.runtimeSession ||
          released.owners[input.authority] !== null ||
          afterRequests?.length !== 1 ||
          afterDescriptors?.length !== 1 ||
          !Number.isSafeInteger(released.revision) ||
          released.revision <= before.authority.revision ||
          after.authority.revision < released.revision
        ) {
          return null;
        }
        return Object.freeze({
          version: 1,
          status: "released",
          operationOrdinal,
          workspaceName: input.workspaceName,
          generation: input.generation,
          runtimeSession: input.runtimeSession,
          semanticPaneId: input.semanticPaneId,
          requestId: input.requestId,
          clientId: authenticatedClientId,
          authority: input.authority,
          beforeRevision: before.authority.revision,
          afterRevision: released.revision,
          owner: null,
        });
      },
    };
  }
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const stop of unsubscribe) stop();
    if (evidenceHost.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ === evidenceReader) {
      delete evidenceHost.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__;
      delete evidenceHost.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__;
    }
    await client.dispose();
  };
  onCleanup(() => void dispose());
  return {
    client,
    snapshot,
    paneStreamTransport: paneStreamBridgeForWebWorkspaceClient(client),
    setTarget: (target) => client.setTarget(target),
    refresh: () => client.refresh(),
    getMetrics: () => client.getMetrics(),
    dispose,
  };
}
