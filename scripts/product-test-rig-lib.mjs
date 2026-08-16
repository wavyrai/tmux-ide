import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { theilSenSlope } from "./lib/performance-reference-report.mjs";

export const PRODUCT_RIG_STATE_VERSION = 1;
/**
 * Source provenance is evidence, not an unbounded in-memory archive. The rig
 * accepts deliberately large native/binary worktrees, but refuses a patch so
 * large that one diagnostic launch could exhaust the owner process.
 */
export const PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES = 8 * 1024 * 1024;

export function boundedSourceTraceDiff(diff, maxBytes = PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES) {
  const bytes = Buffer.byteLength(diff);
  if (bytes > maxBytes) {
    throw new Error(`Product rig source diff is ${bytes} bytes; hard ceiling is ${maxBytes} bytes`);
  }
  return diff;
}
const WARM_COHERENT_SAMPLE_COUNT = 20;
const MEMORY_BUDGET = JSON.parse(
  readFileSync(new URL("../performance/reference-budgets.json", import.meta.url), "utf8"),
).memory;

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function publicRigStatus(state) {
  if (!state) return { status: "stopped", running: false };
  const running = state.status !== "stopped" && processAlive(state.ownerPid);
  return {
    version: state.version,
    status: running ? state.status : "stopped",
    running,
    ownerPid: state.ownerPid,
    runtimeNamespace: state.runtimeNamespace,
    session: state.session,
    daemon: state.daemon
      ? {
          pid: state.daemon.pid,
          port: state.daemon.port,
          instanceId: state.daemon.instanceId,
        }
      : null,
    web: state.web ? { pageUrl: state.web.pageUrl } : null,
    tui: state.tui ?? null,
    convergence: state.convergence
      ? {
          status: state.convergence.status,
          generation: state.convergence.generation,
          clientCount: state.convergence.clientCount,
          timings: state.convergence.timings,
        }
      : null,
    artifactDir: state.artifactDir,
    timelinePath: state.timelinePath,
    failure: state.failure ?? null,
  };
}

export function coherentReadiness({ chromeMs, terminalMs }) {
  return {
    appChromeFrameMs: Number.isFinite(chromeMs) ? Math.round(chromeMs) : null,
    coherentTerminalFrameMs: Number.isFinite(terminalMs) ? Math.round(terminalMs) : null,
    ready:
      Number.isFinite(chromeMs) &&
      Number.isFinite(terminalMs) &&
      Number(terminalMs) >= Number(chromeMs),
  };
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

/**
 * Resolve the body rectangle actually published by root-v2.
 *
 * Tmux geometry is the source of truth for pane size, but it is not a safe
 * origin for an external framebuffer capture: another attached client may
 * change tmux's reported origin between the layout publication and this
 * observation. The semantic pane chrome is rendered in the same framebuffer
 * as the body, so it is the exact origin anchor whenever it is present.
 */
export function resolvePaneBodyRect(frame, pane) {
  const lines = String(frame).split("\n");
  const fallback = Object.freeze({
    left: pane.left,
    firstBodyRow: pane.top + 3,
    width: pane.width,
    bodyRows: Math.max(0, pane.height - 1),
    origin: "tmux-geometry",
    valid: true,
    semanticChromeMatches: 0,
  });
  if (typeof pane.semanticPaneId !== "string" || pane.semanticPaneId.length === 0) return fallback;

  const matches = [];
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    let index = line.indexOf(pane.semanticPaneId);
    while (index >= 0) {
      const prefix = line.slice(Math.max(0, index - 2), index);
      const suffix = line[index + pane.semanticPaneId.length];
      if ((prefix === "● " || prefix === "○ ") && (suffix === undefined || suffix === " "))
        matches.push({ row, left: index - 2 });
      index = line.indexOf(pane.semanticPaneId, index + 1);
    }
  }
  if (matches.length !== 1) {
    return Object.freeze({
      ...fallback,
      bodyRows: 0,
      origin:
        matches.length === 0 ? "semantic-pane-chrome-missing" : "semantic-pane-chrome-ambiguous",
      valid: false,
      semanticChromeMatches: matches.length,
    });
  }
  const [match] = matches;
  return Object.freeze({
    left: match.left,
    firstBodyRow: match.row + 1,
    width: pane.width,
    bodyRows: Math.max(0, pane.height - 1),
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  });
}

