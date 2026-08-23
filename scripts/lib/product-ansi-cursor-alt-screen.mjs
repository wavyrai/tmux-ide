import { createHash, createHmac } from "node:crypto";

import {
  TUI_CURSOR_PRESENTATION_P99_CEILING_MICROS,
  TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS,
  TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS,
  TUI_EVENT_LOOP_WORKLOAD_P99_CEILING_MS,
  TUI_HEAP_ABSOLUTE_CEILING_BYTES,
  TUI_RSS_ABSOLUTE_CEILING_BYTES,
} from "./performance-reference-budgets.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_STATE_HASH = /^[0-9a-f]{16}$/u;
const DAEMON_PROCESS_ID = /^daemon:([1-9][0-9]*)$/u;
const MAX_MICROS = 5_000_000;

export const ANSI_CURSOR_SAMPLE_COUNT = 30;
export const ANSI_CURSOR_P95_BUDGET_MICROS = 16_670;
export const ANSI_CURSOR_P99_BUDGET_MICROS = TUI_CURSOR_PRESENTATION_P99_CEILING_MICROS;
const RESOURCE_ENDPOINT_COUNT = 16;
const ANSI_DAEMON_STAGES = Object.freeze([
  ["pane-stream-socket-message-callback-entry", "transport"],
  ["pane-stream-input-frame-ingress", "transport"],
  ["raw-input-command", "tmux"],
  ["control-write", "tmux"],
  ["control-command-accepted", "tmux"],
  ["first-output-observed", "tmux"],
  ["terminal-replica-write", "parse"],
  ["terminal-replica-project-commit", "reduce"],
  ["terminal-delivery-encode-enqueue", "transport"],
  ["pane-stream-socket-send", "transport"],
]);
const ANSI_DAEMON_NULL_INCARNATION_OPERATIONS = new Set([
  "raw-input-command",
  "control-write",
  "control-command-accepted",
]);

export function ansiDeliverySubscriberTopologyStatus({ records, expected }) {
  if (!Array.isArray(records) || records.length > 100_000)
    return Object.freeze({ exact: false, reason: "records-bounded", lanes: Object.freeze([]) });
  const clients = expected?.deliveryClients;
  if (
    clients === null ||
    typeof clients !== "object" ||
    Array.isArray(clients) ||
    Object.keys(clients).length < 1 ||
    Object.keys(clients).length > 4 ||
    new Set(Object.values(clients)).size !== Object.keys(clients).length
  )
    return Object.freeze({ exact: false, reason: "clients-exact", lanes: Object.freeze([]) });
  const expectedClientSurface = new Map(
    Object.entries(clients).map(([surface, clientId]) => [clientId, surface]),
  );
  const lifecycle = records.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.operation === "terminal-delivery-subscriber-lifecycle" &&
      record.stage === "transport" &&
      record.terminalDelivery?.workspaceName === expected?.deliveryWorkspaceName &&
      record.terminalDelivery?.semanticPaneId === expected?.semanticPaneId &&
      record.terminalDelivery?.canonicalGeneration === expected?.canonicalGeneration,
  );
  const active = new Map();
  let previousOrdinal = 0;
  let reason = null;
  for (const record of lifecycle) {
    const delivery = record.terminalDelivery;
    const surface = expectedClientSurface.get(delivery?.deliveryClientId);
    const shapeExact =
      record.processId === expected?.daemonProcessId &&
      record.clockId === expected?.daemonClockId &&
      record.clockKind === "performance-now" &&
      safeTimestamp(record.startedAtMicros) &&
      safeTimestamp(record.endedAtMicros) &&
      record.startedAtMicros <= record.endedAtMicros &&
      delivery?.canonicalIncarnation === expected?.canonicalIncarnation &&
      surface === delivery?.deliverySurface &&
      delivery?.deliveryPurpose === "terminal-surface" &&
      typeof delivery?.deliveryLaneId === "string" &&
      delivery.deliveryLaneId.length >= 1 &&
      delivery.deliveryLaneId.length <= 256 &&
      typeof delivery?.deliveryRequestId === "string" &&
      UUID_V4.test(delivery.deliveryRequestId) &&
      Number.isSafeInteger(delivery?.deliveryLifecycleOrdinal) &&
      delivery.deliveryLifecycleOrdinal > previousOrdinal &&
      new Set(["open", "close"]).has(delivery?.deliveryLifecycleEvent);
    if (!shapeExact) {
      reason = "lifecycle-shape";
      break;
    }
    previousOrdinal = delivery.deliveryLifecycleOrdinal;
    const lane = delivery.deliveryLaneId;
    if (delivery.deliveryLifecycleEvent === "open") {
      if (active.has(lane)) {
        reason = "duplicate-open";
        break;
      }
      active.set(
        lane,
        Object.freeze({
          clientId: delivery.deliveryClientId,
          surface: delivery.deliverySurface,
          laneId: lane,
          requestId: delivery.deliveryRequestId,
          purpose: delivery.deliveryPurpose,
        }),
      );
    } else if (!active.delete(lane)) {
      reason = "stale-close";
      break;
    }
  }
  const lanes = Object.freeze(
    [...active.values()].sort((left, right) => left.laneId.localeCompare(right.laneId)),
  );
  if (lanes.length < 1 || lanes.length > 16)
    return Object.freeze({
      exact: false,
      reason: "lane-count",
      lifecycleOrdinal: previousOrdinal,
      lanes,
    });
  if (new Set(lanes.map(({ requestId }) => requestId)).size !== lanes.length)
    return Object.freeze({
      exact: false,
      reason: "request-collision",
      lifecycleOrdinal: previousOrdinal,
      lanes,
    });
  if (
    reason === null &&
    Object.values(clients).every(
      (clientId) => lanes.filter((lane) => lane.clientId === clientId).length >= 1,
    )
  )
    return Object.freeze({ exact: true, reason: null, lifecycleOrdinal: previousOrdinal, lanes });
  return Object.freeze({
    exact: false,
    reason: reason ?? "client-lane-missing",
    lifecycleOrdinal: previousOrdinal,
    lanes,
  });
}

const ANSI_DELIVERY_READINESS_REASONS = new Set([
  "topology-not-exact",
  "status-shape",
  "status-missing",
  "lineage-cardinality",
  "lineage-identity",
  "lineage-order",
  "canonical-predecessor",
  "lane-not-visible",
  "lane-in-flight",
  "lane-queue-not-empty",
  "later-enqueue",
]);

/**
 * Proves that every independently-qualified active subscriber has adopted the
 * exact canonical predecessor before an input watermark can be taken.
 */
export function ansiDeliverySubscriberReadinessStatus({ records, expected, topology }) {
  const unavailable = (reason, laneCount = 0, readyLaneCount = 0, firstInvalidLaneOrdinal = null) =>
    Object.freeze({
      exact: false,
      reason: ANSI_DELIVERY_READINESS_REASONS.has(reason) ? reason : "status-shape",
      laneCount: Math.min(Math.max(laneCount, 0), 17),
      readyLaneCount: Math.min(Math.max(readyLaneCount, 0), 16),
      firstInvalidLaneOrdinal:
        Number.isSafeInteger(firstInvalidLaneOrdinal) && firstInvalidLaneOrdinal >= 0
          ? Math.min(firstInvalidLaneOrdinal, 15)
          : null,
    });
  const currentTopology = Array.isArray(records)
    ? ansiDeliverySubscriberTopologyStatus({ records, expected })
    : null;
  if (
    !Array.isArray(records) ||
    records.length > 100_000 ||
    topology?.exact !== true ||
    !Array.isArray(topology?.lanes) ||
    topology.lanes.length < 1 ||
    topology.lanes.length > 16 ||
    !Number.isSafeInteger(expected?.predecessorRevision) ||
    expected.predecessorRevision < 0 ||
    !CANONICAL_STATE_HASH.test(expected?.predecessorStateHash ?? "") ||
    currentTopology?.exact !== true ||
    currentTopology.lifecycleOrdinal !== topology.lifecycleOrdinal ||
    JSON.stringify(currentTopology.lanes) !== JSON.stringify(topology.lanes)
  )
    return unavailable("topology-not-exact", topology?.lanes?.length ?? 0);

  const targetAuthority = (record) =>
    record?.type === "performance.stage" &&
    record.stage === "transport" &&
    record.processId === expected?.daemonProcessId &&
    record.clockId === expected?.daemonClockId &&
    record.clockKind === "performance-now" &&
    safeTimestamp(record.startedAtMicros) &&
    safeTimestamp(record.endedAtMicros) &&
    record.startedAtMicros <= record.endedAtMicros &&
    record.terminalDelivery?.workspaceName === expected?.deliveryWorkspaceName &&
    record.terminalDelivery?.semanticPaneId === expected?.semanticPaneId &&
    record.terminalDelivery?.canonicalGeneration === expected?.canonicalGeneration &&
    record.terminalDelivery?.canonicalIncarnation === expected?.canonicalIncarnation;
  const predecessor = (record, operation) =>
    targetAuthority(record) &&
    record.operation === operation &&
    record.terminalDelivery.canonicalRevision === expected.predecessorRevision &&
    record.terminalDelivery.canonicalStateHash === expected.predecessorStateHash;
  const statuses = records.filter(
    (record) =>
      targetAuthority(record) && record.operation === "terminal-delivery-subscriber-status",
  );
  let priorStatusOrdinal = 0;
  for (const record of statuses) {
    const delivery = record.terminalDelivery;
    if (
      delivery?.deliveryPurpose !== "terminal-surface" ||
      !Number.isSafeInteger(delivery.deliveryStatusOrdinal) ||
      delivery.deliveryStatusOrdinal <= priorStatusOrdinal ||
      typeof delivery.deliveryClientId !== "string" ||
      typeof delivery.deliverySurface !== "string" ||
      typeof delivery.deliveryLaneId !== "string" ||
      !UUID_V4.test(delivery.deliveryRequestId ?? "") ||
      !new Set(["visible", "background", "hidden", "frozen"]).has(delivery.deliveryVisibility) ||
      !Number.isSafeInteger(delivery.deliveryBaselineRevision) ||
      !(
        delivery.deliveryBaselineHash === null ||
        CANONICAL_STATE_HASH.test(delivery.deliveryBaselineHash ?? "")
      ) ||
      !(
        delivery.deliveryInFlightRevision === null ||
        (Number.isSafeInteger(delivery.deliveryInFlightRevision) &&
          delivery.deliveryInFlightRevision >= 0)
      ) ||
      !(
        delivery.deliveryInFlightHash === null ||
        CANONICAL_STATE_HASH.test(delivery.deliveryInFlightHash ?? "")
      ) ||
      !(
        delivery.deliveryLatestRevision === null ||
        (Number.isSafeInteger(delivery.deliveryLatestRevision) &&
          delivery.deliveryLatestRevision >= 0)
      ) ||
      !Number.isSafeInteger(delivery.deliveryClientQueueDepth) ||
      delivery.deliveryClientQueueDepth < 0 ||
      delivery.deliveryClientQueueDepth > 1_024
    )
      return unavailable("status-shape", topology.lanes.length);
    priorStatusOrdinal = delivery.deliveryStatusOrdinal;
  }

  let readyLaneCount = 0;
  let statusOrdinal = 0;
  for (const [laneOrdinal, lane] of topology.lanes.entries()) {
    const laneIdentity = (record) => {
      const delivery = record.terminalDelivery;
      return (
        delivery?.deliveryClientId === lane.clientId &&
        delivery?.deliverySurface === lane.surface &&
        delivery?.deliveryLaneId === lane.laneId &&
        delivery?.deliveryRequestId === lane.requestId
      );
    };
    const activeOpen = records.findLast(
      (record) =>
        targetAuthority(record) &&
        record.operation === "terminal-delivery-subscriber-lifecycle" &&
        record.terminalDelivery?.deliveryLifecycleEvent === "open" &&
        laneIdentity(record),
    );
    if (!activeOpen)
      return unavailable("topology-not-exact", topology.lanes.length, readyLaneCount, laneOrdinal);
    const afterActiveOpen = (record) => record.startedAtMicros >= activeOpen.endedAtMicros;
    const enqueues = records.filter(
      (record) =>
        predecessor(record, "terminal-delivery-encode-enqueue") &&
        laneIdentity(record) &&
        afterActiveOpen(record),
    );
    const sockets = records.filter(
      (record) =>
        predecessor(record, "pane-stream-socket-send") &&
        laneIdentity(record) &&
        afterActiveOpen(record),
    );
    const settlements = records.filter(
      (record) =>
        predecessor(record, "terminal-delivery-settled") &&
        laneIdentity(record) &&
        afterActiveOpen(record),
    );
    if (enqueues.length !== 1 || sockets.length !== 1 || settlements.length !== 1)
      return unavailable("lineage-cardinality", topology.lanes.length, readyLaneCount, laneOrdinal);
    const [enqueue, socket, settlement] = [enqueues[0], sockets[0], settlements[0]];
    const lineageFields = ["deliveryNonce", "transactionId", "deliveryOrdinal"];
    if (
      !lineageFields.every(
        (field) =>
          enqueue.terminalDelivery[field] === socket.terminalDelivery[field] &&
          enqueue.terminalDelivery[field] === settlement.terminalDelivery[field],
      ) ||
      typeof enqueue.terminalDelivery.deliveryNonce !== "string" ||
      enqueue.terminalDelivery.deliveryNonce.length < 1 ||
      enqueue.terminalDelivery.deliveryNonce.length > 256 ||
      typeof enqueue.terminalDelivery.transactionId !== "string" ||
      enqueue.terminalDelivery.transactionId.length < 1 ||
      enqueue.terminalDelivery.transactionId.length > 256 ||
      !Number.isSafeInteger(enqueue.terminalDelivery.deliveryOrdinal) ||
      enqueue.terminalDelivery.deliveryOrdinal < 1
    )
      return unavailable("lineage-identity", topology.lanes.length, readyLaneCount, laneOrdinal);
    if (
      enqueue.endedAtMicros > socket.startedAtMicros ||
      socket.endedAtMicros > settlement.startedAtMicros
    )
      return unavailable("lineage-order", topology.lanes.length, readyLaneCount, laneOrdinal);
    const laneStatuses = statuses.filter(
      (record) => laneIdentity(record) && afterActiveOpen(record),
    );
    const status = laneStatuses.at(-1);
    if (!status)
      return unavailable("status-missing", topology.lanes.length, readyLaneCount, laneOrdinal);
    const delivery = status.terminalDelivery;
    if (
      delivery.canonicalRevision !== expected.predecessorRevision ||
      delivery.canonicalStateHash !== expected.predecessorStateHash ||
      delivery.deliveryBaselineRevision !== expected.predecessorRevision ||
      delivery.deliveryBaselineHash !== expected.predecessorStateHash ||
      delivery.deliveryLatestRevision !== null
    )
      return unavailable(
        "canonical-predecessor",
        topology.lanes.length,
        readyLaneCount,
        laneOrdinal,
      );
    if (delivery.deliveryVisibility !== "visible")
      return unavailable("lane-not-visible", topology.lanes.length, readyLaneCount, laneOrdinal);
    if (delivery.deliveryInFlightRevision !== null || delivery.deliveryInFlightHash !== null)
      return unavailable("lane-in-flight", topology.lanes.length, readyLaneCount, laneOrdinal);
    if (delivery.deliveryClientQueueDepth !== 0)
      return unavailable(
        "lane-queue-not-empty",
        topology.lanes.length,
        readyLaneCount,
        laneOrdinal,
      );
    if (
      records.some(
        (record) =>
          targetAuthority(record) &&
          record.operation === "terminal-delivery-encode-enqueue" &&
          laneIdentity(record) &&
          record.startedAtMicros > settlement.endedAtMicros,
      )
    )
      return unavailable("later-enqueue", topology.lanes.length, readyLaneCount, laneOrdinal);
    if (status.startedAtMicros < settlement.endedAtMicros)
      return unavailable("lineage-order", topology.lanes.length, readyLaneCount, laneOrdinal);
    statusOrdinal = Math.max(statusOrdinal, delivery.deliveryStatusOrdinal);
    readyLaneCount += 1;
  }
  return Object.freeze({
    exact: true,
    reason: null,
    laneCount: topology.lanes.length,
    readyLaneCount,
    firstInvalidLaneOrdinal: null,
    statusOrdinal,
  });
}

export async function waitForAnsiDeliverySubscriberReadiness({
  readRecords,
  now,
  sleep,
  expected,
  timeoutMs = 60_000,
  stableMs = 40,
  pollMs = 10,
}) {
  if (
    typeof readRecords !== "function" ||
    typeof now !== "function" ||
    typeof sleep !== "function" ||
    timeoutMs !== 60_000 ||
    stableMs !== 40 ||
    pollMs !== 10
  )
    throw new TypeError("invalid ANSI delivery readiness wait contract");
  const startedAt = now();
  if (!Number.isFinite(startedAt) || startedAt < 0)
    throw new TypeError("invalid ANSI delivery readiness clock");
  let previous = null;
  let stableSince = null;
  let topology;
  let readiness;
  for (;;) {
    const records = await readRecords();
    topology = ansiDeliverySubscriberTopologyStatus({ records, expected });
    readiness = ansiDeliverySubscriberReadinessStatus({ records, expected, topology });
    const sampledAt = now();
    if (!Number.isFinite(sampledAt) || sampledAt < startedAt)
      throw new TypeError("invalid ANSI delivery readiness clock");
    const serialized =
      topology.exact && readiness.exact ? JSON.stringify([topology, readiness]) : null;
    if (serialized !== null && serialized === previous) {
      stableSince ??= sampledAt;
      if (sampledAt - stableSince >= stableMs)
        return Object.freeze({ qualified: true, topology, readiness });
    } else {
      previous = serialized;
      stableSince = serialized === null ? null : sampledAt;
    }
    if (sampledAt - startedAt >= timeoutMs)
      return Object.freeze({ qualified: false, topology, readiness });
    await sleep(pollMs);
  }
}

export async function runAnsiDeliveryReadyAction({ takeWatermark, driveInput, ...waitOptions }) {
  if (typeof takeWatermark !== "function" || typeof driveInput !== "function")
    throw new TypeError("invalid ANSI delivery ready action contract");
  const wait = await waitForAnsiDeliverySubscriberReadiness(waitOptions);
  if (!wait.qualified) return Object.freeze({ ...wait, watermark: null, delivery: null });
  const watermark = await takeWatermark();
  const delivery = await driveInput();
  return Object.freeze({ ...wait, watermark, delivery });
}

export function ansiWorkloadMarker(marker, cycle) {
  if (
    typeof marker !== "string" ||
    marker.length < 1 ||
    marker.length > 256 ||
    !Number.isSafeInteger(cycle) ||
    cycle < 1 ||
    cycle > 24
  )
    throw new TypeError("invalid ANSI workload marker identity");
  return `ANSI_WORKLOAD_END_${marker}_${String(cycle).padStart(2, "0")}`;
}

export function ansiWorkloadPayload(marker, cycle) {
  let payload = "";
  for (let row = 0; row < 4_096; row += 1)
    payload += `LOAD_${String(row).padStart(4, "0")} 0123456789abcdef\r\n`;
  return `${payload}\x1b[40;1H\x1b[2K${ansiWorkloadMarker(marker, cycle)}`;
}

export function ansiWorkloadProducerStatus(records, expected) {
  const unavailable = (state, reason, record = null) =>
    Object.freeze({ exact: false, state, reason, record });
  if (
    !Array.isArray(records) ||
    records.length > 8 ||
    !Number.isSafeInteger(expected?.cycle) ||
    expected.cycle < 1 ||
    expected.cycle > 24 ||
    !Number.isSafeInteger(expected?.ordinal) ||
    expected.ordinal !== expected.cycle ||
    !Number.isSafeInteger(expected?.payloadBytes) ||
    expected.payloadBytes < 1 ||
    expected.payloadBytes > 16_777_216 ||
    !SHA256.test(expected?.payloadSha256 ?? "")
  )
    return unavailable("invalid", "expected-shape");
  const workloadRecords = records.filter(
    (record) => record?.type === "performance.ansi-fixture-workload",
  );
  if (workloadRecords.length === 0) return unavailable("pending", "completion-absent");
  if (workloadRecords.length !== 1 || workloadRecords.length !== records.length)
    return unavailable("invalid", "completion-cardinality");
  const record = workloadRecords[0];
  const shapeExact =
    exactKeys(record, [
      "version",
      "type",
      "cycle",
      "ordinal",
      "payloadBytes",
      "payloadSha256",
      "status",
      "backpressureCount",
    ]) &&
    record.version === 1 &&
    record.cycle === expected.cycle &&
    record.ordinal === expected.ordinal &&
    record.payloadBytes === expected.payloadBytes &&
    record.payloadSha256 === expected.payloadSha256 &&
    new Set(["complete", "error"]).has(record.status) &&
    Number.isSafeInteger(record.backpressureCount) &&
    record.backpressureCount >= 0 &&
    record.backpressureCount <= 8_192;
  if (!shapeExact) return unavailable("invalid", "completion-shape", record);
  if (record.status === "error") return unavailable("error", "stdout-write", record);
  return Object.freeze({ exact: true, state: "complete", reason: null, record });
}

