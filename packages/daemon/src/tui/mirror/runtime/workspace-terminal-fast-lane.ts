import type {
  ApplicationShellProjectionInputV1,
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
  TerminalReplicaTombstonePayload,
} from "@tmux-ide/contracts";
import {
  createTerminalFastLane,
  createWorkspaceClientTerminalSource,
  type TerminalFastLane,
} from "@tmux-ide/daemon-client/terminal-fast-lane";
import type { WorkspaceClient } from "@tmux-ide/daemon-client/workspace-client-types";

export interface OpenTuiWorkspaceTerminalFastLane {
  readonly lane: TerminalFastLane;
  dispose(): void;
}

/**
 * Bind one WorkspaceClient generation to one shared terminal fast lane. This
 * adapter contains no authority state or replica state of its own.
 */
export function createOpenTuiWorkspaceTerminalFastLane(
  client: WorkspaceClient<
    ApplicationShellProjectionInputV1,
    TerminalReplicaSnapshot,
    TerminalReplicaPatchPayload,
    TerminalReplicaTombstonePayload
  >,
  hostClientId: string,
): OpenTuiWorkspaceTerminalFastLane {
  const target = client.getSnapshot().target;
  if (target === null) throw new Error("terminal fast lane requires a live workspace target");
  const generation = target.daemon.instanceId;
  const lane = createTerminalFastLane({
    address: { workspaceName: target.workspaceName, generation },
    source: createWorkspaceClientTerminalSource(client),
    repair: {
      // Wire admission NACKs gaps before canonical updates are published. A
      // reducer-level gap therefore only needs to wait for that subscription's
      // replacement seed; no second repair protocol belongs in the renderer.
      request: () => undefined,
    },
    control: {
      owns(authority, expectedGeneration) {
        const snapshot = client.getSnapshot();
        return (
          snapshot.target?.daemon.instanceId === expectedGeneration &&
          snapshot.authority?.generation === expectedGeneration &&
          snapshot.authority.owners[authority] === hostClientId
        );
      },
      async request(authority, expectedGeneration) {
        const snapshot = client.getSnapshot();
        if (snapshot.target?.daemon.instanceId !== expectedGeneration) return false;
        const lease = await client.requestAuthority(authority);
        return lease?.generation === expectedGeneration && lease.clientId === hostClientId;
      },
      write(address, input) {
        return client.sendTerminalInput(
          {
            workspaceName: address.workspaceName,
            semanticPaneId: address.semanticPaneId,
          },
          input,
        );
      },
      resize(address, viewport) {
        if (client.getSnapshot().target?.daemon.instanceId !== address.generation) {
          return Promise.resolve("authority-lost");
        }
        return client.fitViewport(viewport.cols, viewport.rows);
      },
    },
  });
  return { lane, dispose: () => lane.dispose() };
}
