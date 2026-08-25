import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  assessCard5ObservedHostLifecycle,
  card5HostCleanupStatus,
  card5ProductionHostTopology,
  validateCard5NativeObserverCommand,
  waitForCard5ObservedHostLifecycle,
} from "./product-card5-host-topology.mjs";

const EVIDENCE_KEY = "ab".repeat(32);
const GENERATION = "generation-card5";
const PANE = "pane-card5";

function lifecycle(client, surface, ordinal, event = "open") {
  return {
    operation: "terminal-delivery-subscriber-lifecycle",
    terminalDelivery: {
      deliveryLifecycleEvent: event,
      deliveryPurpose: "terminal-surface",
      canonicalGeneration: GENERATION,
      semanticPaneId: PANE,
      deliverySurface: surface,
      deliveryRequestId: `request-${client}`,
      deliveryLaneId: `lane-${client}`,
      deliveryClientId: `client-${client}`,
      deliveryLifecycleOrdinal: ordinal,
    },
  };
}

function webEvidence(client) {
  const requestId = `request-${client}`;
  const socketUrl = `ws://127.0.0.1/${client}`;
  const digest = (domain, value) =>
    createHmac("sha256", Buffer.from(EVIDENCE_KEY, "hex"))
      .update(`${domain}\0${value}`)
      .digest("hex");
  return {
    generation: GENERATION,
    processIdentity: `process-${client}`,
    runtimeReplacement: {
      descriptorEvents: [
        {
          generation: GENERATION,
          requestId,
          socketUrl,
        },
      ],
      currentLifecycleRequest: {
        status: "exact",
        requestHmac: digest("request", requestId),
        socketHmac: digest("socket", `${socketUrl}\0${requestId}`),
        activeCount: 1,
        overflow: false,
        descriptorCount: 1,
        firstSeedOrdinal: 5,
      },
    },
  };
}

function assess(
  records,
  web = [webEvidence("web-a"), webEvidence("web-b")],
  stage = "initial-host-lifecycle",
) {
  return assessCard5ObservedHostLifecycle({
    stage,
    generation: GENERATION,
    pane: PANE,
    tuiProcessId: "opentui:123",
    web,
    daemonRecords: records,
    evidenceKey: EVIDENCE_KEY,
  });
}

const observeWeb = async () => [webEvidence("web-a"), webEvidence("web-b")];