export function ansiCursorAltScreenFixtureProgram() {
  return [
    "const marker=process.argv[1]",
    `const ansiWorkloadMarker=${ansiWorkloadMarker.toString()}`,
    `const ansiWorkloadPayload=${ansiWorkloadPayload.toString()}`,
    "const baselineBytes='\\x1b[3J\\x1b[2J\\x1b[H\\x1b[2 q\\x1b[?25h'+marker+'\\x1b[2;1H'",
    "const baseline=()=>process.stdout.write(baselineBytes)",
    "baseline()",
    "if(typeof process.stdin.setRawMode==='function')process.stdin.setRawMode(true);process.stdin.resume()",
    "let cursor=0,workload=0",
    "process.stdin.on('data',chunk=>{for(const byte of chunk){if(byte===98){baseline()}else if(byte===114){process.stdout.write('\\x1b[3J\\x1b[H\\x1b[2K\\x1b[1;3;4;38;5;196;48;2;1;2;3mANSI_RICH界é\\x1b[0m\\x1b[2;129H\\x1b[38;2;90;180;255;48;5;17;1;4mW界éZ\\x1b[0m\\x1b[4;7H\\x1b[5 q\\x1b[?25h')}else if(byte===99){cursor=(cursor+1)%30;const row=2+(cursor%8),col=3+(cursor%20),shape=1+(cursor%6);process.stdout.write('\\x1b['+row+';'+col+'H\\x1b['+shape+' q\\x1b[?25h')}else if(byte===97){process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HALT_SCREEN界é\\x1b[8;12H\\x1b[4 q\\x1b[?25l')}else if(byte===110){process.stdout.write('\\x1b[?1049l\\x1b[0m\\x1b[2;1H\\x1b[2 q\\x1b[?25h')}else if(byte===119){workload+=1;process.stdout.write(ansiWorkloadPayload(marker,workload))}}})",
    "setInterval(()=>{},2147483647)",
  ].join(";");
}

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function safeMicros(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MICROS;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

const ANSI_WORKLOAD_CYCLE_COUNT = 24;
const ANSI_WORKLOAD_STABLE_TAIL_MS = 40;
export const ANSI_WORKLOAD_NO_PROGRESS_MS = 15_000;
export const ANSI_WORKLOAD_ABSOLUTE_MS = 30_000;
export const ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES = TUI_RSS_ABSOLUTE_CEILING_BYTES;
export const ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES = TUI_HEAP_ABSOLUTE_CEILING_BYTES;
export const ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS =
  TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS;
export const ANSI_TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS =
  TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS;

export function ansiEventLoopResourceCapStatus(sample) {
  if (
    !Number.isSafeInteger(sample?.eventLoopDelayMicros) ||
    sample.eventLoopDelayMicros < 0 ||
    sample.eventLoopDelayMicros > ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS
  )
    return "event-loop-current-cap";
  if (
    !Number.isSafeInteger(sample?.eventLoopDelayPeakMicros) ||
    sample.eventLoopDelayPeakMicros < sample.eventLoopDelayMicros ||
    sample.eventLoopDelayPeakMicros > ANSI_TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS
  )
    return "event-loop-cap";
  return null;
}

function boundedSizeFact(value, cap) {
  if (!Number.isSafeInteger(value) || value < 0)
    return Object.freeze({ value: null, atLeast: null, sizeCapped: null });
  return value <= cap
    ? Object.freeze({ value, atLeast: null, sizeCapped: false })
    : Object.freeze({ value: null, atLeast: cap + 1, sizeCapped: true });
}

export function boundedAnsiResourceFailureFacts({ rssBytes, heapUsedBytes, eventLoopDelayMicros }) {
  const rss = boundedSizeFact(rssBytes, 2_147_483_648);
  const heap = boundedSizeFact(heapUsedBytes, 1_073_741_824);
  const delay = boundedSizeFact(eventLoopDelayMicros, 60_000_000);
  return Object.freeze({
    rssBytes: rss.value,
    rssAtLeastBytes: rss.atLeast,
    rssSizeCapped: rss.sizeCapped,
    heapBytes: heap.value,
    heapAtLeastBytes: heap.atLeast,
    heapSizeCapped: heap.sizeCapped,
    eventLoopDelayMicros: delay.value,
    eventLoopDelayAtLeastMicros: delay.atLeast,
    eventLoopDelaySizeCapped: delay.sizeCapped,
  });
}

export function boundedAnsiResourcePeakFailureFacts({
  rssPeakBytes,
  heapUsedPeakBytes,
  eventLoopDelayPeakMicros,
}) {
  const rss = boundedSizeFact(rssPeakBytes, 2_147_483_648);
  const heap = boundedSizeFact(heapUsedPeakBytes, 1_073_741_824);
  const delay = boundedSizeFact(eventLoopDelayPeakMicros, 60_000_000);
  return Object.freeze({
    rssPeakBytes: rss.value,
    rssPeakAtLeastBytes: rss.atLeast,
    rssPeakSizeCapped: rss.sizeCapped,
    heapPeakBytes: heap.value,
    heapPeakAtLeastBytes: heap.atLeast,
    heapPeakSizeCapped: heap.sizeCapped,
    eventLoopDelayPeakMicros: delay.value,
    eventLoopDelayPeakAtLeastMicros: delay.atLeast,
    eventLoopDelayPeakSizeCapped: delay.sizeCapped,
  });
}

const ANSI_RESOURCE_EPOCH_IDENTITY_FIELDS = Object.freeze([
  "processId",
  "clockId",
  "clockKind",
  "semanticPaneId",
  "generation",
  "incarnation",
  "revision",
  "stateHash",
  "cols",
  "rows",
  "sourceEpoch",
  "rendererEpoch",
  "viewportCols",
  "viewportRows",
  "acceptedUpdateType",
  "acceptedRevision",
]);

export function ansiResourceEpochIdentityExact(left, right) {
  return (
    left !== null &&
    typeof left === "object" &&
    right !== null &&
    typeof right === "object" &&
    ANSI_RESOURCE_EPOCH_IDENTITY_FIELDS.every((field) => left[field] === right[field])
  );
}

const ANSI_WORKLOAD_PROGRESS_FIELDS = Object.freeze([
  "canonicalRevision",
  "enqueueOrdinal",
  "enqueueCanonicalRevision",
  "settledOrdinal",
  "settledCanonicalRevision",
  "frameRevision",
  "fenceRevision",
  "producerOrdinal",
]);

export function advanceAnsiWorkloadProgress(previous, observation, nowMs) {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !exactKeys(observation, ANSI_WORKLOAD_PROGRESS_FIELDS) ||
    !ANSI_WORKLOAD_PROGRESS_FIELDS.every(
      (field) =>
        observation[field] === null ||
        (Number.isSafeInteger(observation[field]) && observation[field] >= 0),
    )
  )
    throw new TypeError("invalid ANSI workload progress observation");
  if (previous === null) {
    return Object.freeze({
      startedAtMs: nowMs,
      lastProgressAtMs: nowMs,
      progressCount: 0,
      ...Object.fromEntries(ANSI_WORKLOAD_PROGRESS_FIELDS.map((field) => [field, -1])),
    });
  }
  if (
    !exactKeys(previous, [
      "startedAtMs",
      "lastProgressAtMs",
      "progressCount",
      ...ANSI_WORKLOAD_PROGRESS_FIELDS,
    ]) ||
    !Number.isSafeInteger(previous.startedAtMs) ||
    !Number.isSafeInteger(previous.lastProgressAtMs) ||
    !Number.isSafeInteger(previous.progressCount) ||
    previous.startedAtMs < 0 ||
    previous.lastProgressAtMs < previous.startedAtMs ||
    nowMs < previous.lastProgressAtMs ||
    previous.progressCount < 0 ||
    previous.progressCount > 65_536 ||
    !ANSI_WORKLOAD_PROGRESS_FIELDS.every(
      (field) => Number.isSafeInteger(previous[field]) && previous[field] >= -1,
    )
  )
    throw new TypeError("invalid ANSI workload progress state");
  const regressedField = ANSI_WORKLOAD_PROGRESS_FIELDS.find(
    (field) => observation[field] !== null && observation[field] < previous[field],
  );
  if (regressedField) {
    const error = new Error("ANSI workload progress regressed");
    error.code = "ANSI_WORKLOAD_PROGRESS_REGRESSION";
    error.field = regressedField;
    throw error;
  }
  const advanced = ANSI_WORKLOAD_PROGRESS_FIELDS.some(
    (field) => observation[field] !== null && observation[field] > previous[field],
  );
  return Object.freeze({
    startedAtMs: previous.startedAtMs,
    lastProgressAtMs: advanced ? nowMs : previous.lastProgressAtMs,
    progressCount: advanced ? Math.min(previous.progressCount + 1, 65_536) : previous.progressCount,
    ...Object.fromEntries(
      ANSI_WORKLOAD_PROGRESS_FIELDS.map((field) => [
        field,
        observation[field] === null ? previous[field] : observation[field],
      ]),
    ),
  });
}

export function ansiWorkloadProgressExpiry(progress, nowMs) {
  if (
    !progress ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < progress.lastProgressAtMs ||
    nowMs < progress.startedAtMs
  )
    throw new TypeError("invalid ANSI workload progress deadline");
  if (nowMs - progress.startedAtMs >= ANSI_WORKLOAD_ABSOLUTE_MS) return "absolute-deadline";
  if (nowMs - progress.lastProgressAtMs >= ANSI_WORKLOAD_NO_PROGRESS_MS)
    return "no-progress-deadline";
  return null;
}

export function ansiWorkloadOrderedTailStatus({
  transitions,
  modes,
  enqueues,
  settlements,
  frames,
  fences,
}) {
  const collections = [transitions, modes, enqueues, settlements, frames, fences];
  const counts = Object.freeze({
    canonicalTransitionCount: Math.min(
      Array.isArray(transitions) ? transitions.length : 65_537,
      65_537,
    ),
    modeCount: Math.min(Array.isArray(modes) ? modes.length : 65_537, 65_537),
    enqueueCount: Math.min(Array.isArray(enqueues) ? enqueues.length : 65_537, 65_537),
    settlementCount: Math.min(Array.isArray(settlements) ? settlements.length : 65_537, 65_537),
    frameCount: Math.min(Array.isArray(frames) ? frames.length : 65_537, 65_537),
    fenceCount: Math.min(Array.isArray(fences) ? fences.length : 65_537, 65_537),
  });
  const rejected = (reason, offendingRevision = null, offendingAcceptedType = null) =>
    Object.freeze({
      exact: false,
      reason,
      progress: null,
      counts,
      pendingDeliveryCount: null,
      offendingRevision,
      offendingAcceptedType,
    });
  if (collections.some((records) => !Array.isArray(records) || records.length > 65_536))
    return rejected("tail-bounds");
  const monotonic = (records, project) => {
    let previous = null;
    for (const record of records) {
      const current = project(record);
      if (
        !current ||
        (previous &&
          (current.ordinal <= previous.ordinal || current.at < (previous.endedAt ?? previous.at)))
      )
        return false;
      previous = current;
    }
    return true;
  };
  const canonical = (record) =>
    Number.isSafeInteger(record?.revision) &&
    record.revision >= 0 &&
    CANONICAL_STATE_HASH.test(record?.stateHash ?? "") &&
    safeTimestamp(record?.atMicros)
      ? { ordinal: record.revision, at: record.atMicros, hash: record.stateHash }
      : null;
  const delivery = (record) =>
    Number.isSafeInteger(record?.terminalDelivery?.deliveryOrdinal) &&
    record.terminalDelivery.deliveryOrdinal >= 0 &&
    Number.isSafeInteger(record?.terminalDelivery?.canonicalRevision) &&
    record.terminalDelivery.canonicalRevision >= 0 &&
    CANONICAL_STATE_HASH.test(record?.terminalDelivery?.canonicalStateHash ?? "") &&
    boundedIdentity(record?.terminalDelivery?.transactionId) &&
    safeTimestamp(record?.startedAtMicros) &&
    safeTimestamp(record?.endedAtMicros) &&
    record.startedAtMicros <= record.endedAtMicros
      ? {
          ordinal: record.terminalDelivery.deliveryOrdinal,
          at: record.startedAtMicros,
          revision: record.terminalDelivery.canonicalRevision,
          hash: record.terminalDelivery.canonicalStateHash,
          transactionId: record.terminalDelivery.transactionId,
          endedAt: record.endedAtMicros,
        }
      : null;
  if (
    transitions.some(
      (record) => !new Set(["terminal.seed", "terminal.patch"]).has(record?.updateType),
    )
  )
    return rejected("transition-shape");
  if (!monotonic(transitions, canonical)) return rejected("transition-order");
  if (!monotonic(modes, canonical)) return rejected("mode-order");
  if (!monotonic(frames, canonical)) return rejected("frame-order");
  if (!monotonic(fences, canonical)) return rejected("fence-order");
  if (!monotonic(enqueues, delivery)) return rejected("enqueue-order");
  if (!monotonic(settlements, delivery)) return rejected("settlement-order");
  for (const [records, reason] of [
    [enqueues, "delivery-revision-order"],
    [settlements, "delivery-revision-order"],
  ]) {
    let previousRevision = -1;
    for (const record of records) {
      const currentRevision = record.terminalDelivery.canonicalRevision;
      if (currentRevision <= previousRevision) return rejected(reason, currentRevision);
      previousRevision = currentRevision;
    }
  }
  const hashesByRevision = new Map();
  for (const record of [...enqueues, ...settlements]) {
    const revision = record.terminalDelivery.canonicalRevision;
    const hash = record.terminalDelivery.canonicalStateHash;
    const prior = hashesByRevision.get(revision);
    if (prior !== undefined && prior !== hash) return rejected("delivery-revision-hash", revision);
    hashesByRevision.set(revision, hash);
  }
  const transitionsByRevision = new Map(transitions.map((record) => [record.revision, record]));
  const latestTransitionRevision = transitions.at(-1)?.revision ?? -1;
  for (const record of modes) {
    const transition = transitionsByRevision.get(record.revision);
    if (
      !transition ||
      transition.stateHash !== record.stateHash ||
      transition.atMicros > record.atMicros
    )
      return rejected("canonical-transition-state", record.revision);
  }
  for (const record of [...frames, ...fences]) {
    const transition = transitionsByRevision.get(record.revision);
    if (
      !transition ||
      transition.stateHash !== record.stateHash ||
      transition.atMicros > record.atMicros ||
      record.acceptedRevision !== record.revision ||
      record.acceptedUpdateType !== transition.updateType
    )
      return rejected(
        "accepted-transition-state",
        Number.isSafeInteger(record?.revision) ? record.revision : null,
        new Set(["terminal.seed", "terminal.patch"]).has(record?.acceptedUpdateType)
          ? record.acceptedUpdateType
          : null,
      );
  }
  for (const record of [...enqueues, ...settlements]) {
    const revision = record.terminalDelivery.canonicalRevision;
    const transition = transitionsByRevision.get(revision);
    if (
      revision <= latestTransitionRevision &&
      (!transition || transition.stateHash !== record.terminalDelivery.canonicalStateHash)
    )
      return rejected("delivery-transition-state", revision);
  }
  for (const record of enqueues) {
    const revision = record.terminalDelivery.canonicalRevision;
    if (revision > latestTransitionRevision) continue;
    const transition = transitionsByRevision.get(revision);
    const expectedRepresentation = transition?.updateType === "terminal.seed" ? "seed" : "patch";
    if (record.terminalDelivery.representation !== expectedRepresentation)
      return rejected("delivery-transition-type", revision, transition?.updateType ?? null);
  }
  for (const record of settlements) {
    const revision = record.terminalDelivery.canonicalRevision;
    if (
      revision <= latestTransitionRevision &&
      record.terminalDelivery.representation !== undefined
    ) {
      const transition = transitionsByRevision.get(revision);
      const expectedRepresentation = transition?.updateType === "terminal.seed" ? "seed" : "patch";
      if (record.terminalDelivery.representation !== expectedRepresentation)
        return rejected("delivery-transition-type", revision, transition?.updateType ?? null);
    }
  }
  const coherentEnqueues = enqueues.filter(
    (record) => record.terminalDelivery.canonicalRevision <= latestTransitionRevision,
  );
  const coherentSettlements = settlements.filter(
    (record) => record.terminalDelivery.canonicalRevision <= latestTransitionRevision,
  );
  const pendingDeliveryCount =
    enqueues.length + settlements.length - coherentEnqueues.length - coherentSettlements.length;
  const framesByRevision = new Map(frames.map((record) => [record.revision, record]));
  for (const fence of fences) {
    const frame = framesByRevision.get(fence.revision);
    if (frame && frame.atMicros > fence.atMicros)
      return rejected("presentation-order", fence.revision);
  }
  const enqueueByOrdinal = new Map(
    enqueues.map((record) => [record.terminalDelivery.deliveryOrdinal, record]),
  );
  for (const settled of settlements) {
    const enqueue = enqueueByOrdinal.get(settled.terminalDelivery.deliveryOrdinal);
    if (
      !enqueue ||
      enqueue.terminalDelivery.canonicalRevision !== settled.terminalDelivery.canonicalRevision ||
      enqueue.terminalDelivery.canonicalStateHash !== settled.terminalDelivery.canonicalStateHash ||
      enqueue.terminalDelivery.transactionId !== settled.terminalDelivery.transactionId ||
      enqueue.endedAtMicros > settled.startedAtMicros
    )
      return rejected("delivery-pair", settled.terminalDelivery.canonicalRevision);
  }
  const latestTransition = transitions.at(-1) ?? null;
  const latestEnqueue = coherentEnqueues.at(-1) ?? null;
  const latestSettled = coherentSettlements.at(-1) ?? null;
  const latestFrame = frames.at(-1) ?? null;
  const latestFence = fences.at(-1) ?? null;
  return Object.freeze({
    exact: true,
    reason: null,
    counts,
    pendingDeliveryCount,
    offendingRevision: null,
    offendingAcceptedType: null,
    progress: Object.freeze({
      canonicalRevision: latestTransition?.revision ?? null,
      enqueueOrdinal: latestEnqueue?.terminalDelivery?.deliveryOrdinal ?? null,
      enqueueCanonicalRevision: latestEnqueue?.terminalDelivery?.canonicalRevision ?? null,
      settledOrdinal: latestSettled?.terminalDelivery?.deliveryOrdinal ?? null,
      settledCanonicalRevision: latestSettled?.terminalDelivery?.canonicalRevision ?? null,
      frameRevision: latestFrame?.revision ?? null,
      fenceRevision: latestFence?.revision ?? null,
    }),
  });
}

export function ansiWorkloadDeliveryAuthorityTail({ daemonRecords, expected }) {
  if (
    !expected ||
    !Array.isArray(daemonRecords) ||
    daemonRecords.length > 65_536 ||
    !boundedIdentity(expected.workspaceName) ||
    !boundedIdentity(expected.semanticPaneId) ||
    !boundedIdentity(expected.generation) ||
    !boundedIdentity(expected.incarnation) ||
    !/^daemon:[1-9][0-9]*$/.test(expected.daemonProcessId ?? "") ||
    expected.daemonClockId !== "node-performance-now" ||
    expected.daemonClockKind !== "performance-now"
  )
    return Object.freeze({
      exact: false,
      enqueues: Object.freeze([]),
      settlements: Object.freeze([]),
    });
  const authorityExact = (record) =>
    record?.processId === expected.daemonProcessId &&
    record?.clockId === expected.daemonClockId &&
    record?.clockKind === expected.daemonClockKind &&
    record?.terminalDelivery?.workspaceName === expected.workspaceName &&
    record?.terminalDelivery?.semanticPaneId === expected.semanticPaneId &&
    record?.terminalDelivery?.canonicalGeneration === expected.generation &&
    record?.terminalDelivery?.canonicalIncarnation === expected.incarnation;
  return Object.freeze({
    exact: true,
    enqueues: Object.freeze(
      daemonRecords.filter(
        (record) =>
          record?.type === "performance.stage" &&
          record.operation === "terminal-delivery-encode-enqueue" &&
          authorityExact(record),
      ),
    ),
    settlements: Object.freeze(
      daemonRecords.filter(
        (record) =>
          record?.type === "performance.stage" &&
          record.operation === "terminal-delivery-settled" &&
          authorityExact(record),
      ),
    ),
  });
}

export function ansiWorkloadDeliveryJoin({ canonical, daemonRecords, expected }) {
  const unavailable = () =>
    Object.freeze({
      exact: false,
      encode: null,
      settled: null,
      enqueueCount: 0,
      settledCount: 0,
      latestEnqueueOrdinal: null,
      latestSettledOrdinal: null,
      enqueues: Object.freeze([]),
      settlements: Object.freeze([]),
    });
  if (
    !canonical ||
    !expected ||
    !Array.isArray(daemonRecords) ||
    daemonRecords.length > 65_536 ||
    !boundedIdentity(expected.workspaceName) ||
    !boundedIdentity(expected.semanticPaneId) ||
    !new Set(["terminal.seed", "terminal.patch"]).has(canonical.updateType) ||
    canonical.semanticPaneId !== expected.semanticPaneId ||
    !/^daemon:[1-9][0-9]*$/.test(expected.daemonProcessId ?? "") ||
    expected.daemonClockId !== "node-performance-now" ||
    expected.daemonClockKind !== "performance-now"
  )
    return unavailable();
  const authority = ansiWorkloadDeliveryAuthorityTail({
    daemonRecords,
    expected: {
      ...expected,
      generation: canonical.generation,
      incarnation: canonical.incarnation,
    },
  });
  if (!authority.exact) return unavailable();
  const { enqueues, settlements } = authority;
  const matches = (record) =>
    record.terminalDelivery.canonicalGeneration === canonical.generation &&
    record.terminalDelivery.canonicalIncarnation === canonical.incarnation &&
    record.terminalDelivery.canonicalRevision === canonical.revision &&
    record.terminalDelivery.canonicalStateHash === canonical.stateHash;
  const encodeMatches = enqueues.filter(matches);
  const settledMatches = settlements.filter(matches);
  const encode = encodeMatches.length === 1 ? encodeMatches[0] : null;
  const settled = settledMatches.length === 1 ? settledMatches[0] : null;
  const expectedRepresentation = canonical.updateType === "terminal.seed" ? "seed" : "patch";
  return Object.freeze({
    exact:
      encode !== null &&
      settled !== null &&
      encode.terminalDelivery.representation === expectedRepresentation &&
      (settled.terminalDelivery.representation === undefined ||
        settled.terminalDelivery.representation === expectedRepresentation) &&
      encode === enqueues.at(-1) &&
      settled === settlements.at(-1) &&
      Number.isSafeInteger(encode.terminalDelivery.deliveryOrdinal) &&
      encode.terminalDelivery.deliveryOrdinal === settled.terminalDelivery.deliveryOrdinal &&
      boundedIdentity(encode.terminalDelivery.transactionId) &&
      encode.terminalDelivery.transactionId === settled.terminalDelivery.transactionId &&
      safeTimestamp(encode.endedAtMicros) &&
      safeTimestamp(settled.startedAtMicros) &&
      encode.endedAtMicros <= settled.startedAtMicros &&
      settled.terminalDelivery.queueDepth === 0 &&
      settled.terminalDelivery.inFlight === 0 &&
      settled.terminalDelivery.inFlightBytes === 0,
    encode,
    settled,
    enqueueCount: Math.min(enqueues.length, 65_537),
    settledCount: Math.min(settlements.length, 65_537),
    latestEnqueueOrdinal: Number.isSafeInteger(enqueues.at(-1)?.terminalDelivery?.deliveryOrdinal)
      ? enqueues.at(-1).terminalDelivery.deliveryOrdinal
      : null,
    latestSettledOrdinal: Number.isSafeInteger(
      settlements.at(-1)?.terminalDelivery?.deliveryOrdinal,
    )
      ? settlements.at(-1).terminalDelivery.deliveryOrdinal
      : null,
    enqueues: Object.freeze(enqueues),
    settlements: Object.freeze(settlements),
  });
}

export function assessAnsiWorkloadFinalitySamples(samples, expected) {
  const sampleKeys = [
    "cycle",
    "markerHmac",
    "payloadBytes",
    "producerStatus",
    "producerOrdinal",
    "producerPayloadHmac",
    "producerBackpressureCount",
    "deliveryBytes",
    "representation",
    "attemptedPatchBytes",
    "attemptedSeedBytes",
    "attemptedLegacyPatchBytes",
    "attemptedLegacySeedBytes",
    "attemptedCompactPatchBytes",
    "attemptedCompactSeedBytes",
    "selectedEncoding",
    "selectionStatus",
    "deliveryOrdinal",
    "deliveryHmac",
    "originCount",
    "canonicalTransitionType",
    "canonicalTransitionCount",
    "frameCount",
    "fenceCount",
    "settledCount",
    "markerCount",
    "finalCursorY",
    "viewportRows",
    "cursorVisible",
    "queueDepth",
    "inFlight",
    "inFlightBytes",
    "stableTailMs",
    "elapsedMs",
    "noProgressElapsedMs",
    "progressCount",
    "absoluteDeadlineMs",
    "noProgressDeadlineMs",
    "laterTransitionCount",
    "laterEnqueueCount",
    "laterPaintCount",
    "authorityIdentityExact",
    "finalityExact",
    "drainExact",
    "faulted",
    "rebound",
  ];
  const expectedKeys = ["cycle", "markerHmac", "payloadBytes", "producerPayloadHmac"];
  if (
    !Array.isArray(samples) ||
    !Array.isArray(expected) ||
    samples.length !== ANSI_WORKLOAD_CYCLE_COUNT ||
    expected.length !== ANSI_WORKLOAD_CYCLE_COUNT
  )
    return Object.freeze({ qualified: false, sampleCount: 0, firstInvalidOrdinal: 1 });
  const markerHmacs = new Set();
  const deliveryHmacs = new Set();
  const deliveryOrdinals = new Set();
  let previousDeliveryOrdinal = 0;
  let firstInvalidOrdinal = null;
  for (let index = 0; index < ANSI_WORKLOAD_CYCLE_COUNT; index += 1) {
    const sample = samples[index];
    const contract = expected[index];
    const exact =
      exactKeys(sample, sampleKeys) &&
      exactKeys(contract, expectedKeys) &&
      sample.cycle === index + 1 &&
      contract.cycle === sample.cycle &&
      SHA256.test(sample.markerHmac) &&
      sample.markerHmac === contract.markerHmac &&
      !markerHmacs.has(sample.markerHmac) &&
      Number.isSafeInteger(sample.payloadBytes) &&
      sample.payloadBytes >= 65_536 &&
      sample.payloadBytes <= 16_777_216 &&
      sample.payloadBytes === contract.payloadBytes &&
      sample.producerStatus === "complete" &&
      sample.producerOrdinal === sample.cycle &&
      SHA256.test(sample.producerPayloadHmac) &&
      sample.producerPayloadHmac === contract.producerPayloadHmac &&
      Number.isSafeInteger(sample.producerBackpressureCount) &&
      sample.producerBackpressureCount >= 0 &&
      sample.producerBackpressureCount <= 8_192 &&
      Number.isSafeInteger(sample.deliveryBytes) &&
      sample.deliveryBytes > 0 &&
      sample.deliveryBytes <= 16_777_216 &&
      ["patch", "seed"].includes(sample.representation) &&
      (sample.attemptedPatchBytes === null ||
        (Number.isSafeInteger(sample.attemptedPatchBytes) &&
          sample.attemptedPatchBytes > 0 &&
          sample.attemptedPatchBytes <= 67_108_864)) &&
      (sample.attemptedSeedBytes === null ||
        (Number.isSafeInteger(sample.attemptedSeedBytes) &&
          sample.attemptedSeedBytes > 0 &&
          sample.attemptedSeedBytes <= 67_108_864)) &&
      ["semantic-v1", "semantic-compact-v1"].includes(sample.selectedEncoding) &&
      [
        sample.attemptedLegacyPatchBytes,
        sample.attemptedLegacySeedBytes,
        sample.attemptedCompactPatchBytes,
        sample.attemptedCompactSeedBytes,
      ].every(
        (bytes) =>
          bytes === null || (Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 67_108_864),
      ) &&
      (sample.selectedEncoding === "semantic-compact-v1"
        ? sample.attemptedCompactPatchBytes === sample.attemptedPatchBytes &&
          sample.attemptedCompactSeedBytes === sample.attemptedSeedBytes
        : sample.attemptedLegacyPatchBytes === sample.attemptedPatchBytes &&
          sample.attemptedLegacySeedBytes === sample.attemptedSeedBytes &&
          (sample.selectionStatus === "legacy-patch-fallback"
            ? sample.attemptedCompactPatchBytes !== null
            : sample.selectionStatus === "legacy-seed-fallback"
              ? sample.attemptedCompactSeedBytes !== null
              : sample.attemptedCompactPatchBytes === null &&
                sample.attemptedCompactSeedBytes === null)) &&
      [
        "patch-preferred",
        "seed-preferred",
        "patch-fallback",
        "direct-seed",
        "legacy-patch-fallback",
        "legacy-seed-fallback",
      ].includes(sample.selectionStatus) &&
      (sample.selectionStatus === "patch-preferred"
        ? sample.representation === "patch" &&
          sample.attemptedPatchBytes === sample.deliveryBytes &&
          (sample.attemptedSeedBytes === null ||
            (sample.attemptedPatchBytes > 524_288 &&
              sample.attemptedPatchBytes <= sample.attemptedSeedBytes))
        : sample.selectionStatus === "patch-fallback"
          ? sample.representation === "patch" &&
            sample.attemptedPatchBytes === sample.deliveryBytes &&
            sample.attemptedSeedBytes > 16_777_216
          : sample.selectionStatus === "direct-seed"
            ? sample.representation === "seed" &&
              sample.attemptedPatchBytes === null &&
              sample.attemptedSeedBytes === sample.deliveryBytes
            : sample.selectionStatus === "legacy-patch-fallback"
              ? sample.selectedEncoding === "semantic-v1" &&
                sample.representation === "patch" &&
                sample.attemptedLegacyPatchBytes === sample.deliveryBytes &&
                (sample.attemptedLegacySeedBytes === null ||
                  sample.attemptedLegacyPatchBytes <= sample.attemptedLegacySeedBytes)
              : sample.selectionStatus === "legacy-seed-fallback"
                ? sample.selectedEncoding === "semantic-v1" &&
                  sample.representation === "seed" &&
                  sample.attemptedLegacySeedBytes === sample.deliveryBytes &&
                  (sample.attemptedLegacyPatchBytes === null ||
                    sample.attemptedLegacySeedBytes < sample.attemptedLegacyPatchBytes)
                : sample.representation === "seed" &&
                  sample.attemptedPatchBytes > 524_288 &&
                  sample.attemptedSeedBytes < sample.attemptedPatchBytes &&
                  sample.attemptedSeedBytes === sample.deliveryBytes) &&
      Number.isSafeInteger(sample.deliveryOrdinal) &&
      sample.deliveryOrdinal > previousDeliveryOrdinal &&
      !deliveryOrdinals.has(sample.deliveryOrdinal) &&
      SHA256.test(sample.deliveryHmac) &&
      !deliveryHmacs.has(sample.deliveryHmac) &&
      sample.originCount === 1 &&
      new Set(["terminal.seed", "terminal.patch"]).has(sample.canonicalTransitionType) &&
      (sample.canonicalTransitionType === "terminal.seed" ? "seed" : "patch") ===
        sample.representation &&
      sample.canonicalTransitionCount >= 1 &&
      sample.canonicalTransitionCount <= 8_192 &&
      sample.frameCount >= 1 &&
      sample.frameCount <= 64 &&
      sample.fenceCount === 1 &&
      Number.isSafeInteger(sample.settledCount) &&
      sample.settledCount >= 1 &&
      sample.settledCount <= 8_192 &&
      sample.markerCount === 1 &&
      sample.finalCursorY === 39 &&
      sample.viewportRows === 40 &&
      sample.cursorVisible === true &&
      sample.queueDepth === 0 &&
      sample.inFlight === 0 &&
      sample.inFlightBytes === 0 &&
      Number.isSafeInteger(sample.stableTailMs) &&
      sample.stableTailMs >= ANSI_WORKLOAD_STABLE_TAIL_MS &&
      sample.stableTailMs <= 6_000 &&
      Number.isSafeInteger(sample.elapsedMs) &&
      sample.elapsedMs >= 0 &&
      sample.elapsedMs < ANSI_WORKLOAD_ABSOLUTE_MS &&
      Number.isSafeInteger(sample.noProgressElapsedMs) &&
      sample.noProgressElapsedMs >= 0 &&
      sample.noProgressElapsedMs < ANSI_WORKLOAD_NO_PROGRESS_MS &&
      Number.isSafeInteger(sample.progressCount) &&
      sample.progressCount >= 1 &&
      sample.progressCount <= 65_536 &&
      sample.absoluteDeadlineMs === ANSI_WORKLOAD_ABSOLUTE_MS &&
      sample.noProgressDeadlineMs === ANSI_WORKLOAD_NO_PROGRESS_MS &&
      sample.laterTransitionCount === 0 &&
      sample.laterEnqueueCount === 0 &&
      sample.laterPaintCount === 0 &&
      sample.authorityIdentityExact === true &&
      sample.finalityExact === true &&
      sample.drainExact === true &&
      sample.faulted === false &&
      sample.rebound === false;
    if (!exact && firstInvalidOrdinal === null) firstInvalidOrdinal = index + 1;
    if (SHA256.test(sample?.markerHmac ?? "")) markerHmacs.add(sample.markerHmac);
    if (Number.isSafeInteger(sample?.deliveryOrdinal)) {
      deliveryOrdinals.add(sample.deliveryOrdinal);
      previousDeliveryOrdinal = sample.deliveryOrdinal;
    }
    if (SHA256.test(sample?.deliveryHmac ?? "")) deliveryHmacs.add(sample.deliveryHmac);
  }
  return Object.freeze({
    qualified: firstInvalidOrdinal === null,
    sampleCount: samples.length,
    firstInvalidOrdinal,
  });
}

