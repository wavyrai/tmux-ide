import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PRODUCT_DIAGNOSTIC_BUNDLE_FILES,
  PRODUCT_JOURNEY_REGISTRY,
  ProductJourneyAttemptError,
  auditProductJourneyScope,
  collectProductRigCleanupFailures,
  createProductRigCleanupReceipt,
  createProductDiagnosticBundle,
  dispatchProductJourneyExecutor,
  expandProductJourneyEntries,
  isCleanLegacyStoppedProductRigState,
  parseProductDiagnoseOptions,
  prepareProductDiagnosticBundlePublication,
  productDiagnosticRunId,
  productRigCleanupAcknowledgesRequest,
  productRigCleanupBarrierFailures,
  productRigTerminalFailureError,
  productRigTerminalFailureState,
  resolveProductJourneyPlan,
  runIsolatedProductJourneyAttempt,
  runConfiglessProductJourneyOwnerBoot,
  runProductJourneyPlan,
  settleInternalProductRigCleanup,
} from "./product-test-rig-journeys.mjs";

const unavailableWebPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function removeTestTree(path) {
  if (!existsSync(path)) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) removeTestTree(child);
    else chmodSync(child, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
}

function failureEvidence(boundary, message) {
  const report = { status: "failed", firstBrokenBoundary: boundary, failure: message };
  return {
    report,
    alignment: { firstBrokenBoundary: boundary, correlation: { complete: false } },
    timeline: "",
    tmuxTruth: { status: "unavailable" },
    daemonState: { revision: null },
    clientState: { committed: null, pending: null, derived: null },
    tuiAnsi: "[unavailable]\n",
    webPng: unavailableWebPng,
    stderr: "",
    reproduction: "#!/bin/sh\nexit 1\n",
  };
}

function attemptEntry(runId, repetition = 1) {
  return {
    journey: { id: "runtime-qualification" },
    repetition,
    repeat: 2,
    runId,
  };
}

function cleanupReceipt(runId, overrides = {}) {
  return {
    version: 1,
    runId,
    requestId: "cleanup-request-1",
    attempt: 1,
    passed: true,
    completedAt: "2026-08-18T10:30:11.842Z",
    ownerPid: 1001,
    daemon: { instanceId: "daemon-generation-1", pid: 1002 },
    namespaceDigest: "a".repeat(64),
    ownerDead: true,
    daemonDead: true,
    pathsAbsent: true,
    pathAbsence: {
      runtimeRoot: true,
      tmuxSocket: true,
      hostTmuxSocket: true,
      daemonInfo: true,
    },
    failureCount: 0,
    ...overrides,
  };
}

test("golden registry enables only accepted configless evidence", () => {
  const expected = [
    "configless-cold-start",
    "coherent-first-pane",
    "first-key-paste",
    "focus",
    "window-lifecycle",
    "keyboard-pointer-resize",
    "selection-copy-app-mouse",
    "ansi-cursor-alt-screen",
    "cross-client-handoff",
    "daemon-restart",
    "session-recreate",
  ];
  const golden = PRODUCT_JOURNEY_REGISTRY.filter(({ id }) => id !== "runtime-qualification");
  assert.deepEqual(
    golden.map(({ id }) => id),
    expected,
  );
  assert.equal(golden[0]?.implementation, "implemented");
  assert.ok(golden.slice(1).every(({ implementation }) => implementation === "pending"));
  assert.deepEqual(auditProductJourneyScope(), {
    complete: false,
    declarationComplete: true,
    executableComplete: false,
    missing: [],
    pendingJourneyIds: expected.slice(1),
  });
  assert.deepEqual(auditProductJourneyScope(golden.slice(1)), {
    complete: false,
    declarationComplete: false,
    executableComplete: false,
    missing: ["configless", "cold-start"],
    pendingJourneyIds: expected.slice(1),
  });
});

test("diagnose options select and repeat the executable journey deterministically", () => {
  const options = parseProductDiagnoseOptions([
    "--journey",
    "runtime-qualification",
    "--repeat",
    "3",
    "--json",
  ]);
  assert.equal(options.json, true);
  assert.deepEqual(
    resolveProductJourneyPlan(options).map(({ journey, repetition }) => [journey.id, repetition]),
    [
      ["runtime-qualification", 1],
      ["runtime-qualification", 2],
      ["runtime-qualification", 3],
    ],
  );
  assert.deepEqual(
    resolveProductJourneyPlan(
      parseProductDiagnoseOptions([
        "--journey",
        "configless-cold-start",
        "--repeat",
        "1",
        "--json",
      ]),
    ).map(({ journey, repetition, variant }) => [journey.id, repetition, variant]),
    [["configless-cold-start", 1, null]],
  );
});