test("Card5 topology names actual OpenTUI, Chromium, and Electron security boundaries", () => {
  const topology = card5ProductionHostTopology({
    pageUrl: "http://127.0.0.1:43123/?devHost=1",
    runtimeRoot: "/tmp/product-rig-a",
    electronUserData: "/tmp/product-rig-a/electron-user-data",
    daemonInfoPath: "/tmp/product-rig-a/daemon/daemon.json",
    cleanupToken: "product-rig:abc123",
  });
  assert.deepEqual(
    topology.clients.map(({ id, host }) => [id, host]),
    [
      ["opentui", "opentui"],
      ["web-a", "chromium"],
      ["web-b", "electron"],
    ],
  );
  assert.deepEqual(topology.electron, {
    rendererUrl: "http://127.0.0.1:43123/?devHost=1",
    userData: "/tmp/product-rig-a/electron-user-data",
    daemonInfoPath: "/tmp/product-rig-a/daemon/daemon.json",
    browserWindowCount: 1,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
  assert.deepEqual(topology.nativeObserver, { readOnly: true, attachClient: false });
});

test("Card5 native observer allows only non-attaching tmux reads", () => {
  for (const argv of [
    ["capture-pane", "-p", "-t", "%1"],
    ["display-message", "-p", "-t", "%1", "#{cursor_x}"],
    ["list-panes", "-t", "=session"],
    ["list-windows", "-t", "=session"],
    ["list-clients"],
  ]) {
    assert.deepEqual(validateCard5NativeObserverCommand(argv), argv);
  }
  for (const argv of [
    ["attach-session", "-t", "=session"],
    ["resize-window", "-x", "100"],
    ["send-keys", "hello"],
    ["set-option", "@secret", "x"],
    ["display-message", "hello"],
  ]) {
    assert.throws(() => validateCard5NativeObserverCommand(argv), /cannot mutate|must print/u);
  }
});

test("Card5 lifecycle waits for a staged third client and two stable tail samples", async () => {
  const records = [lifecycle("opentui", "opentui", 1), lifecycle("web-a", "web", 2)];
  let offset = records.length;
  let now = 0;
  let yields = 0;
  const reader = {
    read: () => records,
    snapshot: () => ({
      offset,
      recordCount: records.length,
      retainedRecordBytes: records.length * 100,
      caughtUp: true,
    }),
    confirmCaughtUp: () => true,
  };
  const proof = await waitForCard5ObservedHostLifecycle({
    reader,
    observeWeb,
    assess,
    failureIdentity: {
      stage: "initial-host-lifecycle",
      generation: GENERATION,
      pane: PANE,
      evidenceKey: EVIDENCE_KEY,
    },
    timeoutMs: 100,
    now: () => now,
    yieldTurn: async () => {
      yields += 1;
      now += 10;
      if (yields === 1) {
        records.push(lifecycle("web-b", "web", 3));
        offset = records.length;
      }
    },
  });
  assert.equal(proof.length, 3);
  assert.ok(yields >= 2, "new EOF must receive two identical confirmations");
});

test("Card5 lifecycle jointly stabilizes a Web activation switch instead of freezing its first sample", async () => {
  const records = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  let now = 0;
  let observations = 0;
  const missing = webEvidence("web-b");
  missing.runtimeReplacement.currentLifecycleRequest = {
    status: "missing",
    requestHmac: null,
    socketHmac: null,
    activeCount: 0,
    overflow: false,
    descriptorCount: 0,
    firstSeedOrdinal: null,
  };
  const reader = {
    read: () => records,
    snapshot: () => ({ offset: 3, recordCount: 3, retainedRecordBytes: 300, caughtUp: true }),
    confirmCaughtUp: () => true,
  };
  const proof = await waitForCard5ObservedHostLifecycle({
    reader,
    observeWeb: async () => {
      observations += 1;
      return [webEvidence("web-a"), observations === 1 ? missing : webEvidence("web-b")];
    },
    assess,
    failureIdentity: {
      stage: "initial-host-lifecycle",
      generation: GENERATION,
      pane: PANE,
      evidenceKey: EVIDENCE_KEY,
    },
    timeoutMs: 100,
    now: () => now,
    yieldTurn: async () => {
      now += 10;
    },
  });
  assert.equal(proof.length, 3);
  assert.ok(observations >= 6, "changed Web evidence must reset the two-sample proof");
});

test("Card5 lifecycle resets on daemon growth during Web recapture and bounds perpetual churn", async () => {
  const exact = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  let records = [...exact];
  let now = 0;
  let observations = 0;
  const reader = {
    read: () => records,
    snapshot: () => ({
      offset: records.length,
      recordCount: records.length,
      retainedRecordBytes: records.length * 100,
      caughtUp: true,
    }),
    confirmCaughtUp: () => true,
  };
  const proof = await waitForCard5ObservedHostLifecycle({
    reader,
    observeWeb: async () => {
      observations += 1;
      if (observations === 2) records = [...records, { operation: "bounded-late-record" }];
      return [webEvidence("web-a"), webEvidence("web-b")];
    },
    assess,
    failureIdentity: {
      stage: "initial-host-lifecycle",
      generation: GENERATION,
      pane: PANE,
      evidenceKey: EVIDENCE_KEY,
    },
    timeoutMs: 100,
    now: () => now,
    yieldTurn: async () => {
      now += 10;
    },
  });
  assert.equal(proof.length, 3);
  assert.ok(observations >= 6, "growth between recapture and confirm must reset stability");

  records = [...exact];
  now = 0;
  observations = 0;
  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader,
      observeWeb: async () => {
        observations += 1;
        if (observations % 2 === 0) records = [...records, { operation: "bounded-churn" }];
        return [webEvidence("web-a"), webEvidence("web-b")];
      },
      assess,
      failureIdentity: {
        stage: "initial-host-lifecycle",
        generation: GENERATION,
        pane: PANE,
        evidenceKey: EVIDENCE_KEY,
      },
      timeoutMs: 30,
      now: () => now,
      yieldTurn: async () => {
        now += 10;
      },
    }),
    (error) => error.observation.reason === "lifecycle-tail-unstable",
  );
  assert.ok(observations <= 6, "deadline must bound churn observations");
});

