import { createHash, createHmac } from "node:crypto";

import { causalInputSamples } from "../product-test-rig-lib.mjs";

const REQUIRED_CLIENT_STAGES = Object.freeze([
  "lane-enqueue",
  "transport-send-start",
  "pane-stream-frame-enqueued",
  "pane-stream-socket-send-return",
  "pane-stream-next-event-loop-turn",
  "pane-stream-buffer-before-send",
  "pane-stream-buffer-after-send",
  "pane-stream-buffer-next-turn",
  "pane-stream-buffer-drain-watermark",
  "pane-stream-observer-returned",
  "transport-ack",
  "socket-frame-arrival",
  "delivery-received",
  "delivery-observer-returned",
  "canonical-apply-begin",
  "canonical-apply-end",
  "lane-published",
  "render-invalidated",
  "causal-cell-delivered",
  "causal-cell-painted",
]);
const REQUIRED_DAEMON_STAGES = Object.freeze({
  "pane-stream-socket-message-callback-entry": "transport",
  "pane-stream-input-frame-ingress": "transport",
  "raw-input-command": "tmux",
  "control-write": "tmux",
  "control-command-accepted": "tmux",
  "daemon-event-loop-turn": "transport",
  "first-output-observed": "tmux",
  "terminal-replica-write": "parse",
  "terminal-replica-project-commit": "reduce",
  "terminal-delivery-encode-enqueue": "transport",
  "pane-stream-socket-send": "transport",
});

const MAX_INPUT_PREDICATES = 24;
const KNOWN_TRACE_STAGES = new Set([
  "client",
  "input",
  "paint",
  "tmux",
  "transport",
  "parse",
  "reduce",
]);
const KNOWN_CLOCK_CALIBRATION_REASONS = new Set([
  "calibrated",
  "timeout-no-sample",
  "timeout-retained-sample",
  "clock-unavailable",
  "send-failed",
  "ack-request-mismatch",
  "ack-generation-mismatch",
  "ack-probe-mismatch",
  "ack-client-send-mismatch",
  "ack-clock-unavailable",
  "invalid-samples",
  "connection-closed",
]);

function boundedTraceStage(value) {
  return typeof value === "string" && KNOWN_TRACE_STAGES.has(value) ? value : "invalid";
}

function clockBounds(clientStage, daemonMicros, direction = "client-to-daemon") {
  if (
    !Number.isSafeInteger(clientStage?.sharedMicros) ||
    !Number.isSafeInteger(daemonMicros) ||
    !Number.isSafeInteger(clientStage?.clockOffsetLowerMicros) ||
    !Number.isSafeInteger(clientStage?.clockOffsetUpperMicros)
  )
    return null;
  const rawLower =
    direction === "client-to-daemon"
      ? daemonMicros - clientStage.sharedMicros - clientStage.clockOffsetUpperMicros
      : clientStage.sharedMicros - daemonMicros + clientStage.clockOffsetLowerMicros;
  const upper =
    direction === "client-to-daemon"
      ? daemonMicros - clientStage.sharedMicros - clientStage.clockOffsetLowerMicros
      : clientStage.sharedMicros - daemonMicros + clientStage.clockOffsetUpperMicros;
  const lower = Math.max(0, rawLower);
  return Number.isSafeInteger(lower) && Number.isSafeInteger(upper) && upper >= lower
    ? Object.freeze({ lowerMicros: lower, upperMicros: upper })
    : null;
}

function freezeAssessment(qualified, predicates, terminal = false) {
  const bounded = Object.freeze(predicates.slice(0, MAX_INPUT_PREDICATES).map(Object.freeze));
  return Object.freeze({
    qualified,
    firstFailedPredicate: bounded.find(({ passed }) => !passed)?.id ?? null,
    predicates: bounded,
    predicatesTruncated: predicates.length > bounded.length,
    terminal,
  });
}

export function summarizeProductInputDistribution(evidence) {
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : [];
  const manifest = JSON.stringify(samples);
  return Object.freeze({
    variant: evidence?.variant ?? null,
    passed: evidence?.passed === true,
    sampleCount: evidence?.sampleCount ?? samples.length,
    startOrdinal: evidence?.startOrdinal ?? null,
    p95Ms: evidence?.p95Ms ?? null,
    p99Ms: evidence?.p99Ms ?? null,
    sampleManifestBytes: Buffer.byteLength(manifest),
    sampleManifestSha256: createHash("sha256").update(manifest).digest("hex"),
  });
}

