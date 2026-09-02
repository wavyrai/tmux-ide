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
import type { TuiTerminalCanonicalPaintIdentity } from "../performance-events.ts";
import type { CausalCellClientLedger } from "./causal-cell-client-ledger.ts";

export interface OpenTuiWorkspaceTerminalFastLane {
  readonly lane: TerminalFastLane;
  readonly causalCellLedger: CausalCellClientLedger | null;
  readonly resourceSampler: OpenTuiTerminalResourceSampler | null;
  dispose(): void;
}

export interface OpenTuiTerminalResourceSampler {
  afterFence(
    identity: TuiTerminalCanonicalPaintIdentity & { readonly rendererEpoch: number },
  ): void;
  dispose(): void;
}

const TERMINAL_RESOURCE_SAMPLE_LIMIT = 512;
// The ProductRig idle proof reads after 10.1s. Emit just before that boundary
// so the operation-scoped sample cannot race the proof read.
const TERMINAL_RESOURCE_IDLE_MS = 10_000;
const TERMINAL_RESOURCE_HEARTBEAT_MS = 16;
const TERMINAL_RESOURCE_LOW_WATER_SAMPLES = 8;
const TERMINAL_RESOURCE_LOW_WATER_INTERVAL_MS = 8;
const TERMINAL_RESOURCE_IDLE_RETAINED_SAMPLES = 8;
const TERMINAL_RESOURCE_IDLE_RETAINED_FIRST_MS = 2_000;
const TERMINAL_RESOURCE_IDLE_RETAINED_INTERVAL_MS = 1_000;

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
  const resourceSink = performanceSink?.terminalResourceSample;
  const resourceSampler = resourceSink
    ? createOpenTuiTerminalResourceSampler(lane, resourceSink)
    : null;
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
  return {
    lane,
    causalCellLedger,
    resourceSampler,
    dispose: () => {
      resourceSampler?.dispose();
      lane.dispose();
    },
  };
}

