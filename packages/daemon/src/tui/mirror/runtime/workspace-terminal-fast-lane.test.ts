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
    expect(fastLane.resourceSampler).toBeNull();
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

  it("samples detailed resources once after an exact fence and once after idle", async () => {
    vi.useFakeTimers();
    const samples: Array<Record<string, unknown>> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      terminalResourceSample: (event) => samples.push(event),
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
    const memory = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 100,
      heapTotal: 90,
      heapUsed: 80,
      external: 10,
      arrayBuffers: 5,
    });
    const cpu = vi
      .spyOn(process, "cpuUsage")
      .mockImplementationOnce(() => {
        throw new Error("attribution unavailable");
      })
      .mockReturnValue({ user: 1, system: 1 });
    const wall = vi
      .spyOn(Date, "now")
      .mockImplementationOnce(() => {
        throw new Error("wall attribution unavailable");
      })
      .mockReturnValue(0);
    let clock: ReturnType<typeof vi.spyOn> | null = null;
    try {
      const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      expect(memory).not.toHaveBeenCalled();
      clock = vi
        .spyOn(performance, "now")
        .mockImplementationOnce(() => {
          throw new Error("arm clock unavailable");
        })
        .mockReturnValue(0);
      fastLane.resourceSampler?.afterFence({
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        semanticPaneId: "pane.a",
        generation: GENERATION,
        incarnation: `${GENERATION}:0`,
        revision: 7,
        stateHash: "1111111111111111",
        cols: 132,
        rows: 41,
        sourceEpoch: 1,
        viewportCols: 132,
        viewportRows: 40,
        acceptedUpdateType: "terminal.patch",
        acceptedRevision: 7,
        rendererEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(samples).toHaveLength(1);
      expect(samples.map(({ operation, ordinal }) => [operation, ordinal])).toEqual([
        ["post-fence", 1],
      ]);
      await vi.advanceTimersByTimeAsync(4_100);
      expect(samples.map(({ operation, ordinal }) => [operation, ordinal])).toEqual([
        ["post-fence", 1],
        ["idle", 2],
      ]);
      expect(samples[1]?.idleRetainedSamples).toHaveLength(8);
      expect(
        (samples[1]?.idleRetainedSamples as Array<{ ordinal: number }>).map(
          ({ ordinal }) => ordinal,
        ),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(
        samples.every(
          ({ inputPending, inputInFlight }) => inputPending === 0 && inputInFlight === 0,
        ),
      ).toBe(true);
      expect(
        samples.every(({ resourceSamplingFailureCount }) => resourceSamplingFailureCount === 1),
      ).toBe(true);
      fastLane.dispose();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(samples).toHaveLength(2);
      const rebound = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      rebound.resourceSampler?.afterFence({
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        semanticPaneId: "pane.a",
        generation: "22222222-2222-4222-8222-222222222222",
        incarnation: "22222222-2222-4222-8222-222222222222:0",
        revision: 1,
        stateHash: "2222222222222222",
        cols: 132,
        rows: 41,
        sourceEpoch: 1,
        viewportCols: 132,
        viewportRows: 40,
        acceptedUpdateType: "terminal.seed",
        acceptedRevision: 1,
        rendererEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(samples[2]).toMatchObject({
        ordinal: 1,
        resourceEpochArmed: true,
        resourceEpochIdentity: {
          generation: "22222222-2222-4222-8222-222222222222",
          revision: 1,
        },
      });
      rebound.dispose();
    } finally {
      clock?.mockRestore();
      memory.mockRestore();
      cpu.mockRestore();
      wall.mockRestore();
      uninstall();
      vi.useRealTimers();
    }
  });

  it("keeps failed operation-scoped resource samples fail-open and bounded", async () => {
    vi.useFakeTimers();
    const samples: Array<Record<string, unknown>> = [];
    const terminalResourceSample = vi
      .fn((event: Record<string, unknown>) => samples.push(event))
      .mockImplementationOnce(() => {
        throw new Error("writer unavailable");
      });
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      terminalResourceSample,
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
    const memory = vi
      .spyOn(process, "memoryUsage")
      .mockImplementationOnce(() => {
        throw new Error("sampling unavailable");
      })
      .mockReturnValue({ rss: 100, heapTotal: 90, heapUsed: 80, external: 10, arrayBuffers: 5 });
    try {
      const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      fastLane.resourceSampler?.afterFence({
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        semanticPaneId: "pane.a",
        generation: GENERATION,
        incarnation: `${GENERATION}:0`,
        revision: 7,
        stateHash: "1111111111111111",
        cols: 132,
        rows: 41,
        sourceEpoch: 1,
        viewportCols: 132,
        viewportRows: 40,
        acceptedUpdateType: "terminal.patch",
        acceptedRevision: 7,
        rendererEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(60);
      const counters = vi.spyOn(fastLane.lane, "counters").mockImplementationOnce(() => {
        throw new Error("counter unavailable");
      });
      fastLane.resourceSampler?.afterFence({
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        semanticPaneId: "pane.counter",
        generation: GENERATION,
        incarnation: `${GENERATION}:0`,
        revision: 8,
        stateHash: "2222222222222222",
        cols: 132,
        rows: 41,
        sourceEpoch: 1,
        viewportCols: 132,
        viewportRows: 40,
        acceptedUpdateType: "terminal.patch",
        acceptedRevision: 8,
        rendererEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(60);
      counters.mockRestore();
      fastLane.resourceSampler?.afterFence({
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        semanticPaneId: "pane.clock",
        generation: GENERATION,
        incarnation: `${GENERATION}:0`,
        revision: 9,
        stateHash: "3333333333333333",
        cols: 132,
        rows: 41,
        sourceEpoch: 1,
        viewportCols: 132,
        viewportRows: 40,
        acceptedUpdateType: "terminal.patch",
        acceptedRevision: 9,
        rendererEpoch: 1,
      });
      const now = vi.spyOn(performance, "now").mockImplementationOnce(() => {
        throw new Error("clock unavailable");
      });
      await vi.advanceTimersByTimeAsync(60);
      now.mockRestore();
      fastLane.resourceSampler?.afterFence({
        processId: "opentui:1",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        semanticPaneId: "pane.b",
        generation: GENERATION,
        incarnation: `${GENERATION}:0`,
        revision: 8,
        stateHash: "2222222222222222",
        cols: 132,
        rows: 41,
        sourceEpoch: 1,
        viewportCols: 132,
        viewportRows: 40,
        acceptedUpdateType: "terminal.patch",
        acceptedRevision: 8,
        rendererEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(memory.mock.calls.length).toBeGreaterThanOrEqual(24);
      expect(memory.mock.calls.length).toBeLessThanOrEqual(40);
      expect(terminalResourceSample.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(samples.filter((sample) => sample.operation === "idle")).toEqual([
        expect.objectContaining({
          operation: "idle",
          semanticPaneId: "pane.b",
          resourceSamplingFailureCount: 3,
        }),
      ]);
      expect(samples.at(-1)).toEqual(
        expect.objectContaining({
          operation: "idle",
          resourceSamplingFailureCount: 3,
        }),
      );
      expect(vi.getTimerCount()).toBe(1);
      expect(fastLane.lane.counters().inputPending).toBe(0);
      fastLane.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      memory.mockRestore();
      uninstall();
      vi.useRealTimers();
    }
  });

  it("resets pre-arm lateness once and retains post-arm peaks across sibling endpoints", async () => {
    vi.useFakeTimers();
    const samples: Array<Record<string, unknown>> = [];
    const uninstall = installTuiPerformanceEventSink({
      frame: vi.fn(),
      terminalPaint: vi.fn(),
      terminalDelivery: vi.fn(),
      terminalResourceSample: (event) => samples.push(event),
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
    const memory = vi.spyOn(process, "memoryUsage").mockReturnValue({
      rss: 100,
      heapTotal: 90,
      heapUsed: 80,
      external: 10,
      arrayBuffers: 5,
    });
    let now: ReturnType<typeof vi.spyOn> | null = null;
    try {
      const fastLane = createOpenTuiWorkspaceTerminalFastLane(client, "opentui:test");
      now = vi.spyOn(performance, "now").mockReturnValue(6_000);
      await vi.advanceTimersByTimeAsync(16);
      const settledCounters = fastLane.lane.counters();
      const counters = vi
        .spyOn(fastLane.lane, "counters")
        .mockReturnValueOnce(settledCounters)
        .mockReturnValueOnce({
          ...settledCounters,
          inputPending: 1,
          inputInFlight: 1,
          inputPendingBytes: 8,
        })
        .mockReturnValue(settledCounters);
      memory
        .mockReturnValueOnce({
          rss: 100,
          heapTotal: 90,
          heapUsed: 80,
          external: 10,
          arrayBuffers: 5,
        })
        .mockReturnValueOnce({
          rss: 1_073_741_825,
          heapTotal: 536_870_914,
          heapUsed: 536_870_913,
          external: 10,
          arrayBuffers: 5,
        })
        .mockReturnValue({
          rss: 100,
          heapTotal: 90,
          heapUsed: 80,
          external: 10,
          arrayBuffers: 5,
        });
      const fence = (revision: number, semanticPaneId: string) =>
        fastLane.resourceSampler?.afterFence({
          processId: "opentui:1",
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          semanticPaneId,
          generation: GENERATION,
          incarnation: `${GENERATION}:0`,
          revision,
          stateHash: revision.toString(16).padStart(16, "0"),
          cols: 132,
          rows: 41,
          sourceEpoch: 1,
          viewportCols: 132,
          viewportRows: 40,
          acceptedUpdateType: "terminal.patch",
          acceptedRevision: revision,
          rendererEpoch: 1,
        });
      fence(1, "pane.baseline");
      await vi.advanceTimersByTimeAsync(60);
      expect(samples[0]).toMatchObject({
        resourceEpochArmed: true,
        eventLoopDelayMicros: 0,
        eventLoopDelayPeakMicros: 0,
        eventLoopDelayPeakSource: "endpoint",
      });
      expect(samples[0]?.resourceEpochIdentity).toMatchObject({
        semanticPaneId: "pane.baseline",
        revision: 1,
      });
      now.mockReturnValue(6_076);
      await vi.advanceTimersByTimeAsync(16);
      for (let revision = 2; revision <= 24; revision += 1) {
        fence(revision, revision === 2 ? "pane.sibling" : "pane.target");
      }
      await vi.advanceTimersByTimeAsync(60);
      expect(samples).toHaveLength(24);
      expect(
        samples.every(
          ({ resourceEpochArmed, resourceEpochIdentity }) =>
            resourceEpochArmed === true &&
            (resourceEpochIdentity as { semanticPaneId?: string; revision?: number })
              ?.semanticPaneId === "pane.baseline" &&
            (resourceEpochIdentity as { semanticPaneId?: string; revision?: number })?.revision ===
              1,
        ),
      ).toBe(true);
      expect(samples.every(({ operation }) => operation === "post-fence")).toBe(true);
      expect(samples.map(({ ordinal }) => ordinal)).toEqual(
        Array.from({ length: 24 }, (_, index) => index + 1),
      );
      expect(samples[0]?.eventLoopDelayPeakMicros).toBe(0);
      expect(
        samples
          .slice(1)
          .every(
            ({ eventLoopDelayPeakMicros, eventLoopDelayPeakSource }) =>
              eventLoopDelayPeakMicros === 60_000 && eventLoopDelayPeakSource === "heartbeat",
          ),
      ).toBe(true);
      expect(samples[1]).toMatchObject({
        heartbeatPeakExpectedAtMicros: 6_016_000,
        heartbeatPeakActualAtMicros: 6_076_000,
        heartbeatPeakWallLatenessMicros: 0,
        heartbeatPeakPhase: "terminal-runtime",
        heartbeatPeakRevision: 1,
        heartbeatPeakStateHash: "0000000000000001",
      });
      expect(Number.isSafeInteger(samples[1]?.heartbeatPeakCpuUserMicros)).toBe(true);
      expect(Number.isSafeInteger(samples[1]?.heartbeatPeakCpuSystemMicros)).toBe(true);
      expect(
        samples
          .slice(1)
          .every(
            ({ heartbeatPeakExpectedAtMicros, heartbeatPeakActualAtMicros }) =>
              heartbeatPeakActualAtMicros - heartbeatPeakExpectedAtMicros === 60_000,
          ),
      ).toBe(true);
      expect(samples[2]).toMatchObject({
        semanticPaneId: "pane.target",
        rssBytes: 100,
        rssPeakBytes: 1_073_741_825,
        heapUsedBytes: 80,
        heapUsedPeakBytes: 536_870_913,
        inputPending: 0,
        inputPendingPeak: 1,
        inputInFlightPeak: 1,
        inputPendingBytesPeak: 8,
      });
      fastLane.dispose();
      counters.mockRestore();
    } finally {
      now?.mockRestore();
      memory.mockRestore();
      uninstall();
      vi.useRealTimers();
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