export function productInputOutlierEvidence(evidence) {
  const samples = Array.isArray(evidence?.samples) ? evidence.samples : [];
  const observerRecords = Array.isArray(evidence?.daemonObserverRecords)
    ? evidence.daemonObserverRecords
    : [];
  const startOrdinal = Number.isSafeInteger(evidence?.startOrdinal) ? evidence.startOrdinal : 0;
  return Object.freeze(
    samples
      .map((sample, index) => ({ sample, ordinal: startOrdinal + index }))
      .sort((left, right) => right.sample.sample.durationMs - left.sample.sample.durationMs)
      .slice(0, 3)
      .map(({ sample: qualified, ordinal }) => {
        const sample = qualified.sample;
        const client = new Map(sample.clientStages.map((stage) => [stage.operation, stage]));
        const daemon = new Map(sample.daemonSpans.map((span) => [span.operation, span]));
        const clientAnchor = client.get("pane-stream-socket-send-return");
        const daemonAnchor = daemon.get("pane-stream-socket-message-callback-entry");
        const ackCallback = client.get("pane-stream-input-ack-callback");
        const daemonAck = daemon.get("pane-stream-input-ack-socket-send");
        const frameArrival = client.get("socket-frame-arrival");
        const daemonOutput = daemon.get("pane-stream-socket-send");
        const controlWrite = daemon.get("control-write");
        const controlAccepted = daemon.get("control-command-accepted");
        const firstOutput = daemon.get("first-output-observed");
        const replicaCommit = daemon.get("terminal-replica-project-commit");
        const projectedSendStart =
          Number.isSafeInteger(clientAnchor?.sharedMicros) &&
          Number.isSafeInteger(clientAnchor?.clockOffsetLowerMicros) &&
          Number.isSafeInteger(daemonAnchor?.sharedStartedAtMicros) &&
          Number.isSafeInteger(daemonAnchor?.startedAtMicros)
            ? daemonAnchor.startedAtMicros -
              (daemonAnchor.sharedStartedAtMicros -
                (clientAnchor.sharedMicros + clientAnchor.clockOffsetLowerMicros))
            : null;
        const daemonWindowStart = Number.isSafeInteger(projectedSendStart)
          ? projectedSendStart
          : controlWrite?.startedAtMicros;
        const daemonWindowEnd = daemonOutput?.endedAtMicros;
        const exactObserverRecords = observerRecords.filter(
          (record) =>
            record?.type === "performance.daemon-observer" &&
            record.generation === sample.generation &&
            record.processId === daemonAnchor?.processId &&
            record.clockId === daemonAnchor?.clockId &&
            record.clockKind === "performance-now" &&
            (record.operation === "healthcheck" ||
              record.operation === "drain" ||
              record.operation === "fleet-cycle") &&
            (record.phase === "begin" ||
              record.phase === "event-loop-sentinel" ||
              record.phase === "end") &&
            typeof record.traceId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              record.traceId,
            ) &&
            Number.isSafeInteger(record.atMicros),
        );
        const observerGroups = new Map();
        for (const record of exactObserverRecords) {
          const key = `${record.traceId}:${record.operation}`;
          const group = observerGroups.get(key) ?? [];
          group.push(record);
          observerGroups.set(key, group);
        }
        const observerOverlap =
          Number.isSafeInteger(daemonWindowStart) && Number.isSafeInteger(daemonWindowEnd)
            ? [...observerGroups.values()]
                .flatMap((group) => {
                  const begins = group.filter((record) => record.phase === "begin");
                  const ends = group.filter((record) => record.phase === "end");
                  const sentinels = group.filter(
                    (record) => record.phase === "event-loop-sentinel",
                  );
                  if (begins.length !== 1 || ends.length !== 1 || sentinels.length > 1) return [];
                  const begin = begins[0];
                  const end = ends[0];
                  if (
                    begin.atMicros > daemonWindowEnd ||
                    end.atMicros < begin.atMicros ||
                    end.atMicros < daemonWindowStart ||
                    !Number.isSafeInteger(begin.activeOperations) ||
                    begin.activeOperations !== 1 ||
                    end.activeOperations !== 1 ||
                    typeof end.succeeded !== "boolean"
                  )
                    return [];
                  const sentinel = sentinels[0];
                  if (
                    sentinel &&
                    (sentinel.atMicros < begin.atMicros || sentinel.atMicros > end.atMicros)
                  )
                    return [];
                  return [
                    Object.freeze({
                      operation:
                        begin.operation === "healthcheck" ||
                        begin.operation === "drain" ||
                        begin.operation === "fleet-cycle"
                          ? begin.operation
                          : "invalid",
                      overlapMicros: Math.max(
                        0,
                        Math.min(end.atMicros, daemonWindowEnd) -
                          Math.max(begin.atMicros, daemonWindowStart),
                      ),
                      possibleOutboundOverlapMicros: Math.max(
                        0,
                        Math.min(end.atMicros, daemonAnchor?.startedAtMicros ?? daemonWindowEnd) -
                          Math.max(begin.atMicros, daemonWindowStart),
                      ),
                      definiteDaemonOverlapMicros: Math.max(
                        0,
                        Math.min(end.atMicros, daemonWindowEnd) -
                          Math.max(
                            begin.atMicros,
                            daemonAnchor?.startedAtMicros ?? daemonWindowEnd,
                          ),
                      ),
                      classification:
                        end.atMicros > (daemonAnchor?.startedAtMicros ?? daemonWindowEnd)
                          ? "definite-daemon-overlap"
                          : "possible-outbound-overlap",
                      eventLoopSentinelMicros: sentinel?.atMicros ?? null,
                      activeOperations: begin.activeOperations,
                      succeeded: end.succeeded === true,
                    }),
                  ];
                })
                .slice(0, 4)
            : [];
        return Object.freeze({
          ordinal,
          traceId: sample.traceId,
          durationMs: sample.durationMs,
          phaseMs: Object.freeze({
            sendReturn:
              (client.get("pane-stream-socket-send-return")?.offsetMs ?? 0) -
              (client.get("pane-stream-frame-enqueued")?.offsetMs ?? 0),
            sendReturnToAck:
              (client.get("transport-ack")?.offsetMs ?? 0) -
              (client.get("pane-stream-socket-send-return")?.offsetMs ?? 0),
            canonicalApply:
              (client.get("canonical-apply-end")?.offsetMs ?? 0) -
              (client.get("canonical-apply-begin")?.offsetMs ?? 0),
            invalidationToPaint:
              (client.get("causal-cell-painted")?.offsetMs ?? 0) -
              (client.get("render-invalidated")?.offsetMs ?? 0),
          }),
          daemonPhaseMicros: Object.freeze({
            callbackToControlWrite:
              daemonAnchor && controlWrite
                ? controlWrite.startedAtMicros - daemonAnchor.startedAtMicros
                : null,
            controlReplyWait:
              controlWrite && controlAccepted
                ? controlAccepted.endedAtMicros - controlWrite.endedAtMicros
                : null,
            replyToFirstOutput:
              controlAccepted && firstOutput
                ? firstOutput.startedAtMicros - controlAccepted.endedAtMicros
                : null,
            firstOutputToCommit:
              firstOutput && replicaCommit
                ? replicaCommit.endedAtMicros - firstOutput.startedAtMicros
                : null,
            commitToSocketSend:
              replicaCommit && daemonOutput
                ? daemonOutput.endedAtMicros - replicaCommit.endedAtMicros
                : null,
          }),
          observerOverlap: Object.freeze(observerOverlap),
          observerWindow: Object.freeze({
            source: Number.isSafeInteger(projectedSendStart)
              ? "calibrated-send-through-output"
              : "control-write-through-output",
            startedAtMicros: Number.isSafeInteger(daemonWindowStart) ? daemonWindowStart : null,
            endedAtMicros: Number.isSafeInteger(daemonWindowEnd) ? daemonWindowEnd : null,
          }),
          socketBuffer: Object.freeze({
            before: client.get("pane-stream-buffer-before-send")?.bufferedAmount ?? null,
            after: client.get("pane-stream-buffer-after-send")?.bufferedAmount ?? null,
            nextTurn: client.get("pane-stream-buffer-next-turn")?.bufferedAmount ?? null,
            drained: client.get("pane-stream-buffer-drain-watermark")?.drained ?? null,
            frameBytes: client.get("pane-stream-buffer-after-send")?.frameBytes ?? null,
          }),
          clockAnchors: Object.freeze({
            client: clientAnchor
              ? Object.freeze({
                  processId: sample.processId,
                  clockId: sample.clockId,
                  atMicros: clientAnchor.atMicros,
                })
              : null,
            daemon: daemonAnchor
              ? Object.freeze({
                  processId: daemonAnchor.processId,
                  clockId: daemonAnchor.clockId,
                  atMicros: daemonAnchor.startedAtMicros,
                })
              : null,
          }),
          oneWayBounds: Object.freeze({
            outbound: clockBounds(clientAnchor, daemonAnchor?.sharedStartedAtMicros),
            acknowledgement: clockBounds(
              ackCallback,
              daemonAck?.sharedEndedAtMicros,
              "daemon-to-client",
            ),
            delivery: clockBounds(
              frameArrival,
              daemonOutput?.sharedEndedAtMicros,
              "daemon-to-client",
            ),
            uncertaintyMicros: clientAnchor?.clockUncertaintyMicros ?? null,
          }),
        });
      }),
  );
}

export function productFirstInputDocument(variant, ordinal = 0) {
  if (variant === "key") {
    const key = ordinal % 2 === 0 ? "x" : "y";
    return Object.freeze({ version: 1, kind: "key", key });
  }
  if (variant === "paste") {
    return Object.freeze({
      version: 1,
      kind: "paste",
      text: `PASTE${ordinal % 10}${ordinal % 2 === 0 ? "Q" : "R"}`,
    });
  }
  throw new Error(`unsupported first-input variant ${variant}`);
}

export function productFirstInputPayload(document) {
  return Buffer.from(document.kind === "key" ? document.key : document.text, "utf8");
}

export function productFirstInputFingerprint(key, traceId, payload) {
  return createHmac("sha256", key).update(traceId).update("\0").update(payload).digest("hex");
}