test("Card5 lifecycle timeout seals exact bounded reasons without raw identities", async () => {
  const records = [lifecycle("opentui", "opentui", 1), lifecycle("web-a", "web", 2)];
  let now = 0;
  const reader = {
    read: () => records,
    snapshot: () => ({
      offset: 2,
      recordCount: 2,
      retainedRecordBytes: 200,
      caughtUp: true,
    }),
    confirmCaughtUp: () => true,
  };
  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader,
      observeWeb,
      assess,
      failureIdentity: {
        stage: "initial-host-lifecycle",
        generation: GENERATION,
        pane: PANE,
        evidenceKey: EVIDENCE_KEY,
      },
      timeoutMs: 30,
      now: () => now,
      yieldTurn: async () => {
        now += 10;
      },
    }),
    (error) => {
      assert.equal(error.observation.activeCount, 2);
      assert.equal(error.observation.clients[2].reason, "request-no-active-open");
      const sealed = JSON.stringify(error.observation);
      assert.doesNotMatch(sealed, /generation-card5|pane-card5|request-web-a|lane-web-a/u);
      return true;
    },
  );
});

test("Card5 lifecycle deadline stops before assess/confirm and reader failures stay bounded", async () => {
  let clock = 0;
  let assesses = 0;
  let confirms = 0;
  const identity = {
    stage: "initial-host-lifecycle",
    generation: GENERATION,
    pane: PANE,
    evidenceKey: EVIDENCE_KEY,
  };
  const clientKeys = Object.keys(
    assess([
      lifecycle("opentui", "opentui", 1),
      lifecycle("web-a", "web", 2),
      lifecycle("web-b", "web", 3),
    ]).observation.clients[0],
  ).sort();
  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader: {
        read: () => {
          clock = 5;
          return [];
        },
        snapshot: () => ({ offset: 0, recordCount: 0, retainedRecordBytes: 0, caughtUp: true }),
        confirmCaughtUp: () => {
          confirms += 1;
          return true;
        },
      },
      observeWeb,
      assess: () => {
        assesses += 1;
        return assess([]);
      },
      failureIdentity: identity,
      timeoutMs: 5,
      now: () => clock,
      yieldTurn: async () => assert.fail("deadline must not yield"),
    }),
    (error) => {
      assert.equal(error.observation.reason, "lifecycle-deadline");
      assert.equal(error.observation.clients.length, 3);
      assert.ok(error.observation.clients.every(({ assessed }) => assessed === false));
      assert.deepEqual(Object.keys(error.observation.clients[0]).sort(), clientKeys);
      return true;
    },
  );
  assert.equal(assesses, 0);
  assert.equal(confirms, 0);

  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader: {
        read: () => {
          throw new Error("raw secret source failure");
        },
        snapshot: () => assert.fail("failed read must not snapshot"),
        confirmCaughtUp: () => assert.fail("failed read must not confirm"),
      },
      observeWeb,
      assess,
      failureIdentity: identity,
      timeoutMs: 5,
      now: () => 0,
    }),
    (error) => {
      assert.equal(error.observation.reason, "lifecycle-source-unavailable");
      assert.deepEqual(Object.keys(error.observation.clients[0]).sort(), clientKeys);
      assert.doesNotMatch(JSON.stringify(error.observation), /raw secret/u);
      return true;
    },
  );
  const clockReader = {
    read: () => [],
    snapshot: () => ({ offset: 0, recordCount: 0, retainedRecordBytes: 0, caughtUp: true }),
    confirmCaughtUp: () => true,
  };
  for (const clockSource of [
    () => Number.NaN,
    (() => {
      const values = [1, 0];
      return () => values.shift() ?? 0;
    })(),
  ]) {
    await assert.rejects(
      waitForCard5ObservedHostLifecycle({
        reader: clockReader,
        observeWeb,
        assess,
        failureIdentity: identity,
        timeoutMs: 5,
        now: clockSource,
      }),
      (error) => error.observation.reason === "lifecycle-clock-invalid",
    );
  }
});