/** Exact body rectangle used by root-v2: app header + tabs + pane chrome. */
export function paneBodyRegion(frame, pane) {
  const lines = String(frame).split("\n");
  const rect = resolvePaneBodyRect(frame, pane);
  if (!rect.valid) return "";
  return lines
    .slice(rect.firstBodyRow, rect.firstBodyRow + rect.bodyRows)
    .map((line) => line.slice(rect.left, rect.left + rect.width))
    .join("\n");
}

/** Stable identity for one exact active-window geometry sample. */
export function paneGeometryIdentity(panes) {
  return JSON.stringify(
    [...panes]
      .map(({ paneId, semanticPaneId, left, top, width, height }) => ({
        paneId,
        semanticPaneId,
        left,
        top,
        width,
        height,
      }))
      .sort((left, right) => String(left.paneId).localeCompare(String(right.paneId))),
  );
}

/** Parse the one active tmux pane without confusing runtime and semantic IDs. */
export function activeTmuxPaneFromRows(rows) {
  const panes = String(rows)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, windowActive, paneActive, semanticPaneId, left, top, width, height] =
        line.split("|");
      return {
        paneId,
        windowActive: windowActive === "1",
        paneActive: paneActive === "1",
        semanticPaneId,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
      };
    });
  const pane = panes.find((candidate) => candidate.windowActive && candidate.paneActive);
  if (!pane?.paneId || !pane.semanticPaneId) return null;
  if (![pane.left, pane.top, pane.width, pane.height].every(Number.isFinite)) return null;
  return Object.freeze(pane);
}

export function coherentGenerationPaint(lifecycle) {
  const painted =
    lifecycle.findLast((entry) => entry?.phase === "host-terminal-publication") ??
    lifecycle.findLast((entry) => entry?.phase === "first-terminal-frame");
  const generation = painted?.daemonGeneration ?? painted?.generation;
  return typeof generation === "string" && Number.isFinite(painted?.elapsedMs)
    ? Object.freeze({ ...painted, daemonGeneration: generation })
    : null;
}

export function coherentGenerationDuration(lifecycle) {
  const painted = coherentGenerationPaint(lifecycle);
  if (!painted) return null;
  const connected = lifecycle.find(
    (entry) =>
      entry?.phase === "generation-connection-resolved" &&
      entry?.daemonGeneration === painted.daemonGeneration,
  );
  if (!connected || !Number.isFinite(connected.elapsedMs)) return null;
  return painted.elapsedMs - connected.elapsedMs;
}

export function inputPaintSamples(records) {
  const byTrace = new Map();
  for (const record of records) {
    if (record?.type !== "performance.stage" || typeof record.traceId !== "string") continue;
    const stages = byTrace.get(record.traceId) ?? { input: [], paint: [] };
    if (record.stage === "input" || record.stage === "paint") stages[record.stage].push(record);
    byTrace.set(record.traceId, stages);
  }
  return [...byTrace.entries()].flatMap(([traceId, stages]) => {
    // Duplicate/reordered endpoints are ambiguous and never qualify. A gate
    // must not silently take the last record and bias the distribution.
    if (stages.input.length !== 1 || stages.paint.length !== 1) return [];
    const [input] = stages.input;
    const [paint] = stages.paint;
    if (
      !input ||
      !paint ||
      input.processId !== paint.processId ||
      input.clockId !== paint.clockId ||
      !Number.isFinite(input.startedAtMicros) ||
      !Number.isFinite(paint.endedAtMicros)
    )
      return [];
    return [
      Object.freeze({
        traceId,
        durationMs: (paint.endedAtMicros - input.startedAtMicros) / 1_000,
        // Input stages record the authority tuple while changed-cell paint
        // stages carry the generation directly. Accept both shapes so the
        // report does not discard real same-process samples as unowned.
        generation: paint.authority?.generation ?? paint.generation ?? null,
        processId: paint.processId,
        clockId: paint.clockId,
        semanticPaneId: paint.semanticPaneId ?? null,
        revision: Number.isInteger(paint.revision) ? paint.revision : null,
        stateHash: typeof paint.stateHash === "string" ? paint.stateHash : null,
        paintStateIdentity: paint.paintStateIdentity ?? null,
      }),
    ];
  });
}