export function ansiSemanticBodyProjection(bodyRect) {
  if (
    !exactKeys(bodyRect, [
      "left",
      "firstBodyRow",
      "width",
      "bodyRows",
      "origin",
      "valid",
      "semanticChromeMatches",
    ]) ||
    bodyRect.valid !== true ||
    bodyRect.origin !== "semantic-pane-chrome" ||
    bodyRect.semanticChromeMatches !== 1 ||
    !Number.isSafeInteger(bodyRect.left) ||
    bodyRect.left < 0 ||
    !Number.isSafeInteger(bodyRect.firstBodyRow) ||
    bodyRect.firstBodyRow < 0 ||
    !Number.isSafeInteger(bodyRect.width) ||
    bodyRect.width <= 0 ||
    !Number.isSafeInteger(bodyRect.bodyRows) ||
    bodyRect.bodyRows <= 0
  )
    return null;
  return Object.freeze({
    viewportCols: bodyRect.width,
    viewportRows: bodyRect.bodyRows,
    screenOffsetX: bodyRect.left,
    screenOffsetY: bodyRect.firstBodyRow,
  });
}

export function ansiNativePaneLeaseStatus(rows, expected) {
  const expectedExact =
    exactKeys(expected, ["sessionName", "windowResourceId", "semanticPaneId"]) &&
    boundedIdentity(expected.sessionName) &&
    boundedIdentity(expected.windowResourceId) &&
    boundedIdentity(expected.semanticPaneId);
  const rowsExact =
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.length <= 513 &&
    rows.every(
      (row) =>
        exactKeys(row, [
          "sessionName",
          "nativeWindowId",
          "resourceId",
          "name",
          "active",
          "paneId",
          "semanticPaneId",
          "geometry",
        ]) &&
        exactKeys(row.geometry, ["windowCols", "windowRows", "left", "top", "cols", "rows"]) &&
        boundedIdentity(row.sessionName) &&
        /^@[0-9]+$/u.test(row.nativeWindowId ?? "") &&
        /^%[0-9]+$/u.test(row.paneId ?? "") &&
        boundedIdentity(row.resourceId) &&
        boundedIdentity(row.name) &&
        typeof row.active === "boolean" &&
        boundedIdentity(row.semanticPaneId) &&
        Object.values(row.geometry).every(Number.isSafeInteger) &&
        row.geometry.windowCols > 0 &&
        row.geometry.windowRows > 0 &&
        row.geometry.left >= 0 &&
        row.geometry.top >= 0 &&
        row.geometry.cols > 0 &&
        row.geometry.rows > 0,
    );
  if (!expectedExact || !rowsExact)
    return Object.freeze({ matchCount: null, mappingExact: false, lease: null });
  const matches = rows.filter(
    (row) =>
      row.sessionName === expected.sessionName &&
      `terminal-window.${createHash("sha256").update(row.resourceId).digest("hex").slice(0, 20)}` ===
        expected.windowResourceId &&
      row.semanticPaneId === expected.semanticPaneId &&
      row.active === true,
  );
  const mappingExact = matches.length === 1 && rows.filter(({ active }) => active).length === 1;
  return Object.freeze({
    matchCount: Math.min(matches.length, 513),
    mappingExact,
    lease: mappingExact
      ? Object.freeze({
          paneId: matches[0].paneId,
          nativeWindowId: matches[0].nativeWindowId,
        })
      : null,
  });
}

export function advanceAnsiCanonicalPredecessor(predecessor, qualifiedResult) {
  const origin = qualifiedResult?.raw?.origin;
  const canonical =
    qualifiedResult?.raw?.transition ?? qualifiedResult?.raw?.update ?? qualifiedResult?.raw?.mode;
  if (
    !exactKeys(predecessor, ["revision", "stateHash"]) ||
    !Number.isSafeInteger(predecessor.revision) ||
    predecessor.revision < 0 ||
    !CANONICAL_STATE_HASH.test(predecessor.stateHash ?? "") ||
    qualifiedResult?.qualified !== true ||
    origin?.revision !== predecessor.revision ||
    origin?.stateHash !== predecessor.stateHash ||
    !Number.isSafeInteger(canonical?.revision) ||
    canonical.revision <= predecessor.revision ||
    !CANONICAL_STATE_HASH.test(canonical?.stateHash ?? "")
  )
    return null;
  return Object.freeze({ revision: canonical.revision, stateHash: canonical.stateHash });
}

export function ansiBaselinePreviousCounters(records, currentIndex, expected) {
  const result = (status, reason = null, counters = null) =>
    Object.freeze({ status, reason, counters });
  if (!Array.isArray(records) || records.length > 65_536) return result("invalid", "records-shape");
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex > records.length)
    return result("invalid", "current-index");
  if (
    !boundedIdentity(expected?.processId) ||
    !boundedIdentity(expected?.clockId) ||
    !boundedIdentity(expected?.semanticPaneId) ||
    !boundedIdentity(expected?.generation) ||
    !boundedIdentity(expected?.incarnation) ||
    !Number.isSafeInteger(expected?.sourceEpoch) ||
    expected.sourceEpoch < 0 ||
    !Number.isSafeInteger(expected?.rendererEpoch) ||
    expected.rendererEpoch < 0 ||
    !Number.isSafeInteger(expected?.revision) ||
    expected.revision < 0 ||
    !Number.isSafeInteger(expected?.viewportRows) ||
    expected.viewportRows < 0 ||
    expected.viewportRows > 4_096
  )
    return result("invalid", "expected-shape");
  const sameAuthority = records
    .slice(0, currentIndex)
    .filter(
      (record) =>
        record?.type === "performance.terminal-cursor-presentation" &&
        record.processId === expected.processId &&
        record.clockId === expected.clockId &&
        record.clockKind === "performance-now" &&
        record.semanticPaneId === expected.semanticPaneId &&
        record.generation === expected.generation &&
        record.incarnation === expected.incarnation &&
        record.sourceEpoch === expected.sourceEpoch &&
        record.rendererEpoch === expected.rendererEpoch,
    );
  if (
    sameAuthority.some(
      ({ revision }) =>
        !Number.isSafeInteger(revision) || revision < 0 || revision >= expected.revision,
    )
  )
    return result("invalid", "predecessor-shape");
  if (sameAuthority.length === 0) return result("none");
  const highestRevision = Math.max(...sameAuthority.map(({ revision }) => revision));
  const candidates = sameAuthority.filter(({ revision }) => revision === highestRevision);
  if (candidates.length !== 1) return result("invalid", "duplicate-revision");
  const predecessor = candidates.length === 1 ? candidates[0] : null;
  if (
    !predecessor ||
    !Number.isSafeInteger(predecessor.gridRowsReadTotal) ||
    predecessor.gridRowsReadTotal < 0 ||
    !Number.isSafeInteger(predecessor.fullWalkTotal) ||
    predecessor.fullWalkTotal < 0 ||
    !Number.isSafeInteger(predecessor.presentationCount) ||
    predecessor.presentationCount < 1
  )
    return result("invalid", "counter-shape");
  if (
    !Number.isSafeInteger(predecessor.gridRowsReadTotal + expected.viewportRows) ||
    !Number.isSafeInteger(predecessor.fullWalkTotal + 1) ||
    !Number.isSafeInteger(predecessor.presentationCount + 1)
  )
    return result("invalid", "counter-overflow");
  return result(
    "exact",
    null,
    Object.freeze({
      gridRowsReadTotal: predecessor.gridRowsReadTotal,
      fullWalkTotal: predecessor.fullWalkTotal,
      presentationCount: predecessor.presentationCount,
    }),
  );
}

function boundedCounterDelta(current, previous) {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(previous)) return null;
  const delta = current - previous;
  return Number.isSafeInteger(delta) ? Math.max(-65_536, Math.min(delta, 65_536)) : null;
}

function boundedRowEvidence(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4_096 ? value : null;
}

export function ansiBaselineCursorEvidenceStatus(value, expected) {
  const shapeExact =
    exactKeys(value, ["modes", "presentations"]) &&
    Array.isArray(value.modes) &&
    value.modes.length <= 2 &&
    Array.isArray(value.presentations) &&
    value.presentations.length <= 2 &&
    exactKeys(expected, [
      "processId",
      "clockId",
      "semanticPaneId",
      "generation",
      "incarnation",
      "revision",
      "stateHash",
      "canonicalCols",
      "canonicalRows",
      "viewportCols",
      "viewportRows",
      "screenOffsetX",
      "screenOffsetY",
      "sourceEpoch",
      "rendererEpoch",
      "cursor",
      "alternateScreen",
      "wraparound",
      "mouseProtocol",
      "mouseEncoding",
      "baselinePredecessor",
      "activePaneExact",
      "seedRevisionExact",
      "seedGeometryExact",
      "seedIdentityExact",
    ]) &&
    exactKeys(expected?.cursor, ["x", "y", "hidden", "style", "blink"]) &&
    exactKeys(expected?.baselinePredecessor, ["status", "reason", "counters"]) &&
    (["none", "invalid"].includes(expected.baselinePredecessor.status)
      ? expected.baselinePredecessor.counters === null &&
        (expected.baselinePredecessor.status === "none"
          ? expected.baselinePredecessor.reason === null
          : [
              "records-shape",
              "current-index",
              "expected-shape",
              "predecessor-shape",
              "duplicate-revision",
              "counter-shape",
              "counter-overflow",
            ].includes(expected.baselinePredecessor.reason))
      : expected.baselinePredecessor.status === "exact" &&
        expected.baselinePredecessor.reason === null &&
        exactKeys(expected.baselinePredecessor.counters, [
          "gridRowsReadTotal",
          "fullWalkTotal",
          "presentationCount",
        ]));
  const mode = shapeExact && value.modes.length === 1 ? value.modes[0] : null;
  const presentation =
    shapeExact && value.presentations.length === 1 ? value.presentations[0] : null;
  const timestamp = (candidate) =>
    Number.isSafeInteger(candidate?.atMicros) && candidate.atMicros >= 0;
  const modeLineageExact =
    mode !== null &&
    mode.processId === expected.processId &&
    mode.clockId === expected.clockId &&
    mode.clockKind === "performance-now" &&
    mode.semanticPaneId === expected.semanticPaneId &&
    mode.generation === expected.generation &&
    mode.incarnation === expected.incarnation &&
    mode.revision === expected.revision &&
    mode.stateHash === expected.stateHash &&
    timestamp(mode);
  const modeStateExact =
    mode !== null &&
    mode.alternateScreen === expected.alternateScreen &&
    mode.wraparound === expected.wraparound &&
    mode.mouseProtocol === expected.mouseProtocol &&
    mode.mouseEncoding === expected.mouseEncoding;
  const modeCursorExact =
    mode !== null &&
    mode.cursor?.x === expected.cursor.x &&
    mode.cursor?.y === expected.cursor.y &&
    mode.cursor?.hidden === expected.cursor.hidden &&
    mode.cursor?.style === expected.cursor.style &&
    mode.cursor?.blink === expected.cursor.blink;
  const modeIdentityExact = modeLineageExact && modeStateExact && modeCursorExact;
  const presentationLineageExact =
    presentation !== null &&
    presentation.processId === expected.processId &&
    presentation.clockId === expected.clockId &&
    presentation.clockKind === "performance-now" &&
    presentation.semanticPaneId === expected.semanticPaneId &&
    presentation.generation === expected.generation &&
    presentation.incarnation === expected.incarnation &&
    presentation.revision === expected.revision &&
    presentation.stateHash === expected.stateHash &&
    presentation.sourceEpoch === expected.sourceEpoch &&
    presentation.rendererEpoch === expected.rendererEpoch &&
    timestamp(presentation);
  const presentationCanonicalGeometryExact =
    presentation !== null &&
    presentation.cols === expected.canonicalCols &&
    presentation.rows === expected.canonicalRows;
  const presentationViewportGeometryExact =
    presentation !== null &&
    presentation.viewportCols === expected.viewportCols &&
    presentation.viewportRows === expected.viewportRows;
  const presentationScreenMappingExact =
    presentation !== null &&
    Number.isSafeInteger(presentation.screenX) &&
    Number.isSafeInteger(presentation.screenY) &&
    Number.isSafeInteger(expected.screenOffsetX) &&
    Number.isSafeInteger(expected.screenOffsetY) &&
    presentation.screenX === expected.screenOffsetX + expected.cursor.x + 1 &&
    presentation.screenY === expected.screenOffsetY + expected.cursor.y + 1;
  const presentationGeometryExact =
    presentationCanonicalGeometryExact &&
    presentationViewportGeometryExact &&
    presentationScreenMappingExact;
  const presentationCursorExact =
    presentation !== null &&
    presentation.cursorX === expected.cursor.x &&
    presentation.cursorY === expected.cursor.y &&
    presentation.visible === !expected.cursor.hidden &&
    presentation.style === (expected.cursor.style === "bar" ? "line" : expected.cursor.style) &&
    presentation.blink === expected.cursor.blink;
  const predecessorValid = ["none", "exact"].includes(expected?.baselinePredecessor?.status);
  const predecessorPresent = expected?.baselinePredecessor?.status === "exact";
  const predecessorCounters = predecessorPresent ? expected.baselinePredecessor.counters : null;
  const previousGridRowsReadTotal = predecessorPresent ? predecessorCounters?.gridRowsReadTotal : 0;
  const previousFullWalkTotal = predecessorPresent ? predecessorCounters?.fullWalkTotal : 0;
  const previousPresentationCount = predecessorPresent ? predecessorCounters?.presentationCount : 0;
  const expectedFullWalk = !predecessorPresent;
  const presentationCounterInputExact =
    presentation !== null &&
    predecessorValid &&
    presentation.gridWalked === true &&
    presentation.gridRowsRead === expected.viewportRows &&
    presentation.fullWalk === expectedFullWalk &&
    Number.isSafeInteger(presentation.gridRowsReadTotal) &&
    Number.isSafeInteger(presentation.fullWalkTotal) &&
    Number.isSafeInteger(presentation.presentationCount) &&
    Number.isSafeInteger(previousGridRowsReadTotal) &&
    Number.isSafeInteger(previousFullWalkTotal) &&
    Number.isSafeInteger(previousPresentationCount) &&
    previousGridRowsReadTotal >= 0 &&
    previousFullWalkTotal >= 0 &&
    previousPresentationCount >= 0;
  const presentationCounterExact =
    presentationCounterInputExact &&
    presentation.gridRowsReadTotal === previousGridRowsReadTotal + expected.viewportRows &&
    presentation.fullWalkTotal === previousFullWalkTotal + (expectedFullWalk ? 1 : 0) &&
    presentation.presentationCount === previousPresentationCount + 1;
  const presentationIdentityExact =
    presentationLineageExact &&
    presentationGeometryExact &&
    presentationCursorExact &&
    presentationCounterExact;
  const orderExact =
    mode !== null &&
    presentation !== null &&
    timestamp(mode) &&
    timestamp(presentation) &&
    mode.atMicros <= presentation.atMicros;
  const firstFailedPredicate = !shapeExact
    ? "shapeExact"
    : expected.activePaneExact !== true
      ? "activePaneExact"
      : expected.seedRevisionExact !== true
        ? "seedRevisionExact"
        : expected.seedGeometryExact !== true
          ? "seedGeometryExact"
          : expected.seedIdentityExact !== true
            ? "seedIdentityExact"
            : value.modes.length !== 1
              ? "modeExact"
              : value.presentations.length !== 1
                ? "presentationExact"
                : !modeLineageExact
                  ? "modeLineageExact"
                  : !modeStateExact
                    ? "modeStateExact"
                    : !modeCursorExact
                      ? "modeCursorExact"
                      : !presentationLineageExact
                        ? "presentationLineageExact"
                        : !presentationCanonicalGeometryExact
                          ? "presentationCanonicalGeometryExact"
                          : !presentationViewportGeometryExact
                            ? "presentationViewportGeometryExact"
                            : !presentationScreenMappingExact
                              ? "presentationScreenMappingExact"
                              : !presentationCursorExact
                                ? "presentationCursorExact"
                                : !predecessorValid
                                  ? "predecessorExact"
                                  : !presentationCounterInputExact
                                    ? "presentationCounterInputExact"
                                    : !presentationCounterExact
                                      ? "presentationCounterExact"
                                      : !orderExact
                                        ? "orderExact"
                                        : null;
  return Object.freeze({
    qualified: firstFailedPredicate === null,
    firstFailedPredicate,
    modeCount: shapeExact ? value.modes.length : null,
    presentationCount: shapeExact ? value.presentations.length : null,
    activePaneExact: shapeExact ? expected.activePaneExact === true : false,
    seedRevisionExact: shapeExact ? expected.seedRevisionExact === true : false,
    seedGeometryExact: shapeExact ? expected.seedGeometryExact === true : false,
    seedIdentityExact: shapeExact ? expected.seedIdentityExact === true : false,
    modeLineageExact,
    modeStateExact,
    modeCursorExact,
    modeIdentityExact,
    presentationLineageExact,
    presentationCanonicalGeometryExact,
    presentationViewportGeometryExact,
    presentationScreenMappingExact,
    presentationGeometryExact,
    presentationCursorExact,
    predecessorStatus: shapeExact ? expected.baselinePredecessor.status : null,
    predecessorInvalidReason:
      shapeExact && expected.baselinePredecessor.status === "invalid"
        ? expected.baselinePredecessor.reason
        : null,
    predecessorPresent,
    actualGridRowsRead: boundedRowEvidence(presentation?.gridRowsRead),
    expectedGridRowsRead: boundedRowEvidence(expected?.viewportRows),
    actualFullWalk: typeof presentation?.fullWalk === "boolean" ? presentation.fullWalk : null,
    expectedFullWalk,
    gridRowsReadDelta: boundedCounterDelta(
      presentation?.gridRowsReadTotal,
      previousGridRowsReadTotal,
    ),
    fullWalkDelta: boundedCounterDelta(presentation?.fullWalkTotal, previousFullWalkTotal),
    presentationDelta: boundedCounterDelta(
      presentation?.presentationCount,
      previousPresentationCount,
    ),
    presentationCounterInputExact,
    presentationCounterExact,
    presentationIdentityExact,
    orderExact,
  });
}

function privateHmac(key, domain, value) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32 || !boundedIdentity(value)) return null;
  return createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
}

export function ansiCanonicalPresentationHmac(key, mode, presentation) {
  if (!mode || !presentation) return null;
  return createHmac("sha256", key)
    .update("ansi-presentation\0")
    .update(
      JSON.stringify([
        mode.stateHash,
        mode.alternateScreen,
        mode.cursor.x,
        mode.cursor.y,
        mode.cursor.hidden,
        mode.cursor.style,
        mode.cursor.blink,
        presentation.cursorX,
        presentation.cursorY,
        presentation.visible,
        presentation.style,
        presentation.blink,
      ]),
    )
    .digest("hex");
}

export function ansiPreAlternateNormalStatus(value, expected) {
  const cursorExact =
    value?.stage?.cursor?.x === expected?.cursor?.x &&
    value?.stage?.cursor?.y === expected?.cursor?.y &&
    value?.stage?.cursor?.hidden === expected?.cursor?.hidden &&
    value?.stage?.cursor?.style === expected?.cursor?.style &&
    value?.stage?.cursor?.blink === expected?.cursor?.blink;
  const semanticExact =
    value?.stage?.alternateScreen === false &&
    SHA256.test(value?.stage?.presentationHmac ?? "") &&
    value.stage.presentationHmac === expected?.presentationHmac &&
    SHA256.test(value?.stage?.framebufferHmac ?? "") &&
    value.stage.framebufferHmac === expected?.framebufferHmac &&
    cursorExact;
  const nativeExact =
    value?.nativeGeometryExact === true &&
    SHA256.test(value?.nativeCaptureHmac ?? "") &&
    value.nativeCaptureHmac === expected?.nativeCaptureHmac;
  return Object.freeze({
    qualified: semanticExact && nativeExact,
    semanticExact,
    nativeExact,
    cursorExact,
  });
}

