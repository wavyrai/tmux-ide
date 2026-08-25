import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { devServerProcessIsRunning } from "../apps/desktop-renderer/e2e/fixtures/dev-server.ts";
import {
  PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
  PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS,
  PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES,
  PRODUCT_RIG_SOURCE_MANIFEST_HASH_CHUNK_BYTES,
  PRODUCT_RIG_SOURCE_PATH_MAX_BYTES,
  PRODUCT_RIG_STATE_VERSION,
  PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS,
  PRODUCT_RESOURCE_CONDITIONING_CYCLE_COUNT,
  PRODUCT_RESOURCE_MEASURED_CYCLE_COUNT,
  activeTmuxPaneFromRows,
  bindPromotedInitialPane,
  appendBoundedWebDiagnostic,
  awaitWebDiagnosticWithDeadline,
  boundedSourceTraceDiff,
  buildSourceTracePayload,
  buildProductSourceManifest,
  buildProductDiagnosticReport,
  buildWebStartupEvidence,
  causalFixtureBaselineReadiness,
  causalFixtureTeardownDiagnostic,
  causalInputSamples,
  causalInputSampleHasIncarnation,
  causalFixtureShellReady,
  runCausalFixtureTeardownGate,
  causalProbeEpochState,
  latestCausalFixtureCanonicalWraparound,
  coherentReadiness,
  coherentGenerationDuration,
  createProductJsonlTailReader,
  projectProductPaneStreamLifecycle,
  createProductRigAttemptTimelineClock,
  compareProductSourceProvenance,
  deriveProductSourceManifestReadBudget,
  inputPaintSamples,
  paneBodyRegion,
  paneGeometryIdentity,
  productInputQueuesSettled,
  productRigSourceTraceIncludesPath,
  productRigHostHeartbeatObservation,
  productRigSourceTraceDiffArgs,
  productRigSourceTraceUntrackedArgs,
  productSourceHeadBaselineBytes,
  readBoundedSourceTraceFiles,
  productResourceCycleCommands,
  productResourceCyclePlan,
  productResourceEndpointEpochState,
  productResourceGeometryIdentity,
  productResourceMeasuredEndpointTraceIds,
  productResourceProbeCells,
  productCapturePageUrlStatus,
  publicRigStatus,
  readJson,
  redactWebDiagnosticText,
  resolvePaneBodyRect,
  selectProductResourceEndpoint,
  summarizeProductResources,
  shouldCaptureWebConsoleMessage,
  waitForLifecycleEntry,
  writeJsonAtomic,
} from "./product-test-rig-lib.mjs";

import { sourceArchitectureInventory } from "./architecture-debt-inventory.mjs";
import { buildTuiHostPublicationEvidence } from "./lib/tui-host-publication.mjs";
import { acquireProductRigSleepAssertion } from "./lib/product-rig-sleep-assertion.mjs";
import { selectCard5TuiHostFocusBinding } from "./lib/product-cross-client-host-evidence.mjs";