export function causalInputSamples(traceRecords, daemonTraceRecords = []) {
  const inputs = inputPaintSamples(traceRecords);
  return inputs.map((sample) => {
    const input = traceRecords.find(
      (record) =>
        record?.type === "performance.stage" &&
        record.traceId === sample.traceId &&
        record.stage === "input",
    );
    const clientStages = traceRecords
      .filter(
        (record) =>
          record?.type === "performance.stage" &&
          record.traceId === sample.traceId &&
          record.stage === "client" &&
          record.processId === sample.processId &&
          record.clockId === sample.clockId &&
          Number.isFinite(record.atMicros),
      )
      .map((record) => ({
        operation: record.operation,
        offsetMs: Number.isFinite(input?.startedAtMicros)
          ? (record.atMicros - input.startedAtMicros) / 1_000
          : null,
      }));
    const matchingDaemonRecords = daemonTraceRecords.filter(
      (record) =>
        record?.type === "performance.stage" &&
        record.traceId === sample.traceId &&
        Number.isFinite(record.startedAtMicros) &&
        Number.isFinite(record.endedAtMicros),
    );
    const daemonOrigin = matchingDaemonRecords.find(
      (record) => record.operation === "raw-input-command",
    );
    const daemonSpans = matchingDaemonRecords
      .filter(
        (record) =>
          !daemonOrigin ||
          (record.processId === daemonOrigin.processId && record.clockId === daemonOrigin.clockId),
      )
      .map((record) => ({
        stage: record.stage,
        operation: record.operation,
        // These offsets are daemon-local. They intentionally never subtract
        // an OpenTUI timestamp from a daemon timestamp.
        offsetMs: daemonOrigin
          ? (record.startedAtMicros - daemonOrigin.startedAtMicros) / 1_000
          : null,
        durationMs: (record.endedAtMicros - record.startedAtMicros) / 1_000,
        processId: record.processId,
        clockId: record.clockId,
      }));
    return Object.freeze({ ...sample, clientStages, daemonSpans });
  });
}

