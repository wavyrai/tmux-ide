import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalTerminalReplicaUpdate,
  TerminalReplicaDeliveryMetadata,
} from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalReplicaSnapshot } from "@tmux-ide/core";
import { installTuiPerformanceEventSink } from "../performance-events.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";
import { createOpenTuiWorkspaceTerminalFastLane } from "./workspace-terminal-fast-lane.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";

describe("OpenTUI workspace terminal fast lane", () => {
  it("publishes an explicit zero queue snapshot before the fresh lane can accept input", () => {
    const terminalInputQueueState = vi.fn();
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      terminalInputQueueState,
    });
    const client = {
      getSnapshot: () => ({
        target: { workspaceName: "workspace", daemon: { instanceId: GENERATION } },
        authority: null,
      }),
      subscribeTerminal: vi.fn(() => vi.fn()),
      requestTerminalRepair: vi.fn(),
      requestAuthority: vi.fn(async () => null),
      sendTerminalInput: vi.fn(async () => "authority-lost" as const),
      fitViewport: vi.fn(async () => "authority-lost" as const),
    } as unknown as OpenTuiProductionWorkspaceClient;
    try {
      const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      expect(terminalInputQueueState).toHaveBeenCalledOnce();
      expect(terminalInputQueueState).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "initialized",
          inputPending: 0,
          inputInFlight: 0,
          inputPendingBytes: 0,
        }),
      );
      fastLane.dispose();
    } finally {
      uninstall();
    }
  });

  it("coalesces repeated canonical repair and allows one new repair after a fresh seed", () => {
    let listener:
      | ((
          update: CanonicalTerminalReplicaUpdate,
          metadata?: TerminalReplicaDeliveryMetadata,
        ) => void)
      | null = null;
    const requestTerminalRepair = vi.fn();
    const client = {
      getSnapshot: () => ({
        target: { workspaceName: "workspace", daemon: { instanceId: GENERATION } },
        authority: null,
      }),
      subscribeTerminal: (_target, next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
      requestTerminalRepair,
      requestAuthority: vi.fn(async () => null),
      sendTerminalInput: vi.fn(async () => "authority-lost" as const),
      fitViewport: vi.fn(async () => "authority-lost" as const),
    } as unknown as OpenTuiProductionWorkspaceClient;
    const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
    fastLane.lane.retainPanes(["pane.a"]);
    const snapshot = blankTerminalReplicaSnapshot(2, 1);
    const seed = {
      type: "terminal.seed",
      workspaceName: "workspace",
      semanticPaneId: "pane.a",
      generation: GENERATION,
      incarnation: `${GENERATION}:1`,
      revision: 0,
      cols: 2,
      rows: 1,
      stateHash: hashTerminalReplicaSnapshot(snapshot),
      hashAlgorithm: "fnv1a64-v1",
      snapshot,
    } satisfies CanonicalTerminalReplicaUpdate;
    listener?.(seed);
    const corrupt = {
      type: "terminal.patch",
      workspaceName: "workspace",
      semanticPaneId: "pane.a",
      generation: GENERATION,
      incarnation: `${GENERATION}:1`,
      baseRevision: 0,
      revision: 1,
      cols: 2,
      rows: 1,
      stateHash: "ffffffffffffffff",
      hashAlgorithm: "fnv1a64-v1",
      patch: { rows: [] },
    } satisfies CanonicalTerminalReplicaUpdate;

    listener?.(corrupt);
    listener?.(corrupt);
    expect(requestTerminalRepair).toHaveBeenCalledTimes(1);
    expect(requestTerminalRepair).toHaveBeenCalledWith(
      { workspaceName: "workspace", semanticPaneId: "pane.a" },
      GENERATION,
      "conflict",
    );

    listener?.(seed);
    listener?.(corrupt);
    expect(requestTerminalRepair).toHaveBeenCalledTimes(2);
    fastLane.dispose();
  });
});