test("Card5 tails join delayed phase-only lifecycle and source-shaped reference records", () => {
  const root = mkdtempSync(join(tmpdir(), "product-card5-dual-tail-"));
  const lifecyclePath = join(root, "performance.jsonl");
  const referencePath = join(root, "performance-trace.jsonl");
  const key = "ab".repeat(32);
  const owners = { input: "opentui:42", focus: "opentui:42", geometry: "opentui:42" };
  const presence = {
    clientId: "opentui:42",
    state: "foreground",
    connectedRevision: 1,
    activityRevision: 9,
  };
  const authority = {
    generation: "generation-a",
    session: "runtime-a",
    revision: 9,
    owners,
    clients: [
      {
        clientId: "web:a",
        surface: "web",
        state: "background",
        connectedRevision: 1,
        activityRevision: 1,
      },
      {
        clientId: "web:b",
        surface: "web",
        state: "background",
        connectedRevision: 2,
        activityRevision: 2,
      },
      {
        clientId: "opentui:42",
        surface: "opentui",
        state: "foreground",
        connectedRevision: 1,
        activityRevision: 9,
      },
    ],
  };
  const expectedCanonical = {
    semanticPaneId: "pane-a",
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    generation: "generation-a",
    incarnation: "generation-a:0",
    revision: 5,
    canonicalStateHash: "a".repeat(16),
  };
  const select = (lifecycleReader, referenceReader) =>
    selectCard5TuiHostFocusBinding({
      lifecycleRecords: lifecycleReader.read(),
      referenceRecords: referenceReader.read(),
      expectedCanonical,
      expectedAuthority: authority,
      expectedWorkspaceName: "workspace-a",
      expectedTuiClientId: "opentui:42",
      evidenceKey: key,
    });
  try {
    writeFileSync(lifecyclePath, "");
    writeFileSync(referencePath, "");
    const lifecycleReader = createProductJsonlTailReader(lifecyclePath, {
      recordKind: "lifecycle",
    });
    const referenceReader = createProductJsonlTailReader(referencePath);
    assert.equal(select(lifecycleReader, referenceReader).passed, false);
    appendFileSync(
      lifecyclePath,
      `${JSON.stringify({ phase: "terminal-host-focus-claim-attempt", claimOrdinal: 1 })}\n`,
    );
    assert.equal(select(lifecycleReader, referenceReader).passed, false);
    appendFileSync(
      referencePath,
      `${JSON.stringify({
        version: 1,
        type: "performance.terminal-frame-fence",
        semanticPaneId: "pane-a",
        processId: "opentui:42",
        clockId: "opentui-performance-now",
        generation: "generation-a",
        incarnation: "generation-a:0",
        revision: 5,
        stateHash: "a".repeat(16),
        rendererEpoch: 3,
      })}\n`,
    );
    assert.equal(select(lifecycleReader, referenceReader).passed, false);
    appendFileSync(
      lifecyclePath,
      `${JSON.stringify({
        phase: "terminal-host-focus-control-gate-ready",
        elapsedMs: 9,
        at: "2026-08-24T20:00:00.000Z",
        capability: true,
        detail: true,
        path: true,
        root: true,
        key: true,
        trace: true,
        enabled: true,
        monotonicMicros: 90,
        processId: "opentui:42",
        clockId: "opentui-performance-now",
      })}\n`,
    );
    assert.equal(select(lifecycleReader, referenceReader).passed, false);
    appendFileSync(
      lifecyclePath,
      `${JSON.stringify({
        phase: "terminal-host-focus-control-binding-ready",
        elapsedMs: 10,
        at: "2026-08-24T20:00:00.000Z",
        bindingEpoch: 1,
        processId: "opentui:42",
        clockId: "opentui-performance-now",
        daemonInstanceId: "generation-a",
        authorityGeneration: "generation-a",
        runtimeSession: "runtime-a",
        workspaceName: "workspace-a",
        clientId: "opentui:42",
        clientPhase: "live",
        rendererEpoch: 3,
        clientGeneration: 7,
        monotonicMicros: 100,
      })}\n`,
    );
    assert.equal(select(lifecycleReader, referenceReader).passed, true);
    appendFileSync(
      lifecyclePath,
      `${JSON.stringify({
        phase: "terminal-host-focus-authority-reconcile",
        diagnosticEpoch: null,
        status: "applied",
        processId: "opentui:42",
        clockId: "opentui-performance-now",
        daemonInstanceId: "generation-a",
        authorityGeneration: "generation-a",
        runtimeSession: "runtime-a",
        workspaceName: "workspace-a",
        clientPhase: "live",
        rendererEpoch: 3,
        clientGeneration: 7,
        authorityRevision: 9,
        authorityOwners: owners,
        opentuiPresence: presence,
        receipts: ["input", "focus", "geometry"].map((authorityKind) => ({
          authority: authorityKind,
          status: "fulfilled",
          granted: true,
          exact: true,
        })),
      })}\n`,
    );
    const exact = select(lifecycleReader, referenceReader);
    assert.equal(exact.passed, true);
    assert.equal(exact.observation.epochMismatch, false);
    assert.equal(exact.observation.clientGenerationMismatch, false);
    assert.equal(
      lifecycleReader.read().filter(({ phase }) => phase === "terminal-host-focus-claim-attempt")
        .length,
      1,
    );
    lifecycleReader.close();
    referenceReader.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental JSONL tail parses each bounded append exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "product-jsonl-tail-"));
  const path = join(root, "trace.jsonl");
  try {
    const values = Array.from({ length: 2_560 }, (_, ordinal) => ({
      version: 1,
      type: "performance.test",
      ordinal,
      text: `${ordinal}:界:${"x".repeat(560)}`,
      ...(ordinal === 0 ? { nested: { exact: true } } : {}),
    }));
    const bytes = Buffer.from(values.map((value) => JSON.stringify(value)).join("\n") + "\n");
    writeFileSync(path, bytes.subarray(0, bytes.length - 1));
    const reader = createProductJsonlTailReader(path, {
      maxBytesPerPoll: 64 * 1024,
      maxRecordsPerPoll: 128,
    });
    let prior = reader.snapshot();
    let maxPollMs = 0;
    while (reader.snapshot().offset < bytes.length - 1) {
      const startedAt = performance.now();
      reader.read();
      maxPollMs = Math.max(maxPollMs, performance.now() - startedAt);
      const next = reader.snapshot();
      assert.ok(next.offset - prior.offset <= 64 * 1024);
      assert.ok(next.recordCount - prior.recordCount <= 128);
      prior = next;
    }
    assert.equal(reader.read().length, values.length - 1);
    appendFileSync(path, "\n");
    assert.deepEqual(reader.read(), values);
    assert.equal(reader.read().length, values.length);
    assert.ok(maxPollMs < 33, `incremental observer poll blocked ${maxPollMs.toFixed(3)}ms`);
    assert.equal(reader.snapshot().offset, bytes.length);
    const exactPrefixMark = reader.mark();
    assert.equal(reader.recordsThrough(exactPrefixMark).length, values.length);
    assert.deepEqual(reader.recordsSince(exactPrefixMark), []);
    assert.equal(new Set(reader.read().map(({ ordinal }) => ordinal)).size, values.length);
    assert.throws(() => {
      reader.read()[0].nested.exact = false;
    }, TypeError);
    let maxQualificationPollMs = 0;
    for (let poll = 0; poll < 1_000; poll += 1) {
      const startedAt = performance.now();
      const cumulative = reader.read();
      const tail = cumulative.slice(2_400);
      assert.equal(tail.filter(({ type }) => type === "performance.test").length, 160);
      assert.equal(cumulative.findLast(({ ordinal }) => ordinal <= 2_559)?.ordinal, 2_559);
      maxQualificationPollMs = Math.max(maxQualificationPollMs, performance.now() - startedAt);
    }
    assert.ok(
      maxQualificationPollMs < 33,
      `integrated observer qualification blocked ${maxQualificationPollMs.toFixed(3)}ms`,
    );
    appendFileSync(
      path,
      `${JSON.stringify({ version: 1, type: "performance.test", ordinal: 2_560 })}\n`,
    );
    reader.read();
    assert.equal(reader.recordsThrough(exactPrefixMark).length, values.length);
    assert.deepEqual(
      reader.recordsSince(exactPrefixMark).map(({ ordinal }) => ordinal),
      [2_560],
    );
    reader.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental JSONL tail preserves partial UTF-8 and fails closed on source mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "product-jsonl-integrity-"));
  const path = join(root, "trace.jsonl");
  try {
    const line = Buffer.from(JSON.stringify({ version: 1, type: "test", text: "界" }) + "\n");
    const split = line.indexOf(Buffer.from("界")) + 1;
    writeFileSync(path, line.subarray(0, split));
    const partial = createProductJsonlTailReader(path, {
      maxBytesPerPoll: 64,
      maxRecordsPerPoll: 2,
    });
    assert.deepEqual(partial.read(), []);
    appendFileSync(path, line.subarray(split));
    assert.equal(partial.read()[0].text, "界");
    truncateSync(path, 0);
    assert.throws(() => partial.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    partial.close();

    writeFileSync(path, `${JSON.stringify({ version: 1, type: "first" })}\n`);
    const replaced = createProductJsonlTailReader(path);
    replaced.read();
    renameSync(path, `${path}.old`);
    writeFileSync(path, `${JSON.stringify({ version: 1, type: "second" })}\n`);
    assert.throws(() => replaced.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    replaced.close();

    writeFileSync(path, "{bad}\n");
    const malformed = createProductJsonlTailReader(path);
    assert.throws(() => malformed.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    malformed.close();

    writeFileSync(path, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
    const invalidUtf8 = createProductJsonlTailReader(path);
    assert.throws(() => invalidUtf8.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    invalidUtf8.close();

    writeFileSync(path, `${JSON.stringify({ version: 1, type: "deleted" })}\n`);
    const deleted = createProductJsonlTailReader(path);
    deleted.read();
    rmSync(path);
    assert.throws(() => deleted.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    deleted.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Card5 daemon lifecycle projection is bounded, keyed, and fails closed on causal gaps", async () => {
  const root = mkdtempSync(join(tmpdir(), "product-pane-stream-lifecycle-"));
  const path = join(root, "daemon.jsonl");
  const evidenceKey = "ab".repeat(32);
  const record = (ordinal, operation = "pane-stream-terminal") => ({
    version: 1,
    type: "performance.stage",
    traceId: `private-request-${ordinal}`,
    authority: { generation: "private-generation", incarnation: null },
    operation,
    terminalDelivery: {
      paneStreamCloseCode: 1012,
      paneStreamCloseReason: "topology-changed",
    },
  });
  try {
    writeFileSync(
      path,
      `${Array.from({ length: 80 }, (_, ordinal) => JSON.stringify(record(ordinal))).join("\n")}\n`,
    );
    const projected = await projectProductPaneStreamLifecycle(path, evidenceKey);
    assert.equal(projected.available, true);
    assert.equal(projected.count, 80);
    assert.equal(projected.overflow, 16);
    assert.equal(projected.events.length, 64);
    assert.equal(projected.events[0].ordinal, 16);
    assert.equal(projected.events.at(-1).closeReason, "topology-changed");
    assert.match(projected.events[0].requestHmac, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(JSON.stringify(projected), /private-request|private-generation/u);

    writeFileSync(path, `${JSON.stringify(record(0, "pane-stream-server-ready"))}\n`);
    let appendedDuringDrain = false;
    let appendRaceConfirmations = 0;
    const appended = await projectProductPaneStreamLifecycle(path, evidenceKey, {
      readerFactory: (readerPath, options) => {
        const reader = createProductJsonlTailReader(readerPath, options);
        return {
          read: () => reader.read(),
          snapshot: () => reader.snapshot(),
          confirmCaughtUp: () => {
            appendRaceConfirmations += 1;
            if (!appendedDuringDrain) {
              appendedDuringDrain = true;
              setImmediate(() => appendFileSync(readerPath, `${JSON.stringify(record(1))}\n`));
            }
            return reader.confirmCaughtUp();
          },
          close: () => reader.close(),
        };
      },
    });
    assert.equal(appendedDuringDrain, true);
    assert.equal(appendRaceConfirmations, 3);
    assert.equal(appended.available, true);
    assert.deepEqual(
      appended.events.map(({ stage, ordinal }) => ({ stage, ordinal })),
      [
        { stage: "server-ready", ordinal: 0 },
        { stage: "terminal", ordinal: 1 },
      ],
    );

    writeFileSync(path, `${JSON.stringify(record(0, "pane-stream-server-ready"))}\n`);
    let growthOrdinal = 1;
    const perpetualGrowth = await projectProductPaneStreamLifecycle(path, evidenceKey, {
      readerFactory: (readerPath, options) => {
        const reader = createProductJsonlTailReader(readerPath, options);
        return {
          read: () => reader.read(),
          snapshot: () => reader.snapshot(),
          confirmCaughtUp: () => {
            appendFileSync(readerPath, `${JSON.stringify(record(growthOrdinal))}\n`);
            growthOrdinal += 1;
            return reader.confirmCaughtUp();
          },
          close: () => reader.close(),
        };
      },
    });
    assert.deepEqual(perpetualGrowth, {
      available: false,
      reason: "reader-budget-exhausted",
      count: 0,
      overflow: 0,
      events: [],
    });
    assert.equal(growthOrdinal, 257);

    writeFileSync(path, `${JSON.stringify(record(0))}\n`);
    const abort = new AbortController();
    let abortedReads = 0;
    let abortedCloses = 0;
    const aborted = await projectProductPaneStreamLifecycle(path, evidenceKey, {
      signal: abort.signal,
      readerFactory: (readerPath, options) => {
        const reader = createProductJsonlTailReader(readerPath, options);
        return {
          read: () => {
            abortedReads += 1;
            return reader.read();
          },
          snapshot: () => reader.snapshot(),
          confirmCaughtUp: () => reader.confirmCaughtUp(),
          close: () => {
            abortedCloses += 1;
            reader.close();
          },
        };
      },
      yieldTurn: async () => abort.abort(),
    });
    assert.deepEqual(aborted, {
      available: false,
      reason: "read-aborted",
      count: 0,
      overflow: 0,
      events: [],
    });
    assert.equal(abortedReads, 1);
    assert.equal(abortedCloses, 1);

    writeFileSync(path, `${JSON.stringify(record(0, "unrelated"))}\n`);
    assert.deepEqual(await projectProductPaneStreamLifecycle(path, evidenceKey), {
      available: false,
      reason: "no-matching-events",
      count: 0,
      overflow: 0,
      events: [],
    });
    writeFileSync(path, "{malformed}\n");
    assert.equal((await projectProductPaneStreamLifecycle(path, evidenceKey)).available, false);
    assert.equal(
      (await projectProductPaneStreamLifecycle(path, evidenceKey)).reason,
      "malformed-record",
    );
    writeFileSync(path, JSON.stringify(record(0)));
    assert.deepEqual(await projectProductPaneStreamLifecycle(path, evidenceKey), {
      available: false,
      reason: "partial-record",
      count: 0,
      overflow: 0,
      events: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental JSONL watermark drains buffered records and commits each poll atomically", () => {
  const root = mkdtempSync(join(tmpdir(), "product-jsonl-watermark-"));
  const path = join(root, "trace.jsonl");
  try {
    const values = Array.from({ length: 600 }, (_, ordinal) => ({
      version: 1,
      type: "t",
      ordinal,
    }));
    writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
    const reader = createProductJsonlTailReader(path, {
      maxBytesPerPoll: 64 * 1024,
      maxRecordsPerPoll: 512,
    });
    assert.equal(reader.read().length, 512);
    assert.equal(reader.snapshot().caughtUp, false);
    assert.equal(reader.read().length, 600);
    assert.equal(reader.snapshot().caughtUp, true);
    const mark = reader.mark();
    appendFileSync(path, `${JSON.stringify({ version: 1, type: "t", ordinal: 600 })}\n`);
    reader.read();
    assert.deepEqual(
      reader.recordsSince(mark).map(({ ordinal }) => ordinal),
      [600],
    );
    assert.equal(Object.isFrozen(reader.recordsSince(mark)), true);
    const foreign = createProductJsonlTailReader(path);
    foreign.read();
    assert.throws(() => foreign.recordsSince(mark), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    foreign.close();
    assert.throws(() => reader.read().push(values[0]), {
      code: "PRODUCT_JSONL_TAIL_INVALID",
    });
    assert.throws(() => reader.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    reader.close();

    writeFileSync(path, `${JSON.stringify(values[0])}\n`);
    const atomic = createProductJsonlTailReader(path);
    const visible = atomic.read();
    assert.equal(visible.length, 1);
    appendFileSync(path, `{malformed}\n${JSON.stringify(values[1])}\n`);
    assert.throws(() => atomic.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    assert.equal(visible.length, 1);
    assert.throws(() => atomic.read(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    assert.throws(() => atomic.snapshot(), { code: "PRODUCT_JSONL_TAIL_INVALID" });
    atomic.close();

    writeFileSync(
      path,
      `${JSON.stringify({ phase: "generation-workspace-client-state", elapsedMs: 1 })}\n`,
    );
    const lifecycle = createProductJsonlTailReader(path, { recordKind: "lifecycle" });
    assert.equal(lifecycle.read()[0].phase, "generation-workspace-client-state");
    assert.equal(lifecycle.snapshot().caughtUp, true);
    lifecycle.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("focus Web readiness detects dev-server exit and signal death", () => {
  assert.equal(devServerProcessIsRunning({ exitCode: null, signalCode: null }), true);
  assert.equal(devServerProcessIsRunning({ exitCode: 1, signalCode: null }), false);
  assert.equal(devServerProcessIsRunning({ exitCode: null, signalCode: "SIGTERM" }), false);
});

test("artifact capture accepts only bounded local ProductRig page URLs", () => {
  for (const pageUrl of [
    "http://127.0.0.1:5173/?devHost=1",
    "http://localhost:4000/",
    "http://[::1]:8080/path",
  ])
    assert.deepEqual(productCapturePageUrlStatus(pageUrl), {
      exact: true,
      pageUrl,
      reason: null,
    });
  for (const [value, reason] of [
    [undefined, "missing-or-shape"],
    ["not a URL", "malformed"],
    ["https://127.0.0.1:5173/", "scheme"],
    ["http://example.com:5173/", "host"],
    ["http://127.0.0.1/", "port"],
    ["http://user:secret@127.0.0.1:5173/", "credentials"],
  ])
    assert.equal(productCapturePageUrlStatus(value).reason, reason);
});

function fakeSleepAssertionChild({ pid = 1234, exitBeforeReady = false } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  queueMicrotask(() => {
    child.emit("spawn");
    if (exitBeforeReady) {
      child.exitCode = 1;
      child.emit("close", 1, null);
    }
  });
  return child;
}

test("ProductRig owns one macOS idle-sleep assertion until exact cleanup", async () => {
  const child = fakeSleepAssertionChild();
  const calls = [];
  const assertion = await acquireProductRigSleepAssertion({
    platform: "darwin",
    verifyAssertions: async () => true,
    ownerPid: 99,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.deepEqual(calls, [
    {
      command: "/usr/bin/caffeinate",
      args: ["-s", "-i", "-w", "99"],
      options: { stdio: "ignore" },
    },
  ]);
  assert.equal(assertion.active(), true);
  assert.equal(assertion.pid, child.pid);
  assert.equal(assertion.failure instanceof Promise, true);
  await assertion.release();
  await assertion.release();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(assertion.active(), false);
});

test("lifecycle wait recovers when the filesystem watcher drops the publication", async () => {
  let entry = null;
  let closed = 0;
  const pending = waitForLifecycleEntry({
    findEntry: () => entry,
    subscribe: () => ({
      close: () => {
        closed += 1;
      },
    }),
    timeoutMs: 250,
    timeoutMessage: "missed lifecycle entry",
    pollIntervalMs: 1,
  });
  setTimeout(() => {
    entry = { phase: "first-terminal-frame", processId: "opentui:42" };
  }, 5);

  assert.deepEqual(await pending, entry);
  assert.equal(closed, 1);
});

test("ProductRig sleep assertion is a non-macOS no-op", async () => {
  let spawned = false;
  const assertion = await acquireProductRigSleepAssertion({
    platform: "linux",
    spawnProcess: () => {
      spawned = true;
    },
  });
  assert.equal(spawned, false);
  assert.equal(assertion.kind, "not-required");
  assert.equal(assertion.active(), true);
  await assertion.release();
});

test("ProductRig fails closed when the macOS sleep assertion exits during acquisition", async () => {
  await assert.rejects(
    acquireProductRigSleepAssertion({
      platform: "darwin",
      verifyAssertions: async () => true,
      ownerPid: 99,
      spawnProcess: () => fakeSleepAssertionChild({ exitBeforeReady: true }),
    }),
    /exited before acquisition completed/u,
  );
});

test("ProductRig fails closed when caffeinate cannot spawn", async () => {
  const child = new EventEmitter();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  queueMicrotask(() => child.emit("error", new Error("missing caffeinate")));
  await assert.rejects(
    acquireProductRigSleepAssertion({
      platform: "darwin",
      verifyAssertions: async () => true,
      ownerPid: 99,
      spawnProcess: () => child,
    }),
    /missing caffeinate/u,
  );
});

test("ProductRig aborts and reaps a sleep assertion acquisition in flight", async () => {
  const child = fakeSleepAssertionChild();
  const controller = new AbortController();
  const acquisition = acquireProductRigSleepAssertion({
    platform: "darwin",
    verifyAssertions: async () => true,
    ownerPid: 99,
    spawnProcess: () => child,
    settle: () => new Promise(() => undefined),
    signal: controller.signal,
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  controller.abort();
  await assert.rejects(acquisition, /acquisition aborted/u);
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("ProductRig reports an acquired sleep assertion that dies unexpectedly", async () => {
  const child = fakeSleepAssertionChild();
  const assertion = await acquireProductRigSleepAssertion({
    platform: "darwin",
    verifyAssertions: async () => true,
    ownerPid: 99,
    spawnProcess: () => child,
  });
  child.exitCode = 9;
  child.emit("close", 9, null);
  await assert.rejects(assertion.failure, /exited unexpectedly \(9\)/u);
  assert.equal(assertion.active(), false);
});

test("ProductRig fails closed when macOS does not publish both sleep assertions", async () => {
  const child = fakeSleepAssertionChild();
  await assert.rejects(
    acquireProductRigSleepAssertion({
      platform: "darwin",
      ownerPid: 99,
      spawnProcess: () => child,
      verifyAssertions: async () => false,
    }),
    /system-sleep assertion could not be verified/u,
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("ProductRig reaps caffeinate when assertion verification errors", async () => {
  const child = fakeSleepAssertionChild();
  await assert.rejects(
    acquireProductRigSleepAssertion({
      platform: "darwin",
      ownerPid: 99,
      spawnProcess: () => child,
      verifyAssertions: async () => {
        throw new Error("pmset timeout");
      },
    }),
    /pmset timeout/u,
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("ProductRig classifies a verified heartbeat gap without relying on monotonic sleep", () => {
  assert.deepEqual(
    productRigHostHeartbeatObservation({
      previousHeartbeatWallMs: 1_000,
      wallNowMs: 931_000,
    }),
    {
      reason: "host-suspended",
      suspended: true,
      elapsedMs: 930_000,
      expectedIntervalMs: 100,
      gapMs: 929_900,
    },
  );
});

test("source provenance accepts patches above Node's default buffer and enforces a hard ceiling", () => {
  const aboveNodeDefault = "x".repeat(1024 * 1024 + 1);
  assert.equal(boundedSourceTraceDiff(aboveNodeDefault), aboveNodeDefault);
  assert.throws(
    () => boundedSourceTraceDiff("x".repeat(PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES + 1)),
    /hard ceiling/u,
  );
});

test("source provenance deterministically binds sorted untracked paths and bytes", () => {
  const tracked = Buffer.from("tracked-diff\0bytes");
  const files = [
    { path: "scripts/z-new.mjs", content: Buffer.from("z\0content") },
    { path: "packages/core/src/a-new.ts", content: Buffer.from("alpha") },
  ];
  const payload = buildSourceTracePayload(tracked, files);
  const reversed = buildSourceTracePayload(tracked, files.toReversed());
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.deepEqual(payload, reversed);
  assert.notEqual(
    digest(payload),
    digest(
      buildSourceTracePayload(tracked, [
        files[0],
        { ...files[1], content: Buffer.from("changed") },
      ]),
    ),
  );
  assert.notEqual(
    digest(payload),
    digest(
      buildSourceTracePayload(tracked, [
        files[0],
        { ...files[1], path: "packages/core/src/renamed.ts" },
      ]),
    ),
  );
  assert.throws(() => buildSourceTracePayload(tracked, [...files, files[0]]), /malformed/u);
  assert.throws(
    () => buildSourceTracePayload(tracked, [{ path: "../outside", content: "x" }]),
    /malformed/u,
  );
  assert.throws(
    () =>
      buildSourceTracePayload("", [
        { path: "scripts/new.mjs", content: "x".repeat(PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES) },
      ]),
    /hard ceiling/u,
  );
  assert.equal(productRigSourceTraceIncludesPath("scripts/lib/product-first-input.mjs"), true);
  assert.equal(
    productRigSourceTraceIncludesPath("packages/daemon/native/target/debug/artifact"),
    false,
  );
});

test("source provenance manifest reports stable and bounded between-run drift", () => {
  const expected = {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    manifestDigest: "c".repeat(64),
    manifest: [
      { pathDigest: "1".repeat(64), contentDigest: "2".repeat(64), bytes: 10 },
      { pathDigest: "3".repeat(64), contentDigest: "4".repeat(64), bytes: 20 },
    ],
  };
  assert.equal(compareProductSourceProvenance(expected, structuredClone(expected)).stable, true);
  const changed = structuredClone(expected);
  changed.tree = "d".repeat(40);
  changed.manifestDigest = "e".repeat(64);
  changed.manifest[1].contentDigest = "f".repeat(64);
  const assessment = compareProductSourceProvenance(expected, changed);
  assert.equal(assessment.stable, false);
  assert.equal(assessment.treeExact, false);
  assert.equal(assessment.changedCount, 1);
  assert.deepEqual(assessment.changedPathDigests, ["3".repeat(64)]);
});

test("source manifest uses a derived bounded budget and fixed-memory exact hashing", () => {
  const makeFile = (content, ino, declaredSize = content.length) => ({
    content: Buffer.from(content),
    declaredSize,
    dev: 7,
    ino,
    regular: true,
  });
  const build = (entries, maxBytes, onRead = () => undefined) => {
    const files = new Map(entries);
    let maxRequested = 0;
    const result = buildProductSourceManifest(
      [...files.keys()],
      {
        openFile(path) {
          const file = files.get(path);
          if (file?.symlink) throw Object.assign(new Error("symlink"), { code: "ELOOP" });
          if (!file) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return { path, file };
        },
        statFile(descriptor) {
          return {
            isFile: () => descriptor.file.regular,
            size: descriptor.file.declaredSize,
            dev: descriptor.file.dev,
            ino: descriptor.file.ino,
          };
        },
        readChunk(descriptor, buffer, requested, position) {
          maxRequested = Math.max(maxRequested, requested);
          onRead({ descriptor, files, position, requested });
          const available = Math.max(
            0,
            Math.min(requested, descriptor.file.content.length - position),
          );
          descriptor.file.content.copy(buffer, 0, position, position + available);
          return available;
        },
        closeFile() {},
      },
      maxBytes,
    );
    return { ...result, maxRequested };
  };

  const currentBytes = 8_409_153;
  assert.equal(productSourceHeadBaselineBytes(["blob 7534884", "HEAD:new missing"], 2), 7_534_884);
  assert.throws(() => productSourceHeadBaselineBytes(["tree 1"], 1), /invalid/u);
  assert.throws(
    () => productSourceHeadBaselineBytes([`blob ${Number.MAX_SAFE_INTEGER}`, "blob 1"], 2),
    /overflowed/u,
  );
  const currentBudget = deriveProductSourceManifestReadBudget(7_534_884);
  assert.equal(currentBudget, 15_923_492);
  const current = build(
    [["bin/current-source.js", makeFile(Buffer.alloc(currentBytes, 0x61), 1)]],
    currentBudget,
  );
  assert.equal(current.bytes, currentBytes);
  assert.ok(current.maxRequested <= PRODUCT_RIG_SOURCE_MANIFEST_HASH_CHUNK_BYTES);

  const exactBudget = deriveProductSourceManifestReadBudget(10, 5, 100);
  assert.equal(build([["scripts/exact.mjs", makeFile("x".repeat(15), 2)]], exactBudget).bytes, 15);
  assert.throws(
    () => build([["scripts/over.mjs", makeFile("x".repeat(16), 3)]], exactBudget),
    /byte ceiling/u,
  );
  assert.equal(
    deriveProductSourceManifestReadBudget(
      PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES,
      PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
    ),
    PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES,
  );
  assert.throws(
    () =>
      build(
        [
          [
            "scripts/hard-over.mjs",
            makeFile("", 4, PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES + 1),
          ],
        ],
        PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES,
      ),
    /byte ceiling/u,
  );
  assert.throws(
    () => deriveProductSourceManifestReadBudget(Number.MAX_SAFE_INTEGER, 1),
    /overflowed/u,
  );

  const children = build(
    [
      ["scripts/a.mjs", makeFile("alpha", 5)],
      ["scripts/b.mjs", makeFile("beta", 6)],
    ],
    100,
  );
  assert.equal(
    children.manifest[0].contentDigest,
    createHash("sha256").update("alpha").digest("hex"),
  );
  assert.equal(
    children.manifestDigest,
    createHash("sha256").update(JSON.stringify(children.manifest)).digest("hex"),
  );
});

test("source manifest fails closed on symlink, growth, truncation, and path replacement", () => {
  const file = (content, ino) => ({
    content: Buffer.from(content),
    declaredSize: Buffer.byteLength(content),
    dev: 8,
    ino,
    regular: true,
  });
  const run = (initial, mutate) => {
    const files = new Map([["scripts/source.mjs", initial]]);
    return buildProductSourceManifest(
      ["scripts/source.mjs"],
      {
        openFile(path) {
          const current = files.get(path);
          if (current?.symlink) throw Object.assign(new Error("symlink"), { code: "ELOOP" });
          if (!current) throw Object.assign(new Error("missing"), { code: "ENOENT" });
          return { path, file: current };
        },
        statFile: ({ file: current }) => ({
          isFile: () => current.regular,
          size: current.declaredSize,
          dev: current.dev,
          ino: current.ino,
        }),
        readChunk(descriptor, buffer, requested, position) {
          mutate({ descriptor, files, position });
          const count = Math.max(0, Math.min(requested, descriptor.file.content.length - position));
          descriptor.file.content.copy(buffer, 0, position, position + count);
          return count;
        },
        closeFile() {},
      },
      1_024,
    );
  };

  assert.throws(() => run({ ...file("x", 1), symlink: true }, () => undefined), /symlink/u);
  let missingOpens = 0;
  const deleted = buildProductSourceManifest(
    ["scripts/deleted.mjs"],
    {
      openFile() {
        missingOpens += 1;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      statFile: () => assert.fail("deleted file must not be statted"),
      readChunk: () => assert.fail("deleted file must not be read"),
      closeFile: () => assert.fail("deleted file must not be closed"),
    },
    1_024,
  );
  assert.equal(missingOpens, 2);
  assert.equal(deleted.manifest[0].bytes, 0);
  let appearingOpens = 0;
  assert.throws(
    () =>
      buildProductSourceManifest(
        ["scripts/appeared.mjs"],
        {
          openFile() {
            appearingOpens += 1;
            if (appearingOpens === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
            return { file: file("x", 10) };
          },
          statFile: ({ file: current }) => ({
            isFile: () => current.regular,
            size: current.declaredSize,
            dev: current.dev,
            ino: current.ino,
          }),
          readChunk: () => 0,
          closeFile() {},
        },
        1_024,
      ),
    /changed while building/u,
  );
  let grew = false;
  assert.throws(
    () =>
      run(file("abc", 2), ({ descriptor, position }) => {
        if (!grew && position === 3) {
          grew = true;
          descriptor.file.content = Buffer.from("abcd");
          descriptor.file.declaredSize = 4;
        }
      }),
    /changed while building/u,
  );
  let truncated = false;
  assert.throws(
    () =>
      run(file("abcdef", 3), ({ descriptor, position }) => {
        if (!truncated && position === 0) {
          truncated = true;
          descriptor.file.content = Buffer.from("abc");
          descriptor.file.declaredSize = 3;
        }
      }),
    /changed while building/u,
  );
  let replaced = false;
  assert.throws(
    () =>
      run(file("abc", 4), ({ files, position }) => {
        if (!replaced && position === 3) {
          replaced = true;
          files.set("scripts/source.mjs", file("abc", 5));
        }
      }),
    /changed while building/u,
  );
});

test("source provenance rejects oversized untracked input before reading content", () => {
  let reads = 0;
  let closes = 0;
  assert.throws(
    () =>
      readBoundedSourceTraceFiles(
        "tracked",
        ["scripts/huge-new.mjs"],
        {
          openFile: () => 17,
          statFile: () => ({ isFile: () => true, size: PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES }),
          readFile: () => {
            reads += 1;
            return Buffer.alloc(0);
          },
          closeFile: () => {
            closes += 1;
          },
        },
        1_024,
      ),
    /hard ceiling/u,
  );
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  let statCalls = 0;
  assert.throws(
    () =>
      readBoundedSourceTraceFiles("", ["scripts/raced.mjs"], {
        openFile: () => 18,
        statFile: () => {
          statCalls += 1;
          return {
            isFile: () => true,
            size: statCalls === 1 ? 1 : 2,
            dev: 4,
            ino: 9,
          };
        },
        readFile: () => Buffer.from("x"),
        closeFile: () => undefined,
      }),
    /changed while hashing/u,
  );
  assert.throws(
    () =>
      readBoundedSourceTraceFiles(
        "",
        Array.from(
          { length: PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS + 1 },
          (_, index) => `scripts/${index}.mjs`,
        ),
        {
          openFile: () => assert.fail("oversized inventory must not open files"),
          statFile: () => assert.fail("oversized inventory must not stat files"),
          readFile: () => assert.fail("oversized inventory must not read files"),
          closeFile: () => assert.fail("oversized inventory must not close unopened files"),
        },
      ),
    /path-count ceiling/u,
  );
  assert.throws(
    () =>
      buildSourceTracePayload("", [
        { path: "x".repeat(PRODUCT_RIG_SOURCE_PATH_MAX_BYTES + 1), content: "" },
      ]),
    /malformed/u,
  );
});

test("source provenance excludes tracked native changes but binds tracked source changes", () => {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-source-trace-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "packages", "daemon", "native"), { recursive: true });
    writeFileSync(join(root, "scripts", "tracked.mjs"), "export const value = 1;\n");
    writeFileSync(join(root, "packages", "daemon", "native", "tracked.bin"), "native-1\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=ProductRig", "-c", "user.email=rig@example.test", "commit", "-qm", "base"],
      { cwd: root },
    );
    writeFileSync(join(root, "packages", "daemon", "native", "tracked.bin"), "native-2\n");
    assert.equal(
      execFileSync("git", productRigSourceTraceDiffArgs(), { cwd: root, encoding: "utf8" }),
      "",
    );
    writeFileSync(join(root, "scripts", "tracked.mjs"), "export const value = 2;\n");
    const diff = execFileSync("git", productRigSourceTraceDiffArgs(), {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(diff, /scripts\/tracked\.mjs/u);
    assert.doesNotMatch(diff, /packages\/daemon\/native/u);
    writeFileSync(join(root, "packages", "daemon", "native", "untracked.bin"), "native-new\n");
    writeFileSync(join(root, "scripts", "untracked.mjs"), "export const fresh = true;\n");
    const untracked = execFileSync("git", productRigSourceTraceUntrackedArgs(), {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    assert.deepEqual(untracked, ["scripts/untracked.mjs"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key and paste timelines use distinct attempt-local origins shared with their owners", () => {
  let parentNow = 10_000;
  const keyParent = createProductRigAttemptTimelineClock(() => parentNow, 10_000);
  assert.equal(keyParent.elapsedMs(), 0);
  parentNow = 10_250;
  assert.equal(keyParent.elapsedMs(), 250);

  let ownerNow = 10_400;
  const keyOwner = createProductRigAttemptTimelineClock(() => ownerNow, 10_000);
  assert.equal(keyOwner.elapsedMs(), 400);
  ownerNow = 34_000;
  assert.equal(keyOwner.elapsedMs(), 24_000);

  let pasteNow = 63_000;
  const pasteParent = createProductRigAttemptTimelineClock(() => pasteNow, 63_000);
  assert.equal(pasteParent.elapsedMs(), 0);
  pasteNow = 88_400;
  assert.equal(pasteParent.elapsedMs(), 25_400);
  assert.notEqual(pasteParent.elapsedMs(), 53_026);

  let pasteOwnerNow = 63_180;
  const pasteOwner = createProductRigAttemptTimelineClock(() => pasteOwnerNow, 63_000);
  assert.equal(pasteOwner.elapsedMs(), 180);
  pasteOwnerNow = 63_179;
  assert.throws(() => pasteOwner.elapsedMs(), /invalid/u);

  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /async function executeDiagnosticAttempt\(entry\) \{\s*resetAttemptTimelineClock\(\);/u,
  );
  assert.match(source, /TMUX_IDE_PRODUCT_TIMELINE_ORIGIN_MS: String\(attemptTimelineOriginMs\)/u);
  assert.match(
    source,
    /resetAttemptTimelineClock\(\s*Number\.isFinite\(inheritedTimelineOrigin\)/u,
  );
});

test("Web startup evidence redacts browser authority recursively", () => {
  const secret = "owner-secret-value";
  const evidence = buildWebStartupEvidence(
    {
      capturedAt: "2026-08-16T00:00:00.000Z",
      navigation: {
        requestedUrl: `http://localhost/?token=${secret}`,
        url: `ws://localhost/events?__tmux_ide_dev_host_session=${secret}`,
        status: 503,
      },
      page: { authorization: `Bearer ${secret}`, bodyExcerpt: `token=${secret}` },
      dom: { tag: "meta", attributes: { capability: secret }, children: [] },
      console: [{ type: "error", text: `Bearer ${secret}` }],
      webSockets: [{ event: "open", url: `ws://localhost/?__tmux_ide_dev_host_session=${secret}` }],
      screenshotPath: "/tmp/evidence.png",
      screenshotError: null,
      viteOutput: `ownerToken=${secret}`,
      daemonOutput: secret,
    },
    { secrets: [secret] },
  );
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.match(serialized, /\[REDACTED\]/u);
  assert.equal(evidence.page.authorization, "[REDACTED]");
  assert.equal(evidence.dom, null);
  assert.match(redactWebDiagnosticText("Authorization: Bearer abc"), /\[REDACTED\]/u);
  assert.doesNotMatch(
    redactWebDiagnosticText(`/?__tmux_ide_dev_host_session=${secret}`),
    new RegExp(secret, "u"),
  );
});

test("Web startup evidence has a deterministic bounded shape", () => {
  const events = Array.from(
    { length: PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount + 9 },
    (_, id) => ({
      id,
      text: "x".repeat(PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.textChars + 20),
    }),
  );
  const evidence = buildWebStartupEvidence({
    capturedAt: "now",
    console: events,
    webSockets: events.map(({ id }) => ({ event: "open", id, url: `ws://localhost/${id}` })),
    viteOutput: "v".repeat(PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.processOutputChars + 20),
    daemonOutput: "d".repeat(PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.processOutputChars + 20),
  });
  assert.deepEqual(Object.keys(evidence), [
    "version",
    "kind",
    "capturedAt",
    "navigation",
    "page",
    "dom",
    "pageErrors",
    "console",
    "requestFailures",
    "httpErrors",
    "webSockets",
    "screenshotPath",
    "screenshotError",
    "viteOutput",
    "daemonOutput",
  ]);
  assert.equal(evidence.console.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount);
  assert.equal(evidence.console[0].id, 9);
  assert.equal(evidence.console[0].text.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.textChars);
  assert.equal(evidence.webSockets.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount);
  assert.equal(evidence.webSockets[0].id, 9);
  assert.equal(evidence.viteOutput.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.processOutputChars);
  assert.equal(evidence.daemonOutput.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.processOutputChars);
  assert.equal(evidence.screenshotPath, null);
  assert.equal(evidence.screenshotError, null);
});

test("Web startup collectors bound at capture time and retain the host-active info line", () => {
  const captured = [];
  for (let id = 0; id < PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount + 3; id += 1) {
    appendBoundedWebDiagnostic(captured, { id });
  }
  assert.equal(captured.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount);
  assert.equal(captured[0].id, 3);
  assert.equal(shouldCaptureWebConsoleMessage("warning", "ordinary warning"), true);
  assert.equal(
    shouldCaptureWebConsoleMessage("info", "[tmux-ide] development web host active via gateway"),
    true,
  );
  assert.equal(shouldCaptureWebConsoleMessage("info", "ordinary info"), false);
});

test("Web startup collectors sanitize oversized raw events before retaining them", () => {
  const secret = "raw-host-session-secret";
  const captured = [];
  appendBoundedWebDiagnostic(
    captured,
    {
      url: `ws://localhost/?__tmux_ide_dev_host_session=${secret}`,
      text: "t".repeat(PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.textChars + 100),
      error: `Bearer ${secret}`,
      nested: Array.from({ length: PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount + 5 }, (_, id) => ({
        id,
        detail: "d".repeat(PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.textChars + 100),
      })),
      [`${"x".repeat(PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.fieldNameChars)}token`]: secret,
      ...Object.fromEntries(
        Array.from({ length: PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount + 5 }, (_, id) => [
          `field-${id}`,
          id,
        ]),
      ),
    },
    { secrets: [secret] },
  );
  const [event] = captured;
  assert.notEqual(event.text.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.textChars + 100);
  assert.equal(event.text.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.textChars);
  assert.equal(event.nested.length, PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount);
  assert.ok(Object.keys(event).length <= PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount);
  assert.ok(Object.values(event).includes("[REDACTED]"));
  assert.doesNotMatch(JSON.stringify(event), new RegExp(secret, "u"));
});

test("Web diagnostic evaluation has a fixed deadline and consumes a late rejection", async () => {
  const never = new Promise(() => undefined);
  const timedOut = await awaitWebDiagnosticWithDeadline(never, {
    timeoutMs: 1,
    onFailure: (error) => error.message,
  });
  assert.match(timedOut, /evaluation exceeded 1ms/u);

  let rejectLate;
  const late = new Promise((resolve, reject) => {
    rejectLate = reject;
  });
  const lateResult = await awaitWebDiagnosticWithDeadline(late, {
    timeoutMs: 0,
    onFailure: (error) => error.message,
  });
  rejectLate(new Error("late renderer rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(lateResult, /evaluation exceeded 0ms/u);
});

test("host publication proof requires chrome and generation-local terminal bytes", () => {
  const first = buildTuiHostPublicationEvidence({
    frame: " tmux-ide  F2 Terminals\nprompt FIRST_GENERATION_MARKER",
    kind: "terminal",
    token: "FIRST_GENERATION_MARKER",
    generation: "generation-a",
    processId: 11,
    elapsedMs: 42.4,
  });
  const second = buildTuiHostPublicationEvidence({
    frame: " tmux-ide  F2 Terminals\nprompt SECOND_GENERATION_MARKER",
    kind: "terminal",
    token: "SECOND_GENERATION_MARKER",
    generation: "generation-b",
    processId: 12,
    elapsedMs: 39.7,
  });
  assert.equal(first.passed, true);
  assert.equal(second.passed, true);
  assert.notEqual(first.frameHash, second.frameHash);
  assert.equal(
    buildTuiHostPublicationEvidence({
      frame: "",
      kind: "terminal",
      token: "SECOND_GENERATION_MARKER",
    }).passed,
    false,
  );
  assert.equal(
    buildTuiHostPublicationEvidence({
      frame: "tmux-ide without the requested terminal bytes",
      kind: "terminal",
      token: "SECOND_GENERATION_MARKER",
    }).passed,
    false,
  );
  assert.equal(
    buildTuiHostPublicationEvidence({ frame: "tmux-ide", kind: "terminal" }).passed,
    false,
  );
  assert.throws(
    () => buildTuiHostPublicationEvidence({ frame: "tmux-ide", kind: "paint" }),
    /chrome or terminal/u,
  );
});

test("normalizes external host generation marks for warm coherent timing", () => {
  const lifecycle = [
    {
      phase: "generation-connection-resolved",
      daemonGeneration: "generation-a",
      elapsedMs: 100,
    },
    {
      phase: "first-terminal-frame",
      daemonGeneration: "generation-a",
      elapsedMs: 300,
    },
    {
      phase: "host-terminal-publication",
      generation: "generation-a",
      elapsedMs: 325,
    },
  ];
  assert.equal(coherentGenerationDuration(lifecycle), 225);
});

test("resolves active tmux runtime and semantic pane identities together", () => {
  const pane = activeTmuxPaneFromRows(
    [
      "%1|1|0|pane.promoted.left|0|0|50|30",
      "%2|1|1|pane.promoted.right|51|0|50|30",
      "%3|0|1|pane.promoted.hidden|0|0|101|30",
    ].join("\n"),
  );
  assert.deepEqual(pane, {
    paneId: "%2",
    windowActive: true,
    paneActive: true,
    semanticPaneId: "pane.promoted.right",
    left: 51,
    top: 0,
    width: 50,
    height: 30,
  });
  assert.equal(activeTmuxPaneFromRows("%1|1|1||0|0|50|30"), null);
  assert.equal(
    activeTmuxPaneFromRows("%1|1|1|pane.one|0|0|50|30\n%2|1|1|pane.two|50|0|50|30"),
    null,
  );
  assert.equal(
    bindPromotedInitialPane({ paneId: "%2", width: 80, height: 24 }, pane).semanticPaneId,
    "pane.promoted.right",
  );
  assert.throws(
    () => bindPromotedInitialPane({ paneId: "%1", width: 80, height: 24 }, pane),
    /did not match/u,
  );
});

test("anchors a two-pane framebuffer body to semantic chrome when tmux origin drifted", () => {
  const frame = [
    " tmux-ide",
    " one",
    "● pane.promoted.left".padEnd(50) + " " + "○ pane.promoted.right".padEnd(50),
    "left seed".padEnd(50) + " " + "__right_unique_marker__".padEnd(50),
    "".padEnd(50) + " " + "right row two".padEnd(50),
    "".padEnd(50) + " " + "right row three".padEnd(50),
  ].join("\n");
  const pane = activeTmuxPaneFromRows(
    // Deliberately stale/impossible tmux origin: this is the failure mode the
    // live evidence previously hashed as an almost-empty rectangle. Keeping
    // the full active-pane sample supplies the semantic chrome anchor.
    "%2|1|1|pane.promoted.right|7|28|50|3",
  );
  assert.ok(pane);
  assert.deepEqual(resolvePaneBodyRect(frame, pane), {
    left: 51,
    firstBodyRow: 3,
    width: 50,
    bodyRows: 3,
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  });
  assert.match(paneBodyRegion(frame, pane), /__right_unique_marker__/u);
  assert.doesNotMatch(paneBodyRegion(frame, pane), /left seed/u);
});

test("root-v2 projects all 40 tmux content rows below separate semantic chrome", () => {
  const frame = [
    " tmux-ide",
    " ordinary",
    "● pane.run".padEnd(132),
    ...Array.from({ length: 40 }, (_unused, row) => `body-${row}`.padEnd(132)),
  ].join("\n");
  const pane = {
    semanticPaneId: "pane.run",
    left: 0,
    top: 0,
    width: 132,
    height: 40,
  };
  assert.deepEqual(resolvePaneBodyRect(frame, pane), {
    left: 0,
    firstBodyRow: 3,
    width: 132,
    bodyRows: 40,
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  });
  assert.equal(paneBodyRegion(frame, pane).split("\n").length, 40);
  assert.match(paneBodyRegion(frame, pane), /body-39/u);
});

test("focus framebuffer proof has no synchronous target tmux reads and fences native capture", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "product-test-rig.mjs"), "utf8");
  const focusSlice = source.slice(
    source.indexOf("async function focusPaneSnapshot("),
    source.indexOf("async function activePaneBodyEvidence("),
  );
  assert.doesNotMatch(focusSlice, /execFileSync|tuiCommand\(/u);
  assert.match(focusSlice, /focusActiveWindowPaneGeometry\(state, lifecycle\)/u);
  assert.match(focusSlice, /stage: "native-body-post-capture"/u);
  assert.match(source, /#\{window_visible_layout\}/u);
});

test("focus Web success publishes exact stable semantic readiness before later correlation", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("startWebAfterFocus:");
  const slice = source.slice(
    start,
    source.indexOf('if (journeyId === "coherent-first-pane")', start),
  );
  const readinessPublish = slice.indexOf("focusWebSemantic: semantic");
  const laterWorkspaceState = slice.indexOf("waitForFocusWorkspaceEvidence", readinessPublish);
  const watermark = slice.indexOf("focusWorkspaceEvidenceWatermark");
  const devServerStart = slice.indexOf("startDevServer");
  assert.ok(readinessPublish > 0);
  assert.ok(laterWorkspaceState > readinessPublish);
  assert.ok(watermark > 0);
  assert.ok(devServerStart > watermark);
  assert.match(
    slice,
    /derivedResources: reclaim\.workspaceClient\.derived\.terminalInventory\.resources/u,
  );
  assert.doesNotMatch(slice, /derivedResources:[^\n]*\?\?/u);
  assert.match(slice, /clientGeneration: reclaim\.workspaceClient\.committed\.generation/u);
  assert.match(slice, /semanticPaneId: reclaim\.assessment\.qualified\.semanticPaneId/u);
  assert.match(slice, /afterMicros: workspaceClientWatermark \+ 1/u);
  assert.match(slice, /boundary: "focus-web-correlation"/u);
  const reclaimStart = source.indexOf("driveFocus:");
  const reclaimSlice = source.slice(reclaimStart, start);
  assert.match(reclaimSlice, /\.\.\.baseline\.expected,[\s\S]*boundary: "focus-reclaim-proved"/u);
  assert.match(
    slice,
    /semantic: focusBoot\.web\.semantic,[\s\S]*readiness: focusBoot\.web\.readiness/u,
  );
  assert.doesNotMatch(slice, /locator\("\.terminal-surface\[data-phase='connected'\]"\)/u);
});

test("causal qualification passes the full active pane into its after-capture body", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  assert.match(source, /const renderedBody = paneBodyRegion\(tuiFrame, activePane\);/u);
});

test("fails closed when duplicate semantic chrome could map a marker to the wrong pane", () => {
  const frame = [
    " tmux-ide",
    " one",
    "● pane.duplicate".padEnd(30) + "○ pane.duplicate".padEnd(30),
    // The marker expected for the RIGHT-hand pane appears only in the first,
    // wrong rectangle. A first-match resolver would therefore false-pass.
    "__right_marker__".padEnd(30) + "right has no marker".padEnd(30),
  ].join("\n");
  const pane = {
    semanticPaneId: "pane.duplicate",
    left: 30,
    top: 0,
    width: 30,
    height: 2,
  };
  assert.match(frame.split("\n")[3].slice(0, 30), /__right_marker__/u);
  assert.doesNotMatch(frame.split("\n")[3].slice(30, 60), /__right_marker__/u);
  assert.deepEqual(resolvePaneBodyRect(frame, pane), {
    left: 30,
    firstBodyRow: 3,
    width: 30,
    bodyRows: 0,
    origin: "semantic-pane-chrome-ambiguous",
    valid: false,
    semanticChromeMatches: 2,
  });
  assert.equal(paneBodyRegion(frame, pane), "");
});

test("pane geometry identity is order-independent and changes on any rectangle mutation", () => {
  const left = {
    paneId: "%1",
    semanticPaneId: "pane.left",
    left: 0,
    top: 0,
    width: 50,
    height: 30,
  };
  const right = {
    paneId: "%2",
    semanticPaneId: "pane.right",
    left: 51,
    top: 0,
    width: 50,
    height: 30,
  };
  assert.equal(paneGeometryIdentity([left, right]), paneGeometryIdentity([right, left]));
  assert.notEqual(
    paneGeometryIdentity([left, right]),
    paneGeometryIdentity([left, { ...right, left: 52 }]),
  );
});

test("coherent readiness never aliases app chrome to terminal readiness", () => {
  assert.deepEqual(coherentReadiness({ chromeMs: 12.4, terminalMs: null }), {
    appChromeFrameMs: 12,
    coherentTerminalFrameMs: null,
    ready: false,
  });
  assert.equal(coherentReadiness({ chromeMs: 12, terminalMs: 31 }).ready, true);
});

test("correlates same-client stages and daemon-local spans without subtracting clocks", () => {
  const traceId = "00000000-0000-4000-8000-000000000123";
  const samples = causalInputSamples(
    [
      {
        type: "performance.stage",
        traceId,
        stage: "input",
        processId: "opentui:1",
        clockId: "client-clock",
        startedAtMicros: 1_000,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "client",
        operation: "lane-enqueue",
        processId: "opentui:1",
        clockId: "client-clock",
        atMicros: 2_000,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "paint",
        processId: "opentui:1",
        clockId: "client-clock",
        endedAtMicros: 9_000,
        generation: "generation",
      },
    ],
    [
      {
        type: "performance.stage",
        traceId,
        stage: "tmux",
        operation: "raw-input-command",
        processId: "daemon:2",
        clockId: "daemon-clock",
        startedAtMicros: 50_000,
        endedAtMicros: 53_000,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "tmux",
        operation: "control-write",
        processId: "daemon:2",
        clockId: "daemon-clock",
        startedAtMicros: 53_100,
        endedAtMicros: 53_200,
      },
      {
        type: "performance.stage",
        traceId,
        stage: "tmux",
        operation: "first-output-observed",
        processId: "daemon:2",
        clockId: "daemon-clock",
        startedAtMicros: 70_000,
        endedAtMicros: 70_100,
      },
    ],
  );
  assert.deepEqual(
    samples[0]?.clientStages.map(({ operation, offsetMs }) => ({ operation, offsetMs })),
    [{ operation: "lane-enqueue", offsetMs: 1 }],
  );
  assert.deepEqual(samples[0]?.daemonSpans, [
    {
      stage: "tmux",
      operation: "raw-input-command",
      startedAtMicros: 50_000,
      endedAtMicros: 53_000,
      offsetMs: 0,
      durationMs: 3,
      processId: "daemon:2",
      clockId: "daemon-clock",
    },
    {
      stage: "tmux",
      operation: "control-write",
      startedAtMicros: 53_100,
      endedAtMicros: 53_200,
      offsetMs: 3.1,
      durationMs: 0.1,
      processId: "daemon:2",
      clockId: "daemon-clock",
    },
    {
      stage: "tmux",
      operation: "first-output-observed",
      startedAtMicros: 70_000,
      endedAtMicros: 70_100,
      offsetMs: 20,
      durationMs: 0.1,
      processId: "daemon:2",
      clockId: "daemon-clock",
    },
  ]);
});

test("fails closed when causal-cell-v1 has no finalized proofs", () => {
  const report = buildProductDiagnosticReport({
    state: { status: "ready", daemon: { instanceId: "generation" }, convergence: null },
    truth: { session: "alpha", windows: [], panes: [] },
    lifecycle: [],
    traceRecords: [],
    daemonTraceRecords: [],
    stderr: "",
  });
  assert.equal(report.inputCausalSummary.causalAttribution, false);
  assert.equal(report.inputCausalSummary.correlation, "causal-cell-v1");
  assert.equal(report.inputCausalSummary.finalizedProofs, 0);
  assert.equal(report.firstBrokenInputBoundary, "input-or-paint-pair");
  assert.ok(
    report.boundaries.some(
      (boundary) => boundary.id === "input-enqueue-to-correlated-changed-cell-paint",
    ),
  );
});

test("causal probe epochs admit one input and close on one terminal result", () => {
  const processId = "opentui:1";
  const traceId = "00000000-0000-4000-8000-000000000001";
  const input = { type: "performance.stage", stage: "input", processId, traceId };
  assert.deepEqual(causalProbeEpochState([input], 0, processId), {
    status: "pending",
    traceId,
    reason: null,
  });
  assert.deepEqual(
    causalProbeEpochState(
      [
        input,
        {
          type: "performance.stage",
          stage: "client",
          processId,
          traceId,
          operation: "causal-cell-painted",
        },
      ],
      0,
      processId,
    ),
    { status: "proved", traceId, reason: null },
  );
  assert.deepEqual(
    causalProbeEpochState(
      [
        input,
        {
          type: "performance.stage",
          stage: "client",
          processId,
          traceId,
          operation: "causal-cell-failed:baseline-drift",
        },
      ],
      0,
      processId,
    ),
    { status: "failed", traceId, reason: "baseline-drift" },
  );
});

test("causal probe epochs fail closed instead of pseudoreplicating concurrent inputs", () => {
  const processId = "opentui:1";
  assert.deepEqual(
    causalProbeEpochState(
      [
        { type: "performance.stage", stage: "input", processId, traceId: "trace-a" },
        { type: "performance.stage", stage: "input", processId, traceId: "trace-b" },
      ],
      0,
      processId,
    ),
    { status: "ambiguous", traceId: null, reason: "multiple-inputs" },
  );
});

test("causal fixture teardown requires the restored shell, marker, queues and geometry", () => {
  const ready = {
    fixtureOption: "",
    currentCommand: "zsh",
    expectedCommand: "zsh",
    marker: "tmux-ide-shell-ready-token",
    nativeFrame: "tmux-ide-shell-ready-token",
    tuiBody: "tmux-ide-shell-ready-token",
    inputPending: 0,
    inputInFlight: 0,
    inputPendingBytes: 0,
    geometryStable: true,
    canonicalWraparound: true,
  };
  assert.equal(causalFixtureShellReady(ready), true);
  for (const [field, value] of [
    ["fixtureOption", "ready-v1"],
    ["currentCommand", "node"],
    ["nativeFrame", ""],
    ["tuiBody", ""],
    ["inputPending", 1],
    ["inputInFlight", 1],
    ["inputPendingBytes", 1],
    ["geometryStable", false],
    ["canonicalWraparound", false],
  ]) {
    assert.equal(causalFixtureShellReady({ ...ready, [field]: value }), false, field);
  }
});

test("causal fixture gate orders teardown and releases resource only after direct canonical proof", async () => {
  let clock = 0;
  const calls = [];
  const observations = [
    { fixtureOption: "ready-v1", currentCommand: "node" },
    { fixtureOption: "", currentCommand: "zsh" },
    {
      fixtureOption: "",
      currentCommand: "zsh",
      expectedCommand: "zsh",
      marker: "shell-ready",
      nativeFrame: "shell-ready",
      tuiBody: "shell-ready",
      canonicalWraparound: true,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
      geometryStable: true,
      stabilityIdentity: "stable",
    },
  ];
  let index = 0;
  const result = await runCausalFixtureTeardownGate({
    interrupt: () => calls.push("interrupt"),
    observe: () => {
      calls.push(`observe:${index}`);
      return { expectedCommand: "zsh", marker: "shell-ready", ...observations[index++] };
    },
    sendShellMarker: () => calls.push("marker"),
    releaseResource: () => calls.push("resource"),
    now: () => clock,
    wait: (ms) => {
      clock += ms;
      if (index >= observations.length) index = observations.length - 1;
    },
    stableMs: 25,
    timeoutMs: 200,
    pollMs: 25,
  });
  assert.deepEqual(result, { canDispatchResource: true });
  assert.deepEqual(calls, [
    "interrupt",
    "observe:0",
    "observe:1",
    "marker",
    "observe:2",
    "observe:2",
    "resource",
  ]);
});

test("causal fixture canonical proof uses the latest exact-incarnation transition", () => {
  const expected = {
    processId: "opentui:1",
    semanticPaneId: "pane.alpha",
    generation: "generation",
    incarnation: "incarnation:1",
  };
  const record = (wraparound, incarnation = expected.incarnation) => ({
    type: "performance.terminal-canonical-mode",
    ...expected,
    incarnation,
    wraparound,
  });
  assert.equal(latestCausalFixtureCanonicalWraparound([record(true)], 0, expected), true);
  assert.equal(
    latestCausalFixtureCanonicalWraparound([record(true), record(false)], 0, expected),
    false,
  );
  assert.equal(
    latestCausalFixtureCanonicalWraparound([record(true, "incarnation:other")], 0, expected),
    false,
  );
});

test("causal teardown never releases on rolled-back or wrong-incarnation mode proof", async () => {
  const expected = {
    processId: "opentui:1",
    semanticPaneId: "pane.alpha",
    generation: "generation",
    incarnation: "incarnation:1",
  };
  const mode = (wraparound, incarnation = expected.incarnation) => ({
    type: "performance.terminal-canonical-mode",
    ...expected,
    incarnation,
    wraparound,
  });
  for (const records of [[mode(true), mode(false)], [mode(true, "incarnation:other")]]) {
    let clock = 0;
    let released = 0;
    await assert.rejects(
      runCausalFixtureTeardownGate({
        interrupt: () => undefined,
        sendShellMarker: () => undefined,
        observe: () => ({
          fixtureOption: "",
          currentCommand: "zsh",
          expectedCommand: "zsh",
          marker: "shell-ready",
          nativeFrame: "shell-ready",
          tuiBody: "shell-ready",
          canonicalWraparound: latestCausalFixtureCanonicalWraparound(records, 0, expected),
          inputPending: 0,
          inputInFlight: 0,
          inputPendingBytes: 0,
          geometryStable: true,
          stabilityIdentity: "stable",
        }),
        releaseResource: () => {
          released += 1;
        },
        now: () => clock,
        wait: (ms) => {
          clock += ms;
        },
        timeoutMs: 50,
        pollMs: 25,
      }),
    );
    assert.equal(released, 0);
  }
});

test("causal fixture gate fails closed with zero resource dispatch on timeout and observation error", async () => {
  for (const failure of ["timeout", "error"]) {
    let clock = 0;
    let resources = 0;
    await assert.rejects(
      runCausalFixtureTeardownGate({
        interrupt: () => undefined,
        observe: () => {
          if (failure === "error") throw new Error("capture failed");
          return { fixtureOption: "ready-v1", currentCommand: "node" };
        },
        sendShellMarker: () => undefined,
        releaseResource: () => {
          resources += 1;
        },
        now: () => clock,
        wait: (ms) => {
          clock += ms;
        },
        timeoutMs: 50,
        pollMs: 25,
      }),
    );
    assert.equal(resources, 0, failure);
  }
});

test("causal teardown timeout identifies each failed predicate without retaining terminal content", async () => {
  const ready = {
    fixtureOption: "",
    currentCommand: "zsh",
    expectedCommand: "zsh",
    marker: "private-marker",
    nativeFrame: "private-marker secret-native",
    tuiBody: "private-marker secret-tui",
    markerNativeIndex: 0,
    markerTuiIndex: 0,
    canonicalWraparound: true,
    canonical: {
      revision: 5,
      stateHash: "hash",
      incarnation: "incarnation",
      wraparound: true,
    },
    inputPending: 0,
    inputInFlight: 0,
    inputPendingBytes: 0,
    geometryStable: true,
    geometryBefore: "%1:80x24",
    geometryAfter: "%1:80x24",
    nativeHash: "native-hash",
    bodyHash: "body-hash",
    stabilityIdentity: "stable",
    stabilityParts: { nativeHash: "native-hash", bodyHash: "body-hash" },
  };
  assert.doesNotMatch(JSON.stringify(causalFixtureTeardownDiagnostic(ready)), /secret-|private-/u);
  for (const [field, value, failure] of [
    ["fixtureOption", "ready-v1", "option-empty"],
    ["currentCommand", "node", "command-matches"],
    ["markerNativeIndex", null, "marker-native"],
    ["markerTuiIndex", null, "marker-tui"],
    ["canonicalWraparound", false, "canonical-wraparound"],
    ["inputPending", 1, "queue-zero"],
    ["geometryStable", false, "geometry-stable"],
  ]) {
    let clock = 0;
    await assert.rejects(
      runCausalFixtureTeardownGate({
        interrupt: () => undefined,
        sendShellMarker: () => undefined,
        observe: () => ({ ...ready, [field]: value }),
        releaseResource: () => assert.fail("must not release"),
        now: () => clock,
        wait: (ms) => {
          clock += ms;
        },
        timeoutMs: 25,
        stableMs: 100,
        pollMs: 25,
      }),
      (error) => {
        assert.match(error.message, /"failureKind":"predicate-failed"/u);
        assert.match(error.message, new RegExp(`"${failure}"`, "u"));
        return true;
      },
    );
  }
});

test("causal teardown distinguishes identity churn from an incomplete stability window", async () => {
  const observation = (identity) => ({
    fixtureOption: "",
    currentCommand: "zsh",
    expectedCommand: "zsh",
    marker: "marker",
    nativeFrame: "marker",
    tuiBody: "marker",
    markerNativeIndex: 0,
    markerTuiIndex: 0,
    canonicalWraparound: true,
    inputPending: 0,
    inputInFlight: 0,
    inputPendingBytes: 0,
    geometryStable: true,
    stabilityIdentity: identity,
    stabilityParts: { nativeHash: identity },
  });
  for (const [identities, failureKind] of [
    [["a", "b", "a"], "stability-identity-churn"],
    [["a"], "stability-window-incomplete"],
  ]) {
    let clock = 0;
    let index = 0;
    await assert.rejects(
      runCausalFixtureTeardownGate({
        interrupt: () => undefined,
        sendShellMarker: () => undefined,
        observe: () => observation(identities[Math.min(index++, identities.length - 1)]),
        releaseResource: () => assert.fail("must not release"),
        now: () => clock,
        wait: (ms) => {
          clock += ms;
        },
        timeoutMs: identities.length * 25,
        stableMs: 100,
        pollMs: 25,
      }),
      (error) => {
        assert.match(error.message, new RegExp(`"failureKind":"${failureKind}"`, "u"));
        return true;
      },
    );
  }
});

test("causal helper restores DECAWM and resets probes onto the visible first row", () => {
  const source = readFileSync(
    new URL("./lib/product-rig-causal-cell-fixture.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /writeSync\(1, "\\x1b\[\?7h/u);
  assert.match(source, /if \(restored\) return;/u);
  assert.match(source, /reset-v1;/u);
  assert.match(source, /createCausalFixtureGeometry/u);
});

test("requires a closed zero-drop reference trace summary", () => {
  const base = {
    state: { status: "ready", daemon: { instanceId: "generation" }, convergence: null },
    truth: { session: "alpha", windows: [], panes: [] },
    lifecycle: [],
    stderr: "",
  };
  const missing = buildProductDiagnosticReport({ ...base, traceRecords: [] });
  assert.equal(
    missing.boundaries.find((boundary) => boundary.id === "reference-trace-integrity")?.status,
    "unmeasured",
  );
  const dropped = buildProductDiagnosticReport({
    ...base,
    traceRecords: [
      {
        type: "performance.trace.summary",
        acceptedRecords: 10,
        droppedRecords: 1,
        oversizedRecords: 0,
        failed: false,
        saturated: false,
        pendingInputs: 0,
        droppedInputs: 0,
      },
    ],
  });
  assert.equal(
    dropped.boundaries.find((boundary) => boundary.id === "reference-trace-integrity")?.status,
    "failed",
  );
});

test("pairs only same-clock input and changed-cell paint traces", () => {
  const samples = inputPaintSamples([
    {
      type: "performance.stage",
      traceId: "one",
      stage: "input",
      processId: "tui:1",
      clockId: "clock",
      startedAtMicros: 1_000,
    },
    {
      type: "performance.stage",
      traceId: "one",
      stage: "paint",
      processId: "tui:1",
      clockId: "clock",
      endedAtMicros: 9_000,
      generation: "generation",
      incarnation: "generation:0",
      semanticPaneId: "%1",
      revision: 4,
      stateHash: "abcd1234",
      paintStateIdentity: "latest-canonical-state-blitted",
    },
    {
      type: "performance.stage",
      traceId: "cross-clock",
      stage: "input",
      processId: "tui:1",
      clockId: "a",
      startedAtMicros: 1_000,
    },
    {
      type: "performance.stage",
      traceId: "cross-clock",
      stage: "paint",
      processId: "tui:1",
      clockId: "b",
      endedAtMicros: 2_000,
    },
  ]);
  assert.deepEqual(samples, [
    {
      traceId: "one",
      durationMs: 8,
      generation: "generation",
      incarnation: "generation:0",
      processId: "tui:1",
      clockId: "clock",
      semanticPaneId: "%1",
      revision: 4,
      stateHash: "abcd1234",
      paintStateIdentity: "latest-canonical-state-blitted",
    },
  ]);
  assert.equal(causalInputSampleHasIncarnation(samples[0]), true);
  assert.equal(causalInputSampleHasIncarnation({ ...samples[0], incarnation: null }), false);
  assert.equal(causalInputSampleHasIncarnation({ ...samples[0], incarnation: "" }), false);
});

test("qualifies paint evidence only when it names the latest canonical state blitted", () => {
  const traceRecords = [
    { type: "performance.trace.header", processId: "tui:1" },
    {
      type: "performance.stage",
      traceId: "trace",
      stage: "input",
      processId: "tui:1",
      clockId: "clock",
      startedAtMicros: 1_000,
    },
    {
      type: "performance.stage",
      traceId: "trace",
      stage: "paint",
      processId: "tui:1",
      clockId: "clock",
      endedAtMicros: 2_000,
      generation: "generation",
      semanticPaneId: "%1",
      revision: 2,
      stateHash: "latest-hash",
      paintStateIdentity: "latest-canonical-state-blitted",
    },
  ];
  const base = {
    state: { status: "ready", daemon: { instanceId: "generation" }, convergence: null },
    truth: { session: "alpha", windows: [], panes: [] },
    lifecycle: [],
    traceRecords,
    stderr: "",
  };
  const evidence = {
    traceId: "trace",
    semanticPaneId: "%1",
    revision: 2,
    stateHash: "latest-hash",
    markerVisibleInNative: true,
    markerVisibleInPaneRect: true,
    paintStateIdentity: "latest-canonical-state-blitted",
    causalAttribution: true,
    row: 0,
    column: 1,
    beforeGrapheme: " ",
    afterGrapheme: "x",
  };
  assert.equal(
    buildProductDiagnosticReport({ ...base, qualifyingInputEvidence: [evidence] }).inputSamples
      .length,
    1,
  );
  const { paintStateIdentity: _omitted, ...unproven } = evidence;
  void _omitted;
  assert.equal(
    buildProductDiagnosticReport({ ...base, qualifyingInputEvidence: [unproven] }).inputSamples
      .length,
    0,
  );
});

test("rejects duplicate trace endpoints instead of silently choosing the last sample", () => {
  const base = {
    type: "performance.stage",
    traceId: "duplicate",
    processId: "tui:1",
    clockId: "clock",
  };
  assert.deepEqual(
    inputPaintSamples([
      { ...base, stage: "input", startedAtMicros: 1 },
      { ...base, stage: "input", startedAtMicros: 2 },
      { ...base, stage: "paint", endedAtMicros: 3 },
    ]),
    [],
  );
});

test("extracts proof only from the pane body rectangle", () => {
  const frame = [
    "header",
    "tabs",
    "chrome A",
    "left-marker   sibling",
    "left-second   sibling-clean",
  ].join("\n");
  assert.equal(
    paneBodyRegion(frame, { left: 0, top: 0, width: 12, height: 2 }),
    "left-marker \nleft-second ",
  );
  assert.doesNotMatch(paneBodyRegion(frame, { left: 13, top: 0, width: 7, height: 2 }), /marker/u);
});

test("resource evidence requires a distribution and proves queues settle", () => {
  const clientStages = Array.from({ length: 16 }, (_, index) => ({
    rssBytes: 100_000 + index,
    heapUsedBytes: 50_000 + index,
    inputPending: index === 15 ? 0 : 1,
    inputInFlight: index === 15 ? 0 : 1,
    inputPendingBytes: index === 15 ? 0 : 1,
  }));
  const observation = summarizeProductResources(clientStages, [
    {
      queuePeak: 1,
      queueCapacity: 1,
      settledQueueDepth: 0,
      revisionLagPeak: 0,
    },
  ]);
  assert.equal(observation.memorySampleCount, 16);
  assert.equal(observation.settledInputPending, 0);
  assert.equal(observation.settledInputInFlight, 0);
  assert.equal(observation.settledDeliveryQueueDepth, 0);
  assert.equal(observation.rssGrowthBytes, 15);
  assert.equal(observation.heapGrowthBytes, 15);
  assert.equal(observation.rssRobustSlopeBytesPerSample, 1);
  assert.equal(observation.heapRobustSlopeBytesPerSample, 1);
});

test("resource retention samples independent load-clear-settle cycles", () => {
  const plan = productResourceCyclePlan();
  assert.equal(PRODUCT_RESOURCE_CONDITIONING_CYCLE_COUNT, 8);
  assert.equal(PRODUCT_RESOURCE_MEASURED_CYCLE_COUNT, 16);
  assert.equal(plan.length, 24);
  assert.deepEqual(
    plan.map(({ phase }) => phase),
    [
      ...Array.from({ length: 8 }, () => "conditioning"),
      ...Array.from({ length: 16 }, () => "measured"),
    ],
  );
  assert.deepEqual(
    plan.map(({ measuredIndex }) => measuredIndex),
    [...Array.from({ length: 8 }, () => null), ...Array.from({ length: 16 }, (_, index) => index)],
  );
  assert.equal(new Set(plan.map(({ cycle }) => cycle)).size, plan.length);
  assert.equal(new Set(plan.map(({ cycleMarker }) => cycleMarker)).size, plan.length);
  assert.equal(new Set(plan.map(({ probe }) => probe)).size, plan.length);
  assert.ok(plan.every(({ probe }) => typeof probe === "string" && probe.length === 1));
  assert.ok(plan.every(({ loadLines }) => loadLines === 300));
  for (const cycle of plan) {
    const commands = productResourceCycleCommands(cycle);
    assert.equal(commands.floodCommand.includes(`tmux-ide-flood-${cycle.cycle}`), false);
    assert.equal(commands.settleCommand.includes(cycle.cycleMarker), false);
  }
  assert.throws(() => productResourceCyclePlan(16), /fixed and cannot be configured/u);
});

test("resource conditioning endpoints are fenced but excluded from measured endpoint ids", () => {
  const plan = productResourceCyclePlan();
  const endpoints = plan.map(({ cycle, phase }) => ({
    cycle,
    phase,
    traceId: `${phase}-${cycle}`,
  }));
  assert.deepEqual(
    productResourceMeasuredEndpointTraceIds(endpoints),
    Array.from({ length: 16 }, (_, index) => `measured-${index + 8}`),
  );
  assert.throws(
    () => productResourceMeasuredEndpointTraceIds(endpoints.slice(1)),
    /exactly 24 cycle endpoints/u,
  );
  assert.throws(
    () =>
      productResourceMeasuredEndpointTraceIds([
        endpoints[0],
        { ...endpoints[1], phase: "measured" },
        ...endpoints.slice(2),
      ]),
    /identity mismatch at cycle 1/u,
  );
  assert.throws(
    () =>
      productResourceMeasuredEndpointTraceIds([
        endpoints[0],
        { ...endpoints[1], traceId: endpoints[0].traceId },
        ...endpoints.slice(2),
      ]),
    /trace id is duplicated at cycle 1/u,
  );
});

test("resource endpoint closes only one new exact same-process paired trace", () => {
  const expected = {
    cycle: 2,
    processId: "tui:1",
    generation: "generation",
    semanticPaneId: "%1",
  };
  const endpoint = (traceId) => ({
    traceId,
    processId: "tui:1",
    generation: "generation",
    semanticPaneId: "%1",
    revision: 4,
    stateHash: "hash",
    paintStateIdentity: "latest-canonical-state-blitted",
  });
  assert.equal(
    selectProductResourceEndpoint([endpoint("old")], [endpoint("old"), endpoint("new")], expected)
      .traceId,
    "new",
  );
  assert.throws(
    () => selectProductResourceEndpoint([endpoint("old")], [endpoint("old")], expected),
    /Missing paired resource endpoint/u,
  );
  assert.throws(
    () =>
      selectProductResourceEndpoint(
        [endpoint("old")],
        [endpoint("old"), endpoint("new-a"), endpoint("new-b")],
        expected,
      ),
    /Ambiguous paired resource endpoint/u,
  );

  const pending = productResourceEndpointEpochState({
    beforeSamples: [endpoint("old")],
    afterSamples: [endpoint("old"), endpoint("new")],
    expected,
    inputSettled: true,
    traceQuiet: false,
    probeCellCount: 1,
    geometryStable: true,
  });
  assert.equal(pending.status, "pending");
  assert.equal(
    productResourceEndpointEpochState({
      beforeSamples: [endpoint("old")],
      afterSamples: [endpoint("old"), endpoint("new")],
      expected,
      inputSettled: true,
      traceQuiet: true,
      probeCellCount: 1,
      geometryStable: true,
    }).status,
    "ready",
  );
  assert.throws(
    () =>
      productResourceEndpointEpochState({
        beforeSamples: [endpoint("old")],
        afterSamples: [endpoint("old"), endpoint("new"), endpoint("late")],
        expected,
        inputSettled: true,
        traceQuiet: true,
        probeCellCount: 1,
        geometryStable: true,
      }),
    /Ambiguous paired resource endpoint/u,
  );
  assert.throws(
    () =>
      productResourceEndpointEpochState({
        beforeSamples: [endpoint("old")],
        afterSamples: [endpoint("old"), endpoint("new")],
        expected,
        inputSettled: true,
        traceQuiet: true,
        probeCellCount: 1,
        geometryStable: false,
      }),
    /geometry changed/u,
  );
  assert.throws(
    () =>
      productResourceEndpointEpochState({
        beforeSamples: [endpoint("old")],
        afterSamples: [endpoint("old"), endpoint("new")],
        expected,
        inputSettled: true,
        traceQuiet: true,
        probeCellCount: 2,
        geometryStable: true,
      }),
    /Ambiguous visible resource probe/u,
  );
});

test("resource probe requires one shared newly-visible native and TUI cell", () => {
  assert.deepEqual(
    productResourceProbeCells({
      beforeNative: "prompt ",
      afterNative: "prompt a",
      beforeTui: "prompt ",
      afterTui: "prompt a",
      probe: "a",
    }),
    [{ row: 0, col: 7 }],
  );
  assert.deepEqual(
    productResourceProbeCells({
      beforeNative: "prompt ",
      afterNative: "prompt a",
      beforeTui: "prompt ",
      afterTui: "prompt ",
      probe: "a",
    }),
    [],
  );

  const pane = {
    paneId: "%1",
    semanticPaneId: "pane.one",
    left: 0,
    top: 0,
    width: 20,
    height: 4,
  };
  const frame = "● pane.one         \nprompt             \n                   ";
  assert.equal(
    productResourceGeometryIdentity(frame, pane),
    productResourceGeometryIdentity(frame.replace("prompt", "prompt a"), pane),
  );
  assert.notEqual(
    productResourceGeometryIdentity(frame, pane),
    productResourceGeometryIdentity(frame, { ...pane, width: 21 }),
  );
});

test("resource queue settlement reads the latest bounded input counters", () => {
  const stage = (inputPending, inputInFlight, inputPendingBytes) => ({
    type: "performance.stage",
    stage: "client",
    processId: "tui:1",
    inputPending,
    inputInFlight,
    inputPendingBytes,
  });
  assert.equal(productInputQueuesSettled([stage(1, 0, 1), stage(0, 0, 0)], "tui:1"), true);
  assert.equal(productInputQueuesSettled([stage(0, 0, 0), stage(0, 1, 0)], "tui:1"), false);
  assert.equal(
    productInputQueuesSettled(
      [
        {
          type: "performance.input-queue-state",
          processId: "tui:2",
          operation: "initialized",
          inputPending: 0,
          inputInFlight: 0,
          inputPendingBytes: 0,
        },
      ],
      "tui:2",
    ),
    true,
  );
  assert.equal(productInputQueuesSettled([], "tui:3"), false);
});

test("causal baseline names every fail-closed readiness predicate", () => {
  const ready = {
    fixtureOption: "ready-v1:probe-0",
    expectedOption: "ready-v1:probe-0",
    currentCommand: "node",
    queueObservation: { inputPending: 0, inputInFlight: 0, inputPendingBytes: 0 },
    activePaneId: "%1",
    fixturePaneId: "%1",
    geometryBefore: "%1:80x24",
    geometryAfter: "%1:80x24",
    nativeCell: " ",
    tuiCell: " ",
  };
  assert.equal(causalFixtureBaselineReadiness(ready).ready, true);
  for (const [field, value, predicate] of [
    ["fixtureOption", "ready-v1:other", "optionReady"],
    ["currentCommand", "zsh", "helperCommandReady"],
    ["queueObservation", null, "queueObserved"],
    ["queueObservation", { inputPending: 1, inputInFlight: 0, inputPendingBytes: 1 }, "queueZero"],
    ["activePaneId", "%2", "paneIdentityReady"],
    ["geometryAfter", "%1:81x24", "geometryStable"],
    ["nativeCell", "x", "nativeCellBlank"],
    ["tuiCell", "x", "tuiCellBlank"],
  ]) {
    const result = causalFixtureBaselineReadiness({ ...ready, [field]: value });
    assert.equal(result.ready, false, predicate);
    assert.equal(result.predicates[predicate], false, predicate);
  }
});

test("causal baseline stability ignores unrelated trace growth", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const resetFixtureBaseline");
  const baseline = source.slice(start, source.indexOf("let causalFailure", start));
  const identity = baseline.match(/const nextIdentity = \[[\s\S]*?\]\.join/)?.[0] ?? "";
  assert.doesNotMatch(identity, /records\.length/u);
  assert.match(identity, /queueObservation\?\.atMicros/u);
});

test("window failure preparation seals relocated structural runtime evidence in every JSON view", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function prepareDiagnosticFailure");
  const end = source.indexOf("async function executeDiagnosticAttempt", start);
  const failure = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(failure, /const state = readJson\(statePath\);\s*const partialRuntime =/u);
  assert.match(failure, /report = \{[\s\S]*?failureObservation,\s*partialRuntime,/u);
  assert.match(failure, /alignment: \{[\s\S]*?failureObservation,\s*partialRuntime,/u);
  assert.match(
    failure,
    /clientState: \{ \.\.\.correlation\.clientState, failureObservation, partialRuntime \}/u,
  );
});

test("Card5 owner seals keyed daemon lifecycle before cleanup and controller only reuses it", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const ownerCatch = source.slice(
    source.indexOf("  } catch (error) {", source.indexOf("async function owner")),
    source.indexOf("\n  }\n}\n\nconst [command", source.indexOf("async function owner")),
  );
  assert.match(
    ownerCatch,
    /daemonPaneStreamLifecycle: await card5DaemonPaneStreamLifecycle\(state\)[\s\S]*?publish\(terminalFailure\)[\s\S]*?settleInternalProductRigCleanup/u,
  );
  const execute = source.slice(
    source.indexOf("async function executeDiagnosticAttempt"),
    source.indexOf(
      "async function diagnose",
      source.indexOf("async function executeDiagnosticAttempt"),
    ),
  );
  assert.match(
    execute,
    /state\?\.failureObservation\?\.daemonPaneStreamLifecycle[\s\S]*?state\.failureObservation\.daemonPaneStreamLifecycle/u,
  );
  assert.doesNotMatch(ownerCatch, /publish\([^)]*card5InputFingerprintKey/u);
});

test("window switch selection rejection fails immediately with its bounded predicate", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function driveExactHostedWindowSwitch");
  const end = source.indexOf("async function", start + 20);
  const drive = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(drive, /record\?\.phase === "window-switch-failed"/u);
  assert.match(drive, /windowSwitchSelectionFailureObservation/u);
  assert.doesNotMatch(drive, /tuiCommand\(state/u);
  assert.match(drive, /await tuiCommandAsync\([\s\S]*?signal/u);
  assert.match(drive, /windowSwitchInputFailureObservation/u);
  assert.match(drive, /error\.boundary = boundary/u);
  assert.match(drive, /backendReason: rejectedReceipt\?\.failureBackendReason/u);
  assert.ok(
    drive.indexOf("windowSwitchSelectionFailureObservation") <
      drive.indexOf("window switch actual-frame fence did not settle"),
  );
});

test("window switch callers identify prime versus measured input failures", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /driveExactHostedWindowSwitch\([\s\S]*?boundary: "window-switch-visible"[\s\S]*?signal: ownerAbort\.signal/u,
  );
  assert.match(
    source,
    /driveExactHostedWindowSwitch\(state, tracePath, seen, \{[\s\S]*?boundary: "window-switch-distribution",\s*ordinal,\s*signal: ownerAbort\.signal/u,
  );
});

test("ProductRig checks a heartbeat gap before its monotonic timeout", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function waitForState");
  const end = source.indexOf("function installWebStartupDiagnostics", start);
  const wait = source.slice(start, end);
  assert.match(wait, /for \(;;\)/u);
  assert.ok(wait.indexOf("heartbeat.suspended") < wait.indexOf("performance.now() >= deadline"));
  assert.match(wait, /switchOrdinalWatermark/u);
});

test("ANSI owner readiness uses one bounded journey-specific wait and publishes progress", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const startAt = source.indexOf("async function start(json");
  const stopAt = source.indexOf("async function stop(", startAt);
  const start = source.slice(startAt, stopAt);
  assert.match(start, /ansi-cursor-alt-screen" \? 900_000 : 90_000/u);
  const diagnoseAt = source.indexOf("async function diagnoseAnsiCursorAltScreen");
  const diagnoseEnd = source.indexOf("function executeProductJourney", diagnoseAt);
  const diagnose = source.slice(diagnoseAt, diagnoseEnd);
  assert.match(diagnose, /const state = await start\(false, true, planEntry\)/u);
  assert.doesNotMatch(diagnose, /waitForState/u);
  assert.match(
    source,
    /workloadProgress: Object\.freeze\(\{[\s\S]*?activeCycle:[\s\S]*?completedCycles:/u,
  );
  assert.match(source, /resource-sample-unavailable/u);
  assert.match(source, /resource-sample-cardinality/u);
  assert.match(source, /rss-absolute-cap/u);
  assert.match(source, /heap-absolute-cap/u);
  assert.equal((source.match(/ansiEventLoopResourceCapStatus\(/gu) ?? []).length, 2);
  assert.doesNotMatch(source, /eventLoopDelayPeakMicros\s*>\s*33_000/u);
  const ansiOwnerAt = source.indexOf('if (journeyId === "ansi-cursor-alt-screen")');
  const ansiOwnerEnd = source.indexOf('if (journeyId === "keyboard-pointer-resize")', ansiOwnerAt);
  const ansiOwner = source.slice(ansiOwnerAt, ansiOwnerEnd);
  assert.ok(ansiOwnerAt > 0);
  assert.ok(ansiOwnerEnd > ansiOwnerAt);
  assert.match(ansiOwner, /const ansiJsonlReaders = new Map\(\)/u);
  assert.match(ansiOwner, /createProductJsonlTailReader\(path, \{ recordKind \}\)/u);
  assert.match(ansiOwner, /await ansiJsonlWatermark\(namespace\.tui\.performanceTracePath\)/u);
  assert.equal((ansiOwner.match(/\breadJsonLines\(/gu) ?? []).length, 0);
  assert.ok((ansiOwner.match(/ansiReadJsonLines\(/gu) ?? []).length >= 15);
  assert.match(source, /heartbeatPeakRevisionHmac/u);
  assert.match(source, /heartbeatPeakContextSwitchesAvailable/u);
  const ansiStartWebAt = source.indexOf(
    "startWeb: async (namespace, runningDaemon, identity, _process, baseline)",
  );
  const ansiStartWebEnd = ansiStartWebAt + 60_000;
  const ansiStartWeb = source.slice(ansiStartWebAt, ansiStartWebEnd);
  assert.ok(ansiStartWebAt > 0 && ansiStartWeb.length === 60_000);
  assert.match(ansiStartWeb, /productCapturePageUrlStatus\(devServer\.pageUrl\)/u);
  assert.match(ansiStartWeb, /publish\(\{ web: \{ pageUrl: ansiPageUrl\.pageUrl/u);
  assert.ok(ansiStartWeb.indexOf("publish({ web:") < ansiStartWeb.indexOf("await page.goto("));

  const captureAt = source.indexOf("async function captureArtifacts");
  const captureEnd = source.indexOf("async function waitForState", captureAt);
  const capture = source.slice(captureAt, captureEnd);
  assert.match(capture, /productCapturePageUrlStatus\(state\?\.web\?\.pageUrl\)/u);
  assert.match(capture, /PRODUCT_RIG_CAPTURE_PAGE_URL_INVALID/u);
  assert.match(capture, /error\.boundary = "evidence-capture"/u);
  assert.ok(capture.indexOf("if (!capturePageUrl.exact)") < capture.indexOf("mkdirSync("));
  assert.doesNotMatch(capture, /state\.web\.pageUrl/u);
});

test("window switch rejects writer loss before quiet-tail or rename attribution", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function driveExactHostedWindowSwitch");
  const end = source.indexOf("async function waitForWindowRenameFence", start);
  const drive = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(drive, /window switch lifecycle writer fence was unhealthy/u);
  assert.match(drive, /windowLifecycleWriterFailureObservation/u);
  assert.ok(
    drive.indexOf("windowLifecycleWriterFailureObservation") <
      drive.indexOf("settleWindowReferenceTrace"),
  );
});

test("window reports seal the bounded causal frame assessment in report and alignment", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function diagnoseWindowLifecycle");
  const end = source.indexOf("async function diagnoseKeyboardPointerResize", start);
  const diagnose = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(diagnose, /const causal = assessProductWindowLifecycle/u);
  assert.equal((diagnose.match(/causalAssessment: causal/gu) ?? []).length, 2);
  assert.match(diagnose, /firstBrokenBoundary: assessment\.firstBrokenBoundary/u);
});

test("resize journey owns one bounded two-pane Meta+Arrow and SGR causal executor", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf('if (journeyId === "keyboard-pointer-resize")');
  const end = source.indexOf('if (journeyId === "window-lifecycle")', start);
  const resize = source.slice(start, end);
  const resizeConditioning = source.slice(
    source.indexOf("async function conditionExactResizeTmuxFixture"),
    source.indexOf("async function validateExactResizeTmuxBaseline"),
  );
  const resizeBaseline = source.slice(
    source.indexOf("async function validateExactResizeTmuxBaseline"),
    source.indexOf("async function preserveWarmRehostFailure"),
  );
  assert.ok(start > 0 && end > start);
  assert.match(resize, /runKeyboardPointerResizeOwnerBoot/u);
  assert.match(resize, /windowsPerSession: 1/u);
  assert.match(resize, /"split-window",\s+"-h"/u);
  assert.match(resize, /validateExactResizeTmuxBaseline/u);
  assert.match(resize, /initialPaneCommand/u);
  assert.match(resize, /exactResizeBlockerCommand/u);
  assert.doesNotMatch(resize, /exec sh -i/u);
  assert.match(resizeConditioning, /pane-border-status",\s+"top"/u);
  assert.match(
    resizeConditioning,
    /"resize-window",\s+"-t",\s+target,\s+"-x",\s+"132",\s+"-y",\s+"41"/u,
  );
  assert.match(resizeConditioning, /"select-layout",\s+"-t",\s+target,\s+"even-horizontal"/u);
  assert.doesNotMatch(resizeBaseline, /set-option|resize-window|select-layout/u);
  assert.match(resize, /kind: "modified-key"/u);
  assert.match(resize, /modifiers: \["meta"\]/u);
  assert.match(resize, /ordinal < 30/u);
  assert.match(resize, /action: "down"/u);
  assert.match(resize, /action: "drag"/u);
  assert.match(resize, /action: "up"/u);
  assert.match(resize, /presentationDigest/u);
  assert.match(resize, /waitForWindowWorkspaceEvidence/u);
  assert.match(resize, /waitForFocusWebSemantic/u);
  assert.match(
    resize,
    /fleetSessionId: resizeBoot\.identity\.fleetSessionId,[\s\S]*?catalogRevision: resizeBoot\.identity\.catalogRevision/u,
  );
  assert.match(
    resize,
    /publish\(\{\s*convergence: \{ workspaceClient: resizeBoot\.web\.workspaceClient \},\s*journeyEvidence: \{ keyboardPointerResize: journeyEvidence \}/u,
  );
  assert.doesNotMatch(resize, /\btuiCommand\(state/u);
  assert.doesNotMatch(resize, /\bexecFileSync\(/u);
});

test("selection journey owns one exact hosted selection copy app-mouse executor", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf('if (journeyId === "selection-copy-app-mouse")');
  const end = source.indexOf('if (journeyId === "ansi-cursor-alt-screen")', start);
  const selection = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(selection, /runSelectionCopyAppMouseOwnerBoot/u);
  assert.match(selection, /initialPaneCommand/u);
  assert.match(selection, /kind: "selection-drag"/u);
  assert.match(selection, /kind: "copy-capture"/u);
  assert.match(selection, /kind: "copy-capture", timeoutMs: 3_000/u);
  assert.match(selection, /beforeCount: before/u);
  assert.match(selection, /expectedOrdinal: priorCopy\.copyOrdinal \+ 1/u);
  assert.equal((selection.match(/kind: "application-mouse"/gu) ?? []).length, 1);
  assert.match(selection, /\["down", point\.x\]/u);
  assert.match(selection, /\["drag", point\.x \+ 1\]/u);
  assert.match(selection, /\["up", point\.x \+ 1\]/u);
  assert.match(selection, /gesture < 10/u);
  assert.match(selection, /applicationMouseCausalSamples/u);
  assert.match(selection, /assessApplicationMouseDistribution/u);
  assert.match(selection, /distribution\.qualified/u);
  assert.match(selection, /createHmac/u);
  assert.match(selection, /evidenceKey/u);
  assert.match(selection, /selectionStyle\.extraChangedCells/u);
  assert.match(selection, /selectionMouseFixtureProgram\(\)/u);
  assert.match(selection, /kind: "control-key", key: "y"/u);
  assert.match(selection, /waitForSelectionMouseModeConditioning/u);
  assert.match(selection, /applicationMouseReceipts: 0/u);
  assert.match(selection, /preCleanTmux/u);
  assert.match(selection, /selectionLocalModeFailureObservation/u);
  assert.match(selection, /performanceWatermark: performanceBefore\.length/u);
  assert.match(selection, /traceWatermark: traceBefore\.length/u);
  assert.match(selection, /selectionCopyFailureEvidence/u);
  assert.match(selection, /copyFailure/u);
  assert.match(
    selection,
    /selectionWorkspaceClientEvidence\(selectionBoot\.web\.workspaceClient\)/u,
  );
  assert.match(selection, /workspaceClient\.committed\.terminalResourceRevision/u);
  assert.match(selection, /exactTerminalResourceRevision: baseline\.terminalResourceRevision/u);
  assert.doesNotMatch(selection, /derived\.terminalInventory\.terminalResourceRevision/u);
  assert.match(selection, /selectionCausalFailureObservation\(assessment, journeyEvidence\)/u);
  assert.match(selection, /failureObservation,/u);
  assert.match(selection, /evidenceKey: namespace\.evidenceKey/u);
  assert.match(
    selection,
    /distribution = assessApplicationMouseDistribution\(samples, expectedPoint\)/u,
  );
  assert.match(selection, /applicationMouseDistributionFailureObservation\(\{/u);
  const assessmentFailure = selection.slice(
    selection.indexOf("const assessment = assessProductSelectionCopyAppMouse"),
    selection.indexOf("publish({\n        convergence:", selection.indexOf("const assessment =")),
  );
  assert.ok(assessmentFailure.indexOf("publish({") < assessmentFailure.indexOf("throw error"));
  assert.doesNotMatch(assessmentFailure, /status:\s*"ready"/u);
  assert.match(source, /timeout: testdriveInputSupervisorTimeout\(document\.timeoutMs\)/u);
  assert.match(selection, /latestMode/u);
  assert.match(selection, /waitForWindowWorkspaceEvidence/u);
  assert.match(selection, /waitForFocusWebSemantic/u);
  assert.match(selection, /settleWindowReferenceTrace/u);
  assert.doesNotMatch(selection, /\btuiCommand\(state/u);
  assert.doesNotMatch(selection, /\bexecFileSync\(/u);
});

test("ANSI journey owns one isolated cursor alternate-screen executor", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const ansiHelper = readFileSync(
    new URL("./lib/product-ansi-cursor-alt-screen.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('if (journeyId === "ansi-cursor-alt-screen")');
  const end = source.indexOf('if (journeyId === "keyboard-pointer-resize")', start);
  const ansi = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(source, /TMUX_IDE_PRODUCT_RUN_ID: planEntry\.runId/u);
  assert.match(source, /diagnosticAttempt: inheritedDiagnosticAttempt/u);
  assert.match(source, /Persist the parent-frozen run\/provenance identity/u);
  assert.match(ansi, /runAnsiCursorAltScreenOwnerBoot/u);
  assert.match(ansi, /product-ansi-cursor-alt-screen-fixture\.mjs/u);
  assert.match(ansi, /validateScratchInitialPaneCommand\(initialPaneCommand\)/u);
  assert.doesNotMatch(ansi, /args: \["-e", ansiCursorAltScreenFixtureProgram/u);
  assert.match(ansi, /const marker = ansiWorkloadMarker\(namespace\.marker, cycle\)/u);
  assert.match(ansi, /const workloadPayload = ansiWorkloadPayload\(namespace\.marker, cycle\)/u);
  assert.match(ansi, /ansiWorkloadProducerStatus\(producerTail,/u);
  assert.match(ansi, /producerStatus: producer\.state/u);
  assert.match(ansi, /producerFirstCause:/u);
  assert.match(ansi, /flowRecovery: flowRecoveryEvidence/u);
  assert.match(ansi, /lastFailureReason: ANSI_MIRROR_FLOW_FAILURE_REASONS\.has/u);
  assert.match(ansi, /nativeTimeout:/u);
  assert.doesNotMatch(ansi, /4096 \* 28 \+ Buffer\.byteLength\(marker\)/u);
  assert.match(ansi, /windowsPerSession: 1/u);
  assert.match(ansi, /performanceTraceDetail: "1"/u);
  assert.match(ansi, /for \(let ordinal = 1; ordinal <= 30; ordinal \+= 1\)/u);
  assert.match(ansi, /gridWalked: false/u);
  assert.match(
    ansi,
    /gridWalked: options\.gridWalked,\s*gridRowsRead: options\.gridRowsRead,\s*fullWalk: options\.fullWalk,/u,
  );
  assert.match(ansi, /conditioningCycleCount: 8/u);
  assert.match(ansi, /measuredCycleCount: 16/u);
  assert.match(ansi, /advanceAnsiWorkloadProgress/u);
  assert.match(ansi, /ansiWorkloadProgressExpiry/u);
  assert.match(ansi, /ANSI_WORKLOAD_ABSOLUTE_MS/u);
  assert.match(ansi, /ANSI_WORKLOAD_NO_PROGRESS_MS/u);
  assert.match(ansi, /decodeFocusFramebufferCapture\(captureEnvelope\)/u);
  assert.match(ansi, /markerCount === 1 && captureIdentityExact/u);
  assert.match(ansi, /finalCursorPresentation\.cursorY === 39/u);
  assert.match(ansi, /finalCursorPresentation\.viewportRows === 40/u);
  assert.match(ansi, /finalCursorPresentation\.visible === true/u);
  assert.match(
    ansi,
    /ansiWorkloadDeliveryJoin\(\{\s*canonical: finalTransition,\s*daemonRecords: daemonTail,\s*expected:/u,
  );
  assert.match(ansi, /ansiWorkloadOrderedTailStatus/u);
  assert.match(ansi, /type === "performance\.terminal-canonical-update"/u);
  assert.match(ansi, /type === "performance\.terminal-canonical-publication"/u);
  assert.match(ansi, /record\.updateType === "terminal\.seed"/u);
  assert.match(ansi, /ansiWorkloadOrderedTailStatus\(\{\s*transitions: canonicalTransitions,/u);
  assert.match(ansi, /const finalTransition = canonicalTransitions\.at\(-1\) \?\? null/u);
  assert.match(ansi, /const mode = matchingModes\.length === 1 \? matchingModes\[0\] : null/u);
  assert.match(ansi, /canonical: finalTransition/u);
  assert.match(ansi, /transition: finalTransition/u);
  assert.doesNotMatch(ansi, /mode\.cursor\?\.y === 39/u);
  assert.match(ansi, /finalCursorPresentation\.cursorY === 39/u);
  assert.match(ansi, /laterTransitionCount/u);
  assert.match(ansi, /canonicalTransitionType: finalTransition\.updateType/u);
  assert.match(ansi, /workloadFailure: error\.observation/u);
  assert.match(ansi, /const tracedDelivery = tracedEnqueues\.length === 1/u);
  assert.match(ansi, /tracedDelivery\.traceId/u);
  assert.doesNotMatch(ansi, /daemonTraceHmac:[\s\S]{0,160}daemonDelivery\.traceId/u);
  assert.match(ansi, /workloadFirstFailedPredicate/u);
  assert.match(ansi, /workloadMetrics: Object\.freeze/u);
  assert.match(ansi, /webPredicates: Object\.freeze/u);
  assert.ok(
    ansi.indexOf("ansiWorkloadOrderedTailStatus") <
      ansi.indexOf("const finalTransition = canonicalTransitions.at"),
  );
  assert.match(ansi, /deliveryWorkspaceName: identity\.sessionName/u);
  assert.match(ansi, /workspaceName: baseline\.deliveryWorkspaceName/u);
  assert.match(ansi, /deliverySurfaces: ansiExpectedDeliverySurfaces/u);
  assert.match(ansi, /deliveryClients: ansiExpectedDeliveryClients/u);
  assert.match(ansiHelper, /ansiDeliverySubscriberTopologyStatus/u);
  assert.match(ansi, /const readinessGate = await runAnsiDeliveryReadyAction\(\{/u);
  assert.match(ansiHelper, /waitForAnsiDeliverySubscriberReadiness/u);
  assert.match(ansiHelper, /ansiDeliverySubscriberReadinessStatus/u);
  assert.match(ansi, /ANSI_DELIVERY_LANE_NOT_CAUGHT_UP/u);
  assert.match(
    ansi,
    /publishAnsiPartial\(\{ stage: "web-readiness", webFailure: error\.observation \}\)/u,
  );
  assert.match(ansi, /const expectedGrid = ansiWebExpectedGridProjection\(stage, driven\)/u);
  assert.doesNotMatch(ansi, /driven\.raw\.mode\.dirtyRows/u);
  assert.match(ansi, /operation: "ansi-web-expected-projection"/u);
  assert.match(ansi, /error\.code = "ANSI_WEB_EXPECTED_GRID_INVALID"/u);
  assert.match(ansi, /renditionHmacExact: candidate\?\.renditionHmac === renditionHmac/u);
  assert.match(
    ansi,
    /rendererColsExact:\s*candidate\?\.rendererCols === expectedPresentation\.rendererCols/u,
  );
  assert.match(
    ansi,
    /rendererRowsExact:\s*candidate\?\.rendererRows === expectedPresentation\.rendererRows/u,
  );
  assert.match(ansi, /renditionCellCountExact:/u);
  assert.match(
    ansi,
    /cursorCountExact:\s*candidate\?\.cursorCount === \(expectedPresentation\.cursorHidden \? 0 : 1\)/u,
  );
  assert.match(ansi, /ansiRenditionFailureLocalization\(candidate,/u);
  assert.match(ansi, /positionWrappedHmac:/u);
  assert.match(ansi, /"cellHmacs"/u);
  assert.match(ansi, /renditionFailure: identityExact \? null : localization/u);
  assert.match(ansi, /firstFailedPredicate,/u);
  assert.match(ansi, /code: error\.code,\s*firstFailedPredicate,\s*stableSamples:/u);
  assert.match(ansi, /candidate: boundedCandidate,\s*predicates: predicateVector/u);
  assert.ok(
    ansi.indexOf("const readinessGate = await runAnsiDeliveryReadyAction") <
      ansi.indexOf("takeWatermark:", ansi.indexOf("driveAnsiStage")),
  );
  assert.ok(
    ansi.indexOf("takeWatermark:", ansi.indexOf("driveAnsiStage")) <
      ansi.indexOf("driveInput:", ansi.indexOf("driveAnsiStage")),
  );
  assert.doesNotMatch(ansi, /waitAnsiDeliveryTopology/u);
  assert.match(ansiHelper, /timeoutMs = 60_000/u);
  assert.match(ansi, /const deadline = performance\.now\(\) \+ 3_000/u);
  assert.match(ansiHelper, /sampledAt - stableSince >= stableMs/u);
  assert.match(ansi, /ansiExpectedDeliverySurfaces = Object\.freeze\(\["opentui", "web"\]\)/u);
  assert.match(ansi, /exactWebClients\.length !== 1/u);
  assert.match(ansi, /opentui: baseline\.clientId,\s*web: exactWebClients\[0\]\.clientId/u);
  assert.match(ansi, /semanticPaneId: baseline\.semanticPaneId/u);
  assert.match(ansi, /daemonProcessId: baseline\.rawIdentity\.daemonProcessId/u);
  assert.match(ansi, /daemonClockKind: "performance-now"/u);
  assert.match(ansi, /deliveryJoin\.exact/u);
  assert.match(ansi, /deliveryJoin\.enqueueCount - candidate\.enqueueCount/u);
  assert.match(ansi, /performance\.now\(\) - candidate\.startedAt >= 40/u);
  assert.match(ansi, /workloadFinalities: ansiBoot\.sustained\.workloadFinalities/u);
  assert.match(
    ansi,
    /const qualifiedPresentation = result\.raw\.presentation;[\s\S]*?ansiPresentationCounters = Object\.freeze\(\{\s*gridRowsReadTotal: qualifiedPresentation\.gridRowsReadTotal,\s*fullWalkTotal: qualifiedPresentation\.fullWalkTotal,\s*presentationCount: qualifiedPresentation\.presentationCount,/u,
  );
  assert.match(ansi, /operation: "ansi-idle-counter-continuity"/u);
  assert.match(ansi, /workloadFailure: timeoutObservation/u);
  assert.match(ansi, /captureAnsiCursorWebPresentation/u);
  assert.match(ansi, /__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__/u);
  assert.match(ansi, /webStageVector/u);
  assert.match(ansi, /webFirstFailure/u);
  assert.match(ansi, /boundedWebCandidate/u);
  assert.match(ansi, /ansiBaselineCursorEvidenceStatus/u);
  assert.match(ansi, /ansiBaselinePreviousCounters/u);
  assert.match(ansi, /baselinePredecessor,/u);
  assert.doesNotMatch(ansi, /priorPresentation\?\.gridRowsReadTotal \?\? 0/u);
  assert.match(ansi, /ansiNativePaneLeaseStatus/u);
  assert.equal((ansi.match(/inspectAnsiNativeStage\(/gu) ?? []).length, 6);
  assert.match(ansi, /const preAlternate = await driveAnsiStage\(namespace, "b"/u);
  assert.match(ansi, /afterRevision: cursor\.latest\.stage\.revision/u);
  assert.match(ansi, /afterRevision: preAlternate\.stage\.revision/u);
  assert.match(
    ansi,
    /preAlternate\.stage\.presentationHmac === baseline\.stage\.presentationHmac/u,
  );
  assert.match(
    ansi,
    /result\.stage\.presentationHmac !== alternate\.preAlternate\.stage\.presentationHmac/u,
  );
  assert.match(ansi, /preAlternate: ansiBoot\.alternate\.preAlternate\.evidence/u);
  assert.match(ansi, /const lastCursorExpected = ansiBoot\.cursor\.expectedSamples\.at\(-1\)/u);
  assert.match(ansi, /predecessorRevision: lastCursorExpected\.presentation\.revision/u);
  assert.match(ansi, /predecessorStateHmac: lastCursorExpected\.presentation\.stateHmac/u);
  assert.match(ansi, /"-t", leaseStatus\.lease\.paneId/u);
  assert.doesNotMatch(ansi, /"-t",\s*(?:baseline|ansiBoot\.baseline)\.semanticPaneId/u);
  assert.match(ansi, /const semanticBody = ansiSemanticBodyProjection\(publication\.bodyRect\)/u);
  assert.equal((ansi.match(/\.\.\.semanticBody/gu) ?? []).length, 2);
  assert.doesNotMatch(ansi, /publication\.bodyRect\.(?:x|y|height)\b/u);
  assert.match(ansi, /operation: "ansi-normal-baseline"/u);
  assert.match(ansi, /stage: "cursor-evidence"/u);
  assert.match(ansi, /modes: modes\.slice\(0, 2\)/u);
  assert.match(ansi, /presentations: presentations\.slice\(0, 2\)/u);
  assert.match(ansi, /rendererEpoch: hostFrame\.rendererEpoch/u);
  assert.match(ansi, /daemonProcessId: `daemon:\$\{runningDaemon\.record\.pid\}`/u);
  assert.match(ansi, /daemonClockId: "node-performance-now"/u);
  assert.match(ansi, /seedIdentityExact:/u);
  assert.match(ansi, /\.\.\.status/u);
  assert.match(ansi, /firstFailedPredicate/u);
  assert.match(ansi, /webRestorationPredicates: Object\.freeze/u);
  assert.match(ansi, /webFirstFailedRestorationPredicate: new Set/u);
  assert.match(ansi, /positionWrappedHmacExact/u);
  assert.match(ansi, /domRowsHmacPresent/u);
  assert.match(ansi, /domCursorHmacPresent/u);
  assert.match(ansi, /domSemanticExact: candidate\?\.domSemanticExact === true/u);
  assert.match(ansi, /domRowCountExact: candidate\?\.domRowCountExact === true/u);
  assert.match(ansi, /domTextExact: candidate\?\.domTextExact === true/u);
  assert.match(ansi, /domStyleExact: candidate\?\.domStyleExact === true/u);
  assert.match(ansi, /domFirstMismatchComponent: new Set/u);
  assert.match(ansi, /domCursorExact: candidate\?\.domCursorExact === true/u);
  assert.match(ansi, /expectedRendition,/u);
  assert.match(ansi, /expectedCursor: Object\.freeze\(\{[\s\S]*?style: canonicalCursorStyle/u);
  assert.match(ansi, /"rowsHmac",\s*"cursorHmac"/u);
  assert.match(ansi, /JSON\.stringify\(qualifiedWebPresentation\(candidate, undefined\)\)/u);
  assert.match(ansi, /ansiResourceEpochIdentity === null/u);
  assert.match(ansi, /sample\.resourceEpochArmed !== true/u);
  assert.match(ansi, /ansiResourceEpochIdentityExact\(sample\.resourceEpochIdentity/u);
  assert.match(ansi, /"ansi-normal-baseline-resource-cap"/u);
  assert.match(ansi, /baselineResource \? "ansi-normal-baseline" : "ansi-sustained-workload"/u);
  assert.match(ansi, /rssBytes: sample\.rssBytes/u);
  assert.match(ansi, /rssPeakBytes: sample\.rssPeakBytes/u);
  assert.match(ansi, /daemonEvidence: latest\?\.daemonEvidence \?\? null/u);
  assert.match(ansi, /stageEvidence: latest\?\.stageEvidence \?\? null/u);
  assert.match(ansi, /ansiCursorStageFromRecords/u);
  assert.match(ansi, /ansiCursorAltScreenExpected: expected/u);
  assert.match(ansi, /assessAnsiCursorAltScreenEvidence\(journeyEvidence, expected\)/u);
  assert.doesNotMatch(ansi, /\btuiCommand\(state/u);
  assert.doesNotMatch(ansi, /\bexecFileSync\(/u);
});

test("selection report seals strict causal distribution evidence in report and alignment", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function diagnoseSelectionCopyAppMouse");
  const end = source.indexOf("async function diagnoseAnsiCursorAltScreen", start);
  const diagnose = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(diagnose, /const causal = assessProductSelectionCopyAppMouse/u);
  assert.equal((diagnose.match(/causalAssessment: causal/gu) ?? []).length, 2);
  assert.match(diagnose, /selectionCopyAppMouse: journeyEvidence/u);
  assert.match(diagnose, /firstBrokenBoundary: assessment\.firstBrokenBoundary/u);
});

test("ANSI report seals its causal vector and independent HMAC contract in both JSON views", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function diagnoseAnsiCursorAltScreen");
  const end = source.indexOf("function executeProductJourney", start);
  const diagnose = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal((diagnose.match(/causalAssessment: causal/gu) ?? []).length, 2);
  assert.equal((diagnose.match(/ansiCursorAltScreen: journeyEvidence/gu) ?? []).length, 2);
  assert.equal((diagnose.match(/ansiCursorAltScreenExpected: expected/gu) ?? []).length, 2);
});

test("ANSI fixture reaches exact stable 132x41 geometry before daemon startup", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf('if (journeyId === "ansi-cursor-alt-screen")');
  const end = source.indexOf('if (journeyId === "', start + 10);
  const ansi = source.slice(start, end > start ? end : undefined);
  const cleanupToken = ansi.indexOf("const cleanupToken =");
  const runtimeNamespace = ansi.indexOf("const runtimeNamespace =");
  const ownership = ansi.indexOf("const tui = prepareOwnedTuiRuntime({");
  const condition = ansi.indexOf("await conditionAnsiTmuxFixture({");
  const ready = ansi.indexOf('event("ansi-namespace-ready"');
  const daemon = ansi.indexOf("startDaemon: async");
  assert.ok(
    cleanupToken > 0 &&
      runtimeNamespace > cleanupToken &&
      ownership > runtimeNamespace &&
      condition > ownership &&
      ready > condition &&
      daemon > ready,
  );
  assert.match(ansi, /paneId: initialPane\.paneId/u);
  assert.match(ansi, /socketPath: scratchFleet\.socketPath/u);
  assert.match(ansi, /ownership: \{ session, runtimeNamespace \}/u);
  assert.match(ansi, /resolveProvenance: sourceTraceProvenance/u);
  assert.match(ansi, /left: conditioned\.paneLeft/u);
  assert.match(ansi, /top: conditioned\.paneTop/u);
  assert.doesNotMatch(ansi, /geometry: Object\.freeze\(\{[\s\S]*?top: 0,[\s\S]*?\}\),/u);
});

test("resize diagnostic correlation uses strict post-Web identity and never a sibling fallback", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function productDiagnosticCorrelation");
  const end = source.indexOf("const WARM_COHERENT_SAMPLE_COUNT", start);
  const correlation = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(
    correlation,
    /const keyboardPointerResize = state\?\.journeyEvidence\?\.keyboardPointerResize \?\? null/u,
  );
  assert.match(
    correlation,
    /keyboardPointerResize\.expected\?\.fleetSessionId[\s\S]*?keyboardPointerResize\.expected\?\.catalogRevision[\s\S]*?keyboardPointerResize\.expected\?\.semanticPaneId/u,
  );
  assert.doesNotMatch(correlation, /keyboardPointerResize\.keyboard\.workspaceClient/u);
  assert.doesNotMatch(correlation, /keyboardPointerResize\.pointerRelease\.workspaceClient/u);
  assert.match(correlation, /buildProductDiagnosticCorrelation\(\{[\s\S]*?state,/u);
});

test("selection diagnostic correlation uses its own post-Web identity and no sibling evidence", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function productDiagnosticCorrelation");
  const end = source.indexOf("const WARM_COHERENT_SAMPLE_COUNT", start);
  const correlation = source.slice(start, end);
  assert.match(
    correlation,
    /const selectionCopyAppMouse = state\?\.journeyEvidence\?\.selectionCopyAppMouse \?\? null/u,
  );
  assert.match(
    correlation,
    /selectionCopyAppMouse\.expected\?\.fleetSessionId[\s\S]*?selectionCopyAppMouse\.expected\?\.catalogRevision[\s\S]*?selectionCopyAppMouse\.expected\?\.semanticPaneId/u,
  );
  assert.doesNotMatch(correlation, /selectionCopyAppMouse\.selection\.workspaceClient/u);
  assert.doesNotMatch(correlation, /selectionCopyAppMouse\.copy\.workspaceClient/u);
});

test("strict seed failure preserves bounded native and same-pane patch/frame/fence evidence", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function provePreseededPanePublication");
  const end = source.indexOf("async function preserveWarmRehostFailure", start);
  const proof = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(proof, /runBoundedFocusTmux/u);
  assert.match(proof, /deadline: performance\.now\(\) \+ 500/u);
  assert.match(proof, /maxBuffer: 64 \* 1_024/u);
  assert.match(proof, /latestCanonicalPatch/u);
  assert.match(proof, /latestCanonicalFrame/u);
  assert.match(proof, /latestCanonicalFence/u);
  assert.match(proof, /targetGeometryExact/u);
  assert.match(proof, /canonicalGeometryExact/u);
  assert.match(proof, /viewportGeometryExact/u);
  assert.match(proof, /sourceEpochExact/u);
  assert.doesNotMatch(proof, /\.\.\.\(error\.observation/u);
});

test("window owned actions use the exact live OpenTUI principal and preserve typed failures", () => {
  const source = readFileSync(new URL("./product-test-rig.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function dispatchOwnedProductAction");
  const end = source.indexOf("async function productApplicationShell", start);
  const dispatch = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(dispatch, /"X-Tmux-Ide-Host-Client-Id": hostClientId/u);
  assert.match(dispatch, /ownedWindowActionFailureObservation/u);
  assert.match(dispatch, /predicate: "action-result"|error\.observation/u);
  const windowOwner = source.slice(
    source.indexOf("createWindow: async"),
    source.indexOf("startWebAfterWindowLifecycle:", source.indexOf("createWindow: async")),
  );
  assert.equal(
    (windowOwner.match(/dispatchOwnedProductAction\([\s\S]*?baseline\.clientId,/gu) ?? []).length,
    2,
  );
  assert.match(windowOwner, /postFailure: Object\.freeze/u);
  assert.match(windowOwner, /applicationShellExact/u);
  assert.match(windowOwner, /tmuxPreActionStateExact/u);
  const renameOwner = windowOwner.slice(windowOwner.indexOf("renameWindow: async"));
  assert.match(renameOwner, /windowResourceAcknowledgementWatermark/u);
  assert.match(renameOwner, /exactTerminalResourceRevision: created\.terminalResourceRevision/u);
  assert.match(renameOwner, /acknowledgement: \{[\s\S]*?operationId,[\s\S]*?afterSequence:/u);
  assert.doesNotMatch(renameOwner, /receipt: \{[\s\S]*?operationKind: "workspace\.rename"/u);
});

test("resource conditioning remains in peak and queue evidence but not memory slopes", () => {
  const stages = [
    ...Array.from({ length: 8 }, (_, index) => ({
      traceId: `conditioning-${index}`,
      rssBytes: 900_000 + index * 10_000,
      heapUsedBytes: 800_000 + index * 10_000,
      inputPending: index === 3 ? 7 : 0,
      inputInFlight: index === 3 ? 3 : 0,
      inputPendingBytes: index === 3 ? 777 : 0,
    })),
    ...Array.from({ length: 16 }, (_, index) => ({
      traceId: `endpoint-${index}`,
      rssBytes: 100_000 + index,
      heapUsedBytes: 50_000 + index,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
    })),
  ];
  const observation = summarizeProductResources(
    stages,
    [
      {
        queuePeak: 9,
        queueCapacity: 10,
        settledQueueDepth: 0,
        revisionLagPeak: 4,
      },
    ],
    Array.from({ length: 16 }, (_, index) => `endpoint-${index}`),
  );
  assert.equal(observation.memorySampleCount, 16);
  assert.equal(observation.workloadMemorySampleCount, 24);
  assert.equal(observation.rssWorkloadPeakBytes, 970_000);
  assert.equal(observation.heapWorkloadPeakBytes, 870_000);
  assert.equal(observation.rssPeakBytes, 100_015);
  assert.equal(observation.heapPeakBytes, 50_015);
  assert.equal(observation.rssGrowthBytes, 15);
  assert.equal(observation.heapGrowthBytes, 15);
  assert.equal(observation.rssRobustSlopeBytesPerSample, 1);
  assert.equal(observation.heapRobustSlopeBytesPerSample, 1);
  assert.equal(observation.inputPendingPeak, 7);
  assert.equal(observation.inputInFlightPeak, 3);
  assert.equal(observation.inputPendingBytesPeak, 777);
  assert.equal(observation.settledInputPending, 0);
  assert.equal(observation.settledInputInFlight, 0);
  assert.equal(observation.deliveryQueuePeak, 9);
  assert.equal(observation.deliveryQueueCapacity, 10);
  assert.equal(observation.settledDeliveryQueueDepth, 0);
  assert.equal(observation.revisionLagPeak, 4);
});

test("resource growth uses ordered quiescent endpoints, not a GC max-min range", () => {
  const clientStages = Array.from({ length: 16 }, (_, index) => ({
    traceId: `trace-${index}`,
    rssBytes: index === 8 ? 200_000 : 100_000 + index,
    heapUsedBytes: index < 8 ? 150_000 : 50_000 + index,
    inputPending: 0,
    inputInFlight: 0,
    inputPendingBytes: 0,
  }));
  const observation = summarizeProductResources(clientStages, []);
  assert.equal(observation.rssPeakBytes, 200_000);
  assert.equal(observation.rssGrowthBytes, 15);
  assert.equal(observation.heapPeakBytes, 150_000);
  assert.equal(observation.heapGrowthBytes, 0);
});

test("diagnostic report names the first causal break and never passes unmeasured gates", () => {
  const report = buildProductDiagnosticReport({
    state: {
      status: "ready",
      daemon: { instanceId: "generation" },
      convergence: {
        restart: {
          elapsedMs: 100,
          webRecovered: true,
          tuiRecovered: true,
          hostedTuiInputPainted: true,
        },
      },
    },
    truth: { session: "alpha", windows: ["window"], panes: ["pane"] },
    lifecycle: [
      { phase: "generation-connection-resolved", daemonGeneration: "generation", elapsedMs: 10 },
      {
        phase: "generation-shell-lifecycle",
        clientPhase: "live",
        shellStatus: "live",
        inventoryResources: 1,
        elapsedMs: 20,
      },
      {
        phase: "generation-runtime-progress",
        runtimePhase: "coherent",
        panes: 1,
        seededPanes: 1,
        elapsedMs: 30,
      },
      {
        phase: "generation-status",
        status: "live",
        daemonGeneration: "generation",
        elapsedMs: 31,
      },
    ],
    traceRecords: [],
    stderr: "",
    framebufferEvidence: { passed: true, detail: "1/1 visible pane bodies matched" },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.firstBrokenBoundary, "tui-painted-frame");
  assert.equal(report.firstUnmeasuredBoundary, "reference-trace-integrity");
  assert.deepEqual(report.framebufferEvidence, {
    passed: true,
    detail: "1/1 visible pane bodies matched",
  });
});

test("state artifacts are atomic and public status redacts browser authority", () => {
  const root = mkdtempSync(join(tmpdir(), "tmi-product-rig-test-"));
  try {
    const path = join(root, "state.json");
    writeJsonAtomic(path, {
      version: PRODUCT_RIG_STATE_VERSION,
      status: "ready",
      ownerPid: process.pid,
      runtimeNamespace: { tmuxSocketPath: "/tmp/test.sock" },
      web: { pageUrl: "http://127.0.0.1:5173/?devHost=1", browserWsEndpoint: "secret" },
      daemon: { pid: process.pid, port: 1234, instanceId: "generation", authToken: "secret" },
    });
    assert.equal(readJson(path).status, "ready");
    const publicStatus = publicRigStatus(readJson(path));
    assert.equal(publicStatus.running, true);
    assert.equal("browserWsEndpoint" in publicStatus.web, false);
    assert.equal("authToken" in publicStatus.daemon, false);
    assert.doesNotMatch(readFileSync(path, "utf8"), /\.tmp/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture inventory emits grouped, machine-readable deletion reports", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const report = sourceArchitectureInventory(repo);
  assert.equal(report.version, 1);
  assert.equal("generatedAt" in report, false);
  assert.deepEqual(Object.keys(report.groups).sort(), [
    "direct-tmux",
    "grouped-pty",
    "v1-catalog",
    "v1-default-authority",
    "v1-standalone-authority",
  ]);
  for (const group of Object.values(report.groups)) {
    assert.equal(group.remainingUseCount, group.entries.length);
    assert.equal(group.remainingFileCount, group.uses.length);
    assert.equal(group.zeroUse, group.remainingUseCount === 0);
    assert.deepEqual(
      [...group.uses].sort((left, right) => left.localeCompare(right)),
      group.uses,
    );
    for (const entry of group.entries) {
      assert.ok(entry.line > 0);
      assert.ok(group.uses.includes(entry.file));
    }
  }
});

test("architecture debt cannot grow beyond the checked-in deletion budget", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const report = sourceArchitectureInventory(repo);
  const budget = JSON.parse(
    readFileSync(new URL("./architecture-debt-budget.json", import.meta.url), "utf8"),
  );
  assert.equal(budget.version, 1);
  for (const [name, groupBudget] of Object.entries(budget.groups)) {
    const group = report.groups[name];
    assert.ok(group, `missing inventory group ${name}`);
    assert.ok(
      group.remainingUseCount <= groupBudget.maximumUses,
      `${name} grew from budget ${groupBudget.maximumUses} to ${group.remainingUseCount}`,
    );
    assert.equal(groupBudget.targetUses, 0, `${name} must retain an explicit zero-use target`);
  }
});

test("checked-in product baseline is honest and safe to inventory", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("../docs/product/product-baseline.json", import.meta.url), "utf8"),
  );
  assert.equal(baseline.qualification, "not-product-qualified");
  assert.deepEqual(baseline.defaultProduct.primarySurfaces, ["home", "terminals"]);
  assert.deepEqual(baseline.defaultProduct.quarantinedSurfaces, [
    "files",
    "changes",
    "missions",
    "activity",
  ]);
  assert.equal(baseline.portablePerformance.status, "passed-with-limitations");
  assert.equal(baseline.portablePerformance.coherentTerminalFrame, "not-measured");
  assert.equal(baseline.portablePerformance.inputToPaint, "not-measured");
  assert.ok(baseline.knownDefects.every((defect) => defect.reproduce.length > 0));
  assert.match(baseline.completionPolicy, /not Done/u);
  const lineCount = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8").split("\n").length;
  assert.equal(
    lineCount("../packages/daemon/src/tui/mirror/runtime/application-root.tsx"),
    baseline.sourceMeasurements.openTuiApplicationRootLines + 1,
  );
  assert.equal(
    lineCount("../apps/desktop-renderer/src/experience/application-shell.tsx"),
    baseline.sourceMeasurements.webApplicationShellLines + 1,
  );
  assert.equal(
    lineCount("../apps/desktop-renderer/src/experience/workspace-tiled-surface.tsx"),
    baseline.sourceMeasurements.webWorkspaceTiledSurfaceLines + 1,
  );
});