/** Strictly joins one printable-key ingress to its canonical mode, actual cursor, frame and fence. */
export function ansiCursorStageFromRecords({
  records,
  daemonRecords,
  watermark = 0,
  expected,
  evidenceKey,
}) {
  if (
    !Array.isArray(records) ||
    records.length > 100_000 ||
    !Array.isArray(daemonRecords) ||
    daemonRecords.length > 100_000 ||
    !Number.isSafeInteger(watermark) ||
    watermark < 0 ||
    watermark > records.length
  )
    return Object.freeze({ qualified: false, firstFailedPredicate: "recordsBounded" });
  if (
    !new Set([
      "rich-ansi",
      "cursor-next",
      "pre-alternate-normal",
      "enter-alternate",
      "restore-normal",
    ]).has(expected?.action)
  )
    return Object.freeze({ qualified: false, firstFailedPredicate: "actionExact" });
  const tail = records.slice(watermark);
  const origins = tail.filter(
    (record) =>
      record?.type === "performance.input-origin" &&
      record.origin === "keyboard" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === expected?.canonicalGeneration,
  );
  const origin = origins[0];
  const modes = tail.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-mode" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === expected?.canonicalGeneration &&
      record.incarnation === expected?.canonicalIncarnation &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision,
  );
  const mode = modes[0];
  const presentations = tail.filter(
    (record) =>
      record?.type === "performance.terminal-cursor-presentation" &&
      record.traceId === origin?.traceId &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === mode?.generation &&
      record.incarnation === mode?.incarnation &&
      record.revision === mode?.revision &&
      record.stateHash === mode?.stateHash,
  );
  const presentation = presentations[0];
  const framebufferProjections = tail.filter(
    (record) =>
      record?.type === "performance.terminal-framebuffer-projection" &&
      record.traceId === origin?.traceId &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === mode?.generation &&
      record.incarnation === mode?.incarnation &&
      record.revision === mode?.revision &&
      record.stateHash === mode?.stateHash,
  );
  const framebuffer = framebufferProjections[0];
  const frames = tail.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-host-frame" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === mode?.generation &&
      record.incarnation === mode?.incarnation &&
      record.revision === mode?.revision &&
      record.stateHash === mode?.stateHash &&
      record.atMicros >= presentation?.atMicros,
  );
  const frame = frames[0];
  const fences = tail.filter(
    (record) =>
      record?.type === "performance.terminal-frame-fence" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === mode?.generation &&
      record.incarnation === mode?.incarnation &&
      record.revision === mode?.revision &&
      record.stateHash === mode?.stateHash &&
      record.atMicros >= frame?.atMicros,
  );
  const fence = fences[0];
  const stagePresentationCandidates = tail.filter(
    (record) =>
      record?.type === "performance.terminal-cursor-presentation" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === expected?.canonicalGeneration &&
      record.incarnation === expected?.canonicalIncarnation &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision,
  );
  const stageFrameCandidates = tail.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-host-frame" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === expected?.canonicalGeneration &&
      record.incarnation === expected?.canonicalIncarnation &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision,
  );
  const stageFenceCandidates = tail.filter(
    (record) =>
      record?.type === "performance.terminal-frame-fence" &&
      record.semanticPaneId === expected?.semanticPaneId &&
      record.generation === expected?.canonicalGeneration &&
      record.incarnation === expected?.canonicalIncarnation &&
      Number.isSafeInteger(record.revision) &&
      record.revision > expected?.afterRevision,
  );
  const finalMode = modes.at(-1);
  const finalCursor = finalMode?.cursor;
  const stagePredicates = Object.freeze({
    modeCardinalityExact: modes.length === 1,
    tracedCandidateExact: presentations.length === 1,
    presentationCardinalityExact: stagePresentationCandidates.length === 1,
    frameCardinalityExact: stageFrameCandidates.length === 1,
    fenceCardinalityExact: stageFenceCandidates.length === 1,
    finalAlternateExact: finalMode?.alternateScreen === expected?.alternateScreen,
    finalCursorStatePresent:
      typeof finalCursor?.hidden === "boolean" &&
      typeof finalCursor?.blink === "boolean" &&
      new Set(["block", "underline", "bar"]).has(finalCursor?.style),
  });
  const stageEvidence = Object.freeze({
    modeCandidateCount: Math.min(modes.length, 2),
    presentationCandidateCount: Math.min(stagePresentationCandidates.length, 2),
    frameCandidateCount: Math.min(stageFrameCandidates.length, 2),
    fenceCandidateCount: Math.min(stageFenceCandidates.length, 2),
    tracedCandidateExact: stagePredicates.tracedCandidateExact,
    finalAlternateScreen:
      typeof finalMode?.alternateScreen === "boolean" ? finalMode.alternateScreen : null,
    finalCursorVisible: typeof finalCursor?.hidden === "boolean" ? !finalCursor.hidden : null,
    finalCursorBlink: typeof finalCursor?.blink === "boolean" ? finalCursor.blink : null,
    firstFailedStageSubpredicate:
      Object.entries(stagePredicates).find(([, passed]) => !passed)?.[0] ?? null,
  });
  const ordered = expected?.framebufferHmac
    ? [origin, mode, framebuffer, presentation, frame, fence]
    : [origin, mode, presentation, frame, fence];
  const indexes = ordered.map((record) => tail.indexOf(record));
  const upstreamStageDefinitions = ANSI_DAEMON_STAGES.slice(0, 8);
  const daemonStages = upstreamStageDefinitions.map(([operation, stage]) =>
    daemonRecords.filter(
      (record) =>
        record?.type === "performance.stage" &&
        record.traceId === origin?.traceId &&
        record.operation === operation &&
        record.stage === stage,
    ),
  );
  const expectedDeliverySurfaces = expected?.deliverySurfaces;
  const expectedDeliveryClients = expected?.deliveryClients;
  const expectedDeliveryTopology = expected?.deliveryTopology;
  const expectedDeliveryLanes = expectedDeliveryTopology?.lanes;
  const deliverySurfaceContractExact =
    Array.isArray(expectedDeliverySurfaces) &&
    expectedDeliverySurfaces.length >= 1 &&
    expectedDeliverySurfaces.length <= 4 &&
    new Set(expectedDeliverySurfaces).size === expectedDeliverySurfaces.length &&
    expectedDeliverySurfaces.every(
      (surface) => typeof surface === "string" && /^[a-z][a-z0-9-]{0,31}$/u.test(surface),
    ) &&
    expectedDeliveryClients !== null &&
    typeof expectedDeliveryClients === "object" &&
    !Array.isArray(expectedDeliveryClients) &&
    Object.keys(expectedDeliveryClients).length === expectedDeliverySurfaces.length &&
    expectedDeliverySurfaces.every(
      (surface) =>
        typeof expectedDeliveryClients[surface] === "string" &&
        expectedDeliveryClients[surface].length >= 1 &&
        expectedDeliveryClients[surface].length <= 256,
    ) &&
    new Set(Object.values(expectedDeliveryClients)).size === expectedDeliverySurfaces.length;
  const deliveryTopologyContractExact =
    deliverySurfaceContractExact &&
    expectedDeliveryTopology?.exact === true &&
    Number.isSafeInteger(expectedDeliveryTopology?.lifecycleOrdinal) &&
    expectedDeliveryTopology.lifecycleOrdinal >= 1 &&
    Array.isArray(expectedDeliveryLanes) &&
    expectedDeliveryLanes.length >= expectedDeliverySurfaces.length &&
    expectedDeliveryLanes.length <= 16 &&
    new Set(expectedDeliveryLanes.map((lane) => lane?.laneId)).size ===
      expectedDeliveryLanes.length &&
    expectedDeliveryLanes.every(
      (lane) =>
        lane?.purpose === "terminal-surface" &&
        expectedDeliveryClients[lane.surface] === lane.clientId &&
        typeof lane.laneId === "string" &&
        lane.laneId.length >= 1 &&
        lane.laneId.length <= 256 &&
        UUID_V4.test(lane.requestId),
    );
  const currentDeliveryTopology = ansiDeliverySubscriberTopologyStatus({
    records: daemonRecords,
    expected,
  });
  const deliveryTopologyExact =
    deliveryTopologyContractExact &&
    currentDeliveryTopology.exact === true &&
    currentDeliveryTopology.lifecycleOrdinal === expectedDeliveryTopology.lifecycleOrdinal &&
    JSON.stringify(currentDeliveryTopology.lanes) === JSON.stringify(expectedDeliveryLanes);
  const targetDelivery = (record, operation) =>
    record?.type === "performance.stage" &&
    record.traceId === origin?.traceId &&
    record.operation === operation &&
    record.stage === "transport" &&
    record.terminalDelivery?.workspaceName === expected?.deliveryWorkspaceName &&
    record.terminalDelivery?.semanticPaneId === expected?.semanticPaneId &&
    record.terminalDelivery?.canonicalGeneration === expected?.canonicalGeneration &&
    record.terminalDelivery?.canonicalIncarnation === expected?.canonicalIncarnation &&
    record.terminalDelivery?.canonicalRevision === mode?.revision &&
    record.terminalDelivery?.canonicalStateHash === mode?.stateHash;
  const deliveryEnqueues = daemonRecords.filter((record) =>
    targetDelivery(record, "terminal-delivery-encode-enqueue"),
  );
  const deliverySockets = daemonRecords.filter((record) =>
    targetDelivery(record, "pane-stream-socket-send"),
  );
  const deliverySettlements = daemonRecords.filter((record) =>
    targetDelivery(record, "terminal-delivery-settled"),
  );
  const deliveryRecords = [...deliveryEnqueues, ...deliverySockets, ...deliverySettlements];
  const deliveryIdentityShapeExact = deliveryRecords.every((record) => {
    const delivery = record.terminalDelivery;
    return (
      typeof delivery?.deliveryClientId === "string" &&
      delivery.deliveryClientId.length >= 1 &&
      delivery.deliveryClientId.length <= 256 &&
      typeof delivery?.deliverySurface === "string" &&
      deliverySurfaceContractExact &&
      expectedDeliverySurfaces.includes(delivery.deliverySurface) &&
      delivery.deliveryClientId === expectedDeliveryClients[delivery.deliverySurface] &&
      typeof delivery?.deliveryLaneId === "string" &&
      delivery.deliveryLaneId.length >= 1 &&
      delivery.deliveryLaneId.length <= 256 &&
      typeof delivery?.deliveryRequestId === "string" &&
      UUID_V4.test(delivery.deliveryRequestId) &&
      typeof delivery?.deliveryNonce === "string" &&
      delivery.deliveryNonce.length >= 1 &&
      delivery.deliveryNonce.length <= 256 &&
      typeof delivery?.transactionId === "string" &&
      delivery.transactionId.length >= 1 &&
      delivery.transactionId.length <= 256
    );
  });
  const deliveryPartitions = deliveryTopologyContractExact
    ? expectedDeliveryLanes.map((expectedLane) => {
        const enqueues = deliveryEnqueues.filter(
          (record) => record.terminalDelivery.deliveryLaneId === expectedLane.laneId,
        );
        const sockets = deliverySockets.filter(
          (record) => record.terminalDelivery.deliveryLaneId === expectedLane.laneId,
        );
        const settlements = deliverySettlements.filter(
          (record) => record.terminalDelivery.deliveryLaneId === expectedLane.laneId,
        );
        const [enqueue, socket, settled] = [enqueues[0], sockets[0], settlements[0]];
        const identityFields = [
          "deliveryClientId",
          "deliverySurface",
          "deliveryLaneId",
          "deliveryRequestId",
          "deliveryNonce",
          "transactionId",
        ];
        const identityExact =
          identityFields.every(
            (field) =>
              enqueue?.terminalDelivery?.[field] === socket?.terminalDelivery?.[field] &&
              enqueue?.terminalDelivery?.[field] === settled?.terminalDelivery?.[field],
          ) &&
          enqueue?.terminalDelivery?.deliveryClientId === expectedLane.clientId &&
          enqueue?.terminalDelivery?.deliverySurface === expectedLane.surface &&
          enqueue?.terminalDelivery?.deliveryLaneId === expectedLane.laneId &&
          enqueue?.terminalDelivery?.deliveryRequestId === expectedLane.requestId;
        const ordinalExact =
          Number.isSafeInteger(enqueue?.terminalDelivery?.deliveryOrdinal) &&
          enqueue.terminalDelivery.deliveryOrdinal >= 1 &&
          socket?.terminalDelivery?.deliveryOrdinal === enqueue.terminalDelivery.deliveryOrdinal &&
          settled?.terminalDelivery?.deliveryOrdinal === enqueue.terminalDelivery.deliveryOrdinal;
        const orderedExact =
          safeTimestamp(enqueue?.startedAtMicros) &&
          safeTimestamp(enqueue?.endedAtMicros) &&
          safeTimestamp(socket?.startedAtMicros) &&
          safeTimestamp(socket?.endedAtMicros) &&
          safeTimestamp(settled?.startedAtMicros) &&
          safeTimestamp(settled?.endedAtMicros) &&
          enqueue.startedAtMicros <= enqueue.endedAtMicros &&
          enqueue.endedAtMicros <= socket.startedAtMicros &&
          socket.startedAtMicros <= socket.endedAtMicros &&
          socket.endedAtMicros <= settled.startedAtMicros &&
          settled.startedAtMicros <= settled.endedAtMicros;
        return Object.freeze({
          laneId: expectedLane.laneId,
          cardinalityExact:
            enqueues.length === 1 && sockets.length === 1 && settlements.length === 1,
          identityExact,
          ordinalExact,
          orderedExact,
        });
      })
    : [];
  const deliveryFanoutExact =
    deliveryTopologyExact &&
    deliveryEnqueues.length === expectedDeliveryLanes.length &&
    deliverySockets.length === expectedDeliveryLanes.length &&
    deliverySettlements.length === expectedDeliveryLanes.length &&
    deliveryIdentityShapeExact &&
    [
      "deliveryLaneId",
      "deliveryRequestId",
      "deliveryNonce",
      "transactionId",
      "deliveryOrdinal",
    ].every(
      (field) =>
        new Set(deliveryEnqueues.map((record) => record.terminalDelivery[field])).size ===
        expectedDeliveryLanes.length,
    ) &&
    deliveryPartitions.every(
      ({ cardinalityExact, identityExact, ordinalExact, orderedExact }) =>
        cardinalityExact && identityExact && ordinalExact && orderedExact,
    );
  const daemonFlat = [...daemonStages.flat(), ...deliveryRecords];
  const daemonProcesses = new Set(daemonFlat.map(({ processId }) => processId));
  const daemonClocks = new Set(daemonFlat.map(({ clockId }) => clockId));
  const [callback, ingress, raw, controlWrite, accepted, output, parse, reduce] =
    daemonStages.flat();
  const daemonCardinalityExact = daemonStages.every((matches) => matches.length === 1);
  const expectedDaemonPid = DAEMON_PROCESS_ID.exec(expected?.daemonProcessId ?? "")?.[1];
  const daemonProcessExact =
    daemonFlat.length === upstreamStageDefinitions.length + expectedDeliveryLanes?.length * 3 &&
    daemonProcesses.size === 1 &&
    expectedDaemonPid !== undefined &&
    Number.isSafeInteger(Number(expectedDaemonPid)) &&
    daemonFlat.every((record) => record.processId === expected.daemonProcessId);
  const daemonClockExact =
    daemonFlat.length === upstreamStageDefinitions.length + expectedDeliveryLanes?.length * 3 &&
    daemonClocks.size === 1 &&
    expected?.daemonClockId === "node-performance-now" &&
    daemonFlat.every((record) => record.clockId === expected.daemonClockId);
  const daemonClockKindExact = daemonFlat.every((record) => record.clockKind === "performance-now");
  const daemonAuthorityClassMaskExact = daemonFlat.every(
    (record) =>
      record.authority?.generation === expected?.canonicalGeneration &&
      (ANSI_DAEMON_NULL_INCARNATION_OPERATIONS.has(record.operation)
        ? record.authority?.incarnation === null
        : record.authority?.incarnation === expected?.canonicalIncarnation),
  );
  const daemonTimestampExact = daemonFlat.every(
    (record) =>
      safeTimestamp(record.startedAtMicros) &&
      safeTimestamp(record.endedAtMicros) &&
      record.startedAtMicros <= record.endedAtMicros,
  );
  const daemonOrderExact =
    callback?.endedAtMicros <= ingress?.startedAtMicros &&
    ingress?.endedAtMicros <= raw?.startedAtMicros &&
    raw?.endedAtMicros <= controlWrite?.startedAtMicros &&
    controlWrite?.endedAtMicros <= accepted?.startedAtMicros &&
    accepted?.endedAtMicros <= output?.startedAtMicros &&
    output?.endedAtMicros <= parse?.startedAtMicros &&
    parse?.startedAtMicros <= parse?.endedAtMicros &&
    parse?.endedAtMicros <= reduce?.startedAtMicros &&
    reduce?.startedAtMicros <= reduce?.endedAtMicros &&
    deliveryPartitions.every(
      ({ laneId, orderedExact }) =>
        orderedExact &&
        reduce?.endedAtMicros <=
          deliveryEnqueues.find((record) => record.terminalDelivery.deliveryLaneId === laneId)
            ?.startedAtMicros,
    );
  const daemonScenarioExact = daemonFlat.every(
    (record) => record.scenario === "terminal-input-to-paint" && record.traceId === origin?.traceId,
  );
  const daemonPredicates = Object.freeze({
    deliveryTopologyExact,
    cardinalityExact: daemonCardinalityExact && deliveryFanoutExact,
    deliveryFanoutExact,
    processExact: daemonProcessExact,
    clockExact: daemonClockExact,
    clockKindExact: daemonClockKindExact,
    authorityClassMaskExact: daemonAuthorityClassMaskExact,
    timestampExact: daemonTimestampExact,
    scenarioExact: daemonScenarioExact,
    orderExact: daemonOrderExact,
  });
  const firstFailedDaemonPredicate =
    Object.entries(daemonPredicates).find(([, passed]) => !passed)?.[0] ?? null;
  const daemonEvidence = Object.freeze({
    stageCountVector: Object.freeze([
      ...daemonStages.map((matches) => Math.min(matches.length, 2)),
      Math.min(deliveryEnqueues.length, 5),
      Math.min(deliverySockets.length, 5),
      Math.min(deliverySettlements.length, 5),
    ]),
    deliveryLaneCount: Math.min(currentDeliveryTopology.lanes.length, 17),
    ...daemonPredicates,
    firstFailedDaemonPredicate,
  });
  const daemonExact = firstFailedDaemonPredicate === null;
  const predicates = Object.freeze({
    inputExact:
      origins.length === 1 &&
      origin?.processId === expected?.processId &&
      origin?.clockId === expected?.clockId &&
      origin?.clockKind === "performance-now" &&
      origin?.incarnation === expected?.canonicalIncarnation &&
      origin?.revision === expected?.afterRevision &&
      origin?.stateHash === expected?.priorStateHash &&
      CANONICAL_STATE_HASH.test(origin?.stateHash ?? "") &&
      UUID_V4.test(origin?.traceId ?? "") &&
      origin?.payloadByteCount === 1 &&
      origin?.parserConsumption === "keyboard-event",
    modeExact:
      modes.length === 1 &&
      mode?.alternateScreen === expected?.alternateScreen &&
      mode?.processId === expected?.processId &&
      mode?.clockId === expected?.clockId &&
      mode?.clockKind === "performance-now" &&
      CANONICAL_STATE_HASH.test(mode?.stateHash ?? ""),
    presentationExact:
      presentations.length === 1 &&
      presentation?.processId === expected?.processId &&
      presentation?.clockId === expected?.clockId &&
      presentation?.clockKind === "performance-now" &&
      presentation?.sourceEpoch === expected?.sourceEpoch &&
      presentation?.rendererEpoch === expected?.rendererEpoch &&
      presentation?.cols === expected?.canonicalCols &&
      presentation?.rows === expected?.canonicalRows &&
      presentation?.gridWalked === expected?.gridWalked &&
      presentation?.gridRowsRead === expected?.gridRowsRead &&
      presentation?.fullWalk === expected?.fullWalk &&
      presentation?.gridWalked === presentation?.gridRowsRead > 0 &&
      Number.isSafeInteger(presentation?.gridRowsRead) &&
      presentation.gridRowsRead >= 0 &&
      presentation.gridRowsRead <= expected?.viewportRows &&
      (presentation.fullWalk !== true || presentation.gridRowsRead === expected?.viewportRows) &&
      presentation?.visible === !mode?.cursor?.hidden &&
      presentation?.cursorX === mode?.cursor?.x &&
      presentation?.cursorY === mode?.cursor?.y &&
      presentation?.style === (mode?.cursor?.style === "bar" ? "line" : mode?.cursor?.style) &&
      presentation?.blink === mode?.cursor?.blink &&
      presentation?.viewportCols === expected?.viewportCols &&
      presentation?.viewportRows === expected?.viewportRows &&
      presentation?.screenX === expected?.screenOffsetX + presentation.cursorX + 1 &&
      presentation?.screenY === expected?.screenOffsetY + presentation.cursorY + 1 &&
      Number.isSafeInteger(presentation?.gridRowsReadTotal) &&
      Number.isSafeInteger(presentation?.fullWalkTotal) &&
      Number.isSafeInteger(presentation?.presentationCount) &&
      presentation.gridRowsReadTotal ===
        expected?.previousCounters?.gridRowsReadTotal + presentation.gridRowsRead &&
      presentation.fullWalkTotal ===
        expected?.previousCounters?.fullWalkTotal + (presentation.fullWalk === true ? 1 : 0) &&
      presentation.presentationCount === expected?.previousCounters?.presentationCount + 1,
    framebufferExact:
      expected?.framebufferHmac === null
        ? framebufferProjections.length === 0
        : framebufferProjections.length === 1 &&
          framebuffer?.processId === expected?.processId &&
          framebuffer?.clockId === expected?.clockId &&
          framebuffer?.clockKind === "performance-now" &&
          framebuffer?.sourceEpoch === expected?.sourceEpoch &&
          framebuffer?.rendererEpoch === expected?.rendererEpoch &&
          framebuffer?.cols === expected?.canonicalCols &&
          framebuffer?.rows === expected?.canonicalRows &&
          framebuffer?.projectionHmac === expected?.framebufferHmac &&
          framebuffer?.cellCount === expected?.framebufferCellCount &&
          framebuffer?.wideContinuationCount === expected?.framebufferWideContinuationCount &&
          framebuffer?.combiningCount === expected?.framebufferCombiningCount &&
          framebuffer?.styledCellCount === expected?.framebufferStyledCellCount,
    frameExact:
      frames.length === 1 &&
      frame?.processId === expected?.processId &&
      frame?.clockId === expected?.clockId &&
      frame?.clockKind === "performance-now" &&
      frame?.sourceEpoch === expected?.sourceEpoch &&
      frame?.rendererEpoch === expected?.rendererEpoch &&
      frame?.cols === expected?.canonicalCols &&
      frame?.rows === expected?.canonicalRows &&
      frame?.viewportCols === expected?.viewportCols &&
      frame?.viewportRows === expected?.viewportRows &&
      frame?.acceptedUpdateType === "terminal.patch" &&
      frame?.acceptedRevision === mode?.revision,
    fenceExact:
      fences.length === 1 &&
      fence?.processId === expected?.processId &&
      fence?.clockId === expected?.clockId &&
      fence?.clockKind === "performance-now" &&
      fence?.daemonGeneration === expected?.daemonGeneration &&
      fence?.sourceEpoch === expected?.sourceEpoch &&
      fence?.rendererEpoch === expected?.rendererEpoch &&
      fence?.cols === expected?.canonicalCols &&
      fence?.rows === expected?.canonicalRows &&
      fence?.viewportCols === expected?.viewportCols &&
      fence?.viewportRows === expected?.viewportRows &&
      fence?.acceptedUpdateType === "terminal.patch" &&
      fence?.acceptedRevision === mode?.revision &&
      fence?.writerHealth?.droppedRecords === 0 &&
      fence?.writerHealth?.oversizedRecords === 0 &&
      fence?.writerHealth?.failed === false &&
      fence?.writerHealth?.pendingCriticalRecords === 0,
    orderExact:
      indexes.every((index) => index >= 0) &&
      indexes.every((index, offset) => offset === 0 || index > indexes[offset - 1]) &&
      safeTimestamp(origin?.atMicros) &&
      safeTimestamp(mode?.atMicros) &&
      (!expected?.framebufferHmac || safeTimestamp(framebuffer?.atMicros)) &&
      safeTimestamp(presentation?.atMicros) &&
      safeTimestamp(frame?.atMicros) &&
      safeTimestamp(fence?.atMicros) &&
      origin.atMicros <= mode.atMicros &&
      (!expected?.framebufferHmac || mode.atMicros <= framebuffer.atMicros) &&
      (!expected?.framebufferHmac || framebuffer.atMicros <= presentation.atMicros) &&
      mode.atMicros <= presentation.atMicros &&
      presentation.atMicros <= frame.atMicros &&
      frame.atMicros <= fence.atMicros,
    daemonExact,
  });
  const firstFailedPredicate =
    Object.entries(predicates).find(([, passed]) => !passed)?.[0] ?? null;
  if (firstFailedPredicate)
    return Object.freeze({
      qualified: false,
      firstFailedPredicate,
      predicates,
      daemonEvidence,
      stageEvidence,
    });
  const presentationHmac = ansiCanonicalPresentationHmac(evidenceKey, mode, presentation);
  const identity = (record) =>
    Object.freeze({
      processHmac: privateHmac(evidenceKey, "process", record.processId),
      clockId: record.clockId,
      clockKind: record.clockKind,
      paneHmac: privateHmac(evidenceKey, "pane", record.semanticPaneId),
      generationHmac: privateHmac(evidenceKey, "generation", record.generation),
      incarnationHmac: privateHmac(evidenceKey, "incarnation", record.incarnation),
      revision: record.revision,
      stateHmac: privateHmac(evidenceKey, "state", record.stateHash),
      presentationHmac,
      canonicalCols: record.cols,
      canonicalRows: record.rows,
      viewportCols: record.viewportCols,
      viewportRows: record.viewportRows,
      sourceEpoch: record.sourceEpoch,
      rendererEpoch: record.rendererEpoch,
    });
  const presentationIdentity = identity(presentation);
  const frameIdentity = identity(frame);
  const fenceIdentity = identity(fence);
  const stage = Object.freeze({
    ...presentationIdentity,
    alternateScreen: mode.alternateScreen,
    cursor: Object.freeze({
      x: presentation.cursorX,
      y: presentation.cursorY,
      hidden: !presentation.visible,
      style: presentation.style,
      blink: presentation.blink,
    }),
    framebufferHmac: expected.framebufferHmac,
    framebufferCellCount: expected.framebufferCellCount,
    framebufferWideContinuationCount: expected.framebufferWideContinuationCount,
    framebufferCombiningCount: expected.framebufferCombiningCount,
    framebufferStyledCellCount: expected.framebufferStyledCellCount,
    gridRowsReadTotal: presentation.gridRowsReadTotal,
    fullWalkTotal: presentation.fullWalkTotal,
    presentationCount: presentation.presentationCount,
  });
  return Object.freeze({
    qualified: true,
    firstFailedPredicate: null,
    predicates,
    daemonEvidence,
    stageEvidence,
    stage,
    sample: Object.freeze({
      startedAtMicros: origin.atMicros,
      presentedAtMicros: presentation.atMicros,
      frameAtMicros: frame.atMicros,
      fenceAtMicros: fence.atMicros,
      durationMicros: fence.atMicros - origin.atMicros,
      traceHmac: privateHmac(evidenceKey, "trace", origin.traceId),
      gestureHmac: privateHmac(evidenceKey, "gesture", origin.traceId),
      causal: Object.freeze({
        dirtyRows: Object.freeze([]),
        gridRowsReadDelta:
          presentation.gridRowsReadTotal - expected.previousCounters.gridRowsReadTotal,
        fullWalkDelta: presentation.fullWalkTotal - expected.previousCounters.fullWalkTotal,
        presentationCountDelta:
          presentation.presentationCount - expected.previousCounters.presentationCount,
        inputAccepted: predicates.inputExact && daemonExact,
        canonicalReceiptExact: predicates.modeExact && predicates.presentationExact,
        daemonStageCount: ANSI_DAEMON_STAGES.length,
        daemonProcessHmac: privateHmac(evidenceKey, "daemon-process", daemonFlat[0].processId),
        daemonClockId: daemonFlat[0].clockId,
      }),
      action: expected.action,
      cursor: Object.freeze({
        x: mode.cursor.x,
        y: mode.cursor.y,
        hidden: mode.cursor.hidden,
        canonicalStyle: mode.cursor.style,
        rendererStyle: presentation.style,
        blink: mode.cursor.blink,
      }),
      presentation: Object.freeze({
        ...presentationIdentity,
        gridWalked: presentation.gridWalked,
        gridRowsRead: presentation.gridRowsRead,
        fullWalk: presentation.fullWalk,
        gridRowsReadTotal: presentation.gridRowsReadTotal,
        fullWalkTotal: presentation.fullWalkTotal,
        presentationCount: presentation.presentationCount,
      }),
      frame: frameIdentity,
      fence: fenceIdentity,
    }),
    writerHealth: fence.writerHealth,
    raw: Object.freeze({
      mode,
      presentation,
      frame,
      fence,
      origin,
      deliveryTopology: expectedDeliveryTopology,
    }),
    counters: Object.freeze({
      gridRowsReadTotal: presentation.gridRowsReadTotal,
      fullWalkTotal: presentation.fullWalkTotal,
      presentationCount: presentation.presentationCount,
    }),
  });
}