export function productInputPersistenceFenceState(records, baseline, processId) {
  const epoch = records.slice(baseline);
  const causalFailure = epoch.find(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "client" &&
      record.processId === processId &&
      typeof record.operation === "string" &&
      record.operation.startsWith("causal-cell-failed:"),
  );
  if (causalFailure)
    return Object.freeze({
      status: "failed",
      reason: causalFailure.operation.slice("causal-cell-failed:".length),
      traceId: causalFailure.traceId ?? null,
      diagnostic: causalFailure.causalDiagnostic ?? null,
    });
  const inputs = epoch.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "input" &&
      record.processId === processId,
  );
  if (inputs.length > 1) return Object.freeze({ status: "failed", reason: "multiple-inputs" });
  if (inputs.length === 0) return Object.freeze({ status: "pending", reason: "input" });
  const traceId = inputs[0].traceId;
  const paints = epoch.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "paint" &&
      record.processId === processId &&
      record.traceId === traceId,
  );
  if (paints.length > 1) return Object.freeze({ status: "failed", reason: "multiple-paints" });
  if (paints.length === 0) return Object.freeze({ status: "pending", reason: "paint" });
  const fences = epoch.filter(
    (record) =>
      record?.type === "performance.input-fence" &&
      record.processId === processId &&
      record.traceId === traceId,
  );
  if (fences.length > 1) return Object.freeze({ status: "failed", reason: "multiple-fences" });
  if (fences.length === 0) return Object.freeze({ status: "pending", reason: "fence" });
  const health = fences[0].writerHealth;
  if (health?.droppedRecords !== 0 || health?.oversizedRecords !== 0 || health?.failed !== false)
    return Object.freeze({ status: "failed", reason: "writer-health" });
  return Object.freeze({ status: "proved", reason: null, traceId });
}

export async function waitForProductInputPersistenceFence(options) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 2_000);
  while (now() < deadline) {
    const records = options.readRecords();
    const epoch = productInputPersistenceFenceState(records, options.baseline, options.processId);
    if (epoch.status === "proved") return records;
    if (epoch.status === "failed") {
      const error = new Error(`first-input causal epoch failed: ${epoch.reason ?? "unknown"}`);
      error.boundary = "first-input-causal-paint";
      error.observation = Object.freeze({
        reason: epoch.reason ?? "unknown",
        traceId: epoch.traceId ?? null,
        structuralDiff: epoch.diagnostic ?? null,
      });
      throw error;
    }
    await wait(options.pollMs ?? 10);
  }
  const error = new Error("first-input causal epoch did not reach changed-cell paint");
  error.boundary = "first-input-causal-paint";
  error.observation = Object.freeze({ reason: "input-persistence-timeout" });
  throw error;
}

export async function settleProductFirstInputFixtureReset(options) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const stableMs = options.stableMs ?? 100;
  const deadline = now() + (options.timeoutMs ?? 2_000);
  options.sendReset(options.token);
  let stableKey = null;
  let stableSince = 0;
  let last = null;
  while (now() < deadline) {
    const observed = await options.observe();
    last = observed;
    const ready =
      observed.fixtureOption === `ready-v1:${options.token}` &&
      observed.currentCommand === "node" &&
      observed.paneId === options.expected.paneId &&
      observed.semanticPaneId === options.expected.semanticPaneId &&
      observed.generation === options.expected.generation &&
      typeof observed.incarnation === "string" &&
      Number.isSafeInteger(observed.revision) &&
      typeof observed.stateHash === "string" &&
      observed.stateHash.length > 0 &&
      observed.geometryStable === true &&
      observed.nativeCellBlank === true &&
      observed.tuiCellBlank === true &&
      observed.queueSettled === true;
    const key = ready
      ? JSON.stringify({
          paneId: observed.paneId,
          semanticPaneId: observed.semanticPaneId,
          generation: observed.generation,
          incarnation: observed.incarnation,
          revision: observed.revision,
          stateHash: observed.stateHash,
          geometry: observed.geometry,
          nativeHash: observed.nativeHash,
          tuiHash: observed.tuiHash,
        })
      : null;
    const at = now();
    if (key !== null && key === stableKey) {
      if (at - stableSince >= stableMs) return Object.freeze(observed);
    } else {
      stableKey = key;
      stableSince = at;
    }
    await wait(options.pollMs ?? 10);
  }
  const error = new Error("first-input fixture reset did not reach one stable canonical baseline");
  error.boundary = "first-input-no-prior-hosted-input";
  error.observation = Object.freeze({ reason: "fixture-reset-timeout", last });
  throw error;
}

export async function waitForProductInputQualification(options) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 2_000);
  let latestAssessment = null;
  while (now() < deadline) {
    const tuiRecords = options.readTuiRecords();
    const daemonRecords = options.readDaemonRecords();
    latestAssessment = options.assess?.(tuiRecords, daemonRecords) ?? null;
    const qualified = latestAssessment
      ? latestAssessment.qualified
      : options.qualify(tuiRecords, daemonRecords);
    if (qualified) return qualified;
    if (latestAssessment?.terminal === true && latestAssessment.firstFailedPredicate) {
      const error = new Error(
        `input qualification rejected persisted evidence at ${latestAssessment.firstFailedPredicate}`,
      );
      error.boundary =
        latestAssessment.firstFailedPredicate === "clock-calibration"
          ? "input-clock-calibration"
          : (options.boundary ?? "first-input-causal-paint");
      error.observation = Object.freeze({
        reason: "deterministic-qualification-mismatch",
        firstFailedPredicate: latestAssessment.firstFailedPredicate,
        predicates: latestAssessment.predicates,
        predicatesTruncated: latestAssessment.predicatesTruncated,
        terminal: true,
        tuiRecordCount: tuiRecords.length,
        daemonRecordCount: daemonRecords.length,
      });
      throw error;
    }
    await wait(options.pollMs ?? 10);
  }
  const error = new Error("input qualification did not persist every TUI and daemon endpoint");
  error.boundary = options.boundary ?? "first-input-causal-paint";
  error.observation = Object.freeze({
    reason: "combined-trace-timeout",
    firstFailedPredicate: latestAssessment?.firstFailedPredicate ?? null,
    predicates: latestAssessment?.predicates ?? [],
    predicatesTruncated: latestAssessment?.predicatesTruncated ?? false,
    terminal: latestAssessment?.terminal ?? false,
    tuiRecordCount: options.readTuiRecords().length,
    daemonRecordCount: options.readDaemonRecords().length,
  });
  throw error;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function sameCanonicalOrigin(origin, expected) {
  return (
    origin.processId === expected.processId &&
    origin.clockId === expected.clockId &&
    origin.clockKind === "performance-now" &&
    origin.origin === (expected.variant === "key" ? "keyboard" : "bracketed-paste") &&
    origin.parserConsumption === (expected.variant === "key" ? "keyboard-event" : "paste-event") &&
    origin.semanticPaneId === expected.semanticPaneId &&
    origin.generation === expected.generation &&
    origin.incarnation === expected.incarnation &&
    (expected.revision === undefined
      ? Number.isSafeInteger(origin.revision) && origin.revision >= 0
      : origin.revision === expected.revision) &&
    (expected.stateHash === undefined
      ? typeof origin.stateHash === "string" && origin.stateHash.length > 0
      : origin.stateHash === expected.stateHash)
  );
}