export function summarizeProductResources(clientStages, deliveries, endpointTraceIds = null) {
  const workloadMemorySamples = clientStages.flatMap((record, ordinal) =>
    Number.isFinite(record.rssBytes) && Number.isFinite(record.heapUsedBytes)
      ? [
          {
            traceKey: record.traceId ?? `untraced:${ordinal}`,
            rssBytes: record.rssBytes,
            heapUsedBytes: record.heapUsedBytes,
          },
        ]
      : [],
  );
  // A trace emits several causal stage records with the same process-memory
  // observation. Retained growth is evaluated from the final observation of
  // each bounded post-workload probe, not from the native allocator's
  // transient first-render/flood high-water. The full workload peak remains in
  // the report so a transient regression is still visible rather than hidden.
  const byTrace = new Map();
  for (const sample of workloadMemorySamples) byTrace.set(sample.traceKey, sample);
  const endpointSet = endpointTraceIds ? new Set(endpointTraceIds) : null;
  const memorySamples = [...byTrace.values()]
    .filter((sample) => endpointSet === null || endpointSet.has(sample.traceKey))
    .slice(endpointSet === null ? -16 : 0)
    .map(({ rssBytes, heapUsedBytes }) => ({ rssBytes, heapUsedBytes }));
  const rss = memorySamples.map(({ rssBytes }) => rssBytes);
  const heap = memorySamples.map(({ heapUsedBytes }) => heapUsedBytes);
  const settledInput = clientStages.findLast(
    (record) => Number.isFinite(record.inputPending) && Number.isFinite(record.inputInFlight),
  );
  return Object.freeze({
    inputPendingPeak: Math.max(0, ...clientStages.map((record) => record.inputPending ?? 0)),
    inputPendingBytesPeak: Math.max(
      0,
      ...clientStages.map((record) => record.inputPendingBytes ?? 0),
    ),
    inputInFlightPeak: Math.max(0, ...clientStages.map((record) => record.inputInFlight ?? 0)),
    settledInputPending: settledInput?.inputPending ?? null,
    settledInputInFlight: settledInput?.inputInFlight ?? null,
    deliveryQueuePeak: Math.max(0, ...deliveries.map((record) => record.queuePeak ?? 0)),
    deliveryQueueCapacity: Math.max(0, ...deliveries.map((record) => record.queueCapacity ?? 0)),
    settledDeliveryQueueDepth: Math.max(
      0,
      ...deliveries.map((record) => record.settledQueueDepth ?? 0),
    ),
    revisionLagPeak: Math.max(0, ...deliveries.map((record) => record.revisionLagPeak ?? 0)),
    memorySampleCount: memorySamples.length,
    workloadMemorySampleCount: workloadMemorySamples.length,
    rssWorkloadPeakBytes: Math.max(0, ...workloadMemorySamples.map(({ rssBytes }) => rssBytes)),
    heapWorkloadPeakBytes: Math.max(
      0,
      ...workloadMemorySamples.map(({ heapUsedBytes }) => heapUsedBytes),
    ),
    rssPeakBytes: Math.max(0, ...rss),
    heapPeakBytes: Math.max(0, ...heap),
    // Growth is an ordered quiescent endpoint delta. max-min misclassifies a
    // normal GC cycle (large early heap, smaller later heap) as retained growth.
    // Transient high-water remains visible through the explicit peak fields.
    rssGrowthBytes: rss.length > 0 ? Math.max(0, rss.at(-1) - rss[0]) : null,
    heapGrowthBytes: heap.length > 0 ? Math.max(0, heap.at(-1) - heap[0]) : null,
    rssRobustSlopeBytesPerSample: rss.length >= 4 ? theilSenSlope(rss) : null,
    heapRobustSlopeBytesPerSample: heap.length >= 4 ? theilSenSlope(heap) : null,
    deliverySamples: deliveries.length,
    memorySamples: Object.freeze(memorySamples),
  });
}

function causalInputSummary(samples) {
  const summarizeOffsets = (side, operations) =>
    Object.freeze(
      Object.fromEntries(
        operations.map((operation) => {
          const values = samples.flatMap((sample) => {
            const record = sample[side].find((entry) => entry.operation === operation);
            return Number.isFinite(record?.offsetMs) ? [record.offsetMs] : [];
          });
          return [
            operation,
            Object.freeze({ samples: values.length, p95Ms: percentile(values, 0.95) }),
          ];
        }),
      ),
    );
  const transition = (from, to) => {
    const values = samples.flatMap((sample) => {
      const start = sample.daemonSpans.find((entry) => entry.operation === from);
      const end = sample.daemonSpans.find((entry) => entry.operation === to);
      return Number.isFinite(start?.offsetMs) && Number.isFinite(end?.offsetMs)
        ? [end.offsetMs - start.offsetMs]
        : [];
    });
    return Object.freeze({ samples: values.length, p95Ms: percentile(values, 0.95) });
  };
  return Object.freeze({
    // The daemon currently carries a bounded, latest-only next-output probe.
    // It is useful for ordering diagnostics but cannot establish causality:
    // unrelated output may consume it and coalesced input may supersede it.
    correlation: "latest-input-to-next-output-probe",
    causalAttribution: false,
    clientOperationOffsets: summarizeOffsets("clientStages", [
      "lane-enqueue",
      "transport-send-start",
      "transport-ack",
      "socket-frame-arrival",
      "delivery-received",
      "lane-published",
      "render-invalidated",
    ]),
    daemonOperationOffsets: summarizeOffsets("daemonSpans", [
      "raw-input-command",
      "control-write",
      "control-command-accepted",
      "daemon-event-loop-turn",
      "tmux-output-server-age",
      "control-stdout-parse",
      "control-output-to-replica",
      "first-output-observed",
      "terminal-replica-write",
      "terminal-replica-project-commit",
      "terminal-delivery-encode-enqueue",
      "pane-stream-socket-send",
    ]),
    daemonTransitions: Object.freeze({
      controlWriteToFirstOutput: transition("control-write", "first-output-observed"),
      firstOutputToSocketSend: transition("first-output-observed", "pane-stream-socket-send"),
    }),
  });
}