test("Card5 lifecycle bounds hung Web observations and consumes late settlement before cleanup work", async () => {
  const records = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  const identity = {
    stage: "initial-host-lifecycle",
    generation: GENERATION,
    pane: PANE,
    evidenceKey: EVIDENCE_KEY,
  };
  for (const hungAt of [1, 2]) {
    let observations = 0;
    let reads = 0;
    let confirms = 0;
    let assesses = 0;
    let yields = 0;
    let rejectLate;
    const late = new Promise((_, reject) => {
      rejectLate = reject;
    });
    await assert.rejects(
      waitForCard5ObservedHostLifecycle({
        reader: {
          read: () => {
            reads += 1;
            return records;
          },
          snapshot: () => ({
            offset: 3,
            recordCount: 3,
            retainedRecordBytes: 300,
            caughtUp: true,
          }),
          confirmCaughtUp: () => {
            confirms += 1;
            return true;
          },
        },
        observeWeb: async () => {
          observations += 1;
          if (observations === hungAt) return late;
          return [webEvidence("web-a"), webEvidence("web-b")];
        },
        assess: (...args) => {
          assesses += 1;
          return assess(...args);
        },
        failureIdentity: identity,
        timeoutMs: 5,
        now: () => 0,
        scheduleDeadline: (callback) => {
          const immediate = setImmediate(callback);
          return () => clearImmediate(immediate);
        },
        yieldTurn: async () => {
          yields += 1;
        },
      }),
      (error) => error.observation.reason === "lifecycle-deadline",
    );
    const countsAtFailure = { reads, confirms, assesses, yields };
    rejectLate(new Error("private late observer failure"));
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
    assert.deepEqual({ reads, confirms, assesses, yields }, countsAtFailure);
    assert.equal(yields, 0);
    if (hungAt === 1)
      assert.deepEqual(countsAtFailure, { reads: 0, confirms: 0, assesses: 0, yields: 0 });
    else assert.deepEqual(countsAtFailure, { reads: 1, confirms: 1, assesses: 1, yields: 0 });
  }
});

test("Card5 lifecycle refuses a second stable sample when assessment serialization crosses deadline", async () => {
  const records = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  let clock = 0;
  let assessments = 0;
  let confirms = 0;
  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader: {
        read: () => records,
        snapshot: () => ({ offset: 3, recordCount: 3, retainedRecordBytes: 300, caughtUp: true }),
        confirmCaughtUp: () => {
          confirms += 1;
          return true;
        },
      },
      observeWeb,
      assess: (...args) => {
        assessments += 1;
        const result = assess(...args);
        if (assessments === 4) {
          return {
            ...result,
            proof: {
              toJSON() {
                clock = 5;
                return result.proof;
              },
            },
          };
        }
        return result;
      },
      failureIdentity: {
        stage: "initial-host-lifecycle",
        generation: GENERATION,
        pane: PANE,
        evidenceKey: EVIDENCE_KEY,
      },
      timeoutMs: 5,
      now: () => clock,
      yieldTurn: async () => undefined,
    }),
    (error) => error.observation.reason === "lifecycle-deadline",
  );
  assert.equal(assessments, 4);
  assert.equal(confirms, 4);
});

test("Card5 lifecycle seals one-confirm expiry and clock faults with one fixed client schema", async () => {
  const records = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  const identity = {
    stage: "initial-host-lifecycle",
    generation: GENERATION,
    pane: PANE,
    evidenceKey: EVIDENCE_KEY,
  };
  const reader = {
    read: () => records,
    snapshot: () => ({
      offset: 3,
      recordCount: 3,
      retainedRecordBytes: 300,
      caughtUp: true,
    }),
    confirmCaughtUp: () => true,
  };
  const assessedKeys = Object.keys(assess(records).observation.clients[0]).sort();
  let clock = 0;
  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader,
      observeWeb,
      assess,
      failureIdentity: identity,
      timeoutMs: 5,
      now: () => clock,
      yieldTurn: async () => {
        clock = 5;
      },
    }),
    (error) => {
      assert.equal(error.observation.reason, "lifecycle-tail-unstable");
      assert.equal(error.observation.stableTail, false);
      assert.ok(error.observation.clients.every(({ assessed }) => assessed === true));
      return true;
    },
  );

  await assert.rejects(
    waitForCard5ObservedHostLifecycle({
      reader,
      observeWeb,
      assess,
      failureIdentity: identity,
      timeoutMs: 5,
      now: () => {
        throw new Error("raw clock failure");
      },
    }),
    (error) => {
      assert.equal(error.observation.reason, "lifecycle-clock-invalid");
      assert.deepEqual(Object.keys(error.observation.clients[0]).sort(), assessedKeys);
      assert.ok(error.observation.clients.every(({ assessed }) => assessed === false));
      assert.doesNotMatch(JSON.stringify(error.observation), /raw clock/u);
      return true;
    },
  );
});