function qualifyOne(records, origin, expected, payload, predicates = []) {
  const verify = (id, passed, detail = {}) => {
    predicates.push({ id, passed: passed === true, ...detail });
    return passed === true;
  };
  if (!verify("origin-identity", sameCanonicalOrigin(origin, expected))) return null;
  if (
    !verify(
      "payload-fingerprint",
      origin.payloadByteCount === payload.byteLength &&
        typeof expected.inputFingerprintKey === "string" &&
        expected.inputFingerprintKey.length >= 32 &&
        origin.payloadFingerprint ===
          productFirstInputFingerprint(expected.inputFingerprintKey, origin.traceId, payload),
      { actualByteCount: origin.payloadByteCount ?? null, expectedByteCount: payload.byteLength },
    )
  )
    return null;
  const sample = causalInputSamples(records, expected.daemonTraceRecords ?? []).find(
    ({ traceId }) => traceId === origin.traceId,
  );
  if (
    !verify(
      "sample-identity",
      Boolean(
        sample &&
        sample.processId === expected.processId &&
        sample.clockId === expected.clockId &&
        sample.semanticPaneId === expected.semanticPaneId &&
        sample.generation === expected.generation &&
        sample.incarnation === expected.incarnation &&
        sample.paintStateIdentity === "latest-canonical-state-blitted" &&
        Number.isFinite(sample.durationMs) &&
        sample.durationMs > 0 &&
        Number.isSafeInteger(sample.revision) &&
        typeof sample.stateHash === "string" &&
        sample.stateHash.length > 0 &&
        sample.revision > origin.revision &&
        sample.stateHash !== origin.stateHash,
      ),
    )
  )
    return null;
  const operations = sample.clientStages.map(({ operation }) => operation);
  const rawClientStages = records.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "client" &&
      record.traceId === origin.traceId,
  );
  let previous = -1;
  let clientOrderFailure = null;
  for (const operation of REQUIRED_CLIENT_STAGES) {
    const index = operations.indexOf(operation);
    if (index <= previous || operations.lastIndexOf(operation) !== index) {
      clientOrderFailure = { operation, previousIndex: previous, actualIndex: index };
      break;
    }
    previous = index;
  }
  if (!verify("client-persistence-order", clientOrderFailure === null, clientOrderFailure ?? {}))
    return null;
  let clientIdentityFailure = null;
  for (const operation of REQUIRED_CLIENT_STAGES) {
    const rawMatches = rawClientStages.filter((record) => record.operation === operation);
    if (
      rawMatches.length !== 1 ||
      rawMatches[0].stage !== "client" ||
      rawMatches[0].processId !== expected.processId ||
      rawMatches[0].clockId !== expected.clockId ||
      rawMatches[0].clockKind !== "performance-now"
    ) {
      clientIdentityFailure = { operation, matchCount: rawMatches.length };
      break;
    }
  }
  if (!verify("client-stage-identity", clientIdentityFailure === null, clientIdentityFailure ?? {}))
    return null;
  const transportStageIdentityFailure = [
    "pane-stream-frame-enqueued",
    "pane-stream-socket-send-return",
    "pane-stream-next-event-loop-turn",
    "pane-stream-observer-returned",
  ].find((operation) => {
    const stage = rawClientStages.find((record) => record.operation === operation);
    return !(
      stage?.semanticPaneId === expected.semanticPaneId && stage.generation === expected.generation
    );
  });
  if (
    !verify("transport-stage-identity", transportStageIdentityFailure === undefined, {
      operation: transportStageIdentityFailure ?? null,
    })
  )
    return null;
  const bufferBefore = rawClientStages.find(
    ({ operation }) => operation === "pane-stream-buffer-before-send",
  );
  const bufferAfter = rawClientStages.find(
    ({ operation }) => operation === "pane-stream-buffer-after-send",
  );
  const bufferNextTurn = rawClientStages.find(
    ({ operation }) => operation === "pane-stream-buffer-next-turn",
  );
  const bufferDrain = rawClientStages.find(
    ({ operation }) => operation === "pane-stream-buffer-drain-watermark",
  );
  if (
    !verify(
      "socket-buffer-drain",
      Number.isSafeInteger(bufferBefore?.bufferedAmount) &&
        bufferBefore.bufferedAmount >= 0 &&
        Number.isSafeInteger(bufferAfter?.bufferedAmount) &&
        bufferAfter.bufferedAmount >= 0 &&
        Number.isSafeInteger(bufferNextTurn?.bufferedAmount) &&
        bufferNextTurn.bufferedAmount >= 0 &&
        Number.isSafeInteger(bufferDrain?.bufferedAmount) &&
        bufferDrain.bufferedAmount >= 0 &&
        Number.isSafeInteger(bufferAfter?.frameBytes) &&
        bufferAfter.frameBytes > 0 &&
        bufferBefore.frameBytes === bufferAfter.frameBytes &&
        bufferAfter.frameBytes === bufferNextTurn.frameBytes &&
        bufferNextTurn.frameBytes === bufferDrain.frameBytes &&
        bufferDrain.drained === true &&
        bufferDrain.bufferedAmount <= bufferBefore.bufferedAmount,
      {
        before: bufferBefore?.bufferedAmount ?? null,
        after: bufferAfter?.bufferedAmount ?? null,
        nextTurn: bufferNextTurn?.bufferedAmount ?? null,
        drained: bufferDrain?.drained === true,
      },
    )
  )
    return null;
  const canonicalStageIdentityFailure = [
    "delivery-observer-returned",
    "canonical-apply-begin",
    "canonical-apply-end",
  ].find((operation) => {
    const stage = rawClientStages.find((record) => record.operation === operation);
    return !(
      stage?.semanticPaneId === expected.semanticPaneId &&
      stage.generation === expected.generation &&
      stage.incarnation === expected.incarnation &&
      stage.revision === sample.revision &&
      stage.stateHash === sample.stateHash
    );
  });
  if (
    !verify("canonical-stage-identity", canonicalStageIdentityFailure === undefined, {
      operation: canonicalStageIdentityFailure ?? null,
    })
  )
    return null;
  if (expected.requireDaemonEvidence) {
    let daemonProcess = null;
    let daemonClock = null;
    const daemonByOperation = new Map();
    let daemonIdentityFailure = null;
    for (const [operation, expectedStage] of Object.entries(REQUIRED_DAEMON_STAGES)) {
      const matches = sample.daemonSpans.filter((entry) => entry.operation === operation);
      const rawMatches = (expected.daemonTraceRecords ?? []).filter(
        (record) => record.traceId === origin.traceId && record.operation === operation,
      );
      if (
        !(
          matches.length === 1 &&
          rawMatches.length === 1 &&
          rawMatches[0].stage === expectedStage &&
          rawMatches[0].processId === matches[0].processId &&
          rawMatches[0].clockId === matches[0].clockId &&
          rawMatches[0].clockKind === "performance-now" &&
          Number.isFinite(matches[0].offsetMs) &&
          Number.isFinite(matches[0].durationMs) &&
          matches[0].durationMs >= 0 &&
          (daemonProcess === null || matches[0].processId === daemonProcess) &&
          (daemonClock === null || matches[0].clockId === daemonClock)
        )
      ) {
        daemonIdentityFailure = {
          operation,
          expectedStage,
          actualStage: rawMatches.length === 1 ? boundedTraceStage(rawMatches[0].stage) : null,
          matchCount: rawMatches.length,
        };
        break;
      }
      daemonProcess = matches[0].processId;
      daemonClock = matches[0].clockId;
      daemonByOperation.set(operation, rawMatches[0]);
    }
    if (
      !verify("daemon-stage-identity", daemonIdentityFailure === null, daemonIdentityFailure ?? {})
    )
      return null;
    const daemonBefore = (left, right) =>
      daemonByOperation.get(left).endedAtMicros <= daemonByOperation.get(right).startedAtMicros;
    const raw = daemonByOperation.get("raw-input-command");
    const write = daemonByOperation.get("control-write");
    const daemonOrderPassed =
      daemonBefore(
        "pane-stream-socket-message-callback-entry",
        "pane-stream-input-frame-ingress",
      ) &&
      daemonBefore("pane-stream-input-frame-ingress", "raw-input-command") &&
      raw.startedAtMicros <= write.startedAtMicros &&
      write.endedAtMicros <= raw.endedAtMicros &&
      daemonBefore("raw-input-command", "daemon-event-loop-turn") &&
      daemonBefore("control-write", "control-command-accepted") &&
      daemonBefore("daemon-event-loop-turn", "first-output-observed") &&
      daemonBefore("control-command-accepted", "first-output-observed") &&
      daemonBefore("first-output-observed", "terminal-replica-write") &&
      daemonBefore("terminal-replica-write", "terminal-replica-project-commit") &&
      daemonBefore("terminal-replica-project-commit", "terminal-delivery-encode-enqueue") &&
      daemonBefore("terminal-delivery-encode-enqueue", "pane-stream-socket-send");
    if (
      !verify("daemon-causal-order", daemonOrderPassed, {
        eventLoopMinusAcceptedMicros:
          daemonByOperation.get("daemon-event-loop-turn").startedAtMicros -
          daemonByOperation.get("control-command-accepted").startedAtMicros,
      })
    )
      return null;
    if (expected.requireSharedClockEvidence === true) {
      const sendReturn = rawClientStages.find(
        ({ operation }) => operation === "pane-stream-socket-send-return",
      );
      const calibrationOutcomes = records.filter(
        (record) =>
          record?.type === "performance.clock-calibration" &&
          record.processId === expected.processId &&
          record.daemonInstanceId === expected.generation &&
          record.requestId === sendReturn?.clockCalibrationRequestId,
      );
      const calibrationOutcome = calibrationOutcomes[0];
      const calibrationReason = KNOWN_CLOCK_CALIBRATION_REASONS.has(calibrationOutcome?.reason)
        ? calibrationOutcome.reason
        : "invalid";
      const boundedCalibrationCount = (value) =>
        Number.isSafeInteger(value) && value >= 0 && value <= 5 ? value : null;
      const calibrationOutcomePassed =
        calibrationOutcomes.length === 1 &&
        ["calibrated", "timeout-retained-sample"].includes(calibrationReason) &&
        calibrationOutcome.clockId === expected.clockId &&
        calibrationOutcome.clockKind === "performance-now" &&
        Number.isSafeInteger(calibrationOutcome.atMicros) &&
        calibrationOutcome.atMicros >= 0 &&
        Number.isSafeInteger(sendReturn?.atMicros) &&
        calibrationOutcome.atMicros <= sendReturn.atMicros &&
        calibrationOutcome.requestId === sendReturn?.clockCalibrationRequestId &&
        Number.isSafeInteger(calibrationOutcome?.attemptedProbes) &&
        calibrationOutcome.attemptedProbes >= 1 &&
        calibrationOutcome.attemptedProbes <= 5 &&
        Number.isSafeInteger(calibrationOutcome.receivedProbes) &&
        calibrationOutcome.receivedProbes >= 1 &&
        calibrationOutcome.receivedProbes <= calibrationOutcome.attemptedProbes &&
        Number.isSafeInteger(calibrationOutcome.validProbes) &&
        calibrationOutcome.validProbes >= 1 &&
        calibrationOutcome.validProbes <= calibrationOutcome.receivedProbes &&
        calibrationOutcome.selectedProbes === 1 &&
        Number.isSafeInteger(calibrationOutcome.selectedProbe) &&
        calibrationOutcome.selectedProbe >= 1 &&
        calibrationOutcome.selectedProbe <= calibrationOutcome.attemptedProbes &&
        (calibrationReason === "calibrated"
          ? calibrationOutcome.attemptedProbes === calibrationOutcome.receivedProbes
          : calibrationOutcome.attemptedProbes === calibrationOutcome.receivedProbes + 1);
      if (
        !verify("clock-calibration", calibrationOutcomePassed, {
          outcomeCount: calibrationOutcomes.length,
          reason: calibrationOutcomes.length === 0 ? "missing" : calibrationReason,
          attemptedProbes: boundedCalibrationCount(calibrationOutcome?.attemptedProbes),
          receivedProbes: boundedCalibrationCount(calibrationOutcome?.receivedProbes),
          validProbes: boundedCalibrationCount(calibrationOutcome?.validProbes),
          selectedProbes: boundedCalibrationCount(calibrationOutcome?.selectedProbes),
          selectedProbe: boundedCalibrationCount(calibrationOutcome?.selectedProbe),
        })
      )
        return null;
      const ackCallbackMatches = rawClientStages.filter(
        ({ operation }) => operation === "pane-stream-input-ack-callback",
      );
      const frameArrival = rawClientStages.find(
        ({ operation }) => operation === "socket-frame-arrival",
      );
      const callbackEntry = daemonByOperation.get("pane-stream-socket-message-callback-entry");
      const ackSendMatches = (expected.daemonTraceRecords ?? []).filter(
        (record) =>
          record.traceId === origin.traceId &&
          record.operation === "pane-stream-input-ack-socket-send" &&
          record.stage === "transport" &&
          record.processId === daemonProcess &&
          record.clockId === daemonClock,
      );
      const ackSend = ackSendMatches[0];
      const outputSend = daemonByOperation.get("pane-stream-socket-send");
      const clientEdges = [sendReturn, ackCallbackMatches[0], frameArrival];
      const calibration = sendReturn;
      const calibrationPassed =
        ackCallbackMatches.length === 1 &&
        clientEdges.every(
          (edge) =>
            Number.isSafeInteger(edge?.sharedMicros) &&
            edge.sharedMicros >= 0 &&
            edge.clockCalibrationRequestId === calibration?.clockCalibrationRequestId &&
            edge.clockOffsetLowerMicros === calibration?.clockOffsetLowerMicros &&
            edge.clockOffsetUpperMicros === calibration?.clockOffsetUpperMicros &&
            edge.clockUncertaintyMicros === calibration?.clockUncertaintyMicros &&
            edge.clockCalibratedAtMicros === calibration?.clockCalibratedAtMicros &&
            edge.generation === expected.generation &&
            edge.sharedMicros - edge.clockCalibratedAtMicros >= 0 &&
            edge.sharedMicros - edge.clockCalibratedAtMicros <= 60_000_000,
        ) &&
        typeof calibration?.clockCalibrationRequestId === "string" &&
        /^[0-9a-f-]{36}$/u.test(calibration.clockCalibrationRequestId) &&
        Number.isSafeInteger(calibration.clockOffsetLowerMicros) &&
        Number.isSafeInteger(calibration.clockOffsetUpperMicros) &&
        Number.isSafeInteger(calibration.clockUncertaintyMicros) &&
        calibration.clockOffsetUpperMicros - calibration.clockOffsetLowerMicros ===
          calibration.clockUncertaintyMicros &&
        calibration.clockUncertaintyMicros >= 0 &&
        calibration.clockUncertaintyMicros <= 5_000 &&
        Number.isSafeInteger(calibration.clockCalibratedAtMicros) &&
        calibration.clockCalibratedAtMicros >= 0 &&
        ackSendMatches.length === 1 &&
        [callbackEntry, ackSend, outputSend].every(
          (edge) =>
            Number.isSafeInteger(edge?.sharedStartedAtMicros) &&
            Number.isSafeInteger(edge?.sharedEndedAtMicros) &&
            edge.sharedStartedAtMicros >= 0 &&
            edge.sharedEndedAtMicros >= edge.sharedStartedAtMicros,
        );
      const outbound = clockBounds(sendReturn, callbackEntry?.sharedStartedAtMicros);
      const acknowledgement = clockBounds(
        ackCallbackMatches[0],
        ackSend?.sharedEndedAtMicros,
        "daemon-to-client",
      );
      const delivery = clockBounds(
        frameArrival,
        outputSend?.sharedEndedAtMicros,
        "daemon-to-client",
      );
      if (
        !verify(
          "cross-process-clock-bounds",
          calibrationPassed && outbound !== null && acknowledgement !== null && delivery !== null,
          {
            uncertaintyMicros: calibration?.clockUncertaintyMicros ?? null,
            outbound,
            acknowledgement,
            delivery,
          },
        )
      )
        return null;
    }
  }
  const painted = sample.clientStages.find(({ operation }) => operation === "causal-cell-painted");
  if (
    !verify(
      "causal-cell-paint",
      painted?.causalAttribution === true &&
        painted.semanticPaneId === sample.semanticPaneId &&
        painted.generation === sample.generation &&
        painted.incarnation === sample.incarnation &&
        painted.revision === sample.revision &&
        painted.stateHash === sample.stateHash &&
        Number.isInteger(painted.row) &&
        Number.isInteger(painted.column) &&
        typeof painted.beforeGrapheme === "string" &&
        typeof painted.afterGrapheme === "string" &&
        painted.beforeGrapheme !== painted.afterGrapheme &&
        painted.dirtyRowProved === true,
    )
  )
    return null;
  const input = records.find(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "input" &&
      record.traceId === origin.traceId,
  );
  const paint = records.find(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "paint" &&
      record.traceId === origin.traceId,
  );
  if (
    !verify(
      "input-paint-span",
      Number.isFinite(input?.startedAtMicros) &&
        Number.isFinite(input?.endedAtMicros) &&
        Number.isFinite(paint?.startedAtMicros) &&
        Number.isFinite(paint?.endedAtMicros) &&
        input.clockKind === "performance-now" &&
        paint.clockKind === "performance-now" &&
        input.startedAtMicros === origin.atMicros &&
        input.endedAtMicros >= input.startedAtMicros &&
        paint.startedAtMicros >= input.endedAtMicros &&
        paint.endedAtMicros > paint.startedAtMicros,
    )
  )
    return null;
  const rawByOperation = new Map();
  let clientTimeFailure = null;
  for (const operation of REQUIRED_CLIENT_STAGES) {
    const stage = rawClientStages.find((record) => record.operation === operation);
    if (!Number.isFinite(stage?.atMicros) || stage.atMicros > paint.endedAtMicros) {
      clientTimeFailure = { operation, atMicros: stage?.atMicros ?? null };
      break;
    }
    rawByOperation.set(operation, stage);
  }
  if (!verify("client-stage-time-shape", clientTimeFailure === null, clientTimeFailure ?? {}))
    return null;
  const at = (operation) => rawByOperation.get(operation).atMicros;
  const clientOrderPassed =
    input.startedAtMicros <= at("lane-enqueue") &&
    at("lane-enqueue") <= at("transport-send-start") &&
    at("transport-send-start") <= at("pane-stream-frame-enqueued") &&
    at("pane-stream-frame-enqueued") <= at("pane-stream-buffer-before-send") &&
    at("pane-stream-buffer-before-send") <= at("pane-stream-socket-send-return") &&
    at("pane-stream-frame-enqueued") <= at("pane-stream-socket-send-return") &&
    at("pane-stream-socket-send-return") <= at("pane-stream-buffer-after-send") &&
    at("pane-stream-buffer-after-send") <= input.endedAtMicros &&
    at("pane-stream-socket-send-return") <= input.endedAtMicros &&
    input.endedAtMicros <= at("pane-stream-next-event-loop-turn") &&
    at("pane-stream-next-event-loop-turn") <= at("pane-stream-buffer-next-turn") &&
    at("pane-stream-buffer-next-turn") <= at("pane-stream-buffer-drain-watermark") &&
    at("pane-stream-buffer-drain-watermark") <= at("pane-stream-observer-returned") &&
    at("pane-stream-next-event-loop-turn") <= at("pane-stream-observer-returned") &&
    at("pane-stream-observer-returned") <= at("transport-ack") &&
    at("pane-stream-next-event-loop-turn") <= at("transport-ack") &&
    at("transport-ack") <= at("socket-frame-arrival") &&
    at("socket-frame-arrival") <= at("delivery-received") &&
    at("delivery-received") <= at("delivery-observer-returned") &&
    at("delivery-observer-returned") <= at("canonical-apply-begin") &&
    at("canonical-apply-begin") <= at("canonical-apply-end") &&
    at("canonical-apply-end") <= at("lane-published") &&
    at("delivery-received") <= at("lane-published") &&
    at("lane-published") <= at("causal-cell-delivered") &&
    at("causal-cell-delivered") <= at("render-invalidated") &&
    at("render-invalidated") <= paint.startedAtMicros &&
    paint.startedAtMicros <= at("causal-cell-painted") &&
    at("causal-cell-painted") <= paint.endedAtMicros;
  if (
    !verify("client-causal-order", clientOrderPassed, {
      deliveryMinusInvalidationMicros: at("causal-cell-delivered") - at("render-invalidated"),
      paintMinusInputMicros: paint.endedAtMicros - input.startedAtMicros,
    })
  )
    return null;
  const fences = records.filter(
    (record) => record?.type === "performance.input-fence" && record.traceId === origin.traceId,
  );
  const fence = fences.length === 1 ? fences[0] : null;
  const originIndex = records.indexOf(origin);
  if (originIndex < 0) return null;
  const initialized = records
    .slice(0, originIndex)
    .findLast(
      (record) =>
        (record?.type === "performance.input-queue-state" ||
          (record?.type === "performance.stage" && record.stage === "client")) &&
        record.processId === expected.processId &&
        Number.isFinite(record.atMicros) &&
        record.atMicros <= origin.atMicros &&
        Number.isSafeInteger(record.inputPending) &&
        Number.isSafeInteger(record.inputInFlight) &&
        Number.isSafeInteger(record.inputPendingBytes),
    );
  const ack = sample.clientStages.find(({ operation }) => operation === "transport-ack");
  const queueZero = (record) =>
    record?.inputPending === 0 && record.inputInFlight === 0 && record.inputPendingBytes === 0;
  if (
    !verify("queue-settlement", queueZero(initialized) && queueZero(ack), {
      queueBeforePending: initialized?.inputPending ?? null,
      queueAfterPending: ack?.inputPending ?? null,
    })
  )
    return null;
  if (
    !verify(
      "input-fence",
      origin.atMicros === input?.startedAtMicros &&
        Boolean(fence) &&
        fence.processId === sample.processId &&
        fence.clockId === sample.clockId &&
        fence.clockKind === "performance-now" &&
        Number.isFinite(fence.atMicros) &&
        fence.semanticPaneId === sample.semanticPaneId &&
        fence.generation === sample.generation &&
        fence.incarnation === sample.incarnation &&
        fence.revision === sample.revision &&
        fence.stateHash === sample.stateHash &&
        fence.atMicros >= paint?.endedAtMicros &&
        fence.writerHealth?.droppedRecords === 0 &&
        fence.writerHealth?.oversizedRecords === 0 &&
        fence.writerHealth?.failed === false,
      { fenceCount: fences.length },
    )
  )
    return null;
  return Object.freeze({
    origin,
    sample,
    painted,
    queueBefore: initialized,
    queueAfter: ack,
    fence,
  });
}