function createOpenTuiTerminalResourceSampler(
  lane: TerminalFastLane,
  sink: NonNullable<ReturnType<typeof currentTuiPerformanceEventSink>>["terminalResourceSample"],
): OpenTuiTerminalResourceSampler {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const idleSeriesTimers = new Set<ReturnType<typeof setTimeout>>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let resourceSamplingFailureCount = 0;
  const recordSamplingFailure = () => {
    resourceSamplingFailureCount = Math.min(
      resourceSamplingFailureCount + 1,
      TERMINAL_RESOURCE_SAMPLE_LIMIT,
    );
  };
  const readDiagnosticNow = (): number | null => {
    try {
      const now = performance.now();
      if (!Number.isFinite(now) || now < 0) throw new TypeError("invalid diagnostic clock");
      return now;
    } catch {
      recordSamplingFailure();
      return null;
    }
  };
  let heartbeatExpectedAt = (readDiagnosticNow() ?? 0) + TERMINAL_RESOURCE_HEARTBEAT_MS;
  // Generation-lifetime maximum. An arbitrary intermediate/sibling fence must
  // never consume the stall evidence needed by a later selected target.
  let maxHeartbeatLatenessMs = 0;
  let rssPeakBytes = 0;
  let heapUsedPeakBytes = 0;
  let inputPendingPeak = 0;
  let inputInFlightPeak = 0;
  let inputPendingBytesPeak = 0;
  let eventLoopDelayPeakSource: "heartbeat" | "endpoint" = "endpoint";
  let latestIdentity:
    | (TuiTerminalCanonicalPaintIdentity & { readonly rendererEpoch: number })
    | null = null;
  let heartbeatExpectedWallMs: number | null = null;
  let heartbeatCpu: NodeJS.CpuUsage | null = null;
  try {
    heartbeatExpectedWallMs = Date.now() + TERMINAL_RESOURCE_HEARTBEAT_MS;
    heartbeatCpu = process.cpuUsage();
  } catch {
    // Optional attribution must never alter lane construction.
  }
  let heartbeatResourceUsage: NodeJS.ResourceUsage | null = (() => {
    try {
      return process.resourceUsage();
    } catch {
      return null;
    }
  })();
  let heartbeatPeakEpisode: Readonly<{
    expectedAtMicros: number;
    actualAtMicros: number;
    wallLatenessMicros: number | null;
    cpuUserMicros: number | null;
    cpuSystemMicros: number | null;
    voluntaryContextSwitches: number | null;
    involuntaryContextSwitches: number | null;
    revision: number | null;
    stateHash: string | null;
  }> | null = null;
  let resourceEpochIdentity:
    | (TuiTerminalCanonicalPaintIdentity & { readonly rendererEpoch: number })
    | null = null;
  let ordinal = 0;
  let disposed = false;
  const heartbeat = () => {
    if (disposed) return;
    const now = readDiagnosticNow();
    if (now !== null) {
      const heartbeatLatenessMs = Math.max(now - heartbeatExpectedAt, 0);
      let wallNow: number | null = null;
      let cpuNow: NodeJS.CpuUsage | null = null;
      let resourceUsageNow: NodeJS.ResourceUsage | null = null;
      try {
        wallNow = Date.now();
        cpuNow = process.cpuUsage();
      } catch {
        // Attribution is optional evidence and never changes cap enforcement.
      }
      try {
        resourceUsageNow = process.resourceUsage();
      } catch {
        // Older/non-Node runtimes retain an explicit unavailable projection.
      }
      if (heartbeatLatenessMs > maxHeartbeatLatenessMs) {
        maxHeartbeatLatenessMs = heartbeatLatenessMs;
        eventLoopDelayPeakSource = "heartbeat";
        heartbeatPeakEpisode = Object.freeze({
          expectedAtMicros: Math.max(0, Math.floor(heartbeatExpectedAt * 1_000)),
          actualAtMicros: Math.max(0, Math.floor(now * 1_000)),
          wallLatenessMicros:
            wallNow === null || heartbeatExpectedWallMs === null
              ? null
              : Math.max(0, Math.floor((wallNow - heartbeatExpectedWallMs) * 1_000)),
          cpuUserMicros:
            cpuNow && heartbeatCpu ? Math.max(0, cpuNow.user - heartbeatCpu.user) : null,
          cpuSystemMicros:
            cpuNow && heartbeatCpu ? Math.max(0, cpuNow.system - heartbeatCpu.system) : null,
          voluntaryContextSwitches:
            resourceUsageNow && heartbeatResourceUsage
              ? Math.max(
                  0,
                  resourceUsageNow.voluntaryContextSwitches -
                    heartbeatResourceUsage.voluntaryContextSwitches,
                )
              : null,
          involuntaryContextSwitches:
            resourceUsageNow && heartbeatResourceUsage
              ? Math.max(
                  0,
                  resourceUsageNow.involuntaryContextSwitches -
                    heartbeatResourceUsage.involuntaryContextSwitches,
                )
              : null,
          revision: latestIdentity?.revision ?? null,
          stateHash: latestIdentity?.stateHash ?? null,
        });
      }
      if (cpuNow) heartbeatCpu = cpuNow;
      heartbeatResourceUsage = resourceUsageNow;
      // Reschedule from actual time: missed ticks are summarized, never replayed.
      heartbeatExpectedAt = now + TERMINAL_RESOURCE_HEARTBEAT_MS;
      heartbeatExpectedWallMs = wallNow === null ? null : wallNow + TERMINAL_RESOURCE_HEARTBEAT_MS;
    }
    heartbeatTimer = setTimeout(heartbeat, TERMINAL_RESOURCE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };
  heartbeatTimer = setTimeout(heartbeat, TERMINAL_RESOURCE_HEARTBEAT_MS);
  heartbeatTimer.unref?.();
  const emit = (
    operation: "post-fence" | "idle",
    identity: TuiTerminalCanonicalPaintIdentity & { readonly rendererEpoch: number },
    expectedAt: number,
    sampled?: Readonly<{
      counters: ReturnType<TerminalFastLane["counters"]>;
      memory: NodeJS.MemoryUsage;
      sampleCount: number;
      windowMicros: number;
      idleRetainedSamples?: readonly {
        ordinal: number;
        atMicros: number;
        rssBytes: number;
        heapUsedBytes: number;
        inputPending: number;
        inputInFlight: number;
        inputPendingBytes: number;
      }[];
    }>,
  ) => {
    if (disposed || resourceEpochIdentity === null || ordinal >= TERMINAL_RESOURCE_SAMPLE_LIMIT)
      return;
    ordinal += 1;
    const now = readDiagnosticNow();
    if (now === null) return;
    let counters: ReturnType<TerminalFastLane["counters"]>;
    let memory: NodeJS.MemoryUsage;
    try {
      counters = sampled?.counters ?? lane.counters();
      memory = sampled?.memory ?? process.memoryUsage();
    } catch {
      recordSamplingFailure();
      return;
    }
    const endpointLatenessMs = Math.max(now - expectedAt, 0);
    try {
      if (endpointLatenessMs > maxHeartbeatLatenessMs) {
        maxHeartbeatLatenessMs = endpointLatenessMs;
        eventLoopDelayPeakSource = "endpoint";
        if (now === null) resourceSamplingFailureCount = 1;
      }
      rssPeakBytes = Math.max(rssPeakBytes, memory.rss);
      heapUsedPeakBytes = Math.max(heapUsedPeakBytes, memory.heapUsed);
      inputPendingPeak = Math.max(inputPendingPeak, counters.inputPending);
      inputInFlightPeak = Math.max(inputInFlightPeak, counters.inputInFlight);
      inputPendingBytesPeak = Math.max(inputPendingBytesPeak, counters.inputPendingBytes);
      sink?.({
        operation,
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: Math.floor(now * 1_000),
        ordinal,
        resourceEpochArmed: true,
        resourceEpochIdentity,
        lowWaterFirstSampleOrdinal: 1,
        lowWaterLastSampleOrdinal: sampled?.sampleCount ?? 1,
        lowWaterSampleCount: sampled?.sampleCount ?? 1,
        lowWaterWindowMicros: sampled?.windowMicros ?? 0,
        semanticPaneId: identity.semanticPaneId,
        generation: identity.generation,
        incarnation: identity.incarnation,
        revision: identity.revision,
        stateHash: identity.stateHash,
        sourceEpoch: identity.sourceEpoch,
        rendererEpoch: identity.rendererEpoch,
        viewportCols: identity.viewportCols,
        viewportRows: identity.viewportRows,
        inputPending: counters.inputPending,
        inputInFlight: counters.inputInFlight,
        inputPendingBytes: counters.inputPendingBytes,
        inputPendingPeak,
        inputInFlightPeak,
        inputPendingBytesPeak,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        eventLoopDelayMicros: Math.floor(endpointLatenessMs * 1_000),
        rssPeakBytes,
        heapUsedPeakBytes,
        eventLoopDelayPeakMicros: Math.floor(maxHeartbeatLatenessMs * 1_000),
        eventLoopDelayPeakSource,
        heartbeatPeakExpectedAtMicros: heartbeatPeakEpisode?.expectedAtMicros ?? null,
        heartbeatPeakActualAtMicros: heartbeatPeakEpisode?.actualAtMicros ?? null,
        heartbeatPeakWallLatenessMicros: heartbeatPeakEpisode?.wallLatenessMicros ?? null,
        heartbeatPeakCpuUserMicros: heartbeatPeakEpisode?.cpuUserMicros ?? null,
        heartbeatPeakCpuSystemMicros: heartbeatPeakEpisode?.cpuSystemMicros ?? null,
        heartbeatPeakVoluntaryContextSwitches:
          heartbeatPeakEpisode?.voluntaryContextSwitches ?? null,
        heartbeatPeakInvoluntaryContextSwitches:
          heartbeatPeakEpisode?.involuntaryContextSwitches ?? null,
        heartbeatPeakContextSwitchesAvailable:
          heartbeatPeakEpisode !== null &&
          Number.isSafeInteger(heartbeatPeakEpisode.voluntaryContextSwitches) &&
          Number.isSafeInteger(heartbeatPeakEpisode.involuntaryContextSwitches),
        heartbeatPeakPhase: heartbeatPeakEpisode ? "terminal-runtime" : null,
        heartbeatPeakRevision: heartbeatPeakEpisode?.revision ?? null,
        heartbeatPeakStateHash: heartbeatPeakEpisode?.stateHash ?? null,
        resourceSamplingFailureCount,
        ...(sampled?.idleRetainedSamples
          ? { idleRetainedSamples: sampled.idleRetainedSamples }
          : {}),
      });
    } catch {
      // Sink/writer failures are fenced by writer health, not misclassified as
      // resource construction failures. Diagnostics never own the lane.
    }
  };
  const schedulePostFenceLowWater = (
    identity: TuiTerminalCanonicalPaintIdentity & { readonly rendererEpoch: number },
    expectedAt: number,
  ) => {
    let remaining = TERMINAL_RESOURCE_LOW_WATER_SAMPLES;
    let lowWaterExpectedAt = expectedAt;
    let firstSampleAt: number | null = null;
    let lastSampleAt: number | null = null;
    let completedSamples = 0;
    let lowWater:
      | Readonly<{
          counters: ReturnType<TerminalFastLane["counters"]>;
          memory: NodeJS.MemoryUsage;
        }>
      | undefined;
    const sample = () => {
      if (disposed) return;
      try {
        const sampledAt = readDiagnosticNow();
        if (sampledAt !== null) {
          firstSampleAt ??= sampledAt;
          lastSampleAt = sampledAt;
        }
        const counters = lane.counters();
        const memory = process.memoryUsage();
        rssPeakBytes = Math.max(rssPeakBytes, memory.rss);
        heapUsedPeakBytes = Math.max(heapUsedPeakBytes, memory.heapUsed);
        inputPendingPeak = Math.max(inputPendingPeak, counters.inputPending);
        inputInFlightPeak = Math.max(inputInFlightPeak, counters.inputInFlight);
        inputPendingBytesPeak = Math.max(inputPendingBytesPeak, counters.inputPendingBytes);
        if (
          !lowWater ||
          memory.heapUsed < lowWater.memory.heapUsed ||
          (memory.heapUsed === lowWater.memory.heapUsed && memory.rss < lowWater.memory.rss)
        )
          lowWater = Object.freeze({ counters, memory });
      } catch {
        recordSamplingFailure();
      }
      completedSamples += 1;
      remaining -= 1;
      if (remaining === 0) {
        emit(
          "post-fence",
          identity,
          lowWaterExpectedAt,
          lowWater
            ? Object.freeze({
                ...lowWater,
                sampleCount: completedSamples,
                windowMicros:
                  firstSampleAt === null || lastSampleAt === null
                    ? 0
                    : Math.max(0, Math.floor((lastSampleAt - firstSampleAt) * 1_000)),
              })
            : undefined,
        );
        return;
      }
      lowWaterExpectedAt =
        (readDiagnosticNow() ?? lowWaterExpectedAt) + TERMINAL_RESOURCE_LOW_WATER_INTERVAL_MS;
      const timer = setTimeout(() => {
        pending.delete(timer);
        sample();
      }, TERMINAL_RESOURCE_LOW_WATER_INTERVAL_MS);
      pending.add(timer);
      timer.unref?.();
    };
    sample();
  };
  return {
    afterFence(identity) {
      if (disposed || ordinal >= TERMINAL_RESOURCE_SAMPLE_LIMIT) return;
      latestIdentity = identity;
      let now: number | null;
      if (resourceEpochIdentity === null) {
        resourceEpochIdentity = Object.freeze({ ...identity });
        resourceSamplingFailureCount = 0;
        maxHeartbeatLatenessMs = 0;
        rssPeakBytes = 0;
        heapUsedPeakBytes = 0;
        inputPendingPeak = 0;
        inputInFlightPeak = 0;
        inputPendingBytesPeak = 0;
        eventLoopDelayPeakSource = "endpoint";
        heartbeatPeakEpisode = null;
        if (heartbeatTimer) clearTimeout(heartbeatTimer);
        // The epoch boundary precedes every diagnostic read. A clock failure
        // at arm time therefore belongs to this epoch and remains sticky.
        now = readDiagnosticNow();
        heartbeatExpectedAt = (now ?? 0) + TERMINAL_RESOURCE_HEARTBEAT_MS;
        heartbeatExpectedWallMs = null;
        heartbeatCpu = null;
        try {
          heartbeatExpectedWallMs = Date.now() + TERMINAL_RESOURCE_HEARTBEAT_MS;
          heartbeatCpu = process.cpuUsage();
          heartbeatResourceUsage = process.resourceUsage();
        } catch {
          heartbeatResourceUsage = null;
        }
        heartbeatTimer = setTimeout(heartbeat, TERMINAL_RESOURCE_HEARTBEAT_MS);
        heartbeatTimer.unref?.();
      } else now = readDiagnosticNow();
      const expectedAt = now ?? heartbeatExpectedAt;
      const timer = setTimeout(() => {
        pending.delete(timer);
        schedulePostFenceLowWater(identity, expectedAt);
      }, 0);
      pending.add(timer);
      timer.unref?.();
      if (idleTimer) clearTimeout(idleTimer);
      for (const timer of idleSeriesTimers) clearTimeout(timer);
      idleSeriesTimers.clear();
      const idleExpectedAt =
        (readDiagnosticNow() ?? heartbeatExpectedAt) + TERMINAL_RESOURCE_IDLE_MS;
      const idleRetainedSamples: Array<{
        ordinal: number;
        atMicros: number;
        rssBytes: number;
        heapUsedBytes: number;
        inputPending: number;
        inputInFlight: number;
        inputPendingBytes: number;
      }> = [];
      for (let index = 0; index < TERMINAL_RESOURCE_IDLE_RETAINED_SAMPLES; index += 1) {
        const timer = setTimeout(
          () => {
            idleSeriesTimers.delete(timer);
            if (disposed || resourceEpochIdentity === null) return;
            try {
              const now = readDiagnosticNow();
              if (now === null) return;
              const counters = lane.counters();
              const memory = process.memoryUsage();
              rssPeakBytes = Math.max(rssPeakBytes, memory.rss);
              heapUsedPeakBytes = Math.max(heapUsedPeakBytes, memory.heapUsed);
              inputPendingPeak = Math.max(inputPendingPeak, counters.inputPending);
              inputInFlightPeak = Math.max(inputInFlightPeak, counters.inputInFlight);
              inputPendingBytesPeak = Math.max(inputPendingBytesPeak, counters.inputPendingBytes);
              idleRetainedSamples.push({
                ordinal: index + 1,
                atMicros: Math.floor(now * 1_000),
                rssBytes: memory.rss,
                heapUsedBytes: memory.heapUsed,
                inputPending: counters.inputPending,
                inputInFlight: counters.inputInFlight,
                inputPendingBytes: counters.inputPendingBytes,
              });
            } catch {
              recordSamplingFailure();
            }
          },
          TERMINAL_RESOURCE_IDLE_RETAINED_FIRST_MS +
            index * TERMINAL_RESOURCE_IDLE_RETAINED_INTERVAL_MS,
        );
        idleSeriesTimers.add(timer);
        timer.unref?.();
      }
      idleTimer = setTimeout(() => {
        idleTimer = null;
        let counters: ReturnType<TerminalFastLane["counters"]>;
        let memory: NodeJS.MemoryUsage;
        try {
          counters = lane.counters();
          memory = process.memoryUsage();
        } catch {
          recordSamplingFailure();
          return;
        }
        emit("idle", identity, idleExpectedAt, {
          counters,
          memory,
          sampleCount: 1,
          windowMicros: 0,
          idleRetainedSamples: Object.freeze(
            idleRetainedSamples.map((sample) => Object.freeze(sample)),
          ),
        });
      }, TERMINAL_RESOURCE_IDLE_MS);
      idleTimer.unref?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      for (const timer of idleSeriesTimers) clearTimeout(timer);
      idleSeriesTimers.clear();
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    },
  };
}