test("Card5 lifecycle classifies generation, close, duplicate, and extra-active adversaries", () => {
  const exact = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  assert.equal(assess(exact).passed, true);

  const wrongGeneration = webEvidence("web-a");
  wrongGeneration.generation = "other-generation";
  assert.equal(
    assess(exact, [wrongGeneration, webEvidence("web-b")]).observation.clients[1].reason,
    "generation-mismatch",
  );

  const closed = [...exact, lifecycle("web-b", "web", 4, "close")];
  assert.equal(assess(closed).observation.clients[2].reason, "closed");

  const duplicateLane = structuredClone(exact);
  duplicateLane[2].terminalDelivery.deliveryLaneId = "lane-web-a";
  assert.ok(
    assess(duplicateLane).observation.clients.every(({ reason }) => reason === "duplicate-lane"),
  );

  const extra = [...exact, lifecycle("extra", "web", 4)];
  assert.ok(assess(extra).observation.clients.every(({ reason }) => reason === "extra-active"));
});

test("Card5 lifecycle binds the activated request and rejects ambiguous activation state", () => {
  const exact = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  const withUnusedCandidates = [webEvidence("web-a"), webEvidence("web-b")];
  for (const observed of withUnusedCandidates) {
    observed.runtimeReplacement.descriptorEvents.push({
      generation: GENERATION,
      requestId: "unopened-candidate",
      socketUrl: "ws://127.0.0.1/unopened",
    });
  }
  assert.equal(
    assess(exact, withUnusedCandidates).passed,
    true,
    "a later issued but unactivated candidate must not replace the current request",
  );

  for (const [status, reason] of [
    ["missing", "activated-request-missing"],
    ["ambiguous", "activated-request-ambiguous"],
    ["overflow", "activated-request-overflow"],
  ]) {
    const web = [webEvidence("web-a"), webEvidence("web-b")];
    web[1].runtimeReplacement.currentLifecycleRequest = {
      ...web[1].runtimeReplacement.currentLifecycleRequest,
      status,
      requestHmac: null,
      socketHmac: null,
      activeCount: status === "ambiguous" ? 2 : status === "overflow" ? 8 : 0,
      overflow: status === "overflow",
      descriptorCount: 0,
      firstSeedOrdinal: null,
    };
    assert.equal(assess(exact, web).observation.clients[2].reason, reason);
  }

  for (const mutate of [
    (current) => (current.status = "invented"),
    (current) => (current.activeCount = 2),
    (current) => (current.overflow = true),
    (current) => (current.descriptorCount = 0),
    (current) => (current.firstSeedOrdinal = null),
    (current) => (current.firstSeedOrdinal = -1),
  ]) {
    const web = [webEvidence("web-a"), webEvidence("web-b")];
    mutate(web[1].runtimeReplacement.currentLifecycleRequest);
    assert.equal(assess(exact, web).observation.clients[2].reason, "activated-request-invalid");
  }
});

test("Card5 lifecycle exposes every missing-field reason as a fixed enum", () => {
  const base = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  const cases = [
    [
      "descriptor-missing",
      base,
      [
        { generation: GENERATION, processIdentity: "process-web-a", runtimeReplacement: {} },
        webEvidence("web-b"),
      ],
    ],
    [
      "request-no-active-open",
      base.filter(({ terminalDelivery }) => terminalDelivery.deliveryRequestId !== "request-web-a"),
      [webEvidence("web-a"), webEvidence("web-b")],
    ],
    [
      "process-missing",
      base,
      [{ ...webEvidence("web-a"), processIdentity: null }, webEvidence("web-b")],
    ],
    [
      "socket-missing",
      base,
      [
        {
          ...webEvidence("web-a"),
          runtimeReplacement: {
            ...webEvidence("web-a").runtimeReplacement,
            currentLifecycleRequest: {
              ...webEvidence("web-a").runtimeReplacement.currentLifecycleRequest,
              socketHmac: null,
            },
          },
        },
        webEvidence("web-b"),
      ],
    ],
    [
      "request-missing",
      base,
      [
        {
          ...webEvidence("web-a"),
          runtimeReplacement: {
            ...webEvidence("web-a").runtimeReplacement,
            currentLifecycleRequest: {
              ...webEvidence("web-a").runtimeReplacement.currentLifecycleRequest,
              requestHmac: null,
            },
          },
        },
        webEvidence("web-b"),
      ],
    ],
  ];
  for (const [reason, records, web] of cases) {
    assert.equal(assess(records, web).observation.clients[1].reason, reason);
  }

  for (const [field, reason, value] of [
    ["deliveryLaneId", "lane-missing", null],
    ["deliveryClientId", "client-missing", null],
    ["deliveryLifecycleOrdinal", "ordinal-invalid", -1],
  ]) {
    const records = structuredClone(base);
    records[1].terminalDelivery[field] = value;
    assert.equal(assess(records).observation.clients[1].reason, reason);
  }

  for (const [field, descriptorField, reason] of [
    ["deliveryRequestId", "requestId", "duplicate-request"],
    ["deliveryLaneId", null, "duplicate-lane"],
    ["deliveryClientId", null, "duplicate-client"],
  ]) {
    const records = structuredClone(base);
    records[2].terminalDelivery[field] = records[1].terminalDelivery[field];
    const web = [webEvidence("web-a"), webEvidence("web-b")];
    if (descriptorField) {
      const requestId = records[2].terminalDelivery[field];
      web[1].runtimeReplacement.currentLifecycleRequest.requestHmac = createHmac(
        "sha256",
        Buffer.from(EVIDENCE_KEY, "hex"),
      )
        .update(`request\0${requestId}`)
        .digest("hex");
    }
    assert.equal(assess(records, web).observation.clients[1].reason, reason);
    assert.equal(assess(records, web).observation.clients[2].reason, reason);
  }
});