function exactIdentity(value, expected) {
  return (
    SHA256.test(value?.processHmac ?? "") &&
    value.processHmac === expected?.processHmac &&
    value?.clockId === expected?.clockId &&
    value?.clockKind === "performance-now" &&
    value.clockKind === expected?.clockKind &&
    SHA256.test(value?.paneHmac ?? "") &&
    value.paneHmac === expected?.paneHmac &&
    SHA256.test(value?.generationHmac ?? "") &&
    value.generationHmac === expected?.generationHmac &&
    SHA256.test(value?.incarnationHmac ?? "") &&
    value.incarnationHmac === expected?.incarnationHmac &&
    Number.isSafeInteger(value?.revision) &&
    value.revision >= 0 &&
    SHA256.test(value?.stateHmac ?? "") &&
    value.stateHmac === expected?.stateHmac &&
    SHA256.test(value?.presentationHmac ?? "") &&
    value.presentationHmac === expected?.presentationHmac &&
    Number.isSafeInteger(value?.canonicalCols) &&
    value.canonicalCols > 0 &&
    value.canonicalCols === expected?.canonicalCols &&
    Number.isSafeInteger(value?.canonicalRows) &&
    value.canonicalRows > 0 &&
    value.canonicalRows === expected?.canonicalRows &&
    Number.isSafeInteger(value?.viewportCols) &&
    value.viewportCols > 0 &&
    value.viewportCols === expected?.viewportCols &&
    Number.isSafeInteger(value?.viewportRows) &&
    value.viewportRows > 0 &&
    value.viewportRows === expected?.viewportRows &&
    Number.isSafeInteger(value?.sourceEpoch) &&
    value.sourceEpoch >= 0 &&
    value.sourceEpoch === expected?.sourceEpoch &&
    Number.isSafeInteger(value?.rendererEpoch) &&
    value.rendererEpoch >= 0 &&
    value.rendererEpoch === expected?.rendererEpoch &&
    value.revision === expected?.revision
  );
}

function percentile(sorted, percentileValue) {
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)] ?? null;
}

function theilSen(values) {
  const slopes = [];
  for (let left = 0; left < values.length; left += 1)
    for (let right = left + 1; right < values.length; right += 1)
      slopes.push((values[right] - values[left]) / (right - left));
  slopes.sort((left, right) => left - right);
  return slopes.length === 0 ? null : slopes[Math.floor(slopes.length / 2)];
}

export function assessAnsiQuiescentResourceSamples(samples, expectedSamples) {
  if (!Array.isArray(samples) || samples.length !== RESOURCE_ENDPOINT_COUNT)
    return Object.freeze({
      qualified: false,
      sampleCount: Array.isArray(samples) ? samples.length : 0,
      firstInvalidEndpointOrdinal: null,
      firstInvalidPredicate: "endpoint-cardinality",
    });
  const ordinals = new Set();
  const fences = new Set();
  const daemonTraces = new Set();
  const daemonProcesses = new Set();
  const daemonClocks = new Set();
  let previousAtMicros = -1;
  let previousDaemonEndedAtMicros = -1;
  let exact = true;
  let firstInvalidEndpointOrdinal = null;
  let firstInvalidPredicate = null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const expected = expectedSamples?.[index];
    const sampleExact =
      exactKeys(expected, [
        "endpointOrdinal",
        "sampleOrdinal",
        "fenceHmac",
        "markerHmac",
        "processHmac",
        "clockId",
        "fenceAtMicros",
        "daemonTraceHmac",
        "daemonProcessHmac",
        "daemonClockId",
      ]) &&
      exactKeys(sample, [
        "endpointOrdinal",
        "sampleOrdinal",
        "fenceHmac",
        "markerHmac",
        "processHmac",
        "clockId",
        "clockKind",
        "atMicros",
        "inputPending",
        "inputInFlight",
        "inputPendingBytes",
        "daemonTraceHmac",
        "daemonProcessHmac",
        "daemonClockId",
        "daemonClockKind",
        "daemonStartedAtMicros",
        "daemonEndedAtMicros",
        "representationCacheBytes",
        "rawJournalBytes",
        "deliveryQueueDepth",
        "deliveryMaxQueueDepth",
        "deliveryInFlight",
        "deliveryInFlightBytes",
        "rssBytes",
        "heapUsedBytes",
        "eventLoopDelayMicros",
      ]) &&
      sample?.endpointOrdinal === index + 1 &&
      expected?.endpointOrdinal === index + 1 &&
      Number.isSafeInteger(sample?.sampleOrdinal) &&
      sample.sampleOrdinal === expected?.sampleOrdinal &&
      sample.sampleOrdinal >= 1 &&
      sample.sampleOrdinal <= 512 &&
      !ordinals.has(sample.sampleOrdinal) &&
      SHA256.test(sample?.fenceHmac ?? "") &&
      !fences.has(sample.fenceHmac) &&
      sample.fenceHmac === expected?.fenceHmac &&
      SHA256.test(sample?.markerHmac ?? "") &&
      sample.markerHmac === expected?.markerHmac &&
      SHA256.test(sample?.processHmac ?? "") &&
      sample.processHmac === expected?.processHmac &&
      sample?.clockId === expected?.clockId &&
      sample?.clockKind === "performance-now" &&
      safeTimestamp(sample?.atMicros) &&
      safeTimestamp(expected?.fenceAtMicros) &&
      sample.atMicros >= expected.fenceAtMicros &&
      sample.atMicros > previousAtMicros &&
      sample?.inputPending === 0 &&
      sample?.inputInFlight === 0 &&
      sample?.inputPendingBytes === 0 &&
      SHA256.test(sample?.daemonTraceHmac ?? "") &&
      !daemonTraces.has(sample.daemonTraceHmac) &&
      sample.daemonTraceHmac === expected?.daemonTraceHmac &&
      SHA256.test(sample?.daemonProcessHmac ?? "") &&
      sample.daemonProcessHmac === expected?.daemonProcessHmac &&
      boundedIdentity(sample?.daemonClockId) &&
      sample.daemonClockId === expected?.daemonClockId &&
      sample?.daemonClockKind === "performance-now" &&
      safeTimestamp(sample?.daemonStartedAtMicros) &&
      safeTimestamp(sample?.daemonEndedAtMicros) &&
      sample.daemonStartedAtMicros <= sample.daemonEndedAtMicros &&
      sample.daemonStartedAtMicros > previousDaemonEndedAtMicros &&
      Number.isSafeInteger(sample?.representationCacheBytes) &&
      sample.representationCacheBytes >= 0 &&
      sample.representationCacheBytes <= 16_777_216 &&
      Number.isSafeInteger(sample?.rawJournalBytes) &&
      sample.rawJournalBytes >= 0 &&
      sample.rawJournalBytes <= 4_194_304 &&
      Number.isSafeInteger(sample?.deliveryQueueDepth) &&
      sample.deliveryQueueDepth >= 0 &&
      sample.deliveryQueueDepth <= 64 &&
      Number.isSafeInteger(sample?.deliveryMaxQueueDepth) &&
      sample.deliveryMaxQueueDepth >= sample.deliveryQueueDepth &&
      sample.deliveryMaxQueueDepth <= 64 &&
      sample?.deliveryQueueDepth === 0 &&
      sample?.deliveryInFlight === 0 &&
      sample?.deliveryInFlightBytes === 0 &&
      Number.isSafeInteger(sample?.rssBytes) &&
      sample.rssBytes >= 0 &&
      sample.rssBytes <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
      Number.isSafeInteger(sample?.heapUsedBytes) &&
      sample.heapUsedBytes >= 0 &&
      sample.heapUsedBytes <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES &&
      Number.isSafeInteger(sample?.eventLoopDelayMicros) &&
      sample.eventLoopDelayMicros >= 0 &&
      sample.eventLoopDelayMicros <= ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS;
    exact &&= sampleExact;
    if (!sampleExact && firstInvalidEndpointOrdinal === null) {
      firstInvalidEndpointOrdinal = index + 1;
      firstInvalidPredicate = "endpoint-shape-or-authority";
    }
    if (Number.isSafeInteger(sample?.sampleOrdinal)) ordinals.add(sample.sampleOrdinal);
    if (SHA256.test(sample?.fenceHmac ?? "")) fences.add(sample.fenceHmac);
    if (SHA256.test(sample?.daemonTraceHmac ?? "")) daemonTraces.add(sample.daemonTraceHmac);
    if (safeTimestamp(sample?.atMicros)) previousAtMicros = sample.atMicros;
    if (safeTimestamp(sample?.daemonEndedAtMicros))
      previousDaemonEndedAtMicros = sample.daemonEndedAtMicros;
    if (SHA256.test(sample?.daemonProcessHmac ?? "")) daemonProcesses.add(sample.daemonProcessHmac);
    if (boundedIdentity(sample?.daemonClockId)) daemonClocks.add(sample.daemonClockId);
  }
  const rss = samples.map(({ rssBytes }) => rssBytes);
  const heap = samples.map(({ heapUsedBytes }) => heapUsedBytes);
  const rssSlope = exact ? theilSen(rss) : null;
  const heapSlope = exact ? theilSen(heap) : null;
  const rssGrowth = exact ? Math.max(0, rss.at(-1) - rss[0]) : null;
  const heapGrowth = exact ? Math.max(0, heap.at(-1) - heap[0]) : null;
  const rssPeak = exact ? Math.max(...rss) : null;
  const heapPeak = exact ? Math.max(...heap) : null;
  if (exact && rssGrowth > 67_108_864) firstInvalidPredicate = "rss-growth";
  else if (exact && heapGrowth > 33_554_432) firstInvalidPredicate = "heap-growth";
  else if (exact && rssPeak > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES)
    firstInvalidPredicate = "rss-absolute-cap";
  else if (exact && heapPeak > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES)
    firstInvalidPredicate = "heap-absolute-cap";
  const qualified =
    exact &&
    fences.size === RESOURCE_ENDPOINT_COUNT &&
    daemonTraces.size === RESOURCE_ENDPOINT_COUNT &&
    daemonProcesses.size === 1 &&
    daemonClocks.size === 1 &&
    rssGrowth <= 67_108_864 &&
    heapGrowth <= 33_554_432 &&
    rssPeak <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
    heapPeak <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES;
  return Object.freeze({
    qualified,
    sampleCount: samples.length,
    rssSlopeBytesPerSample: rssSlope,
    heapSlopeBytesPerSample: heapSlope,
    rssGrowthBytes: rssGrowth,
    heapGrowthBytes: heapGrowth,
    rssPeakBytes: rssPeak,
    heapPeakBytes: heapPeak,
    firstInvalidEndpointOrdinal,
    firstInvalidPredicate: qualified ? null : firstInvalidPredicate,
  });
}

export function assessAnsiIdleRetainedResourceSamples(samples, timing) {
  const countExact = Array.isArray(samples) && samples.length === 8;
  let exact = countExact;
  let firstInvalidOrdinal = countExact ? null : 1;
  let firstInvalidPredicate = countExact ? null : "idle-retained-cardinality";
  let previousAtMicros = -1;
  const timingExact =
    safeTimestamp(timing?.fenceAtMicros) &&
    safeTimestamp(timing?.endpointAtMicros) &&
    timing.endpointAtMicros >= timing.fenceAtMicros + 9_800_000 &&
    timing.endpointAtMicros <= timing.fenceAtMicros + 10_200_000;
  if (!timingExact) {
    exact = false;
    firstInvalidPredicate = "idle-retained-window";
  }
  for (let index = 0; countExact && index < samples.length; index += 1) {
    const sample = samples[index];
    const cadence = index === 0 ? null : sample?.atMicros - previousAtMicros;
    const shapeExact =
      exactKeys(sample, [
        "ordinal",
        "atMicros",
        "rssBytes",
        "heapUsedBytes",
        "inputPending",
        "inputInFlight",
        "inputPendingBytes",
      ]) &&
      sample?.ordinal === index + 1 &&
      safeTimestamp(sample?.atMicros) &&
      sample.atMicros > previousAtMicros &&
      sample.atMicros > timing?.fenceAtMicros &&
      sample.atMicros < timing?.endpointAtMicros &&
      (index !== 0 ||
        (sample.atMicros >= timing.fenceAtMicros + 1_800_000 &&
          sample.atMicros <= timing.fenceAtMicros + 2_200_000)) &&
      (index !== 7 ||
        (sample.atMicros >= timing.fenceAtMicros + 8_800_000 &&
          sample.atMicros <= timing.fenceAtMicros + 9_200_000)) &&
      (index === 0 || (cadence >= 900_000 && cadence <= 1_100_000)) &&
      Number.isSafeInteger(sample?.rssBytes) &&
      sample.rssBytes >= 0 &&
      Number.isSafeInteger(sample?.heapUsedBytes) &&
      sample.heapUsedBytes >= 0 &&
      sample?.inputPending === 0 &&
      sample?.inputInFlight === 0 &&
      sample?.inputPendingBytes === 0;
    if (!shapeExact && firstInvalidOrdinal === null) {
      firstInvalidOrdinal = index + 1;
      firstInvalidPredicate =
        sample?.ordinal !== index + 1
          ? "idle-retained-ordinal"
          : !safeTimestamp(sample?.atMicros) ||
              sample.atMicros <= previousAtMicros ||
              (index > 0 && (cadence < 900_000 || cadence > 1_100_000))
            ? "idle-retained-cadence"
            : sample.atMicros <= timing?.fenceAtMicros ||
                sample.atMicros >= timing?.endpointAtMicros ||
                (index === 0 &&
                  (sample.atMicros < timing.fenceAtMicros + 1_800_000 ||
                    sample.atMicros > timing.fenceAtMicros + 2_200_000)) ||
                (index === 7 &&
                  (sample.atMicros < timing.fenceAtMicros + 8_800_000 ||
                    sample.atMicros > timing.fenceAtMicros + 9_200_000))
              ? "idle-retained-window"
              : sample?.inputPending !== 0 ||
                  sample?.inputInFlight !== 0 ||
                  sample?.inputPendingBytes !== 0
                ? "idle-retained-queue"
                : "idle-retained-endpoint";
    }
    exact &&= shapeExact;
    if (safeTimestamp(sample?.atMicros)) previousAtMicros = sample.atMicros;
  }
  const rss = exact ? samples.map(({ rssBytes }) => rssBytes) : [];
  const heap = exact ? samples.map(({ heapUsedBytes }) => heapUsedBytes) : [];
  const rssSlope = exact ? theilSen(rss) : null;
  const heapSlope = exact ? theilSen(heap) : null;
  const rssGrowth = exact ? rss.at(-1) - rss[0] : null;
  const heapGrowth = exact ? heap.at(-1) - heap[0] : null;
  const rssHigh = exact ? Math.max(...rss) : null;
  const heapHigh = exact ? Math.max(...heap) : null;
  if (exact && rssSlope > 262_144) firstInvalidPredicate = "rss-slope";
  else if (exact && heapSlope > 131_072) firstInvalidPredicate = "heap-slope";
  else if (exact && rssGrowth > 67_108_864) firstInvalidPredicate = "idle-retained-rss-growth";
  else if (exact && heapGrowth > 33_554_432) firstInvalidPredicate = "idle-retained-heap-growth";
  else if (exact && rssHigh > ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES)
    firstInvalidPredicate = "idle-retained-rss-high";
  else if (exact && heapHigh > ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES)
    firstInvalidPredicate = "idle-retained-heap-high";
  const qualified =
    exact &&
    rssSlope <= 262_144 &&
    heapSlope <= 131_072 &&
    rssGrowth <= 67_108_864 &&
    heapGrowth <= 33_554_432 &&
    rssHigh <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
    heapHigh <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES;
  return Object.freeze({
    qualified,
    sampleCount: Array.isArray(samples) ? samples.length : 0,
    rssSlopeBytesPerSample: rssSlope,
    heapSlopeBytesPerSample: heapSlope,
    rssGrowthBytes: rssGrowth,
    heapGrowthBytes: heapGrowth,
    rssHighBytes: rssHigh,
    heapHighBytes: heapHigh,
    firstInvalidOrdinal,
    firstInvalidPredicate: qualified ? null : firstInvalidPredicate,
  });
}

export function assessAnsiResourceLifecycle(samples, expectedSamples) {
  if (
    !Array.isArray(samples) ||
    samples.length !== 26 ||
    !Array.isArray(expectedSamples) ||
    expectedSamples.length !== 26
  )
    return Object.freeze({
      qualified: false,
      sampleCount: Array.isArray(samples) ? samples.length : 0,
    });
  let previousOrdinal = 0;
  let previousAtMicros = -1;
  let previousRssPeak = 0;
  let previousHeapPeak = 0;
  let previousDelayPeak = 0;
  let resourceEpochIdentityHmac = null;
  let qualified = true;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const phase = index === 0 ? "baseline" : index === 25 ? "idle" : "cycle";
    const cycle = index === 25 ? 25 : index;
    const expected = expectedSamples[index];
    qualified &&=
      exactKeys(expected, [
        "phase",
        "cycle",
        "operation",
        "resourceEpochIdentityHmac",
        "lowWaterFirstSampleOrdinal",
        "lowWaterLastSampleOrdinal",
        "lowWaterSampleCount",
        "identityHmac",
        "stateHmac",
        "processHmac",
        "clockId",
      ]) &&
      exactKeys(sample, [
        "phase",
        "cycle",
        "sampleOrdinal",
        "operation",
        "resourceEpochArmed",
        "resourceEpochIdentityHmac",
        "lowWaterFirstSampleOrdinal",
        "lowWaterLastSampleOrdinal",
        "lowWaterSampleCount",
        "lowWaterWindowMicros",
        "identityHmac",
        "stateHmac",
        "processHmac",
        "clockId",
        "clockKind",
        "atMicros",
        "rssBytes",
        "heapUsedBytes",
        "eventLoopDelayMicros",
        "rssPeakBytes",
        "heapUsedPeakBytes",
        "eventLoopDelayPeakMicros",
        "eventLoopDelayPeakSource",
        "inputPending",
        "inputInFlight",
        "inputPendingBytes",
        "inputPendingPeak",
        "inputInFlightPeak",
        "inputPendingBytesPeak",
        "resourceSamplingFailureCount",
      ]) &&
      sample?.phase === phase &&
      sample.phase === expected?.phase &&
      sample?.cycle === cycle &&
      sample.cycle === expected?.cycle &&
      sample?.operation === (phase === "idle" ? "idle" : "post-fence") &&
      sample.operation === expected?.operation &&
      sample?.resourceEpochArmed === true &&
      sample?.lowWaterFirstSampleOrdinal === 1 &&
      sample?.lowWaterLastSampleOrdinal === (phase === "idle" ? 1 : 8) &&
      sample?.lowWaterSampleCount === (phase === "idle" ? 1 : 8) &&
      sample?.lowWaterWindowMicros >= (phase === "idle" ? 0 : 40_000) &&
      sample?.lowWaterWindowMicros <= (phase === "idle" ? 0 : 2_000_000) &&
      sample.lowWaterFirstSampleOrdinal === expected?.lowWaterFirstSampleOrdinal &&
      sample.lowWaterLastSampleOrdinal === expected?.lowWaterLastSampleOrdinal &&
      sample.lowWaterSampleCount === expected?.lowWaterSampleCount &&
      SHA256.test(sample?.resourceEpochIdentityHmac ?? "") &&
      sample.resourceEpochIdentityHmac === expected?.resourceEpochIdentityHmac &&
      (index === 0 || sample.resourceEpochIdentityHmac === resourceEpochIdentityHmac) &&
      SHA256.test(sample?.identityHmac ?? "") &&
      sample.identityHmac === expected?.identityHmac &&
      SHA256.test(sample?.stateHmac ?? "") &&
      sample.stateHmac === expected?.stateHmac &&
      Number.isSafeInteger(sample?.sampleOrdinal) &&
      sample.sampleOrdinal > previousOrdinal &&
      sample.sampleOrdinal <= 512 &&
      sample?.processHmac === expected?.processHmac &&
      sample?.clockId === expected?.clockId &&
      sample?.clockKind === "performance-now" &&
      safeTimestamp(sample?.atMicros) &&
      sample.atMicros > previousAtMicros &&
      Number.isSafeInteger(sample?.rssBytes) &&
      sample.rssBytes >= 0 &&
      sample.rssBytes <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
      Number.isSafeInteger(sample?.heapUsedBytes) &&
      sample.heapUsedBytes >= 0 &&
      sample.heapUsedBytes <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES &&
      Number.isSafeInteger(sample?.eventLoopDelayMicros) &&
      sample.eventLoopDelayMicros >= 0 &&
      sample.eventLoopDelayMicros <= ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS &&
      Number.isSafeInteger(sample?.rssPeakBytes) &&
      sample.rssPeakBytes >= Math.max(previousRssPeak, sample.rssBytes) &&
      sample.rssPeakBytes <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
      Number.isSafeInteger(sample?.heapUsedPeakBytes) &&
      sample.heapUsedPeakBytes >= Math.max(previousHeapPeak, sample.heapUsedBytes) &&
      sample.heapUsedPeakBytes <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES &&
      Number.isSafeInteger(sample?.eventLoopDelayPeakMicros) &&
      sample.eventLoopDelayPeakMicros >= Math.max(previousDelayPeak, sample.eventLoopDelayMicros) &&
      sample.eventLoopDelayPeakMicros <=
        ANSI_TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS &&
      new Set(["heartbeat", "endpoint"]).has(sample?.eventLoopDelayPeakSource) &&
      sample?.inputPending === 0 &&
      sample?.inputInFlight === 0 &&
      sample?.inputPendingBytes === 0 &&
      sample?.inputPendingPeak === 0 &&
      sample?.inputInFlightPeak === 0 &&
      sample?.inputPendingBytesPeak === 0;
    qualified &&= sample?.resourceSamplingFailureCount === 0;
    if (Number.isSafeInteger(sample?.sampleOrdinal)) previousOrdinal = sample.sampleOrdinal;
    if (safeTimestamp(sample?.atMicros)) previousAtMicros = sample.atMicros;
    if (Number.isSafeInteger(sample?.rssPeakBytes)) previousRssPeak = sample.rssPeakBytes;
    if (Number.isSafeInteger(sample?.heapUsedPeakBytes))
      previousHeapPeak = sample.heapUsedPeakBytes;
    if (Number.isSafeInteger(sample?.eventLoopDelayPeakMicros))
      previousDelayPeak = sample.eventLoopDelayPeakMicros;
    if (SHA256.test(sample?.resourceEpochIdentityHmac ?? "") && index === 0)
      resourceEpochIdentityHmac = sample.resourceEpochIdentityHmac;
  }
  return Object.freeze({ qualified, sampleCount: samples.length });
}