export function assessProductFirstInput(records, expected) {
  const predicates = [];
  const origins = records.filter(
    (record) =>
      record?.type === "performance.input-origin" && record.processId === expected.processId,
  );
  const inputs = records.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "input" &&
      record.processId === expected.processId,
  );
  predicates.push({
    id: "input-cardinality",
    passed: origins.length === 1 && inputs.length === 1,
    originCount: origins.length,
    inputCount: inputs.length,
  });
  if (origins.length !== 1 || inputs.length !== 1) return freezeAssessment(null, predicates, false);
  const payload = productFirstInputPayload(expected.document);
  const qualified = qualifyOne(records, origins[0], expected, payload, predicates);
  const fences = records.filter(
    (record) =>
      record?.type === "performance.input-fence" &&
      record.processId === expected.processId &&
      record.traceId === origins[0].traceId &&
      record.writerHealth?.droppedRecords === 0 &&
      record.writerHealth?.oversizedRecords === 0 &&
      record.writerHealth?.failed === false,
  );
  const daemonTerminal =
    expected.requireDaemonEvidence !== true ||
    (expected.daemonTraceRecords ?? []).some(
      (record) =>
        record?.type === "performance.stage" &&
        record.traceId === origins[0].traceId &&
        record.operation === "pane-stream-socket-send",
    );
  return freezeAssessment(qualified, predicates, fences.length === 1 && daemonTerminal);
}

