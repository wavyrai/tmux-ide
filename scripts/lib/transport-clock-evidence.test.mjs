import assert from "node:assert/strict";
import test from "node:test";

import { assessTransportClockEvidence } from "./transport-clock-evidence.mjs";

const traceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const expected = {
    generation: "generation-1",
    perTrace: {
      [traceId]: {
        generation: "generation-1",
        incarnation: "incarnation-1",
        semanticPaneId: "pane-1",
      },
    },
    client: {
      processId: "opentui:11",
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
    },
    daemon: {
      processId: "daemon:22",
      clockId: "node-performance-now",
      clockKind: "performance-now",
    },
  };
  const clientRecords = [
    "pane-stream-socket-send-return",
    "pane-stream-input-ack-callback",
    "socket-frame-arrival",
  ].map((operation, i) => ({
    version: 1,
    type: "performance.stage",
    traceId,
    scenario: "terminal-input-to-paint",
    stage: "client",
    operation,
    ...expected.client,
    generation: expected.generation,
    semanticPaneId: "pane-1",
    atMicros: 2000 + i * 100,
    sharedMicros: 1000 + i * 100,
    clockOffsetLowerMicros: 100,
    clockOffsetUpperMicros: 120,
    clockUncertaintyMicros: 20,
    clockCalibratedAtMicros: 10,
    clockCalibrationRequestId: requestId,
  }));
  clientRecords.push({
    version: 1,
    type: "performance.clock-calibration",
    ...expected.client,
    requestId,
    daemonInstanceId: expected.generation,
    reason: "calibrated",
    atMicros: 1900,
    attemptedProbes: 5,
    receivedProbes: 5,
    validProbes: 5,
    selectedProbes: 1,
    selectedProbe: 2,
  });
  const daemonRecords = [
    "pane-stream-socket-message-callback-entry",
    "pane-stream-input-ack-socket-send",
    "pane-stream-socket-send",
  ].map((operation, i) => ({
    version: 1,
    type: "performance.stage",
    traceId,
    scenario: "terminal-input-to-paint",
    stage: "transport",
    operation,
    ...expected.daemon,
    authority: { generation: expected.generation, incarnation: "incarnation-1" },
    startedAtMicros: 5000 + i * 100,
    endedAtMicros: 5000 + i * 100,
    sharedStartedAtMicros: [1130, 1200, 1300][i],
    sharedEndedAtMicros: [1130, 1200, 1300][i],
  }));
  daemonRecords[2].terminalDelivery = {
    semanticPaneId: "pane-1",
    canonicalGeneration: expected.generation,
    canonicalIncarnation: "incarnation-1",
    deliveryClientId: expected.client.processId,
    deliveryRequestId: requestId,
  };
  return { expected, traceIds: [traceId], clientRecords, daemonRecords };
}

test("admits only three bounded transport edges using rebased fields, not raw clocks", () => {
  const input = fixture();
  const result = assessTransportClockEvidence(input);
  assert.equal(result.status, "admitted");
  assert.equal(result.missionBoundaryVerdict, "not-measured");
  assert.deepEqual(
    result.samples[0].edges.map(({ lowerMicros, upperMicros }) => [lowerMicros, upperMicros]),
    [
      [10, 30],
      [0, 20],
      [0, 20],
    ],
  );
  input.daemonRecords.forEach((r) => {
    r.startedAtMicros += 1_000_000;
    r.endedAtMicros += 1_000_000;
  });
  assert.deepEqual(assessTransportClockEvidence(input).samples[0].edges, result.samples[0].edges);
});

test("missing and repeated associations remain visible, including a foreign duplicate", () => {
  const input = fixture();
  input.clientRecords.push({ ...input.clientRecords[0], processId: "other" });
  input.daemonRecords.pop();
  const result = assessTransportClockEvidence(input);
  assert.equal(result.status, "incomplete");
  assert.equal(result.samples[0].association["pane-stream-socket-send-return"], 2);
  assert.equal(result.samples[0].association["pane-stream-socket-send"], 0);
  assert.deepEqual(result.samples[0].reasons, [
    "pane-stream-socket-send-return:ambiguous",
    "pane-stream-socket-send:missing",
  ]);
});