test("Card5 lifecycle labels replacement failures and reports capped-count overflow truthfully", () => {
  const base = [
    lifecycle("opentui", "opentui", 1),
    lifecycle("web-a", "web", 2),
    lifecycle("web-b", "web", 3),
  ];
  const replacement = assess(
    base.filter(({ terminalDelivery }) => terminalDelivery.deliveryRequestId !== "request-web-b"),
    undefined,
    "replacement-host-lifecycle",
  );
  assert.equal(replacement.observation.stage, "replacement-host-lifecycle");

  const extraOpens = Array.from({ length: 65 }, (_, ordinal) =>
    lifecycle(`extra-${ordinal}`, "web", ordinal + 4),
  );
  const openOverflow = assess([...base, ...extraOpens]).observation;
  assert.equal(openOverflow.openCount, 64);
  assert.equal(openOverflow.openOverflow, true);
  assert.equal(openOverflow.activeCount, 64);
  assert.equal(openOverflow.activeOverflow, true);

  const extraCloses = extraOpens.map((record, ordinal) => ({
    ...structuredClone(record),
    terminalDelivery: {
      ...structuredClone(record.terminalDelivery),
      deliveryLifecycleEvent: "close",
      deliveryLifecycleOrdinal: ordinal + 100,
    },
  }));
  const closeOverflow = assess([...base, ...extraCloses]).observation;
  assert.equal(closeOverflow.closeCount, 64);
  assert.equal(closeOverflow.closeOverflow, true);
  assert.equal(closeOverflow.openOverflow, false);
});

test("Card5 cleanup requires every owned host and zero observer/path residue", () => {
  const entries = Object.fromEntries(
    ["chromium", "electron", "opentui", "daemon", "namespace"].map((name) => [
      name,
      { owned: true, retired: true },
    ]),
  );
  const zeroResidue = {
    chromiumProcessCount: 0,
    chromiumDescendantCount: 0,
    chromiumPageCount: 0,
    chromiumContextCount: 0,
    chromiumListenerCount: 0,
    electronProcessCount: 0,
    electronDescendantCount: 0,
    electronWindowCount: 0,
    electronListenerCount: 0,
    electronOpenHandleCount: 0,
    socketResidueCount: 0,
    nativeObserverProcessCount: 0,
    pathResidueCount: 0,
  };
  const clean = card5HostCleanupStatus({ entries, ...zeroResidue });
  assert.equal(clean.passed, true);
  assert.equal(clean.retiredOwners, 5);
  assert.equal(clean.launchStage, "unknown");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(clean.owners).map(([name, value]) => [name, [value.owned, value.retired]]),
    ),
    Object.fromEntries(Object.keys(entries).map((name) => [name, [true, true]])),
  );
  for (const [name, value] of Object.entries(zeroResidue)) assert.equal(clean[name], value);
  assert.equal(
    card5HostCleanupStatus({
      entries: { ...entries, electron: { owned: true, retired: false } },
      ...zeroResidue,
    }).passed,
    false,
  );
  assert.equal(
    card5HostCleanupStatus({ entries, ...zeroResidue, electronWindowCount: 1 }).passed,
    false,
  );
  assert.equal(card5HostCleanupStatus({ entries }).passed, false);
  assert.equal(card5HostCleanupStatus({ entries }).electronProcessCount, null);
  assert.equal(
    card5HostCleanupStatus({
      entries: Object.fromEntries(
        Object.keys(entries).map((name) => [
          name,
          { owned: false, retired: true, reason: "not-acquired" },
        ]),
      ),
      ...zeroResidue,
    }).passed,
    true,
  );
});