export function qualifyProductFirstInput(records, expected) {
  return assessProductFirstInput(records, expected).qualified;
}

export function assessProductInputDistribution(records, expected) {
  const predicates = [];
  const origins = records.filter(
    (record) =>
      record?.type === "performance.input-origin" && record.processId === expected.processId,
  );
  predicates.push({
    id: "distribution-cardinality",
    passed: origins.length === 30,
    originCount: origins.length,
    expectedCount: 30,
  });
  if (origins.length !== 30) return freezeAssessment(null, predicates, false);
  const qualified = [];
  for (let ordinal = 0; ordinal < origins.length; ordinal += 1) {
    const payload = productFirstInputPayload(
      productFirstInputDocument(expected.variant, (expected.startOrdinal ?? 0) + ordinal),
    );
    const samplePredicates = [];
    const result = qualifyOne(records, origins[ordinal], expected, payload, samplePredicates);
    if (!result) {
      const failure = samplePredicates.find(({ passed }) => !passed) ?? {
        id: "sample-qualification",
        passed: false,
      };
      predicates.push({ ...failure, sampleOrdinal: ordinal });
      return freezeAssessment(
        null,
        predicates,
        distributionEvidenceTerminal(records, expected, origins),
      );
    }
    const previous = qualified.at(-1);
    if (
      previous &&
      (result.origin.revision !== previous.sample.revision ||
        result.origin.stateHash !== previous.sample.stateHash)
    )
      return freezeAssessment(
        null,
        predicates.concat({ id: "distribution-chain", passed: false, sampleOrdinal: ordinal }),
        distributionEvidenceTerminal(records, expected, origins),
      );
    qualified.push(result);
  }
  const traceIds = new Set(qualified.map(({ sample }) => sample.traceId));
  if (traceIds.size !== qualified.length)
    return freezeAssessment(
      null,
      predicates.concat({ id: "distribution-trace-uniqueness", passed: false }),
      distributionEvidenceTerminal(records, expected, origins),
    );
  const durations = qualified.map(({ sample }) => sample.durationMs);
  const p95Ms = percentile(durations, 0.95);
  const p99Ms = percentile(durations, 0.99);
  const result = Object.freeze({
    sampleCount: qualified.length,
    p95Ms,
    p99Ms,
    passed: qualified.length >= 30 && p95Ms <= 16.67 && p99Ms <= 33,
    samples: Object.freeze(qualified),
  });
  predicates.push({
    id: "distribution-samples",
    passed: result.passed,
    sampleCount: result.sampleCount,
    p95Ms: result.p95Ms,
    p99Ms: result.p99Ms,
    topOutliers: productInputOutlierEvidence({
      samples: qualified,
      startOrdinal: expected.startOrdinal,
      daemonObserverRecords: expected.daemonTraceRecords,
    }),
  });
  return freezeAssessment(
    result.passed ? result : null,
    predicates,
    distributionEvidenceTerminal(records, expected, origins),
  );
}

