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
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import type { CausalCellClientLedger } from "./causal-cell-client-ledger.ts";

export interface OpenTuiWorkspaceTerminalFastLane {
  readonly lane: TerminalFastLane;
  readonly causalCellLedger: CausalCellClientLedger | null;
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
  causalCellLedger: CausalCellClientLedger | null = null,
): OpenTuiWorkspaceTerminalFastLane {
  const target = client.getSnapshot().target;
  if (target === null) throw new Error("terminal fast lane requires a live workspace target");
  const generation = target.daemon.instanceId;
  const performanceSink = currentTuiPerformanceEventSink();
  const lane = createTerminalFastLane({
    address: { workspaceName: target.workspaceName, generation },
    source: createWorkspaceClientTerminalSource(client),
    repair: {
      request: ({ address, reason }) => {
        // The wire ACK is transport-admission only. A canonical reducer
        // rejection retires this exact generation so its supervisor reconnects
        // and obtains fresh seeds. TerminalFastLane coalesces requests until a
        // seed arrives, preventing corrupt bursts from reconnect-storming.
        client.requestTerminalRepair(
          { workspaceName: address.workspaceName, semanticPaneId: address.semanticPaneId },
          address.generation,
          reason,
        );
      },
    },
    control: {
      owns(authority, expectedGeneration) {
        const snapshot = client.getSnapshot();
        return (
          snapshot.target?.daemon.instanceId === expectedGeneration &&
          snapshot.authority?.generation === expectedGeneration &&
          client.ownsRuntimeAuthority?.(authority) === true
        );
      },
      async request(authority, expectedGeneration) {
        const snapshot = client.getSnapshot();
        if (snapshot.target?.daemon.instanceId !== expectedGeneration) return false;
        const lease = await client.requestAuthority(authority);
        return lease?.generation === expectedGeneration && lease.clientId === hostClientId;
      },
      write(address, input, performanceTraceId, causalProbe) {
        return client.sendTerminalInput(
          {
            workspaceName: address.workspaceName,
            semanticPaneId: address.semanticPaneId,
          },
          input,
          performanceTraceId,
          causalProbe,
        );
      },
      resize(address, viewport) {
        if (client.getSnapshot().target?.daemon.instanceId !== address.generation) {
          return Promise.resolve("authority-lost");
        }
        return client.fitViewport(viewport.cols, viewport.rows);
      },
    },
    ...(performanceSink?.terminalTraceStage
      ? {
          onTraceStage(event) {
            try {
              performanceSink.terminalTraceStage?.({
                ...event,
                scenario: "terminal-input-to-paint",
                stage: "client",
                processId: `opentui:${process.pid}`,
                clockId: "opentui-performance-now",
                clockKind: "performance-now",
              });
            } catch {
              // Diagnostics cannot alter canonical delivery or input dispatch.
            }
          },
        }
      : {}),
  });
  if (performanceSink?.terminalInputQueueState) {
    try {
      const counters = lane.counters();
      const memory = process.memoryUsage();
      performanceSink.terminalInputQueueState({
        operation: "initialized",
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: Math.floor(performance.now() * 1_000),
        inputPending: counters.inputPending,
        inputInFlight: counters.inputInFlight,
        inputPendingBytes: counters.inputPendingBytes,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      });
    } catch {
      // Lifecycle diagnostics cannot prevent creation of the fresh lane.
    }
  }
  return { lane, causalCellLedger, dispose: () => lane.dispose() };
}