test("first-key-paste expands each repetition into separately isolated key and paste attempts", () => {
  const journey = {
    id: "first-key-paste",
    variants: Object.freeze(["key", "paste"]),
    implementation: "implemented",
  };
  assert.deepEqual(
    expandProductJourneyEntries([journey], 2).map(({ repetition, variant }) => [
      repetition,
      variant,
    ]),
    [
      [1, "key"],
      [1, "paste"],
      [2, "key"],
      [2, "paste"],
    ],
  );
  assert.equal(
    parseProductDiagnoseOptions(["--journey", "first-key-paste", "--variant", "paste"]).variant,
    "paste",
  );
  assert.throws(
    () =>
      resolveProductJourneyPlan(
        parseProductDiagnoseOptions(["--journey", "runtime-qualification", "--variant", "paste"]),
      ),
    /only valid with --journey first-key-paste/u,
  );
});

test("journey dispatcher invokes the exact registry executor instead of the runtime monolith", async () => {
  const calls = [];
  const entry = { journey: { id: "configless-cold-start", executor: "configless-cold-start" } };
  const result = await dispatchProductJourneyExecutor(entry, {
    "configless-cold-start": async () => {
      calls.push("configless");
      return "direct";
    },
    "runtime-qualification": async () => {
      calls.push("runtime");
      return "monolith";
    },
  });
  assert.equal(result, "direct");
  assert.deepEqual(calls, ["configless"]);
});

test("configless owner launches public entry before election/adoption/coherence and Web", async () => {
  const calls = [];
  const operation = (name, result) => async () => {
    calls.push(name);
    return result;
  };
  const result = await runConfiglessProductJourneyOwnerBoot({
    createOrdinaryNamespace: operation("ordinary-namespace", { id: "namespace" }),
    assertNamespaceClean: operation("namespace-clean"),
    buildBeforeMeasurement: operation("build"),
    launchPublicNoArgumentEntry: operation("public-no-arg", { pid: 41 }),
    observeElectedDaemon: operation("daemon-election", { instanceId: "daemon" }),
    observeOrdinarySessionDiscovery: operation("ordinary-discovery", { sessionId: "session" }),
    adoptThroughPublicApp: operation("public-adoption", { workspace: "workspace" }),
    proveCoherentPublication: operation("coherent-publication", { frame: "frame" }),
    startWebAfterColdBoundary: operation("web-after-cold", { page: "web" }),
  });
  assert.deepEqual(calls, [
    "ordinary-namespace",
    "namespace-clean",
    "build",
    "public-no-arg",
    "daemon-election",
    "ordinary-discovery",
    "public-adoption",
    "coherent-publication",
    "web-after-cold",
  ]);
  assert.equal(result.publicProcess.pid, 41);

  calls.length = 0;
  await assert.rejects(
    runConfiglessProductJourneyOwnerBoot({
      createOrdinaryNamespace: operation("ordinary-namespace", {}),
      assertNamespaceClean: operation("namespace-clean"),
      buildBeforeMeasurement: operation("build"),
      launchPublicNoArgumentEntry: operation("public-no-arg", {}),
      observeElectedDaemon: async () => {
        calls.push("daemon-election");
        throw new Error("election failed");
      },
      observeOrdinarySessionDiscovery: operation("ordinary-discovery"),
      adoptThroughPublicApp: operation("public-adoption"),
      proveCoherentPublication: operation("coherent-publication"),
      startWebAfterColdBoundary: operation("web-after-cold"),
    }),
    /election failed/u,
  );
  assert.deepEqual(calls, [
    "ordinary-namespace",
    "namespace-clean",
    "build",
    "public-no-arg",
    "daemon-election",
  ]);
});