function distributionEvidenceTerminal(records, expected, origins) {
  const traceIds = new Set(origins.map(({ traceId }) => traceId));
  const healthyFenceTraceIds = new Set(
    records.flatMap((record) =>
      record?.type === "performance.input-fence" &&
      record.processId === expected.processId &&
      traceIds.has(record.traceId) &&
      record.writerHealth?.droppedRecords === 0 &&
      record.writerHealth?.oversizedRecords === 0 &&
      record.writerHealth?.failed === false
        ? [record.traceId]
        : [],
    ),
  );
  const daemonTerminalTraceIds = new Set(
    (expected.daemonTraceRecords ?? []).flatMap((record) =>
      record?.type === "performance.stage" &&
      traceIds.has(record.traceId) &&
      record.operation === "pane-stream-socket-send"
        ? [record.traceId]
        : [],
    ),
  );
  return (
    origins.length === 30 &&
    traceIds.size === 30 &&
    healthyFenceTraceIds.size === 30 &&
    (expected.requireDaemonEvidence !== true || daemonTerminalTraceIds.size === 30)
  );
}

export function qualifyProductInputDistribution(records, expected) {
  return assessProductInputDistribution(records, expected).qualified;
}

const PRODUCT_TUI_RUNTIME_PROGRESS_MAX_RECORDS = 32;
const PRODUCT_TUI_RUNTIME_PHASES = new Set([
  "stream-open-start",
  "stream-open-resolved",
  "physical-ready",
  "layout",
  "seed",
  "coherent",
]);
const PRODUCT_TUI_LAYOUT_REJECTIONS = new Set([
  "ambiguous-window-identity",
  "incomplete-inventory-coverage",
]);

export function summarizeProductTuiRuntimeProgress({
  lifecycleRecords,
  processId,
  daemonGeneration,
}) {
  const projected = [];
  let matchingCount = 0;
  let malformedCount = 0;
  let currentGeneration = null;
  const boundedCount = (value, maximum = 513) =>
    Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
  for (const record of lifecycleRecords) {
    if (record?.processId !== processId || record?.clockId !== "opentui-performance-now") continue;
    if (record?.phase === "generation-connection-start") {
      currentGeneration =
        typeof record.daemonGeneration === "string" ? record.daemonGeneration : null;
      continue;
    }
    if (currentGeneration !== daemonGeneration) continue;
    let entry = null;
    if (record?.phase === "generation-runtime-progress") {
      const runtimePhase = record.runtimePhase;
      if (!PRODUCT_TUI_RUNTIME_PHASES.has(runtimePhase)) continue;
      const atMicros = boundedCount(record.monotonicMicros, 60_000_000_000);
      if (atMicros === null) {
        malformedCount += 1;
        continue;
      }
      if (runtimePhase === "layout") {
        const windows = boundedCount(record.windows);
        const panes = boundedCount(record.panes);
        const current = typeof record.current === "boolean" ? record.current : null;
        const rejected =
          record.rejected === undefined
            ? null
            : PRODUCT_TUI_LAYOUT_REJECTIONS.has(record.rejected)
              ? record.rejected
              : undefined;
        if (windows === null || panes === null || current === null || rejected === undefined) {
          malformedCount += 1;
          continue;
        }
        entry = { phase: runtimePhase, atMicros, windows, panes, current, rejected };
      } else if (runtimePhase === "seed") {
        const seededPanes = boundedCount(record.seededPanes);
        const expectedPanes = boundedCount(record.expectedPanes);
        if (seededPanes === null || expectedPanes === null || seededPanes > expectedPanes) {
          malformedCount += 1;
          continue;
        }
        entry = { phase: runtimePhase, atMicros, seededPanes, expectedPanes };
      } else {
        const panes = boundedCount(record.panes);
        if (panes === null) {
          malformedCount += 1;
          continue;
        }
        entry = {
          phase: runtimePhase,
          atMicros,
          panes,
          ...(runtimePhase === "coherent"
            ? {
                seededPanes: boundedCount(record.seededPanes),
                windows: boundedCount(record.windows),
              }
            : {}),
        };
        if (runtimePhase === "coherent" && (entry.seededPanes === null || entry.windows === null)) {
          malformedCount += 1;
          continue;
        }
      }
    } else if (record?.phase === "generation-runtime-fault") {
      entry = {
        phase: "runtime-fault",
        atMicros: boundedCount(record.monotonicMicros, 60_000_000_000),
        reason: "runtime-fault",
      };
      if (entry.atMicros === null) {
        malformedCount += 1;
        continue;
      }
    } else if (record?.phase === "generation-shell-lifecycle") {
      const clientPhase = [
        "loading",
        "live",
        "stale",
        "degraded",
        "unavailable",
        "error",
        "disposed",
      ].includes(record.clientPhase)
        ? record.clientPhase
        : null;
      const inventoryResources = boundedCount(record.inventoryResources);
      const atMicros = boundedCount(record.monotonicMicros, 60_000_000_000);
      if (clientPhase === null || inventoryResources === null || atMicros === null) {
        malformedCount += 1;
        continue;
      }
      entry = { phase: "supervisor", atMicros, clientPhase, inventoryResources };
    }
    if (!entry) continue;
    matchingCount += 1;
    if (projected.length < PRODUCT_TUI_RUNTIME_PROGRESS_MAX_RECORDS)
      projected.push(Object.freeze(entry));
  }
  return Object.freeze({
    records: Object.freeze(projected),
    matchingCount,
    retainedCount: projected.length,
    overflowCount: Math.max(0, matchingCount - projected.length),
    malformedCount,
  });
}