export function assessAnsiCursorPresentationSamples(samples, expectedSamples) {
  if (!Array.isArray(samples) || samples.length !== ANSI_CURSOR_SAMPLE_COUNT)
    return Object.freeze({
      qualified: false,
      sampleCount: Array.isArray(samples) ? samples.length : 0,
      p95Micros: null,
      p99Micros: null,
    });
  const traces = new Set();
  const gestures = new Set();
  const daemonProcesses = new Set();
  const daemonClocks = new Set();
  const durations = [];
  let previousRevision = -1;
  let commonPresentationIdentity = null;
  let exact = true;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const durationMicros = sample?.durationMicros;
    const causal = sample?.causal;
    const presentation = sample?.presentation;
    const frame = sample?.frame;
    const fence = sample?.fence;
    const expected = expectedSamples?.[index];
    exact &&=
      exactKeys(expected, [
        "ordinal",
        "action",
        "traceHmac",
        "gestureHmac",
        "daemonProcessHmac",
        "daemonClockId",
        "presentation",
        "cursor",
      ]) &&
      exactKeys(expected?.cursor, [
        "x",
        "y",
        "hidden",
        "canonicalStyle",
        "rendererStyle",
        "blink",
      ]) &&
      exactKeys(expected?.presentation, [
        "processHmac",
        "clockId",
        "clockKind",
        "paneHmac",
        "generationHmac",
        "incarnationHmac",
        "revision",
        "stateHmac",
        "presentationHmac",
        "canonicalCols",
        "canonicalRows",
        "viewportCols",
        "viewportRows",
        "sourceEpoch",
        "rendererEpoch",
        "gridWalked",
        "gridRowsRead",
        "fullWalk",
        "gridRowsReadTotal",
        "fullWalkTotal",
        "presentationCount",
      ]) &&
      exactKeys(sample, [
        "ordinal",
        "action",
        "traceHmac",
        "gestureHmac",
        "durationMicros",
        "startedAtMicros",
        "presentedAtMicros",
        "frameAtMicros",
        "fenceAtMicros",
        "causal",
        "cursor",
        "presentation",
        "frame",
        "fence",
      ]) &&
      exactKeys(causal, [
        "dirtyRows",
        "gridRowsReadDelta",
        "fullWalkDelta",
        "presentationCountDelta",
        "inputAccepted",
        "canonicalReceiptExact",
        "daemonStageCount",
        "daemonProcessHmac",
        "daemonClockId",
      ]) &&
      sample?.ordinal === index + 1 &&
      expected?.ordinal === index + 1 &&
      sample?.action === "cursor-next" &&
      expected?.action === "cursor-next" &&
      exactKeys(sample?.cursor, ["x", "y", "hidden", "canonicalStyle", "rendererStyle", "blink"]) &&
      sample.cursor.x === expected?.cursor?.x &&
      sample.cursor.y === expected?.cursor?.y &&
      sample.cursor.hidden === expected?.cursor?.hidden &&
      sample.cursor.canonicalStyle === expected?.cursor?.canonicalStyle &&
      sample.cursor.rendererStyle === expected?.cursor?.rendererStyle &&
      sample.cursor.blink === expected?.cursor?.blink &&
      safeMicros(durationMicros) &&
      SHA256.test(sample?.traceHmac ?? "") &&
      sample.traceHmac === expected?.traceHmac &&
      SHA256.test(sample?.gestureHmac ?? "") &&
      sample.gestureHmac === expected?.gestureHmac &&
      !traces.has(sample.traceHmac) &&
      !gestures.has(sample.gestureHmac) &&
      Array.isArray(causal?.dirtyRows) &&
      causal.dirtyRows.length === 0 &&
      causal?.gridRowsReadDelta === 0 &&
      causal?.fullWalkDelta === 0 &&
      causal?.presentationCountDelta === 1 &&
      causal?.inputAccepted === true &&
      causal?.canonicalReceiptExact === true &&
      causal?.daemonStageCount === ANSI_DAEMON_STAGES.length &&
      SHA256.test(causal?.daemonProcessHmac ?? "") &&
      causal.daemonProcessHmac === expected?.daemonProcessHmac &&
      boundedIdentity(causal?.daemonClockId) &&
      causal.daemonClockId === expected?.daemonClockId &&
      exactKeys(presentation, [
        "processHmac",
        "clockId",
        "clockKind",
        "paneHmac",
        "generationHmac",
        "incarnationHmac",
        "revision",
        "stateHmac",
        "presentationHmac",
        "canonicalCols",
        "canonicalRows",
        "viewportCols",
        "viewportRows",
        "sourceEpoch",
        "rendererEpoch",
        "gridWalked",
        "gridRowsRead",
        "fullWalk",
        "gridRowsReadTotal",
        "fullWalkTotal",
        "presentationCount",
      ]) &&
      exactIdentity(presentation, expected?.presentation) &&
      presentation.revision > previousRevision &&
      (commonPresentationIdentity === null ||
        (presentation.processHmac === commonPresentationIdentity.processHmac &&
          presentation.clockId === commonPresentationIdentity.clockId &&
          presentation.paneHmac === commonPresentationIdentity.paneHmac &&
          presentation.generationHmac === commonPresentationIdentity.generationHmac &&
          presentation.incarnationHmac === commonPresentationIdentity.incarnationHmac &&
          presentation.sourceEpoch === commonPresentationIdentity.sourceEpoch &&
          presentation.rendererEpoch === commonPresentationIdentity.rendererEpoch &&
          presentation.canonicalCols === commonPresentationIdentity.canonicalCols &&
          presentation.canonicalRows === commonPresentationIdentity.canonicalRows &&
          presentation.viewportCols === commonPresentationIdentity.viewportCols &&
          presentation.viewportRows === commonPresentationIdentity.viewportRows)) &&
      presentation?.gridWalked === false &&
      presentation?.gridRowsRead === 0 &&
      presentation?.fullWalk === false &&
      Number.isSafeInteger(presentation?.gridRowsReadTotal) &&
      presentation.gridRowsReadTotal === expected?.presentation?.gridRowsReadTotal &&
      Number.isSafeInteger(presentation?.fullWalkTotal) &&
      presentation.fullWalkTotal === expected?.presentation?.fullWalkTotal &&
      Number.isSafeInteger(presentation?.presentationCount) &&
      presentation.presentationCount === expected?.presentation?.presentationCount &&
      exactKeys(frame, [
        "processHmac",
        "clockId",
        "clockKind",
        "paneHmac",
        "generationHmac",
        "incarnationHmac",
        "revision",
        "stateHmac",
        "presentationHmac",
        "canonicalCols",
        "canonicalRows",
        "viewportCols",
        "viewportRows",
        "sourceEpoch",
        "rendererEpoch",
      ]) &&
      exactIdentity(frame, expected?.presentation) &&
      exactKeys(fence, [
        "processHmac",
        "clockId",
        "clockKind",
        "paneHmac",
        "generationHmac",
        "incarnationHmac",
        "revision",
        "stateHmac",
        "presentationHmac",
        "canonicalCols",
        "canonicalRows",
        "viewportCols",
        "viewportRows",
        "sourceEpoch",
        "rendererEpoch",
      ]) &&
      exactIdentity(fence, expected?.presentation) &&
      presentation.revision === frame.revision &&
      frame.revision === fence.revision &&
      presentation.presentationHmac === frame.presentationHmac &&
      frame.presentationHmac === fence.presentationHmac &&
      safeTimestamp(sample?.startedAtMicros) &&
      safeTimestamp(sample?.presentedAtMicros) &&
      safeTimestamp(sample?.frameAtMicros) &&
      safeTimestamp(sample?.fenceAtMicros) &&
      sample.startedAtMicros <= sample.presentedAtMicros &&
      sample.presentedAtMicros <= sample.frameAtMicros &&
      sample.frameAtMicros <= sample.fenceAtMicros &&
      durationMicros === sample.fenceAtMicros - sample.startedAtMicros;
    if (SHA256.test(sample?.traceHmac ?? "")) traces.add(sample.traceHmac);
    if (SHA256.test(sample?.gestureHmac ?? "")) gestures.add(sample.gestureHmac);
    if (SHA256.test(causal?.daemonProcessHmac ?? "")) daemonProcesses.add(causal.daemonProcessHmac);
    if (boundedIdentity(causal?.daemonClockId)) daemonClocks.add(causal.daemonClockId);
    if (safeMicros(durationMicros)) durations.push(durationMicros);
    if (Number.isSafeInteger(presentation?.revision)) previousRevision = presentation.revision;
    commonPresentationIdentity ??= presentation;
  }
  const sorted = durations.slice().sort((left, right) => left - right);
  const p95Micros = durations.length === ANSI_CURSOR_SAMPLE_COUNT ? percentile(sorted, 0.95) : null;
  const p99Micros = durations.length === ANSI_CURSOR_SAMPLE_COUNT ? percentile(sorted, 0.99) : null;
  return Object.freeze({
    qualified:
      exact &&
      daemonProcesses.size === 1 &&
      daemonClocks.size === 1 &&
      p95Micros !== null &&
      p95Micros <= ANSI_CURSOR_P95_BUDGET_MICROS &&
      p99Micros !== null &&
      p99Micros <= ANSI_CURSOR_P99_BUDGET_MICROS,
    sampleCount: samples.length,
    p95Micros,
    p99Micros,
  });
}

export function ansiCursorWebEvidence(web, expected) {
  const readiness = web?.readiness;
  const normalized = readiness?.normalized;
  const stages = Array.isArray(web?.presentations) ? web.presentations : [];
  const expectedStages = ["normal", "rich", "cursor-only", "alternate", "restored"];
  const stageExact =
    stages.length === expectedStages.length &&
    stages.every(
      (stage, index) =>
        exactKeys(expected?.presentations?.[index], [
          "generationHmac",
          "incarnationHmac",
          "stateHmac",
          "deliveryRequestHmacs",
          "revision",
          "sourceEpoch",
          "activeBuffer",
          "cursorX",
          "cursorY",
          "cursorHidden",
          "cursorStyle",
          "canonicalCursorStyle",
          "cursorBlink",
          "cols",
          "rows",
          "renditionHmac",
          "positionWrappedHmac",
          "renditionCellCount",
          "wideContinuationCount",
          "combiningCount",
          "styledCellCount",
          "gridRowsRead",
          "gridCellsRead",
          "fullGridWalks",
          "rendererEpoch",
          "rendererCols",
          "rendererRows",
        ]) &&
        exactKeys(stage, [
          "stage",
          "semanticPaneHmac",
          "generationHmac",
          "incarnationHmac",
          "stateHmac",
          "deliveryRequestHmac",
          "domRowsHmac",
          "domCursorHmac",
          "domSemanticExact",
          "domRowCountExact",
          "domTextExact",
          "domStyleExact",
          "domFirstMismatchRow",
          "domFirstMismatchColumn",
          "domFirstMismatchComponent",
          "domCursorExact",
          "renditionHmac",
          "positionWrappedHmac",
          "renditionCellCount",
          "wideContinuationCount",
          "combiningCount",
          "styledCellCount",
          "rowCount",
          "cursorCount",
          "cursorVisible",
          "activeBuffer",
          "cursorX",
          "cursorY",
          "cursorHidden",
          "cursorStyle",
          "cursorBlink",
          "revision",
          "sourceEpoch",
          "rendererEpoch",
          "rendererCols",
          "rendererRows",
          "cols",
          "rows",
          "gridRowsRead",
          "gridCellsRead",
          "fullGridWalks",
          "canonicalBuffer",
          "canonicalCursorX",
          "canonicalCursorY",
          "canonicalCursorHidden",
          "canonicalCursorStyle",
          "canonicalCursorBlink",
          "stableSamples",
        ]) &&
        stage?.stage === expectedStages[index] &&
        stage?.semanticPaneHmac === expected?.semanticPaneHmac &&
        stage?.generationHmac === expected?.presentations?.[index]?.generationHmac &&
        stage?.incarnationHmac === expected?.presentations?.[index]?.incarnationHmac &&
        stage?.stateHmac === expected?.presentations?.[index]?.stateHmac &&
        Array.isArray(expected?.presentations?.[index]?.deliveryRequestHmacs) &&
        expected.presentations[index].deliveryRequestHmacs.length >= 1 &&
        expected.presentations[index].deliveryRequestHmacs.length <= 16 &&
        expected.presentations[index].deliveryRequestHmacs.every((value) => SHA256.test(value)) &&
        new Set(expected.presentations[index].deliveryRequestHmacs).size ===
          expected.presentations[index].deliveryRequestHmacs.length &&
        SHA256.test(stage?.deliveryRequestHmac ?? "") &&
        expected.presentations[index].deliveryRequestHmacs.includes(stage.deliveryRequestHmac) &&
        stage?.renditionHmac === expected?.presentations?.[index]?.renditionHmac &&
        stage?.positionWrappedHmac === expected?.presentations?.[index]?.positionWrappedHmac &&
        SHA256.test(stage?.domRowsHmac ?? "") &&
        SHA256.test(stage?.domCursorHmac ?? "") &&
        stage?.domSemanticExact === true &&
        stage?.domRowCountExact === true &&
        stage?.domTextExact === true &&
        stage?.domStyleExact === true &&
        stage?.domFirstMismatchRow === null &&
        stage?.domFirstMismatchColumn === null &&
        stage?.domFirstMismatchComponent === null &&
        stage?.domCursorExact === true &&
        stage?.renditionCellCount === expected?.presentations?.[index]?.renditionCellCount &&
        stage?.wideContinuationCount === expected?.presentations?.[index]?.wideContinuationCount &&
        stage?.combiningCount === expected?.presentations?.[index]?.combiningCount &&
        stage?.styledCellCount === expected?.presentations?.[index]?.styledCellCount &&
        stage?.revision === expected?.presentations?.[index]?.revision &&
        stage?.sourceEpoch === expected?.presentations?.[index]?.sourceEpoch &&
        stage?.rendererEpoch === expected?.presentations?.[index]?.rendererEpoch &&
        stage?.rendererCols === expected?.presentations?.[index]?.rendererCols &&
        stage?.rendererRows === expected?.presentations?.[index]?.rendererRows &&
        stage?.rendererCols === expected?.presentations?.[index]?.cols &&
        stage?.rendererRows === expected?.presentations?.[index]?.rows &&
        stage?.cols === expected?.presentations?.[index]?.cols &&
        stage?.rows === expected?.presentations?.[index]?.rows &&
        stage?.stableSamples === 2 &&
        stage?.activeBuffer === expected?.presentations?.[index]?.activeBuffer &&
        stage?.cursorX === expected?.presentations?.[index]?.cursorX &&
        stage?.cursorY === expected?.presentations?.[index]?.cursorY &&
        stage?.cursorHidden === expected?.presentations?.[index]?.cursorHidden &&
        stage?.cursorStyle === expected?.presentations?.[index]?.cursorStyle &&
        stage?.cursorBlink === expected?.presentations?.[index]?.cursorBlink &&
        stage?.canonicalBuffer === expected?.presentations?.[index]?.activeBuffer &&
        stage?.canonicalCursorX === expected?.presentations?.[index]?.cursorX &&
        stage?.canonicalCursorY === expected?.presentations?.[index]?.cursorY &&
        stage?.canonicalCursorHidden === expected?.presentations?.[index]?.cursorHidden &&
        stage?.canonicalCursorStyle === expected?.presentations?.[index]?.canonicalCursorStyle &&
        stage?.canonicalCursorBlink === expected?.presentations?.[index]?.cursorBlink &&
        stage?.gridRowsRead === expected?.presentations?.[index]?.gridRowsRead &&
        stage?.gridCellsRead === expected?.presentations?.[index]?.gridCellsRead &&
        stage?.fullGridWalks === expected?.presentations?.[index]?.fullGridWalks &&
        stage?.cursorVisible === !expected?.presentations?.[index]?.cursorHidden &&
        Number.isSafeInteger(stage?.rowCount) &&
        stage.rowCount > 0 &&
        stage.rowCount <= 4_096 &&
        stage?.cursorCount === (expected?.presentations?.[index]?.cursorHidden ? 0 : 1),
    );
  const sameCanonicalCursor = (left, right) =>
    left?.canonicalCursorX === right?.canonicalCursorX &&
    left?.canonicalCursorY === right?.canonicalCursorY &&
    left?.canonicalCursorHidden === right?.canonicalCursorHidden &&
    left?.canonicalCursorStyle === right?.canonicalCursorStyle &&
    left?.canonicalCursorBlink === right?.canonicalCursorBlink &&
    left?.cursorVisible === right?.cursorVisible &&
    left?.cursorCount === right?.cursorCount;
  const restorationPredicates = Object.freeze({
    normalRestoredDomRenditionExact:
      SHA256.test(stages[0]?.domRowsHmac ?? "") &&
      stages[0]?.domRowsHmac === stages[4]?.domRowsHmac,
    normalRestoredSemanticRenditionExact:
      SHA256.test(stages[0]?.renditionHmac ?? "") &&
      stages[0]?.renditionHmac === stages[4]?.renditionHmac &&
      stages[0]?.positionWrappedHmac === stages[4]?.positionWrappedHmac,
    normalRestoredCanonicalCursorExact: sameCanonicalCursor(stages[0], stages[4]),
    normalRestoredDomCursorExact:
      SHA256.test(stages[0]?.domCursorHmac ?? "") &&
      stages[0]?.domCursorHmac === stages[4]?.domCursorHmac,
    normalBufferExact:
      stages[0]?.activeBuffer === "normal" &&
      stages[0]?.canonicalBuffer === "normal" &&
      stages[4]?.activeBuffer === "normal" &&
      stages[4]?.canonicalBuffer === "normal",
    richDomDistinctFromNormalExact: stages[1]?.domRowsHmac !== stages[0]?.domRowsHmac,
    richCursorDomRenditionExact:
      SHA256.test(stages[1]?.domRowsHmac ?? "") &&
      stages[1]?.domRowsHmac === stages[2]?.domRowsHmac,
    richCursorSemanticRenditionExact:
      SHA256.test(stages[1]?.renditionHmac ?? "") &&
      stages[1]?.renditionHmac === stages[2]?.renditionHmac &&
      stages[1]?.positionWrappedHmac === stages[2]?.positionWrappedHmac,
    cursorOnlyZeroGridExact:
      stages[2]?.gridRowsRead === 0 &&
      stages[2]?.gridCellsRead === 0 &&
      stages[2]?.fullGridWalks === 0,
    richCursorDistinctExact:
      !sameCanonicalCursor(stages[1], stages[2]) &&
      SHA256.test(stages[1]?.domCursorHmac ?? "") &&
      SHA256.test(stages[2]?.domCursorHmac ?? "") &&
      stages[1]?.domCursorHmac !== stages[2]?.domCursorHmac,
    alternateSemanticDistinct:
      SHA256.test(stages[3]?.renditionHmac ?? "") &&
      stages[3]?.renditionHmac !== stages[1]?.renditionHmac &&
      stages[3]?.domRowsHmac !== stages[1]?.domRowsHmac,
    alternateBufferHiddenExact:
      stages[3]?.activeBuffer === "alternate" &&
      stages[3]?.canonicalBuffer === "alternate" &&
      stages[3]?.canonicalCursorHidden === true &&
      stages[3]?.cursorVisible === false &&
      stages[3]?.cursorCount === 0,
    rendererCanonicalDimensionsExact: stages.every(
      (stage) =>
        stage?.rendererCols === stage?.cols &&
        stage?.rendererRows === stage?.rows &&
        Number.isSafeInteger(stage?.cols) &&
        Number.isSafeInteger(stage?.rows),
    ),
  });
  const firstFailedRestorationPredicate =
    Object.entries(restorationPredicates).find(([, exact]) => exact !== true)?.[0] ?? null;
  const restorationExact = firstFailedRestorationPredicate === null;
  const readinessExact = readiness?.qualified === true && web?.stableExactSamples === 2;
  const topologyExact =
    normalized?.expectedGroupCount === 1 &&
    normalized?.observedTerminalCount === 1 &&
    normalized?.terminalExact === true;
  return Object.freeze({
    qualified:
      exactKeys(web, ["readiness", "stableExactSamples", "presentations"]) &&
      exactKeys(expected, ["semanticPaneHmac", "presentations"]) &&
      readinessExact &&
      topologyExact &&
      SHA256.test(expected?.semanticPaneHmac ?? "") &&
      Array.isArray(expected?.presentations) &&
      expected.presentations.length === expectedStages.length &&
      stageExact &&
      restorationExact,
    stableExactSamples: Number.isSafeInteger(web?.stableExactSamples)
      ? web.stableExactSamples
      : null,
    stageCount: Math.min(stages.length, 6),
    readinessExact,
    topologyExact,
    stageExact,
    restorationExact,
    restorationPredicates,
    firstFailedRestorationPredicate,
  });
}

export function ansiWebExpectedGridProjection(stage, driven) {
  const canonicalRows = driven?.stage?.canonicalRows;
  const canonicalCols = driven?.stage?.canonicalCols;
  const rawRows = driven?.raw?.presentation?.gridRowsRead;
  const sealedRows = driven?.sample?.presentation?.gridRowsRead;
  const stageExact = new Set(["normal", "rich", "cursor-only", "alternate", "restored"]).has(stage);
  if (driven?.qualified !== true)
    return Object.freeze({
      exact: false,
      reason: "qualified-stage",
      canonicalRows: null,
      canonicalCols: null,
      presentationRows: null,
      gridRowsRead: null,
      gridCellsRead: null,
      fullGridWalks: null,
    });
  const canonicalExact =
    Number.isSafeInteger(canonicalRows) &&
    canonicalRows > 0 &&
    canonicalRows <= 4_096 &&
    Number.isSafeInteger(canonicalCols) &&
    canonicalCols > 0 &&
    canonicalCols <= 4_096;
  const presentationExact =
    Number.isSafeInteger(rawRows) &&
    rawRows >= 0 &&
    rawRows <= 4_096 &&
    rawRows === sealedRows &&
    canonicalExact &&
    rawRows <= canonicalRows;
  if (!stageExact)
    return Object.freeze({
      exact: false,
      reason: "stage",
      canonicalRows: null,
      canonicalCols: null,
      presentationRows: null,
      gridRowsRead: null,
      gridCellsRead: null,
      fullGridWalks: null,
    });
  if (!canonicalExact)
    return Object.freeze({
      exact: false,
      reason: "canonical-geometry",
      canonicalRows: Number.isSafeInteger(canonicalRows) ? canonicalRows : null,
      canonicalCols: Number.isSafeInteger(canonicalCols) ? canonicalCols : null,
      presentationRows: null,
      gridRowsRead: null,
      gridCellsRead: null,
      fullGridWalks: null,
    });
  if (!presentationExact)
    return Object.freeze({
      exact: false,
      reason: "presentation-rows",
      canonicalRows,
      canonicalCols,
      presentationRows:
        Number.isSafeInteger(rawRows) && rawRows >= 0 && rawRows <= 4_096 ? rawRows : null,
      gridRowsRead: null,
      gridCellsRead: null,
      fullGridWalks: null,
    });
  const fullGridWalk = stage === "alternate" || stage === "restored";
  const gridRowsRead = fullGridWalk ? canonicalRows : rawRows;
  const gridCellsRead = gridRowsRead * canonicalCols;
  if (!Number.isSafeInteger(gridCellsRead))
    return Object.freeze({
      exact: false,
      reason: "cell-overflow",
      canonicalRows,
      canonicalCols,
      presentationRows: rawRows,
      gridRowsRead: null,
      gridCellsRead: null,
      fullGridWalks: null,
    });
  return Object.freeze({
    exact: true,
    reason: null,
    canonicalRows,
    canonicalCols,
    presentationRows: rawRows,
    gridRowsRead,
    gridCellsRead,
    fullGridWalks: fullGridWalk ? 1 : 0,
  });
}

