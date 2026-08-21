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
  it("does not treat global input ownership as a grant on a replacement runtime", async () => {
    let localGrant = false;
    const requestAuthority = vi.fn(async () => {
      localGrant = true;
      return {
        generation: GENERATION,
        session: "workspace",
        clientId: "opentui:test",
        authority: "input" as const,
        token: "55555555-5555-4555-8555-555555555555",
        revision: 2,
      };
    });
    const sendTerminalInput = vi.fn(async () => "ok" as const);
    const client = {
      getSnapshot: () => ({
        target: { workspaceName: "workspace", daemon: { instanceId: GENERATION } },
        authority: {
          generation: GENERATION,
          owners: { input: "opentui:test", focus: null, geometry: null },
        },
      }),
      ownsRuntimeAuthority: () => localGrant,
      subscribeTerminal: vi.fn(() => vi.fn()),
      requestTerminalRepair: vi.fn(),
      requestAuthority,
      sendTerminalInput,
      fitViewport: vi.fn(async () => "ok" as const),
    } as unknown as OpenTuiProductionWorkspaceClient;
    const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
    fastLane.lane.retainPanes(["pane.a"]);

    await expect(
      fastLane.lane.sendInput("pane.a", { kind: "key", data: "Enter" }),
    ).resolves.toEqual({ status: "sent" });
    expect(requestAuthority).toHaveBeenCalledOnce();
    expect(sendTerminalInput).toHaveBeenCalledOnce();
    fastLane.dispose();
  });

  it("keeps lane construction live when initial queue diagnostics throw", () => {
    const terminalInputQueueState = vi.fn(() => {
      throw new Error("queue diagnostic failed");
    });
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
      let fastLane: ReturnType<typeof createOpenTuiWorkspaceTerminalFastLane> | null = null;
      expect(() => {
        fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      }).not.toThrow();
      expect(terminalInputQueueState).toHaveBeenCalledOnce();
      fastLane?.dispose();
      const memoryUsage = vi.spyOn(process, "memoryUsage").mockImplementation(() => {
        throw new Error("memory sampler failed");
      });
      try {
        expect(() => {
          fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
        }).not.toThrow();
        fastLane?.dispose();
      } finally {
        memoryUsage.mockRestore();
      }
    } finally {
      uninstall();
    }
  });

  it("keeps hot canonical trace stages memory-free and fail-open", () => {
    const stages: Array<Record<string, unknown>> = [];
    const terminalTraceStage = vi.fn((event: Record<string, unknown>) => {
      stages.push(event);
      if (event.operation === "canonical-apply-begin") throw new Error("trace sink failed");
    });
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      terminalTraceStage,
    });
    let listener:
      | ((
          update: CanonicalTerminalReplicaUpdate,
          metadata?: TerminalReplicaDeliveryMetadata,
        ) => void)
      | null = null;
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
      requestTerminalRepair: vi.fn(),
      requestAuthority: vi.fn(async () => null),
      sendTerminalInput: vi.fn(async () => "authority-lost" as const),
      fitViewport: vi.fn(async () => "authority-lost" as const),
    } as unknown as OpenTuiProductionWorkspaceClient;
    try {
      const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      fastLane.lane.retainPanes(["pane.a"]);
      const memoryUsage = vi.spyOn(process, "memoryUsage");
      const snapshot = blankTerminalReplicaSnapshot(2, 1);
      const update = {
        type: "terminal.seed",
        workspaceName: "workspace",
        semanticPaneId: "pane.a",
        generation: GENERATION,
        incarnation: `${GENERATION}:0`,
        revision: 0,
        cols: 2,
        rows: 1,
        stateHash: hashTerminalReplicaSnapshot(snapshot),
        hashAlgorithm: "fnv1a64-v1",
        snapshot,
      } satisfies CanonicalTerminalReplicaUpdate;
      expect(() =>
        listener?.(update, {
          performanceTraceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ).not.toThrow();
      expect(fastLane.lane.paneState("pane.a")?.revision).toBe(0);
      expect(memoryUsage).not.toHaveBeenCalled();
      expect(stages.map(({ operation }) => operation)).toEqual([
        "delivery-received",
        "delivery-observer-returned",
        "canonical-apply-begin",
        "canonical-apply-end",
        "lane-published",
      ]);
      for (const stage of stages) {
        expect(stage).not.toHaveProperty("rssBytes");
        expect(stage).not.toHaveProperty("heapUsedBytes");
      }
      fastLane.dispose();
      memoryUsage.mockRestore();
    } finally {
      uninstall();
    }
  });

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
