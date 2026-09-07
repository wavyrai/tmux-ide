import assert from "node:assert/strict";
import test from "node:test";
import { assessCard5DaemonRestartEnvelopeEvidence as assess } from "./product-cross-client-host-evidence.mjs";

function fixture() {
  return {
    predecessorGeneration: "g1",
    replacementGeneration: "g2",
    retirement: {
      generation: "g1",
      pid: 123,
      port: 4567,
      processAbsent: true,
      connectionRefused: true,
    },
    staleRedemptions: [0, 1].map(() => ({
      rejected: true,
      typed: true,
      reason: "redemption-rejected",
    })),
    lanes: [
      {
        document: {
          before: { epoch: 10, generation: "g1", acceptedCount: 3, socketEventCount: 1 },
          after: { epoch: 10, generation: "g2", acceptedCount: 6 },
          navigationCount: 0,
        },
        socketEvents: [
          { generation: "g1", outcome: "closed", ordinal: 1 },
          { generation: "g2", outcome: "open", ordinal: 2 },
        ],
        events: [
          { generation: "g1", type: "terminal.patch", acceptedOrdinal: 3 },
          { generation: "g2", type: "terminal.seed", acceptedOrdinal: 4 },
          { generation: "g2", type: "terminal.patch", acceptedOrdinal: 5 },
        ],
      },
      {
        document: {
          before: { epoch: 20, generation: "g1", acceptedCount: 10, socketEventCount: 1 },
          after: { epoch: 30, generation: "g2", acceptedCount: 2 },
          navigationCount: 1,
        },
        socketEvents: [{ generation: "g2", outcome: "open", ordinal: 0 }],
        events: [
          { generation: "g2", type: "terminal.seed", acceptedOrdinal: 0 },
          { generation: "g2", type: "terminal.patch", acceptedOrdinal: 1 },
        ],
      },
      {
        replacementBoundary: {
          predecessorGeneration: "g1",
          replacementGeneration: "g2",
          acceptedOrdinal: 0,
        },
        predecessorAcceptedAfterReplacement: 0,
        events: [{ generation: "g2", type: "terminal.seed", acceptedOrdinal: 0 }],
      },
    ],
  };
}

test("crash recovery proves seed admission across persistent and reloaded documents", () => {
  assert.equal(assess(fixture()).passed, true);
});

const corruptions = {
  "surviving daemon": (x) => {
    x.retirement.processAbsent = false;
  },
  "surviving listener": (x) => {
    x.retirement.connectionRefused = false;
  },
  "wrong retired generation": (x) => {
    x.retirement.generation = "g3";
  },
  "missing navigation": (x) => {
    x.lanes[1].document.navigationCount = 0;
  },
  "unchanged document epoch": (x) => {
    x.lanes[1].document.after.epoch = 20;
  },
  "missing baseline": (x) => {
    delete x.lanes[0].document.before;
  },
  "wrong new generation": (x) => {
    x.lanes[1].document.after.generation = "g3";
  },
  "truncated history": (x) => {
    x.lanes[0].events.shift();
  },
  "gapped history": (x) => {
    x.lanes[0].events[1].acceptedOrdinal = 7;
  },
  "reordered history": (x) => {
    x.lanes[0].events.reverse();
  },
  "patch first": (x) => {
    x.lanes[1].events[0].type = "terminal.patch";
  },
  "late predecessor": (x) => {
    x.lanes[0].events[2].generation = "g1";
  },
  "old data in fresh document": (x) => {
    x.lanes[1].events[0].generation = "g1";
    x.lanes[1].events[1].type = "terminal.seed";
  },
  "missing new socket": (x) => {
    x.lanes[1].socketEvents = [];
  },
  "missing old socket close": (x) => {
    x.lanes[0].socketEvents.shift();
  },
  "stale close event": (x) => {
    x.lanes[0].socketEvents[0].ordinal = 0;
  },
  "untyped rejection": (x) => {
    x.staleRedemptions[0].typed = false;
  },
  "navigation storm": (x) => {
    x.lanes[1].document.navigationCount = 9;
  },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`crash recovery rejects ${name}`, () => {
    const input = fixture();
    corrupt(input);
    assert.equal(assess(input).passed, false);
  });
}