export function ansiRenditionFailureLocalization(candidate, expected) {
  const hmac = (value) => (typeof value === "string" && SHA256.test(value) ? value : null);
  const expectedCells = Array.isArray(expected?.cellHmacs) ? expected.cellHmacs : null;
  const actualCells = Array.isArray(candidate?.cellHmacs)
    ? candidate.cellHmacs.slice(0, 256).map(hmac)
    : null;
  const expectedRows = Array.isArray(expected?.rows) ? expected.rows : null;
  let firstDifferenceOrdinal = null;
  if (
    expectedCells &&
    expectedCells.length <= 256 &&
    expectedCells.every((value) => hmac(value) === value) &&
    actualCells
  ) {
    const ordinal = expectedCells.findIndex((value, index) => actualCells[index] !== value);
    if (ordinal >= 0) firstDifferenceOrdinal = ordinal;
    else if (actualCells.length !== expectedCells.length)
      firstDifferenceOrdinal = Math.min(actualCells.length, expectedCells.length);
  }
  const differenceRow =
    firstDifferenceOrdinal !== null &&
    expectedRows &&
    Number.isSafeInteger(expectedRows[firstDifferenceOrdinal]) &&
    expectedRows[firstDifferenceOrdinal] >= 0 &&
    expectedRows[firstDifferenceOrdinal] <= 4095
      ? expectedRows[firstDifferenceOrdinal]
      : null;
  const dimension = (value) =>
    Number.isSafeInteger(value) && value >= 1 && value <= 4096 ? value : null;
  const componentExact = (actual, required) => {
    const expectedHmac = hmac(required);
    return expectedHmac !== null && hmac(actual) === expectedHmac;
  };
  return Object.freeze({
    positionWrappedExact: componentExact(
      candidate?.positionWrappedHmac,
      expected?.positionWrappedHmac,
    ),
    graphemeWidthExact: componentExact(candidate?.graphemeWidthHmac, expected?.graphemeWidthHmac),
    colorExact: componentExact(candidate?.colorHmac, expected?.colorHmac),
    attributesExact: componentExact(candidate?.attributesHmac, expected?.attributesHmac),
    firstDifferenceOrdinal,
    firstDifferenceRow: differenceRow,
    rendererCols: dimension(candidate?.rendererCols),
    rendererRows: dimension(candidate?.rendererRows),
  });
}