test("repeat runner drives every planned journey sequentially and stops at the first failure", async () => {
  const plan = resolveProductJourneyPlan(
    parseProductDiagnoseOptions(["--journey", "runtime-qualification", "--repeat", "3"]),
  );
  const calls = [];
  const results = await runProductJourneyPlan(plan, async ({ repetition }) => {
    calls.push(repetition);
    return `run-${repetition}`;
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(results, ["run-1", "run-2", "run-3"]);

  const failedCalls = [];
  await assert.rejects(
    runProductJourneyPlan(plan, async ({ repetition }) => {
      failedCalls.push(repetition);
      if (repetition === 2) throw new Error("failed run");
    }),
    /failed run/u,
  );
  assert.deepEqual(failedCalls, [1, 2]);
});

test("pending, all, unknown, and invalid repetition selections fail before orchestration", () => {
  assert.throws(
    () => resolveProductJourneyPlan(parseProductDiagnoseOptions(["--journey", "focus"])),
    /not implemented: focus; missing evidence is a failure/u,
  );
  assert.throws(
    () => resolveProductJourneyPlan(parseProductDiagnoseOptions(["--journey", "all"])),
    /not implemented: coherent-first-pane/u,
  );
  assert.throws(
    () => resolveProductJourneyPlan(parseProductDiagnoseOptions(["--journey", "imaginary"])),
    /unknown ProductRig journey imaginary/u,
  );
  for (const value of ["0", "11", "1.5", "many"])
    assert.throws(
      () => parseProductDiagnoseOptions(["--repeat", value]),
      /--repeat requires an integer from 1 to 10/u,
    );
  for (const value of [",", "runtime-qualification,", ",runtime-qualification", "Focus", "a b"])
    assert.throws(
      () => parseProductDiagnoseOptions(["--journey", value]),
      /--journey requires non-empty lowercase journey ids/u,
    );
  assert.throws(
    () =>
      resolveProductJourneyPlan(
        parseProductDiagnoseOptions(["--journey", "all", "--journey", "runtime-qualification"]),
      ),
    /all cannot be combined/u,
  );
});

test("CLI rejects a pending journey before creating ProductRig state", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-cli-plan-"));
  try {
    const rigRoot = join(temporary, "rig");
    const diagnosticRoot = join(temporary, "diagnostics");
    const result = spawnSync(
      process.execPath,
      ["scripts/product-test-rig.mjs", "diagnose", "--journey", "focus", "--json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TMUX_IDE_PRODUCT_RIG_DIR: rigRoot,
          TMUX_IDE_PRODUCT_DIAGNOSTIC_DIR: diagnosticRoot,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not implemented: focus; missing evidence is a failure/u);
    assert.equal(existsSync(join(rigRoot, "state.json")), false);
    assert.equal(existsSync(diagnosticRoot), false);
  } finally {
    removeTestTree(temporary);
  }
});

test("run ids are deterministic, bounded, and path safe", () => {
  assert.equal(
    productDiagnosticRunId({
      journeyId: "runtime-qualification",
      repetition: 2,
      now: "2026-08-17T14:30:12.345Z",
      nonce: "A1-B2_C3",
    }),
    "20260817143012345-runtime-qualification-r2-a1b2c3",
  );
  assert.equal(
    productDiagnosticRunId({
      journeyId: "first-key-paste",
      variant: "paste",
      repetition: 10,
      now: "2026-08-17T14:30:12.345Z",
      nonce: "C0FFEE",
    }),
    "20260817143012345-first-key-paste-paste-r10-c0ffee",
  );
});

test("bundle writer creates the exact immutable M59.4 evidence set", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-bundle-"));
  try {
    const webPngPath = join(temporary, "source.png");
    writeFileSync(webPngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const root = join(temporary, "bundles");
    const runId = "20260817143012345-runtime-qualification-r1-a1b2";
    const evidence = {
      report: { status: "failed" },
      alignment: { firstBrokenBoundary: "release-to-receipt" },
      timeline: '{"phase":"start"}\n',
      tmuxTruth: { panes: [] },
      daemonState: { generation: "daemon-1" },
      clientState: { committed: {}, pending: {} },
      tuiAnsi: "\u001b[Hframe",
      webPngPath,
      stderr: "diagnostic\n",
      reproduction:
        "#!/bin/sh\nset -eu\npnpm product:testdrive diagnose --journey runtime-qualification --repeat 1 --json\n",
    };
    const bundle = createProductDiagnosticBundle({ root, runId, evidence });
    assert.deepEqual(
      readdirSync(bundle.runDir).sort(),
      [...PRODUCT_DIAGNOSTIC_BUNDLE_FILES].sort(),
    );
    assert.equal(
      JSON.parse(readFileSync(join(bundle.runDir, "report.json"), "utf8")).status,
      "failed",
    );
    assert.equal(statSync(bundle.runDir).mode & 0o777, 0o500);
    assert.equal(statSync(join(bundle.runDir, "report.json")).mode & 0o777, 0o400);
    assert.equal(statSync(join(bundle.runDir, "reproduction.sh")).mode & 0o777, 0o500);
    const manifest = readdirSync(bundle.runDir).sort();
    assert.throws(
      () => writeFileSync(join(bundle.runDir, "report.json"), "overwritten\n"),
      (error) => error?.code === "EACCES",
    );
    assert.throws(
      () => writeFileSync(join(bundle.runDir, "eleventh-file"), "forbidden\n"),
      (error) => error?.code === "EACCES",
    );
    assert.throws(
      () => unlinkSync(join(bundle.runDir, "report.json")),
      (error) => error?.code === "EACCES",
    );
    assert.deepEqual(readdirSync(bundle.runDir).sort(), manifest);
    assert.throws(
      () => createProductDiagnosticBundle({ root, runId, evidence }),
      /already exists/u,
    );
    assert.throws(
      () => createProductDiagnosticBundle({ root, runId: "../escape", evidence }),
      /bounded lowercase slug/u,
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("bundle writer publishes a bounded explicit unavailable Web artifact", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-placeholder-"));
  try {
    const webPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const runId = "20260817143012345-runtime-qualification-r1-failure";
    const bundle = createProductDiagnosticBundle({
      root: join(temporary, "bundles"),
      runId,
      evidence: {
        report: {
          status: "failed",
          firstBrokenBoundary: "product-rig-startup",
          failure: "owner never became ready",
        },
        alignment: {
          correlation: { complete: false, missing: ["web.semantic"] },
          availability: { tui: false, web: false },
        },
        timeline: "",
        tmuxTruth: { status: "unavailable" },
        daemonState: { revision: null, correlationComplete: false },
        clientState: {
          committed: null,
          pending: null,
          derived: null,
          correlationComplete: false,
        },
        tuiAnsi: "[unavailable]\n",
        webPng,
        stderr: "",
        reproduction: "#!/bin/sh\nexit 1\n",
      },
    });
    assert.deepEqual(
      readdirSync(bundle.runDir).sort(),
      [...PRODUCT_DIAGNOSTIC_BUNDLE_FILES].sort(),
    );
    assert.equal(readFileSync(join(bundle.runDir, "web.png")).equals(webPng), true);
    assert.equal(
      JSON.parse(readFileSync(join(bundle.runDir, "alignment.json"), "utf8")).correlation.complete,
      false,
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("attempt startup failure cleans up before publishing immutable placeholder evidence", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-attempt-failure-"));
  const events = [];
  const cause = new Error("owner never became ready");
  const entry = attemptEntry("20260817143012345-runtime-qualification-r1-startup");
  try {
    let caught = null;
    try {
      await runIsolatedProductJourneyAttempt(entry, {
        onPhase: (phase) => events.push(`phase:${phase}`),
        preCleanup: async () => events.push("cleanup:before"),
        drive: async () => {
          events.push("drive");
          throw cause;
        },
        currentBoundary: () => "product-rig-startup",
        postCleanup: async () => events.push("cleanup:after"),
        retryCleanup: () => assert.fail("successful cleanup cannot retry"),
        prepareFailure: async (error, boundary) => {
          events.push(`prepare:${boundary}`);
          return { evidence: failureEvidence(boundary, error.message) };
        },
        appendCleanupFailure: () => assert.fail("unexpected secondary cleanup failure"),
        publishFailure: async ({ evidence }) => {
          events.push("publish:failure");
          return createProductDiagnosticBundle({
            root: temporary,
            runId: entry.runId,
            evidence,
          });
        },
        publishSuccess: () => assert.fail("startup failure cannot publish success"),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProductJourneyAttemptError);
    assert.equal(caught.originalCause, cause);
    assert.equal(caught.boundary, "product-rig-startup");
    assert.deepEqual(events, [
      "phase:pre-attempt-cleanup",
      "cleanup:before",
      "phase:product-rig-startup",
      "drive",
      "phase:attempt-cleanup",
      "cleanup:after",
      "prepare:product-rig-startup",
      "phase:failure-bundle-publication",
      "publish:failure",
    ]);
    assert.deepEqual(
      readdirSync(caught.bundle.runDir).sort(),
      [...PRODUCT_DIAGNOSTIC_BUNDLE_FILES].sort(),
    );
    const report = JSON.parse(readFileSync(join(caught.bundle.runDir, "report.json"), "utf8"));
    assert.equal(report.firstBrokenBoundary, "product-rig-startup");
    assert.equal(report.failure, cause.message);
    assert.equal(
      readFileSync(join(caught.bundle.runDir, "web.png")).equals(unavailableWebPng),
      true,
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("structured product boundary survives startup wrapping and cleanup", async () => {
  const boundaryError = new Error("promotion timed out");
  boundaryError.boundary = "canonical-promotion-adoption";
  boundaryError.observation = { predicates: [{ id: "fleet-row-session", status: "failed" }] };
  const terminalState = productRigTerminalFailureState(boundaryError, "product-rig-startup");
  assert.equal(terminalState.firstBrokenBoundary, "canonical-promotion-adoption");
  assert.equal(terminalState.failureObservation, boundaryError.observation);
  const restored = productRigTerminalFailureError(terminalState);
  assert.equal(restored.boundary, "canonical-promotion-adoption");
  assert.equal(restored.observation, boundaryError.observation);
  let preparedBoundary = null;
  await assert.rejects(
    runIsolatedProductJourneyAttempt(attemptEntry("structured-boundary"), {
      preCleanup: async () => undefined,
      drive: async () => {
        throw boundaryError;
      },
      currentBoundary: () => "product-rig-startup",
      postCleanup: async () => undefined,
      retryCleanup: () => assert.fail("cleanup succeeded"),
      prepareFailure: async (_error, boundary) => {
        preparedBoundary = boundary;
        return { evidence: failureEvidence(boundary, "promotion timed out") };
      },
      appendCleanupFailure: () => assert.fail("no cleanup failure"),
      publishFailure: async () => ({ runDir: "/immutable/structured-boundary" }),
      publishSuccess: () => assert.fail("failure cannot publish success"),
    }),
    (error) =>
      error instanceof ProductJourneyAttemptError &&
      error.boundary === "canonical-promotion-adoption" &&
      error.originalCause === boundaryError,
  );
  assert.equal(preparedBoundary, "canonical-promotion-adoption");
});

test("bundle publication embeds and verifies its final immutable report path", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-report-path-"));
  const root = join(temporary, "bundles");
  const runId = "20260818060000000-configless-cold-start-r1-path";
  try {
    const prepared = prepareProductDiagnosticBundlePublication({
      root,
      runId,
      report: { status: "failed", reportPath: null },
      evidence: {
        ...failureEvidence("canonical-promotion-adoption", "timed out"),
        report: { status: "failed", reportPath: null },
      },
      cleanupReceipt: cleanupReceipt(runId),
    });
    const bundle = createProductDiagnosticBundle({ root, runId, evidence: prepared.evidence });
    const expected = join(bundle.runDir, "report.json");
    assert.equal(prepared.reportPath, expected);
    assert.equal(JSON.parse(readFileSync(expected, "utf8")).reportPath, expected);
    assert.equal(JSON.parse(readFileSync(expected, "utf8")).cleanupReceipt.passed, true);
    assert.equal(
      JSON.parse(readFileSync(join(bundle.runDir, "alignment.json"), "utf8")).reportPath,
      expected,
    );
    assert.equal(
      JSON.parse(readFileSync(join(bundle.runDir, "alignment.json"), "utf8")).cleanupReceipt.runId,
      runId,
    );
    assert.throws(
      () =>
        createProductDiagnosticBundle({
          root,
          runId: `${runId}-tampered`,
          evidence: {
            ...prepared.evidence,
            report: { ...prepared.evidence.report, runId: `${runId}-tampered` },
            alignment: { ...prepared.evidence.alignment, cleanupReceipt: null },
          },
        }),
      /cleanup receipt/u,
    );
    assert.throws(
      () =>
        prepareProductDiagnosticBundlePublication({
          root,
          runId: `${runId}-other`,
          report: { status: "failed", reportPath: "/wrong/report.json" },
          evidence: failureEvidence("product-rig-startup", "failed"),
          cleanupReceipt: cleanupReceipt(`${runId}-other`),
        }),
      /does not match/u,
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("bundle preparation requires an exact passed immutable cleanup receipt", () => {
  const root = "/tmp/product-diagnostic-cleanup-contract";
  const runId = "20260818060000000-configless-cold-start-r1-cleanup";
  const input = {
    root,
    runId,
    report: { status: "passed", reportPath: null },
    evidence: failureEvidence(null, ""),
  };
  assert.throws(() => prepareProductDiagnosticBundlePublication(input), /cleanup receipt/u);
  for (const receipt of [
    cleanupReceipt("wrong-run"),
    cleanupReceipt(runId, { passed: false }),
    cleanupReceipt(runId, { ownerDead: false }),
    cleanupReceipt(runId, { pathsAbsent: false }),
    cleanupReceipt(runId, { failureCount: 1 }),
  ])
    assert.throws(
      () => prepareProductDiagnosticBundlePublication({ ...input, cleanupReceipt: receipt }),
      /cleanup receipt/u,
    );
  const canonical = prepareProductDiagnosticBundlePublication({
    ...input,
    cleanupReceipt: cleanupReceipt(runId, {
      ownerToken: "must-not-seal",
      runtimeRoot: "/must/not/seal",
      daemon: {
        instanceId: "daemon-generation-1",
        pid: 1002,
        authToken: "must-not-seal",
      },
    }),
  });
  assert.doesNotMatch(
    JSON.stringify(canonical.evidence),
    /ownerToken|authToken|must-not-seal|\/must\/not\/seal/u,
  );
  assert.deepEqual(Object.keys(canonical.report.cleanupReceipt).sort(), [
    "attempt",
    "completedAt",
    "daemon",
    "daemonDead",
    "failureCount",
    "namespaceDigest",
    "ownerDead",
    "ownerPid",
    "passed",
    "pathAbsence",
    "pathsAbsent",
    "requestId",
    "runId",
    "version",
  ]);
});

test("isolated attempts thread first-pass and retry cleanup receipts into every publication", async () => {
  const successEntry = attemptEntry("20260818060000000-configless-cold-start-r1-receipt-success");
  const firstReceipt = cleanupReceipt(successEntry.runId);
  const success = await runIsolatedProductJourneyAttempt(successEntry, {
    preCleanup: async () => undefined,
    drive: async () => ({ report: { status: "passed" } }),
    currentBoundary: () => "journey-drive",
    postCleanup: async () => firstReceipt,
    retryCleanup: () => assert.fail("first cleanup passed"),
    prepareFailure: () => assert.fail("success cannot prepare failure"),
    appendCleanupFailure: () => assert.fail("success has no cleanup failure"),
    publishFailure: () => assert.fail("success cannot publish failure"),
    publishSuccess: async (_completed, receipt) => receipt,
  });
  assert.equal(success, firstReceipt);

  const failureEntry = attemptEntry("20260818060000000-configless-cold-start-r1-receipt-retry");
  const secondReceipt = cleanupReceipt(failureEntry.runId, { attempt: 2 });
  const journeyFailure = new Error("journey failed before cleanup");
  const cleanupFailure = new Error("first cleanup failed");
  await assert.rejects(
    runIsolatedProductJourneyAttempt(failureEntry, {
      preCleanup: async () => undefined,
      drive: async () => {
        throw journeyFailure;
      },
      currentBoundary: () => "diagnostic-correlation",
      postCleanup: async () => {
        throw cleanupFailure;
      },
      retryCleanup: async (error) => {
        assert.equal(error, cleanupFailure);
        return secondReceipt;
      },
      prepareFailure: async (_error, _boundary, receipt) => ({ receipt }),
      appendCleanupFailure: (_prepared, error) => assert.equal(error, cleanupFailure),
      publishFailure: async (prepared, receipt) => {
        assert.equal(prepared.receipt, secondReceipt);
        assert.equal(receipt, secondReceipt);
        return { runDir: "/immutable/retry-receipt" };
      },
      publishSuccess: () => assert.fail("journey failure cannot publish success"),
    }),
    (error) =>
      error instanceof ProductJourneyAttemptError && error.originalCause === journeyFailure,
  );
});

test("cleanup receipt builder rejects live identity or namespace residue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-cleanup-receipt-"));
  const entry = attemptEntry("20260818060000000-configless-cold-start-r1-builder");
  const state = {
    ownerPid: 2_000_000_001,
    daemon: { pid: 2_000_000_002, instanceId: "daemon-generation" },
    runtimeNamespace: {
      root: join(temporary, "absent"),
      tmuxSocketPath: join(temporary, "absent", "tmux.sock"),
      hostTmuxSocketPath: join(temporary, "absent", "host.sock"),
      daemonInfoDir: join(temporary, "absent", "daemon"),
    },
    cleanup: {
      requestId: "request",
      status: "passed",
      completedAt: "2026-08-18T10:30:11.842Z",
      failures: [],
    },
  };
  try {
    const receipt = createProductRigCleanupReceipt(entry, state, 1);
    assert.equal(receipt.ownerDead, true);
    assert.equal(receipt.daemonDead, true);
    assert.equal(receipt.pathsAbsent, true);
    assert.doesNotMatch(JSON.stringify(receipt), /cleanupToken|ownerToken|\/tmp\//u);
    mkdirSync(state.runtimeNamespace.root);
    assert.throws(() => createProductRigCleanupReceipt(entry, state, 1), /cleanup receipt/u);
    assert.throws(
      () => createProductRigCleanupReceipt(entry, { ...state, ownerPid: process.pid }, 1),
      /cleanup receipt/u,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("attempt cleanup failure is bundled at its exact boundary", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-attempt-cleanup-"));
  const entry = attemptEntry("20260817143012345-runtime-qualification-r1-cleanup");
  const cleanupFailure = new Error("owner survived cleanup");
  const events = [];
  try {
    await assert.rejects(
      runIsolatedProductJourneyAttempt(entry, {
        preCleanup: async () => undefined,
        drive: async () => ({ status: "passed" }),
        currentBoundary: () => "journey-drive",
        postCleanup: async () => {
          events.push("cleanup:first-failed");
          throw cleanupFailure;
        },
        retryCleanup: async (error) => {
          assert.equal(error, cleanupFailure);
          events.push("cleanup:retry-passed");
        },
        prepareFailure: async (error, boundary) => {
          events.push("prepare:failure");
          return { evidence: failureEvidence(boundary, error.message) };
        },
        appendCleanupFailure: () => assert.fail("cleanup is the primary failure"),
        publishFailure: async ({ evidence }) => {
          events.push("publish:failure");
          return createProductDiagnosticBundle({ root: temporary, runId: entry.runId, evidence });
        },
        publishSuccess: () => assert.fail("cleanup failure cannot publish success"),
      }),
      (error) => {
        assert.ok(error instanceof ProductJourneyAttemptError);
        assert.equal(error.originalCause, cleanupFailure);
        assert.equal(error.boundary, "attempt-cleanup");
        assert.equal(
          JSON.parse(readFileSync(join(error.bundle.runDir, "report.json"), "utf8"))
            .firstBrokenBoundary,
          "attempt-cleanup",
        );
        assert.deepEqual(events, [
          "cleanup:first-failed",
          "cleanup:retry-passed",
          "prepare:failure",
          "publish:failure",
        ]);
        return true;
      },
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("persistent cleanup failure blocks evidence publication and later attempts", async () => {
  const entry = attemptEntry("20260817143012345-runtime-qualification-r1-cleanupblocked");
  let prepared = false;
  let published = false;
  await assert.rejects(
    runIsolatedProductJourneyAttempt(entry, {
      preCleanup: async () => undefined,
      drive: async () => ({ status: "passed" }),
      currentBoundary: () => "journey-drive",
      postCleanup: async () => {
        throw new Error("first exact cleanup failed");
      },
      retryCleanup: async () => {
        throw new Error("bounded exact cleanup retry failed");
      },
      prepareFailure: async () => {
        prepared = true;
      },
      appendCleanupFailure: () => undefined,
      publishFailure: async () => {
        published = true;
      },
      publishSuccess: async () => {
        published = true;
      },
    }),
    /cleanup barrier failed after bounded retry/u,
  );
  assert.equal(prepared, false);
  assert.equal(published, false);
});

test("owner cleanup collector persists labeled subsystem failures and permits exact retry", async () => {
  let tuiAttempts = 0;
  const steps = () => [
    {
      subsystem: "tui",
      run: async () => {
        tuiAttempts += 1;
        if (tuiAttempts === 1) throw new Error(`tui stop failed ${"x".repeat(100)}`);
      },
    },
    { subsystem: "daemon", run: async () => undefined },
  ];
  const first = await collectProductRigCleanupFailures(steps(), { detailLimit: 32 });
  assert.equal(first.length, 1);
  assert.equal(first[0].subsystem, "tui");
  assert.equal(first[0].detail.length, 32);
  const retried = await collectProductRigCleanupFailures(steps(), { detailLimit: 32 });
  assert.deepEqual(retried, []);
  assert.equal(tuiAttempts, 2);
});

test("internal owner cleanup preserves its retry actor until an exact attempt passes", async () => {
  const events = [];
  const blocked = await settleInternalProductRigCleanup({
    maxImmediateAttempts: 2,
    cleanup: async (attempt) => {
      events.push(`cleanup:${attempt}`);
      return { passed: false, failures: [{ subsystem: "tui" }] };
    },
    onTerminal: async () => events.push("owner:exit"),
    onRetryable: async () => events.push("owner:retain-token-poller"),
  });
  assert.equal(blocked.passed, false);
  assert.deepEqual(events, ["cleanup:1", "cleanup:2", "owner:retain-token-poller"]);

  events.length = 0;
  const settled = await settleInternalProductRigCleanup({
    maxImmediateAttempts: 2,
    cleanup: async (attempt) => {
      events.push(`cleanup:${attempt}`);
      return { passed: attempt === 2, failures: [] };
    },
    onTerminal: async () => events.push("owner:exit"),
    onRetryable: async () => events.push("owner:retain-token-poller"),
  });
  assert.equal(settled.passed, true);
  assert.deepEqual(events, ["cleanup:1", "cleanup:2", "owner:exit"]);
});

test("cleanup barrier rejects stopped publication before exact owner death and owned path removal", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-cleanup-barrier-"));
  const socket = join(temporary, "main.sock");
  writeFileSync(socket, "owned");
  const state = {
    status: "stopped",
    ownerPid: process.pid,
    daemon: { pid: 987_654_321 },
    runtimeNamespace: {
      root: temporary,
      tmuxSocketPath: socket,
      hostTmuxSocketPath: join(temporary, "host.sock"),
      daemonInfoDir: join(temporary, "daemon"),
      cleanupToken: "exact-token",
    },
    cleanup: {
      requestId: "request-1",
      status: "passed",
      cleanupToken: "exact-token",
      failures: [],
    },
  };
  try {
    const premature = productRigCleanupBarrierFailures(state, "request-1", {
      processAlive: (pid) => pid === process.pid,
      pathExists: existsSync,
    });
    assert.ok(premature.includes("owner-process-live"));
    assert.ok(premature.includes("runtime-root-present"));
    assert.ok(premature.includes("tmux-socket-present"));
  } finally {
    removeTestTree(temporary);
  }
  assert.deepEqual(
    productRigCleanupBarrierFailures(state, "request-1", {
      processAlive: () => false,
      pathExists: existsSync,
    }),
    [],
  );
  assert.deepEqual(
    productRigCleanupBarrierFailures(
      { ...state, status: "failed", failure: "startup broke" },
      "request-1",
      {
        processAlive: () => false,
        pathExists: existsSync,
      },
    ),
    [],
  );
});

test("legacy stopped preclean admits only the exact dead and residue-free v1 shape", () => {
  const root = join(tmpdir(), "tmi-e2e-legacy-clean-shape");
  const state = {
    version: 1,
    status: "stopped",
    ownerPid: 98_875,
    daemon: { pid: 1_387, instanceId: "legacy-generation" },
    runtimeNamespace: {
      root,
      tmuxSocketPath: join(root, "t.sock"),
      hostTmuxSocketPath: join(root, "product-rig-host-tmux.sock"),
      daemonInfoDir: join(root, "daemon"),
      cleanupToken: "product-test-rig:legacy",
    },
  };
  const deadAndAbsent = { processAlive: () => false, pathExists: () => false };
  assert.equal(isCleanLegacyStoppedProductRigState(state, deadAndAbsent), true);

  for (const contaminated of [
    (({ version: _version, ...withoutVersion }) => withoutVersion)(state),
    { ...state, version: 2 },
    { ...state, cleanup: null },
    { ...state, cleanup: undefined },
    { ...state, cleanup: { status: "passed" } },
    { ...state, status: "failed" },
    { ...state, status: "cleanup-failed" },
    { ...state, ownerToken: null },
    { ...state, ownerToken: undefined },
    { ...state, ownerToken: "current-owner-token" },
    { ...state, ownerPid: 0 },
    { ...state, daemon: { ...state.daemon, pid: null } },
    { ...state, daemon: { ...state.daemon, instanceId: "" } },
    {
      ...state,
      runtimeNamespace: { ...state.runtimeNamespace, tmuxSocketPath: "/tmp/outside.sock" },
    },
    {
      ...state,
      runtimeNamespace: { ...state.runtimeNamespace, tmuxSocketPath: root },
    },
    {
      ...state,
      runtimeNamespace: { ...state.runtimeNamespace, hostTmuxSocketPath: root },
    },
    {
      ...state,
      runtimeNamespace: { ...state.runtimeNamespace, daemonInfoDir: root },
    },
    {
      ...state,
      runtimeNamespace: { ...state.runtimeNamespace, cleanupToken: null },
    },
  ])
    assert.equal(isCleanLegacyStoppedProductRigState(contaminated, deadAndAbsent), false);

  assert.equal(
    isCleanLegacyStoppedProductRigState(state, {
      processAlive: (pid) => pid === state.ownerPid,
      pathExists: () => false,
    }),
    false,
  );
  assert.equal(
    isCleanLegacyStoppedProductRigState(state, {
      processAlive: (pid) => pid === state.daemon.pid,
      pathExists: () => false,
    }),
    false,
  );
  for (const ownedPath of [
    state.runtimeNamespace.root,
    state.runtimeNamespace.tmuxSocketPath,
    state.runtimeNamespace.hostTmuxSocketPath,
    state.runtimeNamespace.daemonInfoDir,
  ])
    assert.equal(
      isCleanLegacyStoppedProductRigState(state, {
        processAlive: () => false,
        pathExists: (candidate) => candidate === ownedPath,
      }),
      false,
    );
});

test("public-elected daemon cleanup is an exact barrier before the next repeat", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-public-repeat-"));
  const daemonInfoDir = join(temporary, "daemon-info");
  mkdirSync(daemonInfoDir);
  const state = {
    status: "stopped",
    ownerPid: 111,
    daemon: { pid: 222, instanceId: "public-generation-1" },
    runtimeNamespace: {
      root: temporary,
      tmuxSocketPath: join(temporary, "tmux.sock"),
      hostTmuxSocketPath: join(temporary, "host.sock"),
      daemonInfoDir,
      cleanupToken: "public-repeat-token",
    },
    cleanup: {
      requestId: "public-repeat-cleanup",
      status: "passed",
      cleanupToken: "public-repeat-token",
      failures: [],
    },
  };
  try {
    const blocked = productRigCleanupBarrierFailures(state, "public-repeat-cleanup", {
      processAlive: (pid) => pid === 222,
      pathExists: existsSync,
    });
    assert.ok(blocked.includes("daemon-process-live"));
    assert.ok(blocked.includes("runtime-root-present"));
    removeTestTree(temporary);
    assert.deepEqual(
      productRigCleanupBarrierFailures(state, "public-repeat-cleanup", {
        processAlive: () => false,
        pathExists: existsSync,
      }),
      [],
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("controller adopts an overlapping internal cleanup only after its exact terminal pass", () => {
  const internal = {
    status: "failed",
    cleanup: { requestId: "internal-owner-failure", status: "passed" },
  };
  assert.equal(productRigCleanupAcknowledgesRequest(internal, "controller-request"), true);
  assert.equal(
    productRigCleanupAcknowledgesRequest(
      { ...internal, status: "cleanup-failed", cleanup: { ...internal.cleanup, status: "failed" } },
      "controller-request",
    ),
    false,
  );
  assert.equal(
    productRigCleanupAcknowledgesRequest(
      { status: "cleanup-failed", cleanup: { requestId: "controller-request", status: "failed" } },
      "controller-request",
    ),
    true,
  );
});

test("two successful attempts use distinct clean owners and immutable namespaces", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-attempt-repeat-"));
  const published = [];
  try {
    for (const repetition of [1, 2]) {
      const entry = attemptEntry(
        `20260817143012345-runtime-qualification-r${repetition}-success`,
        repetition,
      );
      const ownerPath = join(temporary, `owner-${repetition}.json`);
      const namespacePath = join(temporary, `namespace-${repetition}`);
      const result = await runIsolatedProductJourneyAttempt(entry, {
        preCleanup: async () => {
          assert.equal(existsSync(ownerPath), false);
          assert.equal(existsSync(namespacePath), false);
        },
        drive: async () => {
          writeFileSync(ownerPath, JSON.stringify({ owner: `owner-${repetition}` }));
          mkdirSync(namespacePath, { mode: 0o700 });
          writeFileSync(join(namespacePath, "tmux.sock"), "owned socket");
          return { owner: `owner-${repetition}`, namespace: `namespace-${repetition}` };
        },
        currentBoundary: () => "journey-drive",
        postCleanup: async () => {
          unlinkSync(ownerPath);
          removeTestTree(namespacePath);
        },
        retryCleanup: () => assert.fail("successful cleanup cannot retry"),
        prepareFailure: () => assert.fail("successful attempt cannot prepare failure"),
        appendCleanupFailure: () => assert.fail("successful attempt cannot append cleanup"),
        publishFailure: () => assert.fail("successful attempt cannot publish failure"),
        publishSuccess: async (completed) => {
          assert.equal(existsSync(ownerPath), false);
          assert.equal(existsSync(namespacePath), false);
          const bundle = createProductDiagnosticBundle({
            root: temporary,
            runId: entry.runId,
            evidence: {
              ...failureEvidence("none", ""),
              report: { status: "passed", ...completed },
            },
          });
          published.push(bundle.runDir);
          return { completed, bundle, reportPath: join(bundle.runDir, "report.json") };
        },
      });
      assert.equal(result.completed.owner, `owner-${repetition}`);
      assert.equal(result.completed.namespace, `namespace-${repetition}`);
      assert.equal(result.reportPath, join(result.bundle.runDir, "report.json"));
    }
    assert.equal(new Set(published).size, 2);
    assert.ok(published.every((runDir) => existsSync(join(runDir, "report.json"))));
  } finally {
    removeTestTree(temporary);
  }
});