const negatives = {
  "missing mapped origin": (x) => {
    delete x.expected.perTrace;
  },
  "foreign delivery request": (x) => {
    x.daemonRecords[2].terminalDelivery.deliveryRequestId = traceId;
  },
  "foreign delivery client": (x) => {
    x.daemonRecords[2].terminalDelivery.deliveryClientId = "other";
  },
  "foreign delivery pane": (x) => {
    x.daemonRecords[2].terminalDelivery.semanticPaneId = "other";
  },
  "foreign send pane": (x) => {
    x.clientRecords[0].semanticPaneId = "other";
  },
  "foreign mapped incarnation": (x) => {
    x.expected.perTrace[traceId].incarnation = "other";
  },
  "no explicit admission identities": (x) => {
    delete x.expected;
  },
  "duplicate supplied trace IDs": (x) => {
    x.traceIds.push(traceId);
  },
  "empty supplied trace IDs": (x) => {
    x.traceIds = [];
  },
  "wrong client process": (x) => {
    x.clientRecords[1].processId = "other";
  },
  "wrong daemon clock": (x) => {
    x.daemonRecords[0].clockId = "other";
  },
  "wrong daemon generation": (x) => {
    x.daemonRecords[1].authority.generation = "other";
  },
  "missing daemon incarnation": (x) => {
    x.daemonRecords[1].authority.incarnation = null;
  },
  "inconsistent daemon incarnation": (x) => {
    x.daemonRecords[1].authority.incarnation = "other";
  },
  "missing shared endpoint": (x) => {
    delete x.daemonRecords[0].sharedStartedAtMicros;
  },
  "reversed shared span": (x) => {
    x.daemonRecords[0].sharedEndedAtMicros = 1;
  },
  "invalid raw clock domain": (x) => {
    x.clientRecords[0].atMicros = NaN;
  },
  "unsafe shared clock": (x) => {
    x.clientRecords[0].sharedMicros = Number.MAX_SAFE_INTEGER + 1;
  },
  "fractional offset": (x) => {
    x.clientRecords[0].clockOffsetLowerMicros = 0.5;
  },
  "inconsistent calibration": (x) => {
    x.clientRecords[1].clockOffsetLowerMicros = 99;
  },
  "stale calibration": (x) => {
    x.clientRecords[2].sharedMicros = 60_000_011;
  },
  "calibration from the future": (x) => {
    x.clientRecords[0].clockCalibratedAtMicros = 1001;
  },
  "excessive uncertainty": (x) => {
    for (const r of x.clientRecords.slice(0, 3)) {
      r.clockOffsetUpperMicros = 5101;
      r.clockUncertaintyMicros = 5001;
    }
  },
  "negative calibration width": (x) => {
    x.clientRecords[0].clockOffsetUpperMicros = 90;
  },
  "missing outcome": (x) => {
    x.clientRecords.pop();
  },
  "duplicate outcome": (x) => {
    x.clientRecords.push({ ...x.clientRecords.at(-1) });
  },
  "foreign outcome": (x) => {
    x.clientRecords.at(-1).daemonInstanceId = "other";
  },
  "invalid probe conservation": (x) => {
    x.clientRecords.at(-1).receivedProbes = 4;
  },
  "outcome after edge": (x) => {
    x.clientRecords.at(-1).atMicros = 2001;
  },
  "bounds incompatible with causal direction": (x) => {
    x.daemonRecords[0].sharedStartedAtMicros = 1;
    x.daemonRecords[0].sharedEndedAtMicros = 1;
  },
};
for (const [name, mutate] of Object.entries(negatives)) {
  test(`fails closed: ${name}`, () => {
    const input = fixture();
    mutate(input);
    const result = assessTransportClockEvidence(input);
    assert.equal(result.status, "incomplete");
    assert.equal(result.missionBoundaryVerdict, "not-measured");
  });
}

test("retained-sample outcome requires its declared one missing probe", () => {
  const input = fixture();
  Object.assign(input.clientRecords.at(-1), {
    reason: "timeout-retained-sample",
    receivedProbes: 4,
    validProbes: 4,
  });
  assert.equal(assessTransportClockEvidence(input).status, "admitted");
});

test("unmapped operations are not substituted and all supplied IDs receive a verdict", () => {
  const input = fixture();
  input.traceIds.push("33333333-3333-4333-8333-333333333333");
  const result = assessTransportClockEvidence(input);
  assert.equal(result.status, "incomplete");
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples[0].status, "admitted");
  assert.equal(result.samples[1].reasons.length, 6);
});