/** Browser-side observation hashes actual xterm DOM rows/cursor before crossing realms. */
export async function captureAnsiCursorWebPresentation(
  page,
  { keyHex, stage, semanticPaneId, expectedRendition, expectedCursor },
) {
  if (
    !/^[0-9a-f]{64}$/u.test(keyHex) ||
    !boundedIdentity(stage) ||
    !boundedIdentity(semanticPaneId) ||
    !Array.isArray(expectedRendition) ||
    expectedRendition.length > 256 ||
    !expectedRendition.every(
      (cell) =>
        Number.isSafeInteger(cell?.row) &&
        cell.row >= 0 &&
        cell.row <= 4_095 &&
        Number.isSafeInteger(cell?.column) &&
        cell.column >= 0 &&
        cell.column <= 4_095 &&
        typeof cell?.chars === "string" &&
        cell.chars.length <= 4_096 &&
        new Set([0, 1, 2]).has(cell?.width) &&
        typeof cell?.foreground === "string" &&
        typeof cell?.background === "string" &&
        typeof cell?.bold === "boolean" &&
        typeof cell?.italic === "boolean" &&
        typeof cell?.underline === "boolean",
    ) ||
    !expectedCursor ||
    !Number.isSafeInteger(expectedCursor.x) ||
    !Number.isSafeInteger(expectedCursor.y) ||
    expectedCursor.x < 0 ||
    expectedCursor.y < 0 ||
    expectedCursor.x > 4_095 ||
    expectedCursor.y > 4_095 ||
    !new Set(["block", "bar", "underline"]).has(expectedCursor.style) ||
    typeof expectedCursor.hidden !== "boolean" ||
    typeof expectedCursor.blink !== "boolean"
  )
    throw new TypeError("ANSI Web presentation request was malformed");
  return page.evaluate(
    async ({ evidenceKey, expectedStage, expectedPane, expectedCells, expectedDomCursor }) => {
      const bytes = (hex) =>
        new Uint8Array(hex.match(/.{2}/gu)?.map((value) => Number.parseInt(value, 16)) ?? []);
      const hmac = async (domain, value) => {
        const key = await crypto.subtle.importKey(
          "raw",
          bytes(evidenceKey),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const digest = await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${domain}\0${value}`),
        );
        return [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      };
      const probe = globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__;
      const diagnostic =
        typeof probe === "function" ? await probe(expectedPane, evidenceKey) : null;
      const surface = diagnostic?.surface ?? null;
      if (
        !(surface instanceof globalThis.HTMLElement) ||
        surface.getAttribute("data-phase") !== "connected" ||
        surface.getAttribute("data-semantic-pane-id") !== expectedPane
      )
        return null;
      const rows = [...surface.querySelectorAll(".xterm-rows > div")];
      const allCursors = [...surface.querySelectorAll(".xterm-cursor")];
      const cursors = allCursors.filter((cursor) => {
        const style = globalThis.getComputedStyle(cursor);
        const rect = cursor.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      });
      const cursor = cursors[0] ?? null;
      const cursorRect = cursor?.getBoundingClientRect();
      const rendition = diagnostic?.rendition ?? null;
      const presentation = diagnostic?.presentation ?? null;
      const canonical = diagnostic?.canonical ?? null;
      const normalizedStyle = (element) => {
        const style = globalThis.getComputedStyle(element);
        return Object.freeze({
          color: style.color,
          backgroundColor: style.backgroundColor,
          fontWeight: style.fontWeight,
          fontStyle: style.fontStyle,
          textDecorationLine: style.textDecorationLine,
        });
      };
      const semanticCellStyle = (element) => {
        const cursorCell = element.closest(".xterm-cursor");
        if (!cursorCell || !cursorCell.parentElement) return normalizedStyle(element);
        // The DOM renderer puts both cursor paint classes and the original
        // cell's color/attribute classes on one span. Measure a same-parent
        // clone with only cursor-owned classes removed, preserving every cell
        // class and inline style without mutating the live cursor node.
        const semanticClone = cursorCell.cloneNode(false);
        for (const name of [...semanticClone.classList])
          if (name.startsWith("xterm-cursor")) semanticClone.classList.remove(name);
        cursorCell.parentElement.insertBefore(semanticClone, cursorCell);
        const style = normalizedStyle(semanticClone);
        semanticClone.remove();
        return style;
      };
      const cssColor = (value) => {
        const serialized = String(value).trim();
        if (serialized === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
        const hex = serialized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu)?.[1];
        if (hex) {
          const expanded =
            hex.length === 3 ? [...hex].map((digit) => `${digit}${digit}`).join("") : hex;
          return {
            rgb: [
              Number.parseInt(expanded.slice(0, 2), 16),
              Number.parseInt(expanded.slice(2, 4), 16),
              Number.parseInt(expanded.slice(4, 6), 16),
            ],
            alpha: 1,
          };
        }
        const match = serialized.match(
          /^rgba?\(\s*(\d+)\s*(?:,\s*|\s+)(\d+)\s*(?:,\s*|\s+)(\d+)(?:\s*(?:,|\/)\s*(\d*\.?\d+%?))?\s*\)$/u,
        );
        if (!match) return null;
        const alpha = match[4]?.endsWith("%")
          ? Number(match[4].slice(0, -1)) / 100
          : Number(match[4] ?? 1);
        if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return null;
        return { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha };
      };
      const rgb = (value) => cssColor(value)?.rgb ?? null;
      const indexed = (index) => {
        if (!Number.isSafeInteger(index) || index < 16 || index > 255) return null;
        if (index >= 232) {
          const value = 8 + (index - 232) * 10;
          return [value, value, value];
        }
        const level = [0, 95, 135, 175, 215, 255];
        const offset = index - 16;
        return [
          level[Math.floor(offset / 36)],
          level[Math.floor((offset % 36) / 6)],
          level[offset % 6],
        ];
      };
      const colorExact = (actual, expected, fallback, background = false) => {
        const parsedActual = cssColor(actual);
        const parsedFallback = cssColor(fallback);
        if (!parsedActual || !parsedFallback || parsedFallback.alpha !== 1) return false;
        const defaultTransparentBackground =
          expected === "default" && background && parsedActual.alpha === 0;
        if (!defaultTransparentBackground && parsedActual.alpha !== 1) return false;
        const actualRgb = defaultTransparentBackground ? parsedFallback.rgb : parsedActual.rgb;
        const expectedRgb = expected.startsWith("rgb:")
          ? [
              Number.parseInt(expected.slice(4, 6), 16),
              Number.parseInt(expected.slice(6, 8), 16),
              Number.parseInt(expected.slice(8, 10), 16),
            ]
          : expected.startsWith("indexed:")
            ? indexed(Number(expected.slice(8)))
            : rgb(fallback);
        return (
          actualRgb !== null &&
          expectedRgb !== null &&
          actualRgb.every((component, index) => component === expectedRgb[index])
        );
      };
      const expectedByRow = new Map();
      for (const cell of expectedCells) {
        const row = expectedByRow.get(cell.row) ?? new Map();
        row.set(cell.column, cell);
        expectedByRow.set(cell.row, row);
      }
      let domRowCountExact = rows.length === rendition?.rendererRows;
      let domTextExact = true;
      let domStyleExact = true;
      let domFirstMismatchRow = null;
      let domFirstMismatchColumn = null;
      let domFirstMismatchComponent = null;
      const mismatch = (row, column, component) => {
        if (domFirstMismatchComponent !== null) return;
        domFirstMismatchRow = Number.isSafeInteger(row) && row >= 0 && row <= 4_095 ? row : null;
        domFirstMismatchColumn =
          Number.isSafeInteger(column) && column >= 0 && column <= 4_095 ? column : null;
        domFirstMismatchComponent = component;
      };
      if (!domRowCountExact) mismatch(0, 0, "row-cardinality");
      const domRowsProjection = [];
      const themeForeground = rendition?.defaultForeground ?? "missing";
      const themeBackground = rendition?.defaultBackground ?? "missing";
      for (const [rowIndex, row] of rows.entries()) {
        const expectedRow = expectedByRow.get(rowIndex) ?? new Map();
        const actualCells = [];
        let column = 0;
        const walker = globalThis.document.createTreeWalker(row, globalThis.NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.nodeValue ?? "";
          const element = node.parentElement ?? row;
          if (text.length === 0) continue;
          const style = semanticCellStyle(element);
          const graphemes = [
            ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
          ];
          for (const { segment } of graphemes) {
            // xterm's DOM renderer uses NBSP for a buffer cell containing a
            // literal space so layout cannot collapse it. This is the one
            // renderer spelling that maps back to the canonical grapheme.
            const chars = segment === "\u00a0" ? " " : segment;
            // DomRenderer coalesces adjacent cells into one span and does not
            // expose wide-cell markers. Width is already independently proven
            // by the exact same renderer's canonical rendition; use that
            // bound cell only to advance this DOM text/style projection.
            const expectedAtColumn = expectedRow.get(column);
            const width = expectedAtColumn?.chars === chars ? expectedAtColumn.width : 1;
            const bold =
              Number.parseInt(style.fontWeight, 10) >= 600 || style.fontWeight === "bold";
            const italic = style.fontStyle !== "normal";
            const underline = style.textDecorationLine.includes("underline");
            const defaultSpace =
              chars === " " &&
              width === 1 &&
              colorExact(style.color, "default", themeForeground) &&
              colorExact(style.backgroundColor, "default", themeBackground, true) &&
              !bold &&
              !italic &&
              !underline;
            if (!defaultSpace)
              actualCells.push({ column, chars, width, style, bold, italic, underline });
            column += width;
          }
        }
        domRowsProjection.push({
          row: rowIndex,
          cells: actualCells.map(({ column, chars, width, style, bold, italic, underline }) => ({
            column,
            chars,
            width,
            style,
            bold,
            italic,
            underline,
          })),
        });
        const actualByColumn = new Map(actualCells.map((cell) => [cell.column, cell]));
        for (const expected of expectedRow.values()) {
          if (expected.width === 0 || expected.chars.length === 0) continue;
          const actual = actualByColumn.get(expected.column);
          if (!actual) {
            domTextExact = false;
            mismatch(rowIndex, expected.column, "cell-missing");
            continue;
          }
          if (actual.chars !== expected.chars) {
            domTextExact = false;
            mismatch(rowIndex, expected.column, "row-text");
          } else if (actual.width !== expected.width) {
            domTextExact = false;
            mismatch(rowIndex, expected.column, "width");
          }
          const component = !colorExact(actual.style.color, expected.foreground, themeForeground)
            ? "foreground"
            : !colorExact(actual.style.backgroundColor, expected.background, themeBackground, true)
              ? "background"
              : actual.bold !== expected.bold
                ? "bold"
                : actual.italic !== expected.italic
                  ? "italic"
                  : actual.underline !== expected.underline
                    ? "underline"
                    : null;
          if (component) {
            domStyleExact = false;
            mismatch(rowIndex, expected.column, component);
          }
          actualByColumn.delete(expected.column);
        }
        if (actualByColumn.size > 0) {
          domTextExact = false;
          mismatch(rowIndex, Math.min(...actualByColumn.keys()), "row-text");
        }
      }
      const domSemanticExact = domRowCountExact && domTextExact && domStyleExact;
      const screen = surface.querySelector(".xterm-screen") ?? surface;
      const screenRect = screen.getBoundingClientRect();
      const surfaceRect = surface.getBoundingClientRect();
      const rendererCols = rendition?.rendererCols;
      const rendererRows = rendition?.rendererRows;
      const rawCursorProjection = cursor
        ? JSON.stringify({
            className: cursor.className,
            left: Math.round((cursorRect.left - surfaceRect.left) * 1_000) / 1_000,
            top: Math.round((cursorRect.top - surfaceRect.top) * 1_000) / 1_000,
            width: Math.round(cursorRect.width * 1_000) / 1_000,
            height: Math.round(cursorRect.height * 1_000) / 1_000,
            backgroundColor: globalThis.getComputedStyle(cursor).backgroundColor,
          })
        : "missing";
      const domCursorProjection = cursor
        ? JSON.stringify({
            row:
              Number.isSafeInteger(rendererRows) && rendererRows > 0 && screenRect.height > 0
                ? Math.round(((cursorRect.top - screenRect.top) * rendererRows) / screenRect.height)
                : -1,
            column:
              Number.isSafeInteger(rendererCols) && rendererCols > 0 && screenRect.width > 0
                ? Math.round(
                    ((cursorRect.left - screenRect.left) * rendererCols) / screenRect.width,
                  )
                : -1,
            classes: [...cursor.classList].filter((name) => name.startsWith("xterm-cursor")).sort(),
          })
        : "missing";
      const domCursorClasses = cursor
        ? [...cursor.classList].filter((name) => name.startsWith("xterm-cursor"))
        : [];
      const domCursorRow =
        cursor && Number.isSafeInteger(rendererRows) && rendererRows > 0 && screenRect.height > 0
          ? Math.round(((cursorRect.top - screenRect.top) * rendererRows) / screenRect.height)
          : -1;
      const domCursorColumn =
        cursor && Number.isSafeInteger(rendererCols) && rendererCols > 0 && screenRect.width > 0
          ? Math.round(((cursorRect.left - screenRect.left) * rendererCols) / screenRect.width)
          : -1;
      const domCursorExact = expectedDomCursor.hidden
        ? cursor === null && allCursors.length === 0
        : cursor !== null &&
          domCursorRow === expectedDomCursor.y &&
          domCursorColumn === expectedDomCursor.x &&
          domCursorClasses.includes(`xterm-cursor-${expectedDomCursor.style}`) &&
          domCursorClasses.includes("xterm-cursor-blink") === expectedDomCursor.blink;
      return {
        stage: expectedStage,
        semanticPaneHmac: await hmac("pane", expectedPane),
        generationHmac: await hmac("generation", canonical?.generation ?? "missing"),
        incarnationHmac: await hmac("incarnation", canonical?.incarnation ?? "missing"),
        stateHmac: await hmac("state", canonical?.stateHash ?? "missing"),
        deliveryRequestHmac: await hmac(
          "delivery-request",
          canonical?.deliveryRequestId ?? "missing",
        ),
        rowsHmac: await hmac("web-rows", rows.map((row) => row.innerHTML).join("\n")),
        cursorHmac: await hmac("web-cursor", rawCursorProjection),
        domRowsHmac: await hmac("web-dom-rendition", JSON.stringify(domRowsProjection)),
        domCursorHmac: await hmac("web-dom-cursor", domCursorProjection),
        domSemanticExact,
        domRowCountExact,
        domTextExact,
        domStyleExact,
        domFirstMismatchRow,
        domFirstMismatchColumn,
        domFirstMismatchComponent,
        domCursorExact,
        renditionHmac: rendition?.renditionHmac ?? null,
        positionWrappedHmac: rendition?.positionWrappedHmac ?? null,
        graphemeWidthHmac: rendition?.graphemeWidthHmac ?? null,
        colorHmac: rendition?.colorHmac ?? null,
        attributesHmac: rendition?.attributesHmac ?? null,
        cellHmacs: Array.isArray(rendition?.cellHmacs) ? rendition.cellHmacs.slice(0, 256) : null,
        rendererCols: rendition?.rendererCols ?? -1,
        rendererRows: rendition?.rendererRows ?? -1,
        renditionCellCount: rendition?.renditionCellCount ?? -1,
        wideContinuationCount: rendition?.wideContinuationCount ?? -1,
        combiningCount: rendition?.combiningCount ?? -1,
        styledCellCount: rendition?.styledCellCount ?? -1,
        rowCount: rows.length,
        cursorCount: allCursors.length,
        cursorVisible: cursor !== null,
        activeBuffer: presentation?.activeBuffer ?? null,
        cursorX: presentation?.cursorX ?? -1,
        cursorY: presentation?.cursorY ?? -1,
        cursorHidden: presentation?.cursorHidden ?? null,
        cursorStyle: presentation?.cursorStyle ?? null,
        cursorBlink: presentation?.cursorBlink ?? null,
        revision: canonical?.revision ?? -1,
        sourceEpoch: canonical?.sourceEpoch ?? -1,
        rendererEpoch: canonical?.rendererEpoch ?? -1,
        cols: canonical?.cols ?? -1,
        rows: canonical?.rows ?? -1,
        gridRowsRead: canonical?.gridRowsRead ?? -1,
        gridCellsRead: canonical?.gridCellsRead ?? -1,
        fullGridWalks: canonical?.fullGridWalks ?? -1,
        canonicalBuffer: canonical ? (canonical.alternateScreen ? "alternate" : "normal") : null,
        canonicalCursorX: canonical?.cursor.x ?? -1,
        canonicalCursorY: canonical?.cursor.y ?? -1,
        canonicalCursorHidden: canonical?.cursor.hidden ?? null,
        canonicalCursorStyle: canonical?.cursor.style ?? null,
        canonicalCursorBlink: canonical?.cursor.blink ?? null,
      };
    },
    {
      evidenceKey: keyHex,
      expectedStage: stage,
      expectedPane: semanticPaneId,
      expectedCells: expectedRendition,
      expectedDomCursor: expectedCursor,
    },
  );
}

function exactStage(value, expected) {
  const keys = [
    "processHmac",
    "clockId",
    "clockKind",
    "paneHmac",
    "generationHmac",
    "incarnationHmac",
    "revision",
    "stateHmac",
    "presentationHmac",
    "canonicalCols",
    "canonicalRows",
    "viewportCols",
    "viewportRows",
    "sourceEpoch",
    "rendererEpoch",
    "alternateScreen",
    "cursor",
    "framebufferHmac",
    "framebufferCellCount",
    "framebufferWideContinuationCount",
    "framebufferCombiningCount",
    "framebufferStyledCellCount",
    "gridRowsReadTotal",
    "fullWalkTotal",
    "presentationCount",
  ];
  return (
    exactKeys(value, keys) &&
    exactKeys(expected, keys) &&
    exactKeys(value?.cursor, ["x", "y", "hidden", "style", "blink"]) &&
    exactKeys(expected?.cursor, ["x", "y", "hidden", "style", "blink"]) &&
    exactIdentity(value, expected) &&
    value?.alternateScreen === expected?.alternateScreen &&
    value?.cursor?.hidden === expected?.cursor?.hidden &&
    value?.cursor?.style === expected?.cursor?.style &&
    value?.cursor?.blink === expected?.cursor?.blink &&
    Number.isSafeInteger(value?.cursor?.x) &&
    Number.isSafeInteger(value?.cursor?.y) &&
    value.cursor.x >= 0 &&
    value.cursor.x === expected?.cursor?.x &&
    value.cursor.y >= 0 &&
    value.cursor.y === expected?.cursor?.y &&
    value.cursor.x < value.viewportCols &&
    value.cursor.y < value.viewportRows &&
    value?.framebufferHmac === expected?.framebufferHmac &&
    value?.framebufferCellCount === expected?.framebufferCellCount &&
    value?.framebufferWideContinuationCount === expected?.framebufferWideContinuationCount &&
    value?.framebufferCombiningCount === expected?.framebufferCombiningCount &&
    value?.framebufferStyledCellCount === expected?.framebufferStyledCellCount &&
    Number.isSafeInteger(value?.gridRowsReadTotal) &&
    value.gridRowsReadTotal >= 0 &&
    value.gridRowsReadTotal === expected?.gridRowsReadTotal &&
    Number.isSafeInteger(value?.fullWalkTotal) &&
    value.fullWalkTotal >= 0 &&
    value.fullWalkTotal === expected?.fullWalkTotal &&
    Number.isSafeInteger(value?.presentationCount) &&
    value.presentationCount >= 1 &&
    value.presentationCount === expected?.presentationCount
  );
}

function exactPreAlternate(value, expected, evidence) {
  const sample = value?.sample;
  const causal = sample?.causal;
  const counters = value?.counters;
  const cardinality = value?.cardinality;
  const predecessor = value?.predecessor;
  const native = value?.native;
  const cursorLast = evidence?.cursorSamples?.at(-1);
  const identityKeys = [
    "processHmac",
    "clockId",
    "clockKind",
    "paneHmac",
    "generationHmac",
    "incarnationHmac",
    "revision",
    "stateHmac",
    "presentationHmac",
    "canonicalCols",
    "canonicalRows",
    "viewportCols",
    "viewportRows",
    "sourceEpoch",
    "rendererEpoch",
  ];
  const counterFields = [
    "beforeGridRowsReadTotal",
    "afterGridRowsReadTotal",
    "beforeFullWalkTotal",
    "afterFullWalkTotal",
    "beforePresentationCount",
    "afterPresentationCount",
    "gridRowsReadDelta",
    "fullWalkDelta",
    "presentationCountDelta",
  ];
  const safeCounter = (number) =>
    Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000_000;
  return (
    exactKeys(value, ["stage", "sample", "cardinality", "predecessor", "counters", "native"]) &&
    exactKeys(expected, [
      "stage",
      "predecessorRevision",
      "predecessorStateHmac",
      "presentationHmac",
      "framebufferHmac",
      "nativeCaptureHmac",
      "cursor",
      "beforeGridRowsReadTotal",
      "afterGridRowsReadTotal",
      "beforeFullWalkTotal",
      "afterFullWalkTotal",
      "beforePresentationCount",
      "afterPresentationCount",
      "gridRowsReadDelta",
      "fullWalkDelta",
      "presentationCountDelta",
      "daemonProcessHmac",
      "daemonClockId",
    ]) &&
    exactStage(value?.stage, expected?.stage) &&
    exactKeys(expected?.cursor, ["x", "y", "hidden", "style", "blink"]) &&
    exactKeys(predecessor, ["revision", "stateHmac"]) &&
    predecessor?.revision === expected?.predecessorRevision &&
    predecessor?.revision === cursorLast?.presentation?.revision &&
    predecessor?.stateHmac === expected?.predecessorStateHmac &&
    predecessor?.stateHmac === cursorLast?.presentation?.stateHmac &&
    Number.isSafeInteger(value?.stage?.revision) &&
    value.stage.revision === predecessor.revision + 1 &&
    value.stage.processHmac === evidence?.baseline?.processHmac &&
    value.stage.clockId === evidence?.baseline?.clockId &&
    value.stage.clockKind === evidence?.baseline?.clockKind &&
    value.stage.paneHmac === evidence?.baseline?.paneHmac &&
    value.stage.generationHmac === evidence?.baseline?.generationHmac &&
    value.stage.incarnationHmac === evidence?.baseline?.incarnationHmac &&
    value.stage.canonicalCols === evidence?.baseline?.canonicalCols &&
    value.stage.canonicalRows === evidence?.baseline?.canonicalRows &&
    value.stage.viewportCols === evidence?.baseline?.viewportCols &&
    value.stage.viewportRows === evidence?.baseline?.viewportRows &&
    value.stage.sourceEpoch === evidence?.baseline?.sourceEpoch &&
    value.stage.rendererEpoch === evidence?.baseline?.rendererEpoch &&
    value.stage.stateHmac === evidence?.baseline?.stateHmac &&
    value.stage.presentationHmac === expected?.presentationHmac &&
    value.stage.presentationHmac === evidence?.baseline?.presentationHmac &&
    value.stage.framebufferHmac === expected?.framebufferHmac &&
    value.stage.alternateScreen === false &&
    Object.entries(expected.cursor).every(([field, expectedValue]) =>
      Object.is(value.stage.cursor[field], expectedValue),
    ) &&
    exactKeys(cardinality, ["mode", "presentation", "frame", "fence", "traced"]) &&
    cardinality?.mode === 1 &&
    cardinality?.presentation === 1 &&
    cardinality?.frame === 1 &&
    cardinality?.fence === 1 &&
    cardinality?.traced === true &&
    exactKeys(counters, counterFields) &&
    counterFields.every((field) => safeCounter(counters?.[field])) &&
    counters.gridRowsReadDelta === expected?.gridRowsReadDelta &&
    counters.fullWalkDelta === expected?.fullWalkDelta &&
    counters.presentationCountDelta === expected?.presentationCountDelta &&
    counters.beforeGridRowsReadTotal === expected?.beforeGridRowsReadTotal &&
    counters.afterGridRowsReadTotal === expected?.afterGridRowsReadTotal &&
    counters.beforeFullWalkTotal === expected?.beforeFullWalkTotal &&
    counters.afterFullWalkTotal === expected?.afterFullWalkTotal &&
    counters.beforePresentationCount === expected?.beforePresentationCount &&
    counters.afterPresentationCount === expected?.afterPresentationCount &&
    counters.afterGridRowsReadTotal - counters.beforeGridRowsReadTotal ===
      counters.gridRowsReadDelta &&
    counters.afterFullWalkTotal - counters.beforeFullWalkTotal === counters.fullWalkDelta &&
    counters.afterPresentationCount - counters.beforePresentationCount ===
      counters.presentationCountDelta &&
    exactKeys(native, [
      "paneCount",
      "matchCount",
      "mappingExact",
      "geometryExact",
      "captureHmac",
    ]) &&
    native?.paneCount === 1 &&
    native?.matchCount === 1 &&
    native?.mappingExact === true &&
    native?.geometryExact === true &&
    SHA256.test(native?.captureHmac ?? "") &&
    native.captureHmac === expected?.nativeCaptureHmac &&
    exactKeys(sample, [
      "startedAtMicros",
      "presentedAtMicros",
      "frameAtMicros",
      "fenceAtMicros",
      "durationMicros",
      "traceHmac",
      "gestureHmac",
      "causal",
      "action",
      "cursor",
      "presentation",
      "frame",
      "fence",
    ]) &&
    sample?.action === "pre-alternate-normal" &&
    SHA256.test(sample?.traceHmac ?? "") &&
    SHA256.test(sample?.gestureHmac ?? "") &&
    safeMicros(sample?.durationMicros) &&
    safeTimestamp(sample?.startedAtMicros) &&
    safeTimestamp(sample?.presentedAtMicros) &&
    safeTimestamp(sample?.frameAtMicros) &&
    safeTimestamp(sample?.fenceAtMicros) &&
    sample.startedAtMicros <= sample.presentedAtMicros &&
    sample.presentedAtMicros <= sample.frameAtMicros &&
    sample.frameAtMicros <= sample.fenceAtMicros &&
    sample.durationMicros === sample.fenceAtMicros - sample.startedAtMicros &&
    exactKeys(causal, [
      "dirtyRows",
      "gridRowsReadDelta",
      "fullWalkDelta",
      "presentationCountDelta",
      "inputAccepted",
      "canonicalReceiptExact",
      "daemonStageCount",
      "daemonProcessHmac",
      "daemonClockId",
    ]) &&
    Array.isArray(causal?.dirtyRows) &&
    causal.dirtyRows.length === 0 &&
    causal.gridRowsReadDelta === counters.gridRowsReadDelta &&
    causal.fullWalkDelta === counters.fullWalkDelta &&
    causal.presentationCountDelta === counters.presentationCountDelta &&
    causal.inputAccepted === true &&
    causal.canonicalReceiptExact === true &&
    causal.daemonStageCount === ANSI_DAEMON_STAGES.length &&
    SHA256.test(causal?.daemonProcessHmac ?? "") &&
    causal.daemonProcessHmac === expected?.daemonProcessHmac &&
    causal.daemonProcessHmac === cursorLast?.causal?.daemonProcessHmac &&
    boundedIdentity(causal?.daemonClockId) &&
    causal.daemonClockId === expected?.daemonClockId &&
    causal.daemonClockId === cursorLast?.causal?.daemonClockId &&
    exactKeys(sample?.cursor, ["x", "y", "hidden", "canonicalStyle", "rendererStyle", "blink"]) &&
    sample.cursor.x === expected.cursor.x &&
    sample.cursor.y === expected.cursor.y &&
    sample.cursor.hidden === expected.cursor.hidden &&
    sample.cursor.canonicalStyle === expected.cursor.style &&
    sample.cursor.rendererStyle === expected.cursor.style &&
    sample.cursor.blink === expected.cursor.blink &&
    exactKeys(sample?.presentation, [
      ...identityKeys,
      "gridWalked",
      "gridRowsRead",
      "fullWalk",
      "gridRowsReadTotal",
      "fullWalkTotal",
      "presentationCount",
    ]) &&
    exactIdentity(sample.presentation, expected.stage) &&
    sample.presentation.gridWalked === true &&
    sample.presentation.gridRowsRead === expected.gridRowsReadDelta &&
    sample.presentation.fullWalk === false &&
    sample.presentation.gridRowsReadTotal === counters.afterGridRowsReadTotal &&
    sample.presentation.fullWalkTotal === counters.afterFullWalkTotal &&
    sample.presentation.presentationCount === counters.afterPresentationCount &&
    exactKeys(sample?.frame, identityKeys) &&
    exactIdentity(sample.frame, expected.stage) &&
    exactKeys(sample?.fence, identityKeys) &&
    exactIdentity(sample.fence, expected.stage)
  );
}

export function assessAnsiCursorAltScreenEvidence(evidence, expected) {
  const topLevelExact =
    exactKeys(evidence, [
      "baseline",
      "rich",
      "cursorSamples",
      "preAlternate",
      "alternate",
      "restored",
      "workload",
      "workloadFinalities",
      "resourceSamples",
      "resourceLifecycle",
      "idle",
      "web",
      "tmux",
      "writer",
    ]) &&
    exactKeys(expected, [
      "baseline",
      "rich",
      "cursorSamples",
      "preAlternate",
      "alternate",
      "restored",
      "normalBeforeAlternateHmac",
      "workloadFinalities",
      "resourceSamples",
      "resourceLifecycle",
      "web",
    ]);
  const distribution = assessAnsiCursorPresentationSamples(
    evidence?.cursorSamples,
    expected?.cursorSamples,
  );
  const baseline = exactStage(evidence?.baseline, expected?.baseline);
  const rich = exactStage(evidence?.rich, expected?.rich);
  const preAlternate = exactPreAlternate(evidence?.preAlternate, expected?.preAlternate, evidence);
  const alternate = exactStage(evidence?.alternate, expected?.alternate);
  const restored = exactStage(evidence?.restored, expected?.restored);
  const restoreExact =
    restored &&
    preAlternate &&
    evidence?.restored?.alternateScreen === false &&
    evidence.restored.presentationHmac === expected?.restored?.presentationHmac &&
    evidence.restored.presentationHmac === evidence?.preAlternate?.stage?.presentationHmac &&
    evidence.restored.stateHmac === evidence?.preAlternate?.stage?.stateHmac &&
    expected?.restored?.presentationHmac === expected?.normalBeforeAlternateHmac;
  const workload = evidence?.workload;
  const workloadFinalities = assessAnsiWorkloadFinalitySamples(
    evidence?.workloadFinalities,
    expected?.workloadFinalities,
  );
  const resources = assessAnsiQuiescentResourceSamples(
    evidence?.resourceSamples,
    expected?.resourceSamples,
  );
  const resourceLifecycle = assessAnsiResourceLifecycle(
    evidence?.resourceLifecycle,
    expected?.resourceLifecycle,
  );
  const workloadShapeExact = exactKeys(workload, [
    "cycleCount",
    "conditioningCycleCount",
    "measuredCycleCount",
    "bytes",
    "maxQueueDepth",
    "settledDeliveryQueueDepth",
    "representationCacheBytes",
    "rawJournalBytes",
    "eventLoopP99Ms",
    "finalityCycleCount",
    "markerCount",
    "stableTailMs",
    "finalityExact",
    "drainExact",
    "faulted",
    "rebound",
  ]);
  const workloadPredicates = Object.freeze({
    resourceSamplesExact: resources.qualified,
    resourceLifecycleExact: resourceLifecycle.qualified,
    workloadFinalitiesExact: workloadFinalities.qualified,
    workloadShapeExact,
    workloadCountsExact:
      workload?.cycleCount === 24 &&
      workload?.conditioningCycleCount === 8 &&
      workload?.measuredCycleCount === 16 &&
      workload?.finalityCycleCount === 24 &&
      workload?.markerCount === 24,
    workloadBytesExact:
      Number.isSafeInteger(workload?.bytes) &&
      workload.bytes >= 1_048_576 &&
      workload.bytes <= 64 * 1_048_576,
    workloadQueueExact:
      Number.isSafeInteger(workload?.maxQueueDepth) &&
      workload.maxQueueDepth <= 64 &&
      workload?.settledDeliveryQueueDepth === 0,
    workloadCacheExact:
      Number.isSafeInteger(workload?.representationCacheBytes) &&
      workload.representationCacheBytes >= 0 &&
      workload.representationCacheBytes <= 16_777_216,
    workloadJournalExact:
      Number.isSafeInteger(workload?.rawJournalBytes) &&
      workload.rawJournalBytes >= 0 &&
      workload.rawJournalBytes <= 4_194_304,
    workloadEventLoopExact:
      Number.isFinite(workload?.eventLoopP99Ms) &&
      workload.eventLoopP99Ms <= TUI_EVENT_LOOP_WORKLOAD_P99_CEILING_MS,
    workloadFinalStateExact:
      workload?.stableTailMs === 40 &&
      workload?.finalityExact === true &&
      workload?.drainExact === true &&
      workload?.faulted === false &&
      workload?.rebound === false,
  });
  const workloadExact = Object.values(workloadPredicates).every(Boolean);
  const idleExact =
    exactKeys(evidence?.idle, [
      "durationMs",
      "frameCount",
      "paintCount",
      "gridRowsReadDelta",
      "fullWalkDelta",
      "presentationCountDelta",
      "framebufferHmacBefore",
      "framebufferHmacAfter",
      "queueDepth",
      "resourceExact",
      "resourceSampleOrdinal",
      "resourceEpochArmed",
      "resourceEpochIdentityHmac",
      "lowWaterFirstSampleOrdinal",
      "lowWaterLastSampleOrdinal",
      "lowWaterSampleCount",
      "lowWaterWindowMicros",
      "resourceProcessHmac",
      "resourceClockId",
      "resourceClockKind",
      "resourceAtMicros",
      "resourceIdentityHmac",
      "resourceStateHmac",
      "resourceInputPending",
      "resourceInputInFlight",
      "resourceInputPendingBytes",
      "resourceInputPendingPeak",
      "resourceInputInFlightPeak",
      "resourceInputPendingBytesPeak",
      "resourceSamplingFailureCount",
      "rssBytes",
      "heapUsedBytes",
      "eventLoopDelayMicros",
      "rssPeakBytes",
      "heapUsedPeakBytes",
      "eventLoopDelayPeakMicros",
      "eventLoopDelayPeakSource",
      "idleRetainedSampleCount",
      "idleRetainedRssSlopeBytesPerSample",
      "idleRetainedHeapSlopeBytesPerSample",
      "idleRetainedRssGrowthBytes",
      "idleRetainedHeapGrowthBytes",
      "idleRetainedRssHighBytes",
      "idleRetainedHeapHighBytes",
      "idleRetainedFirstInvalidOrdinal",
      "idleRetainedFirstInvalidPredicate",
    ]) &&
    Number.isSafeInteger(evidence?.idle?.durationMs) &&
    evidence.idle.durationMs >= 10_000 &&
    evidence.idle.durationMs <= 12_000 &&
    evidence?.idle?.frameCount === 0 &&
    evidence?.idle?.paintCount === 0 &&
    evidence?.idle?.gridRowsReadDelta === 0 &&
    evidence?.idle?.fullWalkDelta === 0 &&
    evidence?.idle?.presentationCountDelta === 0 &&
    SHA256.test(evidence?.idle?.framebufferHmacBefore ?? "") &&
    evidence.idle.framebufferHmacBefore === evidence.idle.framebufferHmacAfter &&
    evidence?.idle?.queueDepth === 0 &&
    evidence?.idle?.resourceExact === true &&
    Number.isSafeInteger(evidence?.idle?.resourceSampleOrdinal) &&
    evidence.idle.resourceSampleOrdinal >= 1 &&
    evidence.idle.resourceSampleOrdinal <= 512 &&
    evidence?.idle?.resourceEpochArmed === true &&
    evidence?.idle?.lowWaterFirstSampleOrdinal === 1 &&
    evidence?.idle?.lowWaterLastSampleOrdinal === 1 &&
    evidence?.idle?.lowWaterSampleCount === 1 &&
    evidence?.idle?.lowWaterWindowMicros === 0 &&
    SHA256.test(evidence?.idle?.resourceEpochIdentityHmac ?? "") &&
    evidence.idle.resourceEpochIdentityHmac ===
      evidence?.resourceLifecycle?.[0]?.resourceEpochIdentityHmac &&
    evidence?.idle?.resourceProcessHmac === evidence?.baseline?.processHmac &&
    evidence?.idle?.resourceClockId === evidence?.baseline?.clockId &&
    evidence?.idle?.resourceClockKind === "performance-now" &&
    safeTimestamp(evidence?.idle?.resourceAtMicros) &&
    SHA256.test(evidence?.idle?.resourceIdentityHmac ?? "") &&
    SHA256.test(evidence?.idle?.resourceStateHmac ?? "") &&
    evidence?.idle?.resourceInputPending === 0 &&
    evidence?.idle?.resourceInputInFlight === 0 &&
    evidence?.idle?.resourceInputPendingBytes === 0 &&
    evidence?.idle?.resourceInputPendingPeak === 0 &&
    evidence?.idle?.resourceInputInFlightPeak === 0 &&
    evidence?.idle?.resourceInputPendingBytesPeak === 0 &&
    evidence?.idle?.resourceSamplingFailureCount === 0 &&
    Number.isSafeInteger(evidence?.idle?.rssBytes) &&
    evidence.idle.rssBytes >= 0 &&
    evidence.idle.rssBytes <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
    Number.isSafeInteger(evidence?.idle?.rssPeakBytes) &&
    evidence.idle.rssPeakBytes >= evidence.idle.rssBytes &&
    evidence.idle.rssPeakBytes <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
    Number.isSafeInteger(evidence?.idle?.heapUsedBytes) &&
    evidence.idle.heapUsedBytes >= 0 &&
    evidence.idle.heapUsedBytes <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES &&
    Number.isSafeInteger(evidence?.idle?.heapUsedPeakBytes) &&
    evidence.idle.heapUsedPeakBytes >= evidence.idle.heapUsedBytes &&
    evidence.idle.heapUsedPeakBytes <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES &&
    Number.isSafeInteger(evidence?.idle?.eventLoopDelayMicros) &&
    evidence.idle.eventLoopDelayMicros >= 0 &&
    evidence.idle.eventLoopDelayMicros <= ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS &&
    Number.isSafeInteger(evidence?.idle?.eventLoopDelayPeakMicros) &&
    evidence.idle.eventLoopDelayPeakMicros >= evidence.idle.eventLoopDelayMicros &&
    evidence.idle.eventLoopDelayPeakMicros <=
      ANSI_TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS &&
    new Set(["heartbeat", "endpoint"]).has(evidence?.idle?.eventLoopDelayPeakSource) &&
    evidence?.idle?.idleRetainedSampleCount === 8 &&
    Number.isFinite(evidence?.idle?.idleRetainedRssSlopeBytesPerSample) &&
    evidence.idle.idleRetainedRssSlopeBytesPerSample <= 262_144 &&
    Number.isFinite(evidence?.idle?.idleRetainedHeapSlopeBytesPerSample) &&
    evidence.idle.idleRetainedHeapSlopeBytesPerSample <= 131_072 &&
    Number.isSafeInteger(evidence?.idle?.idleRetainedRssGrowthBytes) &&
    evidence.idle.idleRetainedRssGrowthBytes <= 67_108_864 &&
    Number.isSafeInteger(evidence?.idle?.idleRetainedHeapGrowthBytes) &&
    evidence.idle.idleRetainedHeapGrowthBytes <= 33_554_432 &&
    Number.isSafeInteger(evidence?.idle?.idleRetainedRssHighBytes) &&
    evidence.idle.idleRetainedRssHighBytes <= ANSI_TUI_RSS_ABSOLUTE_CEILING_BYTES &&
    Number.isSafeInteger(evidence?.idle?.idleRetainedHeapHighBytes) &&
    evidence.idle.idleRetainedHeapHighBytes <= ANSI_TUI_HEAP_ABSOLUTE_CEILING_BYTES &&
    evidence?.idle?.idleRetainedFirstInvalidOrdinal === null &&
    evidence?.idle?.idleRetainedFirstInvalidPredicate === null;
  const web = ansiCursorWebEvidence(evidence?.web, expected?.web);
  const writerExact =
    exactKeys(evidence?.writer, [
      "droppedRecords",
      "oversizedRecords",
      "failed",
      "pendingCriticalRecords",
    ]) &&
    evidence?.writer?.droppedRecords === 0 &&
    evidence?.writer?.oversizedRecords === 0 &&
    evidence?.writer?.failed === false &&
    evidence?.writer?.pendingCriticalRecords === 0;
  const tmuxExact =
    exactKeys(evidence?.tmux, [
      "paneCount",
      "geometryStable",
      "markerExact",
      "baselineCaptureHmac",
      "alternateCaptureHmac",
      "alternateGeometryStable",
      "alternateMarkerAbsent",
      "alternateCursorExact",
      "finalCaptureHmac",
    ]) &&
    evidence?.tmux?.paneCount === 1 &&
    evidence?.tmux?.geometryStable === true &&
    evidence?.tmux?.markerExact === true &&
    SHA256.test(evidence?.tmux?.baselineCaptureHmac ?? "") &&
    SHA256.test(evidence?.tmux?.alternateCaptureHmac ?? "") &&
    evidence.tmux.alternateCaptureHmac !== evidence.tmux.baselineCaptureHmac &&
    evidence?.tmux?.alternateGeometryStable === true &&
    evidence?.tmux?.alternateMarkerAbsent === true &&
    evidence?.tmux?.alternateCursorExact === true &&
    evidence.tmux.baselineCaptureHmac === evidence.tmux.finalCaptureHmac;
  const cursorCounterContinuity = Array.isArray(evidence?.cursorSamples)
    ? evidence.cursorSamples.every((sample, index) => {
        const prior =
          index === 0 ? evidence?.rich : evidence.cursorSamples[index - 1]?.presentation;
        return (
          sample?.presentation?.gridRowsReadTotal === prior?.gridRowsReadTotal &&
          sample?.presentation?.fullWalkTotal === prior?.fullWalkTotal &&
          sample?.presentation?.presentationCount === prior?.presentationCount + 1
        );
      })
    : false;
  const counterContinuityExact =
    baseline &&
    rich &&
    preAlternate &&
    alternate &&
    restored &&
    evidence.baseline.gridRowsReadTotal === evidence.baseline.viewportRows &&
    evidence.baseline.fullWalkTotal === 1 &&
    evidence.baseline.presentationCount === 1 &&
    evidence.rich.gridRowsReadTotal === evidence.baseline.gridRowsReadTotal + 3 &&
    evidence.rich.fullWalkTotal === evidence.baseline.fullWalkTotal &&
    evidence.rich.presentationCount === evidence.baseline.presentationCount + 1 &&
    cursorCounterContinuity &&
    evidence.preAlternate.counters.beforeGridRowsReadTotal ===
      evidence.cursorSamples.at(-1)?.presentation?.gridRowsReadTotal &&
    evidence.preAlternate.counters.beforeFullWalkTotal ===
      evidence.cursorSamples.at(-1)?.presentation?.fullWalkTotal &&
    evidence.preAlternate.counters.beforePresentationCount ===
      evidence.cursorSamples.at(-1)?.presentation?.presentationCount &&
    evidence.alternate.gridRowsReadTotal ===
      evidence.preAlternate.counters.afterGridRowsReadTotal + evidence.alternate.viewportRows &&
    evidence.alternate.fullWalkTotal === evidence.preAlternate.counters.afterFullWalkTotal &&
    evidence.alternate.presentationCount ===
      evidence.preAlternate.counters.afterPresentationCount + 1 &&
    evidence.restored.gridRowsReadTotal ===
      evidence.alternate.gridRowsReadTotal + evidence.restored.viewportRows &&
    evidence.restored.fullWalkTotal === evidence.alternate.fullWalkTotal &&
    evidence.restored.presentationCount === evidence.alternate.presentationCount + 1;
  const lineageExact =
    baseline &&
    rich &&
    preAlternate &&
    alternate &&
    restored &&
    [evidence.rich, evidence.preAlternate.stage, evidence.alternate, evidence.restored].every(
      (stage) =>
        stage.generationHmac === evidence.baseline.generationHmac &&
        stage.incarnationHmac === evidence.baseline.incarnationHmac &&
        stage.sourceEpoch === evidence.baseline.sourceEpoch &&
        stage.rendererEpoch === evidence.baseline.rendererEpoch &&
        stage.revision > evidence.baseline.revision,
    ) &&
    evidence.rich.revision < evidence.preAlternate.stage.revision &&
    evidence.preAlternate.stage.revision + 1 === evidence.alternate.revision &&
    evidence.alternate.revision + 1 === evidence.restored.revision;
  const predicates = Object.freeze({
    topLevelExact,
    baselineExact: baseline,
    richExact: rich,
    cursorDistributionExact: distribution.qualified,
    preAlternateExact: preAlternate,
    counterContinuityExact,
    alternateExact: alternate,
    restoreExact,
    lineageExact,
    workloadExact,
    idleExact,
    webExact: web.qualified,
    tmuxExact,
    writerExact,
  });
  return Object.freeze({
    qualified: Object.values(predicates).every(Boolean),
    predicates,
    distribution,
    workloadFinalities,
    resources,
    resourceLifecycle,
    workloadPredicates,
    web,
  });
}

export function ansiCursorAltJourneyStatus({ timeline, assessment, correlationComplete }) {
  const required = [
    "ansi-normal-baseline",
    "ansi-rich-presentation",
    "ansi-cursor-only-distribution",
    "ansi-alternate-screen",
    "ansi-normal-restored",
    "ansi-sustained-workload",
    "ansi-idle-quiescent",
    "ansi-web-correlation",
  ];
  const observed =
    Array.isArray(timeline) && timeline.length <= 4_096
      ? timeline.map(({ phase }) => phase).filter((phase) => required.includes(phase))
      : [];
  const orderedExact =
    observed.length === required.length &&
    observed.every((phase, index) => phase === required[index]);
  const boundaries = required.map((id) =>
    Object.freeze({
      id,
      status: orderedExact || observed.indexOf(id) === required.indexOf(id) ? "passed" : "failed",
    }),
  );
  if (!orderedExact) {
    const mismatch = required.findIndex((phase, index) => observed[index] !== phase);
    const firstFailedIndex = mismatch >= 0 ? mismatch : required.length - 1;
    for (let index = firstFailedIndex; index < boundaries.length; index += 1)
      boundaries[index] = Object.freeze({ id: boundaries[index].id, status: "failed" });
  }
  boundaries.push(
    Object.freeze({
      id: "ansi-causal-proof",
      status: assessment?.qualified === true ? "passed" : "failed",
    }),
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete === true ? "passed" : "failed",
    }),
  );
  const firstBrokenBoundary = boundaries.find(({ status }) => status !== "passed")?.id ?? null;
  return Object.freeze({
    status: firstBrokenBoundary === null ? "passed" : "failed",
    firstBrokenBoundary,
    firstUnmeasuredBoundary: null,
    boundaries: Object.freeze(boundaries),
  });
}