export function productCoherentFrameTimeoutObservation({
  lifecycleRecords,
  traceRecords,
  processId,
  daemonGeneration,
  detailMode,
}) {
  const exactProcessId =
    typeof processId === "string" && /^opentui:[1-9][0-9]{0,9}$/u.test(processId)
      ? processId
      : null;
  const exactGeneration =
    typeof daemonGeneration === "string" &&
    /^[0-9a-f]{8}-[0-9a-f-]{27,63}$/iu.test(daemonGeneration)
      ? daemonGeneration
      : null;
  const lifecycle = exactProcessId
    ? lifecycleRecords.filter((record) => record?.processId === exactProcessId)
    : [];
  const publications = lifecycle.filter(
    (record) =>
      record?.phase === "generation-host-internal-snapshot-publication" &&
      record?.publicationPhase === "internal-snapshot-published" &&
      record?.daemonGeneration === exactGeneration &&
      record?.clockId === "opentui-performance-now" &&
      Number.isSafeInteger(record?.rendererEpoch) &&
      record.rendererEpoch >= 0,
  );
  const published = publications.at(-1) ?? null;
  const rendererEpoch = published?.rendererEpoch ?? null;
  const internalPublicationAtMicros =
    Number.isSafeInteger(published?.monotonicMicros) && published.monotonicMicros >= 0
      ? published.monotonicMicros
      : null;
  const trace = exactProcessId
    ? traceRecords.filter(
        (record) =>
          record?.processId === exactProcessId &&
          record?.clockId === "opentui-performance-now" &&
          (record?.generation === undefined || record.generation === exactGeneration) &&
          internalPublicationAtMicros !== null &&
          Number.isSafeInteger(record?.atMicros) &&
          record.atMicros >= internalPublicationAtMicros,
      )
    : [];
  const canonicalPublications = trace.filter(
    (record) => record?.type === "performance.terminal-canonical-publication",
  );
  const canonicalPaints = trace.filter(
    (record) => record?.type === "performance.terminal-canonical-paint",
  );
  const terminalFrames = lifecycle.filter(
    (record) =>
      record?.phase === "first-terminal-frame" &&
      record?.daemonGeneration === exactGeneration &&
      record?.rendererEpoch === rendererEpoch,
  );
  const resources = lifecycle.filter((record) => record?.phase === "resource-snapshot").at(-1);
  const finiteMicros = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const runtimeProgress =
    exactProcessId && exactGeneration
      ? summarizeProductTuiRuntimeProgress({
          lifecycleRecords,
          processId: exactProcessId,
          daemonGeneration: exactGeneration,
        })
      : Object.freeze({
          records: Object.freeze([]),
          matchingCount: 0,
          retainedCount: 0,
          overflowCount: 0,
          malformedCount: 0,
        });
  return Object.freeze({
    version: 1,
    operation: "wait-for-coherent-terminal-frame",
    reason:
      exactProcessId && exactGeneration
        ? "matching-first-terminal-frame-missing"
        : "expected-runtime-identity-missing",
    processId: exactProcessId,
    daemonGeneration: exactGeneration,
    rendererEpoch,
    detailMode: detailMode === "1" ? "detailed" : "input-detail",
    internalPublicationCount: publications.length,
    internalPublicationAtMicros,
    canonicalPublicationCount: canonicalPublications.length,
    canonicalPaintCount: canonicalPaints.length,
    latestCanonicalPaintAtMicros: finiteMicros(canonicalPaints.at(-1)?.atMicros),
    firstTerminalFrameCount: terminalFrames.length,
    canonicalHostFrameCount: trace.filter(
      (record) =>
        record?.type === "performance.terminal-canonical-host-frame" &&
        record?.rendererEpoch === rendererEpoch,
    ).length,
    terminalFrameFenceCount: trace.filter(
      (record) =>
        record?.type === "performance.terminal-frame-fence" &&
        record?.rendererEpoch === rendererEpoch,
    ).length,
    lifecycleDroppedRecords:
      Number.isSafeInteger(resources?.diagnostics?.droppedRecords) &&
      resources.diagnostics.droppedRecords >= 0
        ? resources.diagnostics.droppedRecords
        : null,
    lifecycleWriterFailed:
      typeof resources?.diagnostics?.failed === "boolean" ? resources.diagnostics.failed : null,
    runtimeProgress,
  });
}

export async function launchAndWaitForExactProductTui({ start, status, waitForCoherent }) {
  start();
  const launched = status();
  if (!Number.isSafeInteger(launched?.processId) || launched.processId <= 0)
    throw new Error("launched ProductRig TUI process identity is unavailable");
  await waitForCoherent(launched.processId);
  const coherent = status();
  if (coherent?.processId !== launched.processId)
    throw new Error("ProductRig TUI process changed before coherent readiness");
  return Object.freeze(coherent);
}

export function assessFirstKeyPasteBoundaries({ timeline, evidence, correlationComplete }) {
  const required = Object.freeze([
    "first-input-namespace-ready",
    "first-input-daemon-ready",
    "first-input-no-prior-hosted-input",
    "first-input-causal-paint",
    "distribution-lane-fresh",
    "distribution-samples",
    "first-input-web-correlation",
  ]);
  let previous = -1;
  const boundaries = required.map((id) => {
    const matches = timeline.flatMap((entry, index) => (entry?.phase === id ? [index] : []));
    const measured = matches.length === 1;
    const observed = matches.length > 0;
    const ordered = measured && matches[0] > previous;
    if (ordered) previous = matches[0];
    const evidencePassed =
      id !== "first-input-causal-paint"
        ? id !== "distribution-samples"
          ? true
          : evidence?.distribution?.sampleCount >= 30 && evidence.distribution.passed === true
        : evidence?.firstInput?.noPriorHostedInput === true && evidence.firstInput.traceId;
    const passed = Boolean(measured && ordered && evidencePassed);
    return Object.freeze({
      id,
      status: passed ? "passed" : observed ? "failed" : "unmeasured",
      detail: !measured
        ? `observed ${matches.length}/1`
        : !ordered
          ? "out-of-order"
          : evidencePassed
            ? "observed once in order"
            : "direct evidence incomplete",
    });
  });
  boundaries.push(
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete ? "passed" : "unmeasured",
      detail: correlationComplete
        ? "exact daemon/client/TUI/Web correlation"
        : "correlation incomplete",
    }),
  );
  const firstBrokenBoundary = boundaries.find(({ status }) => status === "failed")?.id ?? null;
  const firstUnmeasuredBoundary =
    boundaries.find(({ status }) => status === "unmeasured")?.id ?? null;
  return Object.freeze({
    status: firstBrokenBoundary ? "failed" : firstUnmeasuredBoundary ? "incomplete" : "passed",
    firstBrokenBoundary,
    firstUnmeasuredBoundary,
    boundaries: Object.freeze(boundaries),
  });
}
