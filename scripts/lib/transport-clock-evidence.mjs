import { clockBounds } from "./transport-clock-bounds.mjs";

const CLIENT = [
  "pane-stream-socket-send-return",
  "pane-stream-input-ack-callback",
  "socket-frame-arrival",
];
const DAEMON = [
  "pane-stream-socket-message-callback-entry",
  "pane-stream-input-ack-socket-send",
  "pane-stream-socket-send",
];
const CALIBRATION = [
  "clockCalibrationRequestId",
  "clockOffsetLowerMicros",
  "clockOffsetUpperMicros",
  "clockUncertaintyMicros",
  "clockCalibratedAtMicros",
];
const safe = (n) => Number.isSafeInteger(n) && n >= 0;
const text = (s) => typeof s === "string" && s.length > 0;
const uuid = (s) =>
  typeof s === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(s);

// Input files must already have passed their respective integrity/owner-close admissions.
// Expected identities come from those admissions, never from a first matching stage.
// This admits associations and bounded transport-edge intervals, not application causality.
export function assessTransportClockEvidence({ clientRecords, daemonRecords, traceIds, expected }) {
  const samples = [];
  const fail = (reason) => ({
    status: "incomplete",
    reason,
    suppliedTraceCount: Array.isArray(traceIds) ? traceIds.length : null,
    samples,
    missionBoundaryVerdict: "not-measured",
    scope: "Instrumented transport edges only; not pure network latency or six-boundary acceptance",
  });
  if (
    !Array.isArray(clientRecords) ||
    !Array.isArray(daemonRecords) ||
    !Array.isArray(traceIds) ||
    traceIds.length === 0 ||
    traceIds.some((id) => !uuid(id)) ||
    new Set(traceIds).size !== traceIds.length ||
    !text(expected?.generation) ||
    !text(expected?.client?.processId) ||
    !text(expected?.client?.clockId) ||
    !text(expected?.daemon?.processId) ||
    !text(expected?.daemon?.clockId) ||
    expected.client.processId === expected.daemon.processId ||
    expected.client.clockKind !== "performance-now" ||
    expected.daemon.clockKind !== "performance-now"
  )
    return fail("invalid-explicit-inputs");

  const identity = (r, who) =>
    r?.version === 1 &&
    r.type === "performance.stage" &&
    r.processId === expected[who].processId &&
    r.clockId === expected[who].clockId &&
    r.clockKind === expected[who].clockKind &&
    r.scenario === "terminal-input-to-paint";
  for (const traceId of traceIds) {
    const reasons = [];
    const association = {};
    const select = (records, operations, who) =>
      operations.map((operation) => {
        // Count all same-ID operations before checking identity; foreign duplicates cannot disappear.
        const matches = records.filter((r) => r?.traceId === traceId && r.operation === operation);
        association[operation] = matches.length;
        if (matches.length !== 1) {
          reasons.push(`${operation}:${matches.length === 0 ? "missing" : "ambiguous"}`);
          return null;
        }
        const r = matches[0];
        if (!identity(r, who)) reasons.push(`${operation}:identity`);
        return r;
      });
    const client = select(clientRecords, CLIENT, "client");
    const daemon = select(daemonRecords, DAEMON, "daemon");
    const sample = { traceId, association, status: "incomplete", reasons };
    samples.push(sample);
    if (reasons.length) continue;
    const origin = expected.perTrace?.[traceId];
    const delivery = daemon[2].terminalDelivery;
    if (
      !text(origin?.semanticPaneId) ||
      !text(origin?.incarnation) ||
      origin.generation !== expected.generation ||
      client[0].semanticPaneId !== origin.semanticPaneId ||
      !daemon.every((r) => r.authority?.incarnation === origin.incarnation) ||
      delivery?.semanticPaneId !== origin.semanticPaneId ||
      delivery?.canonicalGeneration !== origin.generation ||
      delivery?.canonicalIncarnation !== origin.incarnation ||
      delivery?.deliveryClientId !== expected.client.processId ||
      delivery?.deliveryRequestId !== client[0].clockCalibrationRequestId
    )
      reasons.push("mapped-origin-or-delivery-connection");
    const calibration = client[0];
    const lower = calibration.clockOffsetLowerMicros;
    const upper = calibration.clockOffsetUpperMicros;
    const uncertainty = calibration.clockUncertaintyMicros;
    if (
      !uuid(calibration.clockCalibrationRequestId) ||
      !Number.isSafeInteger(lower) ||
      !Number.isSafeInteger(upper) ||
      !safe(uncertainty) ||
      uncertainty > 5_000 ||
      !Number.isSafeInteger(upper - lower) ||
      upper - lower !== uncertainty ||
      !safe(calibration.clockCalibratedAtMicros)
    )
      reasons.push("calibration-domain");
    if (
      !client.every(
        (r) =>
          r.stage === "client" &&
          r.generation === expected.generation &&
          safe(r.atMicros) &&
          safe(r.sharedMicros) &&
          CALIBRATION.every((key) => r[key] === calibration[key]) &&
          safe(r.sharedMicros - r.clockCalibratedAtMicros) &&
          r.sharedMicros - r.clockCalibratedAtMicros <= 60_000_000,
      )
    )
      reasons.push("client-calibration-consistency-or-age");
    if (
      !daemon.every(
        (r) =>
          r.stage === "transport" &&
          r.authority?.generation === expected.generation &&
          text(r.authority?.incarnation) &&
          safe(r.startedAtMicros) &&
          safe(r.endedAtMicros) &&
          r.endedAtMicros >= r.startedAtMicros &&
          safe(r.sharedStartedAtMicros) &&
          safe(r.sharedEndedAtMicros) &&
          r.sharedEndedAtMicros >= r.sharedStartedAtMicros,
      )
    )
      reasons.push("daemon-identity-or-time-domain");
    if (new Set(daemon.map((r) => r.authority?.incarnation)).size !== 1)
      reasons.push("daemon-incarnation-mismatch");
    const outcomes = clientRecords.filter(
      (r) =>
        r?.type === "performance.clock-calibration" &&
        r.requestId === calibration.clockCalibrationRequestId,
    );
    const outcome = outcomes.length === 1 ? outcomes[0] : null;
    if (
      !outcome ||
      outcome.version !== 1 ||
      outcome.processId !== expected.client.processId ||
      outcome.clockId !== expected.client.clockId ||
      outcome.clockKind !== expected.client.clockKind ||
      outcome.daemonInstanceId !== expected.generation ||
      !safe(outcome.atMicros) ||
      !client.every((r) => outcome.atMicros <= r.atMicros) ||
      !["calibrated", "timeout-retained-sample"].includes(outcome.reason) ||
      !safe(outcome.attemptedProbes) ||
      outcome.attemptedProbes < 1 ||
      outcome.attemptedProbes > 5 ||
      !safe(outcome.receivedProbes) ||
      outcome.receivedProbes < 1 ||
      outcome.receivedProbes > outcome.attemptedProbes ||
      !safe(outcome.validProbes) ||
      outcome.validProbes < 1 ||
      outcome.validProbes > outcome.receivedProbes ||
      outcome.selectedProbes !== 1 ||
      !safe(outcome.selectedProbe) ||
      outcome.selectedProbe < 1 ||
      outcome.selectedProbe > outcome.attemptedProbes ||
      outcome.attemptedProbes !== outcome.receivedProbes + (outcome.reason === "calibrated" ? 0 : 1)
    )
      reasons.push("calibration-outcome");
    if (reasons.length) continue;
    const endpoints = [
      daemon[0].sharedStartedAtMicros,
      daemon[1].sharedEndedAtMicros,
      daemon[2].sharedEndedAtMicros,
    ];
    // Reject unsafe intermediate arithmetic even when later cancellation could yield a safe result.
    const arithmeticSafe = client.every((r, i) => {
      const difference = i === 0 ? endpoints[i] - r.sharedMicros : r.sharedMicros - endpoints[i];
      return (
        Number.isSafeInteger(difference) &&
        Number.isSafeInteger(i === 0 ? difference - lower : difference + lower) &&
        Number.isSafeInteger(i === 0 ? difference - upper : difference + upper)
      );
    });
    const bounds = client.map((r, i) =>
      clockBounds(r, endpoints[i], i === 0 ? "client-to-daemon" : "daemon-to-client"),
    );
    if (!arithmeticSafe || bounds.some((b) => b === null)) {
      reasons.push("unsupported-clock-bounds");
      continue;
    }
    sample.status = "admitted";
    sample.calibrationRequestId = calibration.clockCalibrationRequestId;
    sample.uncertaintyMicros = uncertainty;
    sample.edges = [
      { from: CLIENT[0], to: DAEMON[0], ...bounds[0] },
      { from: DAEMON[1], to: CLIENT[1], ...bounds[1] },
      { from: DAEMON[2], to: CLIENT[2], ...bounds[2] },
    ];
  }
  const result = fail(
    samples.every((sample) => sample.status === "admitted")
      ? null
      : "one-or-more-unsupported-associations",
  );
  result.status = result.reason === null ? "admitted" : "incomplete";
  return result;
}