export function buildProductDiagnosticReport({
  state,
  truth,
  lifecycle,
  traceRecords,
  daemonTraceRecords = [],
  stderr,
  warmCoherentSamples = [],
  warmCoherentJourneys = [],
  runtimeResourceRetirements = [],
  windowSwitchSamples = [],
  resizeGuideSamples = [],
  framebufferEvidence = null,
  idleObservation = null,
  resourceObservation = null,
  qualifyingInputEvidence = [],
}) {
  const generation = state?.daemon?.instanceId ?? null;
  const connectionIndex = lifecycle.findLastIndex(
    (entry) =>
      entry?.phase === "generation-connection-resolved" && entry?.daemonGeneration === generation,
  );
  const currentLifecycle = connectionIndex >= 0 ? lifecycle.slice(connectionIndex) : [];
  const shellLive = currentLifecycle.find(
    (entry) =>
      entry?.phase === "generation-shell-lifecycle" &&
      entry?.clientPhase === "live" &&
      entry?.shellStatus === "live",
  );
  const coherent = currentLifecycle.find(
    (entry) => entry?.phase === "generation-runtime-progress" && entry?.runtimePhase === "coherent",
  );
  const generationLive = currentLifecycle.find(
    (entry) =>
      entry?.phase === "generation-status" &&
      entry?.status === "live" &&
      entry?.daemonGeneration === generation,
  );
  const painted = currentLifecycle.find(
    (entry) => entry?.phase === "first-terminal-frame" && entry?.daemonGeneration === generation,
  );
  const activeTraceProcess = traceRecords.findLast(
    (record) => record?.type === "performance.trace.header",
  )?.processId;
  const qualifyingTraceEvidence = new Map(
    qualifyingInputEvidence.map((entry) => [entry.traceId, entry]),
  );
  const qualifies = (sample) =>
    sample.generation === generation &&
    sample.processId === activeTraceProcess &&
    sample.paintStateIdentity === "latest-canonical-state-blitted" &&
    (() => {
      const evidence = qualifyingTraceEvidence.get(sample.traceId);
      return (
        evidence?.paintStateIdentity === "latest-canonical-state-blitted" &&
        evidence.markerVisibleInNative === true &&
        evidence?.markerVisibleInPaneRect === true &&
        evidence.semanticPaneId === sample.semanticPaneId &&
        evidence.revision === sample.revision &&
        evidence.stateHash === sample.stateHash
      );
    })();
  const inputSamples = inputPaintSamples(traceRecords).filter(qualifies);
  const causalSamples = causalInputSamples(traceRecords, daemonTraceRecords).filter(qualifies);
  const inputCausalSummary = causalInputSummary(causalSamples);
  const outputTransition = inputCausalSummary.daemonTransitions.controlWriteToFirstOutput;
  const firstBrokenInputBoundary = null;
  const inputDurations = inputSamples.map(({ durationMs }) => durationMs);
  const inputP95 = percentile(inputDurations, 0.95);
  const inputP99 = percentile(inputDurations, 0.99);
  const warmCoherentP95 = percentile(warmCoherentSamples, 0.95);
  const warmLaunchSamples = warmCoherentJourneys
    .map(({ launchToHostMs }) => launchToHostMs)
    .filter(Number.isFinite);
  const warmLaunchP95 = percentile(warmLaunchSamples, 0.95);
  const windowSwitchP95 = percentile(windowSwitchSamples, 0.95);
  const resizeGuideP95 = percentile(resizeGuideSamples, 0.95);
  const traceIntegrity = traceRecords.findLast(
    (record) => record?.type === "performance.trace.summary",
  );
  const traceIntegrityPassed = traceIntegrity
    ? traceIntegrity.acceptedRecords > 0 &&
      traceIntegrity.droppedRecords === 0 &&
      traceIntegrity.oversizedRecords === 0 &&
      traceIntegrity.failed === false &&
      traceIntegrity.saturated === false &&
      traceIntegrity.pendingInputs === 0 &&
      traceIntegrity.droppedInputs === 0
    : null;
  const classify = (id, passed, detail) => ({
    id,
    status: passed === null ? "unmeasured" : passed ? "passed" : "failed",
    detail,
  });
  const boundaries = [
    classify(
      "tmux-truth",
      Boolean(truth?.session) && (truth?.panes?.length ?? 0) > 0,
      `${truth?.panes?.length ?? 0} panes / ${truth?.windows?.length ?? 0} windows`,
    ),
    classify(
      "daemon-generation",
      state?.status === "ready" && typeof generation === "string",
      generation ?? "no live daemon generation",
    ),
    classify(
      "workspace-client-commit",
      Boolean(shellLive),
      shellLive ? `${shellLive.inventoryResources ?? 0} committed resources` : "no live commit",
    ),
    classify(
      "terminal-fast-lane",
      Boolean(coherent && generationLive),
      coherent
        ? `${coherent.seededPanes ?? 0}/${coherent.panes ?? 0} pane seeds coherent`
        : "no coherent generation runtime",
    ),
    classify(
      "tui-painted-frame",
      Boolean(painted && coherent && painted.elapsedMs >= coherent.elapsedMs),
      painted
        ? `coherent ${coherent?.elapsedMs ?? "?"}ms → paint ${painted.elapsedMs}ms`
        : "no generation-fenced changed-cell paint",
    ),
    classify(
      "tui-framebuffer-content",
      framebufferEvidence ? framebufferEvidence.passed === true : null,
      framebufferEvidence?.detail ?? "no per-active-window-pane rectangle proof",
    ),
    classify(
      "web-tui-authority-restart",
      state?.convergence?.restart
        ? state.convergence.restart.webRecovered === true &&
            state.convergence.restart.tuiRecovered === true &&
            state.convergence.restart.hostedTuiInputPainted === true
        : false,
      state?.convergence?.restart
        ? `${state.convergence.restart.elapsedMs}ms full restart journey`
        : "restart journey absent",
    ),
    classify(
      "reference-trace-integrity",
      traceIntegrityPassed,
      traceIntegrity
        ? `${traceIntegrity.acceptedRecords} accepted; ${traceIntegrity.droppedRecords} dropped; ${traceIntegrity.oversizedRecords} oversized; failed ${traceIntegrity.failed}; pending inputs ${traceIntegrity.pendingInputs}; dropped inputs ${traceIntegrity.droppedInputs}`
        : "no closed reference trace summary",
    ),
    classify(
      "input-enqueue-to-correlated-changed-cell-paint",
      inputSamples.length < 30 ? null : inputP95 <= 16.67 && inputP99 <= 33,
      `${inputSamples.length}/30 renderer-correlated samples; p95 ${inputP95 ?? "?"}ms; p99 ${inputP99 ?? "?"}ms; causal attribution false${outputTransition.samples > 0 ? `; non-causal next-output probe p95 ${outputTransition.p95Ms}ms` : ""}`,
    ),
    classify(
      "resize-guide-preview",
      resizeGuideSamples.length < 20 ? null : resizeGuideP95 <= 16.67,
      `${resizeGuideSamples.length}/20 samples; p95 ${resizeGuideP95 ?? "?"}ms`,
    ),
    classify(
      "warm-window-switch",
      windowSwitchSamples.length < 30 ? null : windowSwitchP95 <= 150,
      `${windowSwitchSamples.length}/30 samples; p95 ${windowSwitchP95 ?? "?"}ms`,
    ),
    classify(
      "warm-coherent-terminal-frame",
      warmCoherentSamples.length < WARM_COHERENT_SAMPLE_COUNT ? null : warmCoherentP95 <= 750,
      `${warmCoherentSamples.length}/${WARM_COHERENT_SAMPLE_COUNT} connection→host-publication samples; p95 ${warmCoherentP95 ?? "?"}ms`,
    ),
    classify(
      "warm-process-launch-to-host-publication",
      warmLaunchSamples.length < WARM_COHERENT_SAMPLE_COUNT ? null : warmLaunchP95 <= 750,
      `${warmLaunchSamples.length}/${WARM_COHERENT_SAMPLE_COUNT} fresh-process launch→host-publication samples; p95 ${warmLaunchP95 ?? "?"}ms`,
    ),
    classify(
      "runtime-resource-retirement",
      runtimeResourceRetirements.length < WARM_COHERENT_SAMPLE_COUNT
        ? null
        : runtimeResourceRetirements.every(({ passed }) => passed === true),
      `${runtimeResourceRetirements.filter(({ passed }) => passed === true).length}/${WARM_COHERENT_SAMPLE_COUNT} rehosts returned sockets/listeners/supervisors/subscriptions/runtime timers to zero; in-close snapshots permit only the one instrumented enclosing shutdown deadline`,
    ),
    classify(
      "idle-frame-work",
      idleObservation
        ? idleObservation.durationMs >= 10_000 &&
            idleObservation.frameCount === 0 &&
            idleObservation.terminalPaints === 0 &&
            idleObservation.zeroDirtyPaints === 0 &&
            idleObservation.framebufferStable === true
        : null,
      idleObservation
        ? `${idleObservation.durationMs}ms idle; ${idleObservation.frameCount} renderer frames; ${idleObservation.terminalPaints} terminal paints; framebuffer stable ${idleObservation.framebufferStable}`
        : "no renderer dirty-frame/idle-window sample",
    ),
    classify(
      "bounded-queues-memory",
      resourceObservation
        ? resourceObservation.deliverySamples > 0 &&
            resourceObservation.memorySampleCount >= MEMORY_BUDGET.minimumSamples &&
            resourceObservation.rssPeakBytes > 0 &&
            resourceObservation.heapPeakBytes > 0 &&
            resourceObservation.rssRobustSlopeBytesPerSample <=
              MEMORY_BUDGET.rssRobustSlopeBytesPerSample &&
            resourceObservation.heapRobustSlopeBytesPerSample <=
              MEMORY_BUDGET.heapRobustSlopeBytesPerSample &&
            resourceObservation.rssGrowthBytes <= MEMORY_BUDGET.rssGrowthCeilingBytes &&
            resourceObservation.heapGrowthBytes <= MEMORY_BUDGET.heapGrowthCeilingBytes &&
            resourceObservation.inputPendingPeak <= 256 &&
            resourceObservation.inputPendingBytesPeak <= 256 * 1_024 &&
            resourceObservation.inputInFlightPeak <= 8 &&
            resourceObservation.deliveryQueuePeak <= resourceObservation.deliveryQueueCapacity &&
            resourceObservation.settledInputPending === MEMORY_BUDGET.settledQueueDepth &&
            resourceObservation.settledInputInFlight === MEMORY_BUDGET.settledQueueDepth &&
            resourceObservation.settledDeliveryQueueDepth === MEMORY_BUDGET.settledQueueDepth
        : null,
      resourceObservation
        ? `${resourceObservation.memorySampleCount}/${MEMORY_BUDGET.minimumSamples} memory samples; input peak ${resourceObservation.inputPendingPeak}/${resourceObservation.inputPendingBytesPeak}B settled ${resourceObservation.settledInputPending}/${resourceObservation.settledInputInFlight}; delivery peak ${resourceObservation.deliveryQueuePeak}/${resourceObservation.deliveryQueueCapacity} settled ${resourceObservation.settledDeliveryQueueDepth}; RSS growth/slope ${resourceObservation.rssGrowthBytes}/${resourceObservation.rssRobustSlopeBytesPerSample}B; heap growth/slope ${resourceObservation.heapGrowthBytes}/${resourceObservation.heapRobustSlopeBytesPerSample}B`
        : "no sustained-output queue/memory distribution",
    ),
  ];
  return Object.freeze({
    version: 1,
    status: boundaries.some(({ status }) => status === "failed")
      ? "failed"
      : boundaries.some(({ status }) => status === "unmeasured")
        ? "incomplete"
        : "passed",
    firstBrokenBoundary: boundaries.find(({ status }) => status === "failed")?.id ?? null,
    firstBrokenInputBoundary,
    firstUnmeasuredBoundary: boundaries.find(({ status }) => status === "unmeasured")?.id ?? null,
    generation,
    boundaries: Object.freeze(boundaries),
    clocks: Object.freeze([
      ...new Set(
        lifecycle.map(({ processId, clockId }) => `${processId ?? "?"}:${clockId ?? "?"}`),
      ),
    ]),
    inputSamples: Object.freeze(inputSamples),
    qualifyingInputEvidence: Object.freeze(
      qualifyingInputEvidence.map((entry) => Object.freeze({ ...entry })),
    ),
    inputCausalSamples: Object.freeze(causalSamples),
    inputCausalSummary,
    framebufferEvidence:
      framebufferEvidence === null ? null : Object.freeze({ ...framebufferEvidence }),
    warmCoherentSamples: Object.freeze([...warmCoherentSamples]),
    warmLaunchSamples: Object.freeze([...warmLaunchSamples]),
    warmCoherentJourneys: Object.freeze(
      warmCoherentJourneys.map((journey) =>
        Object.freeze({
          ...journey,
          daemonSpans: (() => {
            const matching = daemonTraceRecords.filter(
              (record) => journey.streamRequestId && record?.traceId === journey.streamRequestId,
            );
            const origin = Math.min(
              ...matching
                .map((record) => record.startedAtMicros)
                .filter((value) => Number.isFinite(value)),
            );
            return Object.freeze(
              matching.map((record) =>
                Object.freeze({
                  operation: record.operation,
                  offsetMs:
                    Number.isFinite(origin) && Number.isFinite(record.startedAtMicros)
                      ? (record.startedAtMicros - origin) / 1_000
                      : null,
                  durationMs:
                    Number.isFinite(record.startedAtMicros) && Number.isFinite(record.endedAtMicros)
                      ? (record.endedAtMicros - record.startedAtMicros) / 1_000
                      : null,
                  processId: record.processId,
                  clockId: record.clockId,
                }),
              ),
            );
          })(),
        }),
      ),
    ),
    runtimeResourceRetirements: Object.freeze(
      runtimeResourceRetirements.map((retirement) => Object.freeze({ ...retirement })),
    ),
    windowSwitchSamples: Object.freeze([...windowSwitchSamples]),
    resizeGuideSamples: Object.freeze([...resizeGuideSamples]),
    idleObservation: idleObservation ? Object.freeze({ ...idleObservation }) : null,
    resourceObservation: resourceObservation ? Object.freeze({ ...resourceObservation }) : null,
    stderr: Object.freeze({
      nonEmptyLines: String(stderr ?? "")
        .split("\n")
        .filter(Boolean).length,
      tail: String(stderr ?? "")
        .split("\n")
        .filter(Boolean)
        .slice(-20),
    }),
  });
}
