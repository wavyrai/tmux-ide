import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  ANSI_CURSOR_SAMPLE_COUNT,
  ANSI_CURSOR_P99_BUDGET_MICROS,
  ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS,
  ANSI_TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS,
  advanceAnsiCanonicalPredecessor,
  advanceAnsiWorkloadProgress,
  ansiBaselinePreviousCounters,
  ansiBaselineCursorEvidenceStatus,
  ansiEventLoopResourceCapStatus,
  ansiCursorAltScreenFixtureProgram,
  ansiWorkloadMarker,
  ansiWorkloadOrderedTailStatus,
  ansiWorkloadPayload,
  ansiWorkloadProducerStatus,
  ansiNativePaneLeaseStatus,
  ansiPreAlternateNormalStatus,
  ansiResourceEpochIdentityExact,
  ansiRenditionFailureLocalization,
  ansiSemanticBodyProjection,
  ansiCursorStageFromRecords,
  ansiDeliverySubscriberReadinessStatus,
  ansiDeliverySubscriberTopologyStatus,
  ansiWebExpectedGridProjection,
  ansiCursorAltJourneyStatus,
  ansiCursorWebEvidence,
  ansiWorkloadDeliveryJoin,
  ansiWorkloadProgressExpiry,
  assessAnsiCursorAltScreenEvidence,
  assessAnsiCursorPresentationSamples,
  assessAnsiQuiescentResourceSamples,
  assessAnsiIdleRetainedResourceSamples,
  assessAnsiResourceLifecycle,
  assessAnsiWorkloadFinalitySamples,
  boundedAnsiResourceFailureFacts,
  boundedAnsiResourcePeakFailureFacts,
  runAnsiDeliveryReadyAction,
} from "./product-ansi-cursor-alt-screen.mjs";
import { resolvePaneBodyRect } from "../product-test-rig-lib.mjs";
import {
  REFERENCE_CURSOR_PRESENTATION_BUDGET,
  REFERENCE_EVENT_LOOP_BUDGET,
  TUI_HEAP_ABSOLUTE_CEILING_BYTES,
  TUI_RSS_ABSOLUTE_CEILING_BYTES,
} from "./performance-reference-budgets.mjs";
import {
  createScratchFleet,
  validateScratchInitialPaneCommand,
} from "../../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";

test("workload progress renews only monotonically and remains absolutely bounded", () => {
  const empty = {
    canonicalRevision: null,
    enqueueOrdinal: null,
    enqueueCanonicalRevision: null,
    settledOrdinal: null,
    settledCanonicalRevision: null,
    frameRevision: null,
    fenceRevision: null,
    producerOrdinal: null,
  };
  let progress = advanceAnsiWorkloadProgress(null, empty, 1_000);
  progress = advanceAnsiWorkloadProgress(
    progress,
    {
      ...empty,
      canonicalRevision: 40,
      enqueueOrdinal: 38,
      enqueueCanonicalRevision: 40,
    },
    10_000,
  );
  assert.equal(ansiWorkloadProgressExpiry(progress, 24_999), null);
  const duplicate = advanceAnsiWorkloadProgress(
    progress,
    {
      ...empty,
      canonicalRevision: 40,
      enqueueOrdinal: 38,
      enqueueCanonicalRevision: 40,
    },
    20_000,
  );
  assert.equal(duplicate.lastProgressAtMs, 10_000);
  assert.equal(ansiWorkloadProgressExpiry(duplicate, 25_000), "no-progress-deadline");

  progress = advanceAnsiWorkloadProgress(
    progress,
    {
      ...empty,
      canonicalRevision: 42,
      enqueueOrdinal: 40,
      enqueueCanonicalRevision: 42,
      settledOrdinal: 40,
      settledCanonicalRevision: 42,
    },
    16_500,
  );
  assert.equal(ansiWorkloadProgressExpiry(progress, 16_954), null);
  assert.equal(ansiWorkloadProgressExpiry(progress, 31_000), "absolute-deadline");
  assert.throws(
    () =>
      advanceAnsiWorkloadProgress(
        progress,
        {
          ...empty,
          canonicalRevision: 41,
          enqueueOrdinal: 41,
          enqueueCanonicalRevision: 41,
          settledOrdinal: 40,
          settledCanonicalRevision: 42,
        },
        17_000,
      ),
    (error) => error.code === "ANSI_WORKLOAD_PROGRESS_REGRESSION",
  );
  assert.throws(
    () =>
      advanceAnsiWorkloadProgress(
        progress,
        {
          ...empty,
          canonicalRevision: 43,
          enqueueOrdinal: 41,
          enqueueCanonicalRevision: 41,
          settledOrdinal: 41,
          settledCanonicalRevision: 42,
        },
        17_000,
      ),
    (error) =>
      error.code === "ANSI_WORKLOAD_PROGRESS_REGRESSION" &&
      error.field === "enqueueCanonicalRevision",
  );
  assert.throws(
    () => advanceAnsiWorkloadProgress(progress, { ...empty, siblingHealth: 1 }, 17_000),
    /invalid ANSI workload progress observation/u,
  );
});

test("workload producer completion is exact, unique, and distinguishes pending from write error", () => {
  const payload = ansiWorkloadPayload("ANSI_TEST", 7);
  const expected = {
    cycle: 7,
    ordinal: 7,
    payloadBytes: Buffer.byteLength(payload),
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  };
  const complete = {
    version: 1,
    type: "performance.ansi-fixture-workload",
    ...expected,
    status: "complete",
    backpressureCount: 3,
  };
  assert.deepEqual(ansiWorkloadProducerStatus([], expected), {
    exact: false,
    state: "pending",
    reason: "completion-absent",
    record: null,
  });
  assert.equal(ansiWorkloadProducerStatus([complete], expected).exact, true);
  assert.equal(
    ansiWorkloadProducerStatus([{ ...complete, status: "error" }], expected).state,
    "error",
  );
  assert.equal(
    ansiWorkloadProducerStatus([complete, complete], expected).reason,
    "completion-cardinality",
  );
  for (const mutate of [
    (record) => (record.cycle = 8),
    (record) => (record.ordinal = 8),
    (record) => (record.payloadBytes += 1),
    (record) => (record.payloadSha256 = "0".repeat(64)),
    (record) => (record.backpressureCount = 8_193),
  ]) {
    const record = structuredClone(complete);
    mutate(record);
    assert.equal(ansiWorkloadProducerStatus([record], expected).exact, false);
  }
});

test("workload progress tails reject reorder duplicate rollback and incoherent delivery pairs", () => {
  const mode = (revision, atMicros = revision) => ({
    revision,
    stateHash: revision === 41 ? "1111111111111111" : "2222222222222222",
    atMicros,
  });
  const transition = (revision, atMicros = revision, updateType = "terminal.patch") => ({
    ...mode(revision, atMicros),
    updateType,
  });
  const frame = (revision, atMicros = revision, acceptedUpdateType = "terminal.patch") => ({
    ...mode(revision, atMicros),
    acceptedUpdateType,
    acceptedRevision: revision,
  });
  const delivery = (
    revision,
    ordinal,
    operation,
    atMicros = ordinal * 10,
    representation = "patch",
  ) => ({
    startedAtMicros: atMicros,
    endedAtMicros: atMicros + 1,
    terminalDelivery: {
      canonicalRevision: revision,
      canonicalStateHash: revision === 41 ? "1111111111111111" : "2222222222222222",
      deliveryOrdinal: ordinal,
      transactionId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
      ...(operation === "enqueue" ? { representation } : {}),
    },
    operation,
  });
  const exact = {
    transitions: [transition(41, 1), transition(42, 2)],
    modes: [mode(41, 3), mode(42, 4)],
    enqueues: [delivery(41, 7, "enqueue", 10), delivery(42, 8, "enqueue", 20)],
    settlements: [delivery(41, 7, "settled", 12), delivery(42, 8, "settled", 22)],
    frames: [frame(41, 30), frame(42, 40)],
    fences: [frame(41, 31), frame(42, 41)],
  };
  assert.equal(ansiWorkloadOrderedTailStatus(exact).exact, true);
  assert.equal(ansiWorkloadOrderedTailStatus({ ...exact, modes: [] }).exact, true);
  assert.equal(ansiWorkloadOrderedTailStatus({ ...exact, modes: [mode(42, 4)] }).exact, true);
  for (let cycle = 1; cycle <= 24; cycle += 1) {
    const revision = 40 + cycle;
    const cycleExact = {
      transitions: [transition(revision, 1)],
      modes: [],
      enqueues: [delivery(revision, cycle, "enqueue", 10)],
      settlements: [delivery(revision, cycle, "settled", 12)],
      frames: [frame(revision, 30)],
      fences: [frame(revision, 31)],
    };
    assert.equal(ansiWorkloadOrderedTailStatus(cycleExact).exact, true);
  }
  const futureEnqueue = structuredClone(exact);
  futureEnqueue.enqueues.push(delivery(43, 9, "enqueue", 50));
  const futureStatus = ansiWorkloadOrderedTailStatus(futureEnqueue);
  assert.equal(futureStatus.exact, true);
  assert.equal(futureStatus.pendingDeliveryCount, 1);
  assert.equal(futureStatus.progress.enqueueCanonicalRevision, 42);
  const seedGap = {
    transitions: [transition(60, 1), transition(61, 2), transition(63, 3, "terminal.seed")],
    modes: [mode(60, 4), mode(61, 5)],
    enqueues: [
      delivery(60, 60, "enqueue", 10),
      delivery(61, 61, "enqueue", 20),
      delivery(63, 63, "enqueue", 30, "seed"),
    ],
    settlements: [
      delivery(60, 60, "settled", 12),
      delivery(61, 61, "settled", 22),
      delivery(63, 63, "settled", 32),
    ],
    frames: [frame(60, 40), frame(61, 41), frame(63, 42, "terminal.seed")],
    fences: [frame(60, 43), frame(61, 44), frame(63, 45, "terminal.seed")],
  };
  assert.equal(ansiWorkloadOrderedTailStatus(seedGap).exact, true);
  assert.equal(ansiWorkloadOrderedTailStatus(seedGap).progress.canonicalRevision, 63);
  const seedOnly = {
    transitions: [transition(63, 1, "terminal.seed")],
    modes: [],
    enqueues: [delivery(63, 63, "enqueue", 10, "seed")],
    settlements: [delivery(63, 63, "settled", 12)],
    frames: [frame(63, 20, "terminal.seed")],
    fences: [frame(63, 21, "terminal.seed")],
  };
  assert.equal(ansiWorkloadOrderedTailStatus(seedOnly).exact, true);
  const seedTypeSplice = structuredClone(seedGap);
  seedTypeSplice.frames[2].acceptedUpdateType = "terminal.patch";
  const seedTypeStatus = ansiWorkloadOrderedTailStatus(seedTypeSplice);
  assert.equal(seedTypeStatus.reason, "accepted-transition-state");
  assert.equal(seedTypeStatus.offendingRevision, 63);
  assert.equal(seedTypeStatus.offendingAcceptedType, "terminal.patch");
  const crossKindDuplicate = structuredClone(seedGap);
  crossKindDuplicate.transitions.splice(2, 0, transition(61, 3, "terminal.seed"));
  assert.equal(ansiWorkloadOrderedTailStatus(crossKindDuplicate).reason, "transition-order");
  for (const mutate of [
    (value) => (value.enqueues[0].terminalDelivery.representation = "seed"),
    (value) => (value.enqueues[2].terminalDelivery.representation = "patch"),
    (value) => delete value.enqueues[0].terminalDelivery.representation,
    (value) => (value.enqueues[0].terminalDelivery.representation = "tombstone"),
    (value) => (value.settlements[0].terminalDelivery.representation = "seed"),
    (value) => (value.settlements[0].terminalDelivery.representation = "tombstone"),
  ]) {
    const value = structuredClone(seedGap);
    mutate(value);
    assert.equal(ansiWorkloadOrderedTailStatus(value).reason, "delivery-transition-type");
  }
  const explicitSettlementTypes = structuredClone(seedGap);
  explicitSettlementTypes.settlements[0].terminalDelivery.representation = "patch";
  explicitSettlementTypes.settlements[1].terminalDelivery.representation = "patch";
  explicitSettlementTypes.settlements[2].terminalDelivery.representation = "seed";
  assert.equal(ansiWorkloadOrderedTailStatus(explicitSettlementTypes).exact, true);
  const revisionRollback = structuredClone(exact);
  revisionRollback.enqueues.push(delivery(41, 9, "enqueue", 30), delivery(43, 10, "enqueue", 40));
  revisionRollback.settlements.push(
    delivery(41, 9, "settled", 32),
    delivery(43, 10, "settled", 42),
  );
  assert.equal(ansiWorkloadOrderedTailStatus(revisionRollback).reason, "delivery-revision-order");
  const equalRevision = structuredClone(exact);
  equalRevision.enqueues.push(delivery(42, 9, "enqueue", 30));
  assert.equal(ansiWorkloadOrderedTailStatus(equalRevision).reason, "delivery-revision-order");
  const conflictingHash = structuredClone(exact);
  conflictingHash.settlements[1].terminalDelivery.canonicalStateHash = "1111111111111111";
  assert.equal(ansiWorkloadOrderedTailStatus(conflictingHash).reason, "delivery-revision-hash");
  for (const [mutate, reason] of [
    [(value) => value.transitions.shift(), "canonical-transition-state"],
    [
      (value) => (value.transitions[1].stateHash = "1111111111111111"),
      "canonical-transition-state",
    ],
    [(value) => value.transitions.reverse(), "transition-order"],
    [(value) => (value.transitions[1].updateType = "terminal.tombstone"), "transition-shape"],
    [(value) => (value.frames[1].acceptedRevision = 41), "accepted-transition-state"],
    [(value) => delete value.fences[1].acceptedUpdateType, "accepted-transition-state"],
    [(value) => (value.modes[1].stateHash = "1111111111111111"), "canonical-transition-state"],
    [(value) => (value.modes[1].atMicros = 1), "mode-order"],
  ]) {
    const value = structuredClone(exact);
    mutate(value);
    assert.equal(ansiWorkloadOrderedTailStatus(value).reason, reason);
  }
  for (const mutate of [
    (value) => value.modes.reverse(),
    (value) => value.modes.push(structuredClone(value.modes.at(-1))),
    (value) => (value.modes[1].revision = 40),
    (value) => (value.enqueues[1].terminalDelivery.deliveryOrdinal = 6),
    (value) => (value.settlements[1].terminalDelivery.canonicalRevision = 41),
    (value) => (value.settlements[1].terminalDelivery.canonicalStateHash = "1111111111111111"),
    (value) => (value.settlements[1].startedAtMicros = 20),
    (value) => (value.enqueues[1].startedAtMicros = 10),
    (value) => (value.frames[1].revision = 41),
    (value) => (value.fences[1].revision = 41),
    (value) => (value.frames[1].stateHash = "1111111111111111"),
    (value) => (value.frames[1].atMicros = 1),
    (value) => (value.fences[1].atMicros = 39),
  ]) {
    const value = structuredClone(exact);
    mutate(value);
    assert.equal(ansiWorkloadOrderedTailStatus(value).exact, false);
  }
});

test("fixture restores normal state with one non-destructive stdout write", () => {
  const source = ansiCursorAltScreenFixtureProgram();
  const branch = /else if\(byte===110\)\{([^}]+)\}/u.exec(source)?.[1] ?? "";
  assert.equal((branch.match(/process\.stdout\.write\(/gu) ?? []).length, 1);
  assert.equal(branch.includes("normalize()"), false);
  assert.equal(
    branch.includes("process.stdout.write('\\x1b[?1049l\\x1b[0m\\x1b[2;1H\\x1b[2 q\\x1b[?25h')"),
    true,
  );
  assert.doesNotMatch(branch, /\\x1b\[(?:2J|3J)/u);
  assert.doesNotMatch(branch, /marker|ANSI_BASELINE|ALT_SCREEN/u);
});

test("fixture normalizes before alternate explicitly and enters alternate with one write", () => {
  const source = ansiCursorAltScreenFixtureProgram();
  const baselineBranch = /if\(byte===98\)\{([^}]+)\}/u.exec(source)?.[1] ?? "";
  const alternateBranch = /else if\(byte===97\)\{([^}]+)\}/u.exec(source)?.[1] ?? "";
  assert.equal(baselineBranch, "baseline()");
  assert.equal((alternateBranch.match(/process\.stdout\.write\(/gu) ?? []).length, 1);
  assert.doesNotMatch(alternateBranch, /baseline|3J/u);
  assert.match(alternateBranch, /\\x1b\[\?1049h/u);
  assert.match(alternateBranch, /ALT_SCREEN/u);
});

test("pre-alternate normal proof rejects semantic cursor and native splices", () => {
  const expected = {
    presentationHmac: "1".repeat(64),
    framebufferHmac: "2".repeat(64),
    nativeCaptureHmac: "3".repeat(64),
    cursor: { x: 0, y: 1, hidden: false, style: "block", blink: false },
  };
  const value = {
    stage: {
      alternateScreen: false,
      presentationHmac: expected.presentationHmac,
      framebufferHmac: expected.framebufferHmac,
      cursor: { ...expected.cursor },
    },
    nativeGeometryExact: true,
    nativeCaptureHmac: expected.nativeCaptureHmac,
  };
  assert.deepEqual(ansiPreAlternateNormalStatus(value, expected), {
    qualified: true,
    semanticExact: true,
    nativeExact: true,
    cursorExact: true,
  });
  for (const mutate of [
    (item) => (item.stage.presentationHmac = "4".repeat(64)),
    (item) => (item.stage.framebufferHmac = "4".repeat(64)),
    (item) => (item.stage.alternateScreen = true),
    (item) => (item.stage.cursor.x = 1),
    (item) => (item.nativeGeometryExact = false),
    (item) => (item.nativeCaptureHmac = "4".repeat(64)),
  ]) {
    const mutated = structuredClone(value);
    mutate(mutated);
    assert.equal(ansiPreAlternateNormalStatus(mutated, expected).qualified, false);
  }
});

test("workload payloads are exact, unique, and position their marker on viewport row 39", () => {
  const marker = "ANSI_WORKLOAD_FIXTURE";
  const markers = new Set();
  const byteCounts = new Set();
  for (let cycle = 1; cycle <= 24; cycle += 1) {
    const expectedMarker = ansiWorkloadMarker(marker, cycle);
    const payload = ansiWorkloadPayload(marker, cycle);
    markers.add(expectedMarker);
    byteCounts.add(Buffer.byteLength(payload));
    assert.equal(payload.split("\r\n").length - 1, 4_096);
    assert.equal(payload.endsWith(`\x1b[40;1H\x1b[2K${expectedMarker}`), true);
    assert.equal(payload.split(expectedMarker).length - 1, 1);
  }
  assert.equal(markers.size, 24);
  assert.equal(byteCounts.size, 1);
  assert.throws(() => ansiWorkloadPayload(marker, 0), /invalid ANSI workload marker identity/u);
  assert.throws(() => ansiWorkloadPayload(marker, 25), /invalid ANSI workload marker identity/u);
  const source = ansiCursorAltScreenFixtureProgram();
  assert.match(source, /process\.stdout\.write\(ansiWorkloadPayload\(marker,workload\)\)/u);
  assert.doesNotMatch(source, /out\+='ANSI_WORKLOAD_END_/u);
});

test("scratch fleet launches the static ANSI fixture with bounded clean argv and disposes", async (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 1_000 }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const marker = "ANSI_STATIC_FIXTURE";
  const fixturePath = fileURLToPath(
    new URL("./product-ansi-cursor-alt-screen-fixture.mjs", import.meta.url),
  );
  const completionPath = join(tmpdir(), `tmi-ansi-completion-${process.pid}.jsonl`);
  const command = Object.freeze({
    executable: process.execPath,
    args: Object.freeze([fixturePath, marker, completionPath]),
  });
  assert.doesNotThrow(() => validateScratchInitialPaneCommand(command));
  assert.throws(
    () =>
      validateScratchInitialPaneCommand({
        executable: process.execPath,
        args: ["source-with-a-newline\n", marker],
      }),
    (error) => error?.code === "scratch-initial-pane-command-invalid",
  );
  assert.equal(
    [command.executable, ...command.args].every(
      (value) => value.length <= 4_096 && !/[\0\r\n]/u.test(value),
    ),
    true,
  );
  const fleet = await createScratchFleet({
    sessions: 1,
    slug: `ansi-static-${process.pid}`,
    windowsPerSession: 1,
    initialPaneCommand: command,
  });
  const session = fleet.sessionNames[0];
  const pane = fleet.initialPanes[0];
  const tmux = (args) =>
    execFileSync("tmux", ["-S", fleet.socketPath, ...args], {
      encoding: "utf8",
      timeout: 3_000,
    });
  try {
    assert.ok(pane);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fleet.capturePane(session).includes(marker)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    assert.match(fleet.capturePane(session), new RegExp(marker, "u"));
    tmux(["set-option", "-g", "pane-border-status", "top"]);
    tmux(["resize-window", "-t", `=${session}:0`, "-x", "132", "-y", "41"]);
    tmux(["send-keys", "-t", pane.paneId, "-l", "w"]);
    const expectedMarker = ansiWorkloadMarker(marker, 1);
    let visible = "";
    for (let attempt = 0; attempt < 150; attempt += 1) {
      visible = tmux(["capture-pane", "-p", "-t", pane.paneId]);
      if (visible.includes(expectedMarker)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    assert.equal(visible.split(expectedMarker).length - 1, 1);
    assert.equal(visible.trimEnd().split("\n").at(-1), expectedMarker);
  } finally {
    await fleet.dispose();
    rmSync(completionPath, { force: true });
  }
  assert.equal(existsSync(fleet.root), false);
});

test("private tmux presents the workload marker once on y39 and retains its history", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 1_000 }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "tmi-ansi-workload-"));
  const socket = join(root, "tmux.sock");
  const config = join(root, "tmux.conf");
  const fixture = join(root, "fixture.mjs");
  const baselineMarker = "ANSI_WORKLOAD_BASELINE";
  const workloadMarker = ansiWorkloadMarker(baselineMarker, 1);
  writeFileSync(
    config,
    "set -g status on\nset -g status-position top\nset -g pane-border-status top\nset -g history-limit 5000\n",
  );
  writeFileSync(fixture, `process.argv.splice(1,1);${ansiCursorAltScreenFixtureProgram()}`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const tmux = (args) =>
    execFileSync("tmux", ["-f", config, "-S", socket, ...args], {
      encoding: "utf8",
      timeout: 3_000,
    });
  const cursor = () =>
    tmux([
      "display-message",
      "-p",
      "-t",
      "=fixture:0.0",
      "#{window_width}:#{window_height}:#{pane_width}:#{pane_height}:#{cursor_x}:#{cursor_y}:#{alternate_on}",
    ]).trim();
  try {
    tmux([
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-x",
      "132",
      "-y",
      "41",
      `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(baselineMarker)}`,
    ]);
    for (let attempt = 0; attempt < 100 && cursor() !== "132:41:132:40:0:1:0"; attempt += 1)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.equal(cursor(), "132:41:132:40:0:1:0");
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "w"]);
    const expectedCursor = `132:41:132:40:${workloadMarker.length}:39:0`;
    for (let attempt = 0; attempt < 150 && cursor() !== expectedCursor; attempt += 1)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    assert.equal(cursor(), expectedCursor);
    const visible = tmux(["capture-pane", "-p", "-t", "=fixture:0.0"]);
    const visibleRows = visible.trimEnd().split("\n");
    assert.equal(visibleRows.length, 40);
    assert.equal(visibleRows[39], workloadMarker);
    assert.equal(visible.split(workloadMarker).length - 1, 1);
    const history = tmux(["capture-pane", "-p", "-S", "-", "-t", "=fixture:0.0"]);
    assert.match(history, /LOAD_0000 0123456789abcdef/u);
    assert.match(history, /LOAD_4095 0123456789abcdef/u);
    assert.equal(history.split(workloadMarker).length - 1, 1);
  } finally {
    spawnSync("tmux", ["-f", config, "-S", socket, "kill-server"], {
      stdio: "ignore",
      timeout: 2_000,
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture baseline cursor is exact across cooked start, raw reset, and alt restore", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 1_000 }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "tmi-ansi-baseline-"));
  const socket = join(root, "tmux.sock");
  const fixture = join(root, "fixture.mjs");
  const marker = "ANSI_BASELINE_MARKER";
  writeFileSync(fixture, `process.argv.splice(1,1);${ansiCursorAltScreenFixtureProgram()}`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const tmux = (args) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      timeout: 2_000,
    });
  const cursor = () =>
    tmux([
      "display-message",
      "-p",
      "-t",
      "=fixture:0.0",
      "#{cursor_x}:#{cursor_y}:#{alternate_on}",
    ]).trim();
  const capture = () => tmux(["capture-pane", "-p", "-e", "-S", "-", "-t", "=fixture:0.0"]);
  const visible = () => tmux(["capture-pane", "-p", "-e", "-t", "=fixture:0.0"]);
  const waitFor = (expected) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (cursor() === expected) return;
      } catch {
        // The private pane may still be starting.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    assert.equal(cursor(), expected);
  };
  try {
    tmux([
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-x",
      "80",
      "-y",
      "24",
      `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(marker)}`,
    ]);
    waitFor("0:1:0");
    const semanticPaneId = "pane-a";
    const resourceId = "window-resource-a";
    tmux(["set-option", "-p", "-t", "=fixture:0.0", "@tmux_ide_pane_id", semanticPaneId]);
    tmux(["set-option", "-w", "-t", "=fixture:0", "@tmux_ide_window_id", resourceId]);
    const fields = tmux([
      "list-panes",
      "-s",
      "-t",
      "=fixture",
      "-F",
      "#{session_name}\t#{window_id}\t#{@tmux_ide_window_id}\t#{window_name}\t#{window_active}\t#{window_width}\t#{window_height}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
    ])
      .trimEnd()
      .split("\t");
    const leaseStatus = ansiNativePaneLeaseStatus(
      [
        {
          sessionName: fields[0],
          nativeWindowId: fields[1],
          resourceId: fields[2],
          name: fields[3],
          active: fields[4] === "1",
          paneId: fields[7],
          semanticPaneId: fields[8],
          geometry: {
            windowCols: Number(fields[5]),
            windowRows: Number(fields[6]),
            left: Number(fields[9]),
            top: Number(fields[10]),
            cols: Number(fields[11]),
            rows: Number(fields[12]),
          },
        },
      ],
      {
        sessionName: "fixture",
        windowResourceId: `terminal-window.${createHash("sha256").update(resourceId).digest("hex").slice(0, 20)}`,
        semanticPaneId,
      },
    );
    assert.equal(leaseStatus.mappingExact, true);
    assert.match(
      tmux(["capture-pane", "-p", "-t", leaseStatus.lease.paneId]),
      /ANSI_BASELINE_MARKER/u,
    );
    const initialVisible = visible();
    assert.match(initialVisible, /ANSI_BASELINE_MARKER/u);
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "b"]);
    waitFor("0:1:0");
    assert.equal(visible(), initialVisible);
    const normalBeforeAlternate = capture();
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "a"]);
    waitFor("11:7:1");
    const alternate = visible();
    assert.match(alternate, /ALT_SCREEN/u);
    assert.doesNotMatch(alternate, /ANSI_BASELINE_MARKER/u);
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "n"]);
    waitFor("0:1:0");
    assert.equal(capture(), normalBeforeAlternate);
  } finally {
    spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore", timeout: 2_000 });
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalization cannot fake restoration when alternate-buffer entry is broken", (t) => {
  if (spawnSync("tmux", ["-V"], { stdio: "ignore", timeout: 1_000 }).status !== 0) {
    t.skip("tmux is unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "tmi-ansi-broken-alt-"));
  const socket = join(root, "tmux.sock");
  const fixture = join(root, "fixture.mjs");
  const marker = "ANSI_BROKEN_ALT_MARKER";
  const brokenProgram = ansiCursorAltScreenFixtureProgram().replace("\\x1b[?1049h", "");
  writeFileSync(fixture, `process.argv.splice(1,1);${brokenProgram}`);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const tmux = (args) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      timeout: 2_000,
    });
  const cursor = () =>
    tmux([
      "display-message",
      "-p",
      "-t",
      "=fixture:0.0",
      "#{cursor_x}:#{cursor_y}:#{alternate_on}",
    ]).trim();
  const waitFor = (expected) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (cursor() === expected) return;
      } catch {
        // The private pane may still be starting.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    assert.equal(cursor(), expected);
  };
  const capture = () => tmux(["capture-pane", "-p", "-e", "-S", "-", "-t", "=fixture:0.0"]);
  try {
    tmux([
      "new-session",
      "-d",
      "-s",
      "fixture",
      "-x",
      "80",
      "-y",
      "24",
      `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(marker)}`,
    ]);
    waitFor("0:1:0");
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "b"]);
    waitFor("0:1:0");
    const normalBeforeAlternate = capture();
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "a"]);
    waitFor("11:7:0");
    tmux(["send-keys", "-t", "=fixture:0.0", "-l", "n"]);
    waitFor("0:1:0");
    assert.notEqual(capture(), normalBeforeAlternate);
  } finally {
    spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore", timeout: 2_000 });
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline cursor evidence qualifies one rev0 full render and a retained reseed", () => {
  const frame = [
    " tmux-ide",
    " ordinary",
    `${" ".repeat(28)}● pane-1`,
    ...Array.from({ length: 40 }, () => " ".repeat(160)),
  ].join("\n");
  const bodyRect = resolvePaneBodyRect(frame, {
    semanticPaneId: "pane-1",
    left: 0,
    top: 0,
    width: 132,
    height: 40,
  });
  assert.deepEqual(bodyRect, {
    left: 28,
    firstBodyRow: 3,
    width: 132,
    bodyRows: 40,
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  });
  const semanticBody = ansiSemanticBodyProjection(bodyRect);
  assert.deepEqual(semanticBody, {
    viewportCols: 132,
    viewportRows: 40,
    screenOffsetX: 28,
    screenOffsetY: 3,
  });
  const expected = {
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    semanticPaneId: "pane-1",
    generation: "generation-1",
    incarnation: "incarnation-1",
    revision: 2,
    stateHash: "0123456789abcdef",
    canonicalCols: 132,
    canonicalRows: 41,
    ...semanticBody,
    sourceEpoch: 1,
    rendererEpoch: 3,
    cursor: { x: 0, y: 1, hidden: false, style: "block", blink: false },
    alternateScreen: false,
    wraparound: true,
    mouseProtocol: "none",
    mouseEncoding: "default",
    baselinePredecessor: {
      status: "exact",
      reason: null,
      counters: { gridRowsReadTotal: 41, fullWalkTotal: 1, presentationCount: 1 },
    },
    activePaneExact: true,
    seedRevisionExact: true,
    seedGeometryExact: true,
    seedIdentityExact: true,
  };
  const mode = {
    type: "performance.terminal-canonical-mode",
    processId: expected.processId,
    clockId: expected.clockId,
    clockKind: "performance-now",
    atMicros: 100,
    semanticPaneId: expected.semanticPaneId,
    generation: expected.generation,
    incarnation: expected.incarnation,
    revision: expected.revision,
    stateHash: expected.stateHash,
    alternateScreen: expected.alternateScreen,
    cursor: expected.cursor,
    wraparound: expected.wraparound,
    mouseProtocol: expected.mouseProtocol,
    mouseEncoding: expected.mouseEncoding,
  };
  const presentation = {
    type: "performance.terminal-cursor-presentation",
    processId: expected.processId,
    clockId: expected.clockId,
    clockKind: "performance-now",
    atMicros: 101,
    semanticPaneId: expected.semanticPaneId,
    generation: expected.generation,
    incarnation: expected.incarnation,
    revision: expected.revision,
    stateHash: expected.stateHash,
    cols: expected.canonicalCols,
    rows: expected.canonicalRows,
    viewportCols: expected.viewportCols,
    viewportRows: expected.viewportRows,
    screenX: 29,
    screenY: 5,
    sourceEpoch: expected.sourceEpoch,
    rendererEpoch: expected.rendererEpoch,
    cursorX: expected.cursor.x,
    cursorY: expected.cursor.y,
    visible: true,
    style: "block",
    blink: false,
    gridWalked: true,
    gridRowsRead: 40,
    fullWalk: false,
    gridRowsReadTotal: 81,
    fullWalkTotal: 1,
    presentationCount: 2,
  };
  const value = { modes: [mode], presentations: [presentation] };
  assert.equal(ansiBaselineCursorEvidenceStatus(value, expected).qualified, true);
  assert.equal(
    ansiBaselineCursorEvidenceStatus(
      { ...value, presentations: [{ ...presentation, fullWalk: true, fullWalkTotal: 2 }] },
      expected,
    ).qualified,
    false,
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(value, {
      ...expected,
      baselinePredecessor: { status: "none", reason: null, counters: null },
    }).qualified,
    false,
  );
  const initialExpected = {
    ...expected,
    revision: 0,
    baselinePredecessor: { status: "none", reason: null, counters: null },
  };
  const initialMode = { ...mode, revision: 0 };
  const initialPresentation = {
    ...presentation,
    revision: 0,
    fullWalk: true,
    gridRowsReadTotal: 40,
    fullWalkTotal: 1,
    presentationCount: 1,
  };
  const initialStatus = ansiBaselineCursorEvidenceStatus(
    { modes: [initialMode], presentations: [initialPresentation] },
    initialExpected,
  );
  assert.equal(initialStatus.qualified, true);
  assert.deepEqual(
    {
      predecessorPresent: initialStatus.predecessorPresent,
      actualGridRowsRead: initialStatus.actualGridRowsRead,
      expectedGridRowsRead: initialStatus.expectedGridRowsRead,
      actualFullWalk: initialStatus.actualFullWalk,
      expectedFullWalk: initialStatus.expectedFullWalk,
      gridRowsReadDelta: initialStatus.gridRowsReadDelta,
      fullWalkDelta: initialStatus.fullWalkDelta,
      presentationDelta: initialStatus.presentationDelta,
    },
    {
      predecessorPresent: false,
      actualGridRowsRead: 40,
      expectedGridRowsRead: 40,
      actualFullWalk: true,
      expectedFullWalk: true,
      gridRowsReadDelta: 40,
      fullWalkDelta: 1,
      presentationDelta: 1,
    },
  );
  for (const malformed of [
    { ...initialPresentation, fullWalk: false },
    { ...initialPresentation, fullWalkTotal: 0 },
    { ...initialPresentation, gridRowsReadTotal: 39 },
    { ...initialPresentation, presentationCount: 2 },
  ])
    assert.equal(
      ansiBaselineCursorEvidenceStatus(
        { modes: [initialMode], presentations: [malformed] },
        initialExpected,
      ).qualified,
      false,
    );
  const exactPredecessor = {
    ...presentation,
    revision: 1,
    gridRowsReadTotal: 41,
    presentationCount: 1,
  };
  assert.deepEqual(ansiBaselinePreviousCounters([exactPredecessor], 1, expected), {
    status: "exact",
    reason: null,
    counters: { gridRowsReadTotal: 41, fullWalkTotal: 1, presentationCount: 1 },
  });
  assert.deepEqual(
    ansiBaselinePreviousCounters(
      [{ ...exactPredecessor, processId: "opentui:spliced" }],
      1,
      expected,
    ),
    { status: "none", reason: null, counters: null },
  );
  assert.deepEqual(
    ansiBaselinePreviousCounters([exactPredecessor, { ...exactPredecessor }], 2, expected),
    { status: "invalid", reason: "duplicate-revision", counters: null },
  );
  assert.deepEqual(ansiBaselinePreviousCounters([], 0, expected), {
    status: "none",
    reason: null,
    counters: null,
  });
  const invalidPredecessors = [
    ansiBaselinePreviousCounters([exactPredecessor, { ...exactPredecessor }], 2, expected),
    ansiBaselinePreviousCounters([{ ...exactPredecessor, gridRowsReadTotal: 1.5 }], 1, expected),
    ansiBaselinePreviousCounters(
      [{ ...exactPredecessor, gridRowsReadTotal: Number.MAX_SAFE_INTEGER }],
      1,
      expected,
    ),
    ansiBaselinePreviousCounters([{ ...exactPredecessor, revision: "1" }], 1, expected),
    ansiBaselinePreviousCounters(null, 0, expected),
  ];
  assert.deepEqual(
    invalidPredecessors.map(({ status, reason }) => [status, reason]),
    [
      ["invalid", "duplicate-revision"],
      ["invalid", "counter-shape"],
      ["invalid", "counter-overflow"],
      ["invalid", "predecessor-shape"],
      ["invalid", "records-shape"],
    ],
  );
  for (const baselinePredecessor of invalidPredecessors) {
    const status = ansiBaselineCursorEvidenceStatus(
      { modes: [initialMode], presentations: [initialPresentation] },
      { ...initialExpected, baselinePredecessor },
    );
    assert.equal(status.qualified, false);
    assert.equal(status.firstFailedPredicate, "predecessorExact");
    assert.equal(status.predecessorInvalidReason, baselinePredecessor.reason);
  }
  const negativeRows = ansiBaselineCursorEvidenceStatus(
    {
      modes: [initialMode],
      presentations: [{ ...initialPresentation, gridRowsRead: -1 }],
    },
    initialExpected,
  );
  assert.equal(negativeRows.actualGridRowsRead, null);
  assert.equal(negativeRows.qualified, false);
  const oversizedExpectedRows = ansiBaselineCursorEvidenceStatus(
    { modes: [initialMode], presentations: [initialPresentation] },
    { ...initialExpected, viewportRows: Number.MAX_SAFE_INTEGER },
  );
  assert.equal(oversizedExpectedRows.expectedGridRowsRead, null);
  assert.equal(oversizedExpectedRows.qualified, false);
  assert.deepEqual(ansiBaselineCursorEvidenceStatus({ ...value, modes: [] }, expected), {
    qualified: false,
    firstFailedPredicate: "modeExact",
    modeCount: 0,
    presentationCount: 1,
    activePaneExact: true,
    seedRevisionExact: true,
    seedGeometryExact: true,
    seedIdentityExact: true,
    modeLineageExact: false,
    modeStateExact: false,
    modeCursorExact: false,
    modeIdentityExact: false,
    presentationLineageExact: true,
    presentationCanonicalGeometryExact: true,
    presentationViewportGeometryExact: true,
    presentationScreenMappingExact: true,
    presentationGeometryExact: true,
    presentationCursorExact: true,
    predecessorStatus: "exact",
    predecessorInvalidReason: null,
    predecessorPresent: true,
    actualGridRowsRead: 40,
    expectedGridRowsRead: 40,
    actualFullWalk: false,
    expectedFullWalk: false,
    gridRowsReadDelta: 40,
    fullWalkDelta: 0,
    presentationDelta: 1,
    presentationCounterInputExact: true,
    presentationCounterExact: true,
    presentationIdentityExact: true,
    orderExact: false,
  });
  assert.equal(
    ansiBaselineCursorEvidenceStatus({ ...value, presentations: [] }, expected)
      .firstFailedPredicate,
    "presentationExact",
  );

  for (const [label, mutated] of [
    ["mode process", { modes: [{ ...mode, processId: "opentui:43" }] }],
    ["mode clock", { modes: [{ ...mode, clockId: "other" }] }],
    ["mode clock kind", { modes: [{ ...mode, clockKind: "wall-clock" }] }],
    ["mode pane", { modes: [{ ...mode, semanticPaneId: "pane-2" }] }],
    ["mode generation", { modes: [{ ...mode, generation: "generation-2" }] }],
    ["mode hash", { modes: [{ ...mode, stateHash: "fedcba9876543210" }] }],
    ["mode cursor", { modes: [{ ...mode, cursor: { ...mode.cursor, x: 10 } }] }],
    ["mode state", { modes: [{ ...mode, alternateScreen: true }] }],
    ["presentation process", { presentations: [{ ...presentation, processId: "opentui:43" }] }],
    ["presentation clock", { presentations: [{ ...presentation, clockId: "other" }] }],
    ["presentation kind", { presentations: [{ ...presentation, clockKind: "wall-clock" }] }],
    [
      "presentation incarnation",
      { presentations: [{ ...presentation, incarnation: "incarnation-2" }] },
    ],
    ["presentation revision", { presentations: [{ ...presentation, revision: 3 }] }],
    ["presentation hash", { presentations: [{ ...presentation, stateHash: "bad" }] }],
    ["presentation cols", { presentations: [{ ...presentation, cols: 131 }] }],
    ["presentation rows", { presentations: [{ ...presentation, rows: 40 }] }],
    ["presentation viewport", { presentations: [{ ...presentation, viewportRows: 41 }] }],
    ["presentation screen", { presentations: [{ ...presentation, screenY: 4 }] }],
    ["presentation source", { presentations: [{ ...presentation, sourceEpoch: 2 }] }],
    ["presentation renderer", { presentations: [{ ...presentation, rendererEpoch: 4 }] }],
    ["presentation cursor", { presentations: [{ ...presentation, cursorX: 10 }] }],
    ["presentation style", { presentations: [{ ...presentation, style: "underline" }] }],
    ["presentation counters", { presentations: [{ ...presentation, gridRowsReadTotal: 80 }] }],
  ]) {
    const status = ansiBaselineCursorEvidenceStatus({ ...value, ...mutated }, expected);
    assert.equal(status.qualified, false, label);
    assert.match(status.firstFailedPredicate, /Exact$/u, label);
  }
  assert.equal(
    ansiBaselineCursorEvidenceStatus(value, {
      ...expected,
      cursor: { ...expected.cursor, x: 9 },
    }).firstFailedPredicate,
    "modeCursorExact",
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(
      { ...value, presentations: [{ ...presentation, screenX: 30 }] },
      expected,
    ).firstFailedPredicate,
    "presentationScreenMappingExact",
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(
      { ...value, presentations: [{ ...presentation, atMicros: 99 }] },
      expected,
    ).orderExact,
    false,
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(
      { ...value, modes: [{ ...mode, processId: "opentui:wrong", atMicros: 200 }] },
      expected,
    ).orderExact,
    false,
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(
      { ...value, modes: [{ ...mode, processId: "opentui:wrong", atMicros: 90 }] },
      expected,
    ).orderExact,
    true,
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(
      { ...value, presentations: [{ ...presentation, atMicros: 99 }] },
      expected,
    ).firstFailedPredicate,
    "orderExact",
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus({ ...value, modes: [mode, { ...mode }] }, expected)
      .firstFailedPredicate,
    "modeExact",
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(value, { ...expected, seedRevisionExact: false })
      .firstFailedPredicate,
    "seedRevisionExact",
  );
  assert.equal(
    ansiBaselineCursorEvidenceStatus(value, { ...expected, seedGeometryExact: false })
      .firstFailedPredicate,
    "seedGeometryExact",
  );
});

test("semantic body projection rejects legacy aliases and malformed resolver evidence", () => {
  const valid = {
    left: 28,
    firstBodyRow: 3,
    width: 132,
    bodyRows: 40,
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  };
  for (const malformed of [
    { ...valid, left: -1 },
    { ...valid, firstBodyRow: 1.5 },
    { ...valid, width: 0 },
    { ...valid, bodyRows: 0 },
    { ...valid, origin: "tmux-geometry" },
    { ...valid, valid: false },
    { ...valid, semanticChromeMatches: 2 },
    { ...valid, extra: true },
    { x: 28, y: 3, width: 132, height: 40, valid: true },
    Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "bodyRows")),
  ])
    assert.equal(ansiSemanticBodyProjection(malformed), null);
});

test("native pane lease resolves one current semantic mapping and admits native replacement", () => {
  const resourceId = "window-resource-a";
  const expected = {
    sessionName: "session-a",
    windowResourceId: `terminal-window.${createHash("sha256").update(resourceId).digest("hex").slice(0, 20)}`,
    semanticPaneId: "pane-a",
  };
  const row = {
    sessionName: expected.sessionName,
    nativeWindowId: "@1",
    resourceId,
    name: "one",
    active: true,
    paneId: "%0",
    semanticPaneId: expected.semanticPaneId,
    geometry: { windowCols: 132, windowRows: 41, left: 0, top: 0, cols: 132, rows: 40 },
  };
  assert.deepEqual(ansiNativePaneLeaseStatus([row], expected), {
    matchCount: 1,
    mappingExact: true,
    lease: { paneId: "%0", nativeWindowId: "@1" },
  });
  assert.deepEqual(ansiNativePaneLeaseStatus([{ ...row, paneId: "%7" }], expected), {
    matchCount: 1,
    mappingExact: true,
    lease: { paneId: "%7", nativeWindowId: "@1" },
  });
  for (const rows of [
    [],
    [{ ...row, sessionName: "session-b" }],
    [{ ...row, resourceId: "window-resource-b" }],
    [{ ...row, semanticPaneId: "pane-b" }],
    [{ ...row, active: false }],
    [{ ...row, paneId: "pane-a" }],
    [{ ...row, nativeWindowId: "window-1" }],
    [{ ...row, extra: true }],
    [row, { ...row, paneId: "%7" }],
  ]) {
    const result = ansiNativePaneLeaseStatus(rows, expected);
    assert.equal(result.mappingExact, false);
    assert.equal(result.lease, null);
  }
});

test("advances the immediate canonical predecessor across rich cursor normal alt and restore", () => {
  let predecessor = { revision: 1, stateHash: "0000000000000001" };
  for (const [stage, revision] of [
    ["rich", 2],
    ["cursor-1", 3],
    ["cursor-2", 4],
    ["pre-alternate-normal", 5],
    ["alternate", 6],
    ["restored", 7],
  ]) {
    const next = advanceAnsiCanonicalPredecessor(predecessor, {
      qualified: true,
      raw: {
        origin: { revision: predecessor.revision, stateHash: predecessor.stateHash },
        mode: { revision, stateHash: revision.toString(16).padStart(16, "0"), stage },
      },
    });
    assert.ok(next);
    predecessor = next;
  }
  assert.equal(predecessor.revision, 7);
  assert.equal(
    advanceAnsiCanonicalPredecessor(predecessor, {
      qualified: true,
      raw: {
        origin: { revision: 1, stateHash: "0000000000000001" },
        mode: { revision: 8, stateHash: "0000000000000008" },
      },
    }),
    null,
  );
});

const daemonTrace = (traceId) => [
  ...[
    ["pane-stream-socket-message-callback-entry", "transport", 1, 1],
    ["pane-stream-input-frame-ingress", "transport", 2, 2],
    ["raw-input-command", "tmux", 3, 4],
    ["control-write", "tmux", 5, 6],
    ["control-command-accepted", "tmux", 7, 7],
    ["first-output-observed", "tmux", 8, 8],
    ["terminal-replica-write", "parse", 9, 10],
    ["terminal-replica-project-commit", "reduce", 11, 12],
    ["terminal-delivery-encode-enqueue", "transport", 13, 14],
    ["pane-stream-socket-send", "transport", 15, 16],
    ["terminal-delivery-settled", "transport", 17, 17],
  ].map(([operation, stage, startedAtMicros, endedAtMicros]) => ({
    type: "performance.stage",
    operation,
    stage,
    traceId,
    processId: "daemon:1",
    clockId: "node-performance-now",
    clockKind: "performance-now",
    scenario: "terminal-input-to-paint",
    authority: {
      generation: "generation-a",
      incarnation: new Set(["raw-input-command", "control-write", "control-command-accepted"]).has(
        operation,
      )
        ? null
        : "incarnation-a",
    },
    startedAtMicros,
    endedAtMicros,
    ...(new Set([
      "terminal-delivery-encode-enqueue",
      "pane-stream-socket-send",
      "terminal-delivery-settled",
    ]).has(operation)
      ? {
          terminalDelivery: {
            workspaceName: "session-a",
            semanticPaneId: "pane-a",
            canonicalGeneration: "generation-a",
            canonicalIncarnation: "incarnation-a",
            canonicalRevision: 8,
            canonicalStateHash: "0123456789abcdef",
            deliveryOrdinal: 1,
            transactionId: "transaction-a",
            deliveryClientId: "opentui:42",
            deliverySurface: "opentui",
            deliveryLaneId: "opentui:42:lane-1",
            deliveryRequestId: "00000000-0000-4000-8000-000000000010",
            deliveryNonce: "nonce-a",
          },
        }
      : {}),
  })),
  {
    type: "performance.stage",
    operation: "terminal-delivery-subscriber-lifecycle",
    stage: "transport",
    traceId: null,
    processId: "daemon:1",
    clockId: "node-performance-now",
    clockKind: "performance-now",
    scenario: null,
    authority: null,
    startedAtMicros: 0,
    endedAtMicros: 0,
    terminalDelivery: {
      workspaceName: "session-a",
      semanticPaneId: "pane-a",
      canonicalGeneration: "generation-a",
      canonicalIncarnation: "incarnation-a",
      canonicalRevision: 7,
      canonicalStateHash: "fedcba9876543210",
      deliveryClientId: "opentui:42",
      deliverySurface: "opentui",
      deliveryLaneId: "opentui:42:lane-1",
      deliveryRequestId: "00000000-0000-4000-8000-000000000010",
      deliveryLifecycleEvent: "open",
      deliveryPurpose: "terminal-surface",
      deliveryLifecycleOrdinal: 1,
    },
  },
];

test("bounds active delivery topology before input and rejects stability-window growth", () => {
  const records = daemonTrace("00000000-0000-4000-8000-000000000099").filter(
    (record) => record.operation === "terminal-delivery-subscriber-lifecycle",
  );
  for (let ordinal = 2; ordinal <= 16; ordinal += 1) {
    const record = structuredClone(records[0]);
    record.terminalDelivery.deliveryClientId = "web:1";
    record.terminalDelivery.deliverySurface = "web";
    record.terminalDelivery.deliveryLaneId = `web:1:lane-${ordinal}`;
    record.terminalDelivery.deliveryRequestId = `00000000-0000-4000-8000-${String(100 + ordinal).padStart(12, "0")}`;
    record.terminalDelivery.deliveryLifecycleOrdinal = ordinal;
    records.push(record);
  }
  const expected = {
    deliveryWorkspaceName: "session-a",
    semanticPaneId: "pane-a",
    canonicalGeneration: "generation-a",
    canonicalIncarnation: "incarnation-a",
    daemonProcessId: "daemon:1",
    daemonClockId: "node-performance-now",
    deliveryClients: { opentui: "opentui:42", web: "web:1" },
  };
  const empty = ansiDeliverySubscriberTopologyStatus({ records: [], expected });
  assert.equal(empty.exact, false);
  assert.equal(empty.reason, "lane-count");
  const sixteen = ansiDeliverySubscriberTopologyStatus({ records, expected });
  assert.equal(sixteen.exact, true);
  assert.equal(sixteen.lanes.length, 16);

  const collisionRecords = structuredClone(records);
  collisionRecords.at(-1).terminalDelivery.deliveryRequestId =
    collisionRecords[0].terminalDelivery.deliveryRequestId;
  const collision = ansiDeliverySubscriberTopologyStatus({ records: collisionRecords, expected });
  assert.equal(collision.exact, false);
  assert.equal(collision.reason, "request-collision");

  const grown = structuredClone(records.at(-1));
  grown.terminalDelivery.deliveryLaneId = "web:1:lane-17";
  grown.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000117";
  grown.terminalDelivery.deliveryLifecycleOrdinal = 17;
  records.push(grown);
  const seventeen = ansiDeliverySubscriberTopologyStatus({ records, expected });
  assert.equal(seventeen.exact, false);
  assert.equal(seventeen.reason, "lane-count");
  assert.notEqual(JSON.stringify(seventeen), JSON.stringify(sixteen));
});

test("requires every active delivery lane to settle the exact predecessor before input", () => {
  const records = daemonTrace("00000000-0000-4000-8000-000000000099");
  for (const record of records.filter((candidate) =>
    new Set([
      "terminal-delivery-encode-enqueue",
      "pane-stream-socket-send",
      "terminal-delivery-settled",
    ]).has(candidate.operation),
  ))
    record.traceId = null;
  const expected = {
    deliveryWorkspaceName: "session-a",
    semanticPaneId: "pane-a",
    canonicalGeneration: "generation-a",
    canonicalIncarnation: "incarnation-a",
    daemonProcessId: "daemon:1",
    daemonClockId: "node-performance-now",
    deliveryClients: { opentui: "opentui:42" },
    predecessorRevision: 8,
    predecessorStateHash: "0123456789abcdef",
  };
  const topology = ansiDeliverySubscriberTopologyStatus({ records, expected });
  const status = structuredClone(records.at(-1));
  status.operation = "terminal-delivery-subscriber-status";
  status.traceId = null;
  status.startedAtMicros = 3_500_018;
  status.endedAtMicros = 3_500_018;
  Object.assign(status.terminalDelivery, {
    canonicalRevision: 8,
    canonicalStateHash: "0123456789abcdef",
    deliveryPurpose: "terminal-surface",
    deliveryStatusOrdinal: 1,
    deliveryVisibility: "visible",
    deliveryBaselineRevision: 8,
    deliveryBaselineHash: "0123456789abcdef",
    deliveryInFlightRevision: null,
    deliveryInFlightHash: null,
    deliveryLatestRevision: null,
    deliveryClientQueueDepth: 0,
  });
  records.push(status);
  const ready = ansiDeliverySubscriberReadinessStatus({ records, expected, topology });
  assert.equal(
    records.filter(({ operation }) => operation === "pane-stream-socket-send").length,
    1,
    "one producer-shaped trace-null initial seed socket span completes readiness",
  );
  assert.deepEqual(ready, {
    exact: true,
    reason: null,
    laneCount: 1,
    readyLaneCount: 1,
    firstInvalidLaneOrdinal: null,
    statusOrdinal: 1,
  });

  const reject = (mutate, reason) => {
    const adversary = structuredClone(records);
    mutate(adversary);
    const result = ansiDeliverySubscriberReadinessStatus({
      records: adversary,
      expected,
      topology,
    });
    assert.equal(result.exact, false);
    assert.equal(result.reason, reason);
  };
  reject(
    (candidate) =>
      candidate.splice(
        candidate.findIndex(({ operation }) => operation === "terminal-delivery-settled"),
        1,
      ),
    "lineage-cardinality",
  );
  reject(
    (candidate) =>
      candidate.splice(
        candidate.findIndex(({ operation }) => operation === "pane-stream-socket-send"),
        1,
      ),
    "lineage-cardinality",
  );
  reject(
    (candidate) =>
      candidate.push(
        structuredClone(
          candidate.find(({ operation }) => operation === "terminal-delivery-settled"),
        ),
      ),
    "lineage-cardinality",
  );
  reject((candidate) => {
    candidate.push(
      structuredClone(candidate.find(({ operation }) => operation === "pane-stream-socket-send")),
    );
  }, "lineage-cardinality");
  reject((candidate) => {
    candidate.find(
      ({ operation }) => operation === "pane-stream-socket-send",
    ).terminalDelivery.transactionId = "wrong-socket-transaction";
  }, "lineage-identity");
  reject((candidate) => {
    candidate.at(-1).terminalDelivery.deliveryBaselineRevision = 7;
  }, "canonical-predecessor");
  reject((candidate) => {
    candidate.at(-1).terminalDelivery.deliveryBaselineHash = "fedcba9876543210";
  }, "canonical-predecessor");
  for (const visibility of ["hidden", "frozen"]) {
    reject((candidate) => {
      candidate.at(-1).terminalDelivery.deliveryVisibility = visibility;
    }, "lane-not-visible");
  }
  reject((candidate) => {
    candidate.at(-1).terminalDelivery.deliveryInFlightRevision = 9;
    candidate.at(-1).terminalDelivery.deliveryInFlightHash = "fedcba9876543210";
  }, "lane-in-flight");
  reject((candidate) => {
    candidate.at(-1).terminalDelivery.deliveryClientQueueDepth = 1;
  }, "lane-queue-not-empty");
  reject((candidate) => {
    const later = structuredClone(
      candidate.find(({ operation }) => operation === "terminal-delivery-encode-enqueue"),
    );
    later.startedAtMicros = 3_600_000;
    later.endedAtMicros = 3_600_001;
    later.terminalDelivery.canonicalRevision = 9;
    later.terminalDelivery.canonicalStateHash = "fedcba9876543210";
    candidate.push(later);
  }, "later-enqueue");
  reject((candidate) => {
    const closed = structuredClone(
      candidate.find(({ operation }) => operation === "terminal-delivery-subscriber-lifecycle"),
    );
    closed.terminalDelivery.deliveryLifecycleEvent = "close";
    closed.terminalDelivery.deliveryLifecycleOrdinal = 2;
    closed.startedAtMicros = 3_700_000;
    closed.endedAtMicros = 3_700_000;
    const replacement = structuredClone(closed);
    replacement.terminalDelivery.deliveryLifecycleEvent = "open";
    replacement.terminalDelivery.deliveryLifecycleOrdinal = 3;
    replacement.terminalDelivery.deliveryLaneId = "opentui:42:lane-2";
    replacement.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000011";
    replacement.startedAtMicros = 3_700_001;
    replacement.endedAtMicros = 3_700_001;
    candidate.push(closed, replacement);
  }, "topology-not-exact");
});

test("derives strict Web grid work from qualified presentation evidence, never mode fields", () => {
  const driven = (gridRowsRead, mode = {}) => ({
    qualified: true,
    stage: { canonicalRows: 41, canonicalCols: 132 },
    raw: { mode, presentation: { gridRowsRead } },
    sample: { presentation: { gridRowsRead } },
  });
  for (const [stage, rows, expectedRows, expectedFullWalks] of [
    ["normal", 40, 40, 0],
    ["rich", 3, 3, 0],
    ["cursor-only", 0, 0, 0],
    ["alternate", 40, 41, 1],
    ["restored", 40, 41, 1],
  ]) {
    const withoutModeRows = ansiWebExpectedGridProjection(stage, driven(rows));
    assert.deepEqual(withoutModeRows, {
      exact: true,
      reason: null,
      canonicalRows: 41,
      canonicalCols: 132,
      presentationRows: rows,
      gridRowsRead: expectedRows,
      gridCellsRead: expectedRows * 132,
      fullGridWalks: expectedFullWalks,
    });
    assert.deepEqual(
      ansiWebExpectedGridProjection(stage, driven(rows, { dirtyRows: Array(999).fill(0) })),
      withoutModeRows,
      "a forged canonical-mode dirtyRows field is outside the authority contract",
    );
  }
  for (const mutate of [
    (value) => delete value.raw.presentation.gridRowsRead,
    (value) => (value.raw.presentation.gridRowsRead = 1.5),
    (value) => (value.raw.presentation.gridRowsRead = -1),
    (value) => (value.raw.presentation.gridRowsRead = Number.MAX_SAFE_INTEGER),
    (value) => (value.sample.presentation.gridRowsRead = 39),
    (value) => (value.stage.canonicalCols = Number.MAX_SAFE_INTEGER),
    (value) => (value.qualified = false),
  ]) {
    const value = driven(40);
    mutate(value);
    const result = ansiWebExpectedGridProjection("normal", value);
    assert.equal(result.exact, false);
    assert.equal(JSON.stringify(result).includes("MAX_SAFE"), false);
    assert.equal(JSON.stringify(result).length < 256, true);
  }
});

test("localizes Web rendition failures with bounded keyed facts only", () => {
  const hmac = (digit) => digit.repeat(64);
  const expected = {
    positionWrappedHmac: hmac("1"),
    graphemeWidthHmac: hmac("2"),
    colorHmac: hmac("3"),
    attributesHmac: hmac("4"),
    cellHmacs: [hmac("5"), hmac("6"), hmac("7")],
    rows: [0, 1, 2],
  };
  const exact = ansiRenditionFailureLocalization(
    {
      ...expected,
      rendererCols: 132,
      rendererRows: 41,
    },
    expected,
  );
  assert.deepEqual(exact, {
    positionWrappedExact: true,
    graphemeWidthExact: true,
    colorExact: true,
    attributesExact: true,
    firstDifferenceOrdinal: null,
    firstDifferenceRow: null,
    rendererCols: 132,
    rendererRows: 41,
  });
  for (const [field, predicate] of [
    ["positionWrappedHmac", "positionWrappedExact"],
    ["graphemeWidthHmac", "graphemeWidthExact"],
    ["colorHmac", "colorExact"],
    ["attributesHmac", "attributesExact"],
  ]) {
    const localized = ansiRenditionFailureLocalization(
      { ...expected, [field]: hmac("a"), rendererCols: 132, rendererRows: 41 },
      expected,
    );
    assert.equal(localized[predicate], false);
  }
  assert.deepEqual(
    ansiRenditionFailureLocalization(
      {
        ...expected,
        positionWrappedHmac: hmac("8"),
        cellHmacs: [hmac("5"), hmac("9"), hmac("7")],
        rendererCols: Number.MAX_SAFE_INTEGER,
        rendererRows: -1,
      },
      expected,
    ),
    {
      positionWrappedExact: false,
      graphemeWidthExact: true,
      colorExact: true,
      attributesExact: true,
      firstDifferenceOrdinal: 1,
      firstDifferenceRow: 1,
      rendererCols: null,
      rendererRows: null,
    },
  );
  assert.deepEqual(
    ansiRenditionFailureLocalization(
      { ...expected, cellHmacs: ["raw-content"], rendererCols: 80, rendererRows: 24 },
      { ...expected, rows: [Number.MAX_SAFE_INTEGER, -1, 2] },
    ),
    {
      positionWrappedExact: true,
      graphemeWidthExact: true,
      colorExact: true,
      attributesExact: true,
      firstDifferenceOrdinal: 0,
      firstDifferenceRow: null,
      rendererCols: 80,
      rendererRows: 24,
    },
  );
});

test("joins one cursor-only input to one actual presentation, frame, and healthy fence", async () => {
  const evidenceKey = Buffer.alloc(32, 7);
  const common = {
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    semanticPaneId: "pane-a",
    generation: "generation-a",
    incarnation: "incarnation-a",
    revision: 8,
    stateHash: "0123456789abcdef",
  };
  const records = [
    {
      version: 1,
      type: "performance.input-origin",
      ...common,
      revision: 7,
      stateHash: "fedcba9876543210",
      atMicros: 100,
      origin: "keyboard",
      parserConsumption: "keyboard-event",
      payloadByteCount: 1,
      traceId: "00000000-0000-4000-8000-000000000001",
    },
    {
      version: 1,
      type: "performance.terminal-canonical-mode",
      ...common,
      atMicros: 110,
      alternateScreen: false,
      cursor: { x: 4, y: 3, hidden: false, style: "bar", blink: true },
    },
    {
      version: 1,
      type: "performance.terminal-cursor-presentation",
      ...common,
      traceId: "00000000-0000-4000-8000-000000000001",
      atMicros: 120,
      cols: 80,
      rows: 25,
      sourceEpoch: 2,
      rendererEpoch: 3,
      acceptedUpdateType: "terminal.patch",
      acceptedRevision: 8,
      cursorX: 4,
      cursorY: 3,
      viewportCols: 80,
      viewportRows: 24,
      screenX: 7,
      screenY: 5,
      visible: true,
      style: "line",
      blink: true,
      gridWalked: false,
      gridRowsRead: 0,
      fullWalk: false,
      gridRowsReadTotal: 24,
      fullWalkTotal: 1,
      presentationCount: 2,
    },
    {
      version: 1,
      type: "performance.terminal-canonical-host-frame",
      ...common,
      atMicros: 130,
      cols: 80,
      rows: 25,
      viewportCols: 80,
      viewportRows: 24,
      sourceEpoch: 2,
      rendererEpoch: 3,
      acceptedUpdateType: "terminal.patch",
      acceptedRevision: 8,
    },
    {
      version: 1,
      type: "performance.terminal-frame-fence",
      ...common,
      atMicros: 140,
      daemonGeneration: "generation-a",
      cols: 80,
      rows: 25,
      viewportCols: 80,
      viewportRows: 24,
      sourceEpoch: 2,
      rendererEpoch: 3,
      acceptedUpdateType: "terminal.patch",
      acceptedRevision: 8,
      writerHealth: {
        droppedRecords: 0,
        oversizedRecords: 0,
        failed: false,
        pendingCriticalRecords: 0,
      },
    },
  ];
  const expectedStage = {
    processId: "opentui:42",
    clockId: "opentui-performance-now",
    daemonProcessId: "daemon:1",
    daemonClockId: "node-performance-now",
    deliveryWorkspaceName: "session-a",
    deliverySurfaces: ["opentui"],
    deliveryClients: { opentui: "opentui:42" },
    deliveryTopology: {
      exact: true,
      reason: null,
      lifecycleOrdinal: 1,
      lanes: [
        {
          clientId: "opentui:42",
          surface: "opentui",
          laneId: "opentui:42:lane-1",
          requestId: "00000000-0000-4000-8000-000000000010",
          purpose: "terminal-surface",
        },
      ],
    },
    semanticPaneId: "pane-a",
    canonicalGeneration: "generation-a",
    canonicalIncarnation: "incarnation-a",
    daemonGeneration: "generation-a",
    afterRevision: 7,
    priorStateHash: "fedcba9876543210",
    action: "cursor-next",
    alternateScreen: false,
    sourceEpoch: 2,
    rendererEpoch: 3,
    canonicalCols: 80,
    canonicalRows: 25,
    viewportCols: 80,
    viewportRows: 24,
    screenOffsetX: 2,
    screenOffsetY: 1,
    gridWalked: false,
    gridRowsRead: 0,
    fullWalk: false,
    framebufferHmac: null,
    framebufferCellCount: null,
    framebufferWideContinuationCount: null,
    framebufferCombiningCount: null,
    framebufferStyledCellCount: null,
    previousCounters: { gridRowsReadTotal: 24, fullWalkTotal: 1, presentationCount: 1 },
  };
  const joined = ansiCursorStageFromRecords({
    records,
    daemonRecords: daemonTrace(common.traceId ?? records[0].traceId),
    expected: expectedStage,
    evidenceKey,
  });
  assert.equal(joined.qualified, true);
  assert.equal(
    ansiCursorStageFromRecords({
      records,
      daemonRecords: daemonTrace(records[0].traceId),
      expected: { ...expectedStage, action: "not-an-action" },
      evidenceKey,
    }).firstFailedPredicate,
    "actionExact",
  );
  assert.equal(joined.sample.durationMicros, 40);
  assert.deepEqual(joined.sample.causal.dirtyRows, []);
  assert.equal(joined.sample.presentation.gridWalked, false);
  assert.equal(joined.sample.presentation.gridRowsRead, 0);
  assert.equal(joined.sample.presentation.fullWalk, false);
  assert.equal(joined.sample.frame.viewportRows, 24);
  assert.equal(joined.sample.fence.viewportRows, 24);
  assert.deepEqual(joined.daemonEvidence, {
    stageCountVector: Array(11).fill(1),
    deliveryLaneCount: 1,
    deliveryTopologyExact: true,
    cardinalityExact: true,
    deliveryFanoutExact: true,
    processExact: true,
    clockExact: true,
    clockKindExact: true,
    authorityClassMaskExact: true,
    timestampExact: true,
    scenarioExact: true,
    orderExact: true,
    firstFailedDaemonPredicate: null,
  });
  assert.deepEqual(joined.stageEvidence, {
    modeCandidateCount: 1,
    presentationCandidateCount: 1,
    frameCandidateCount: 1,
    fenceCandidateCount: 1,
    tracedCandidateExact: true,
    finalAlternateScreen: false,
    finalCursorVisible: true,
    finalCursorBlink: true,
    firstFailedStageSubpredicate: null,
  });
  const restoreRecords = structuredClone(records);
  restoreRecords[1].cursor = { x: 0, y: 1, hidden: false, style: "block", blink: false };
  Object.assign(restoreRecords[2], {
    cursorX: 0,
    cursorY: 1,
    screenX: 3,
    screenY: 3,
    style: "block",
    blink: false,
    gridWalked: true,
    gridRowsRead: 24,
    fullWalk: false,
    gridRowsReadTotal: 48,
  });
  const restoreResult = ansiCursorStageFromRecords({
    records: restoreRecords,
    daemonRecords: daemonTrace(records[0].traceId),
    expected: { ...expectedStage, gridWalked: true, gridRowsRead: 24, fullWalk: false },
    evidenceKey,
  });
  assert.equal(restoreResult.qualified, true);
  assert.equal(restoreResult.sample.presentation.gridRowsRead, 24);
  assert.equal(restoreResult.sample.presentation.fullWalk, false);
  assert.deepEqual(restoreResult.stage.cursor, {
    x: 0,
    y: 1,
    hidden: false,
    style: "block",
    blink: false,
  });
  const splitRestore = structuredClone(records);
  splitRestore.push(
    { ...structuredClone(records[1]), revision: 9, stateHash: "1111111111111111" },
    {
      ...structuredClone(records[2]),
      traceId: null,
      revision: 9,
      stateHash: "1111111111111111",
    },
    { ...structuredClone(records[3]), revision: 9, stateHash: "1111111111111111" },
    { ...structuredClone(records[4]), revision: 9, stateHash: "1111111111111111" },
  );
  const splitResult = ansiCursorStageFromRecords({
    records: splitRestore,
    daemonRecords: daemonTrace(records[0].traceId),
    expected: expectedStage,
    evidenceKey,
  });
  assert.equal(splitResult.firstFailedPredicate, "modeExact");
  assert.deepEqual(
    {
      mode: splitResult.stageEvidence.modeCandidateCount,
      presentation: splitResult.stageEvidence.presentationCandidateCount,
      frame: splitResult.stageEvidence.frameCandidateCount,
      fence: splitResult.stageEvidence.fenceCandidateCount,
      first: splitResult.stageEvidence.firstFailedStageSubpredicate,
    },
    {
      mode: 2,
      presentation: 2,
      frame: 2,
      fence: 2,
      first: "modeCardinalityExact",
    },
  );
  for (const mutate of [
    (value) => value.splice(2, 0, structuredClone(value[2])),
    (value) => (value[2].traceId = "00000000-0000-4000-8000-000000000002"),
    (value) => (value[0].stateHash = "F".repeat(16)),
    (value) => (value[0].stateHash = "f".repeat(64)),
    (value) => (value[1].stateHash = "A".repeat(16)),
    (value) => (value[2].gridWalked = true),
    (value) => (value[2].gridRowsReadTotal += 1),
    (value) => (value[2].gridRowsRead = 1),
    (value) => (value[2].fullWalk = true),
    (value) => (value[2].viewportRows += 1),
    (value) => (value[2].screenX += 1),
    (value) => (value[2].screenY += 1),
    (value) => (value[2].presentationCount += 1),
    (value) => (value[2].sourceEpoch += 1),
    (value) => (value[2].stateHash = "state-b"),
    (value) => (value[3].clockKind = "date-now"),
    (value) => delete value[3].acceptedUpdateType,
    (value) => (value[3].acceptedRevision = 9),
    (value) => (value[3].viewportCols = 79),
    (value) => (value[3].viewportRows = 23),
    (value) => (value[4].sourceEpoch += 1),
    (value) => (value[4].acceptedUpdateType = "terminal.seed"),
    (value) => (value[4].acceptedRevision = 9),
    (value) => (value[4].viewportCols = 79),
    (value) => (value[4].viewportRows = 23),
    (value) => (value[4].writerHealth.droppedRecords = 1),
    (value) => ([value[2], value[3]] = [value[3], value[2]]),
  ]) {
    const malformed = structuredClone(records);
    mutate(malformed);
    assert.equal(
      ansiCursorStageFromRecords({
        records: malformed,
        daemonRecords: daemonTrace(records[0].traceId),
        expected: expectedStage,
        evidenceKey,
      }).qualified,
      false,
    );
  }

  for (const traceId of [
    "00000000-0000-3000-8000-000000000001",
    "00000000-0000-4000-7000-000000000001",
    "00000000-0000-4000-8000-00000000000A",
    "0".repeat(64),
  ]) {
    const malformed = structuredClone(records);
    malformed[0].traceId = traceId;
    assert.equal(
      ansiCursorStageFromRecords({
        records: malformed,
        daemonRecords: daemonTrace(traceId),
        expected: expectedStage,
        evidenceKey,
      }).qualified,
      false,
    );
  }
  for (const malformedState of ["A".repeat(16), "a".repeat(64), "short"]) {
    const malformed = structuredClone(records);
    const malformedExpected = structuredClone(expectedStage);
    malformed[0].stateHash = malformedState;
    malformedExpected.priorStateHash = malformedState;
    assert.equal(
      ansiCursorStageFromRecords({
        records: malformed,
        daemonRecords: daemonTrace(records[0].traceId),
        expected: malformedExpected,
        evidenceKey,
      }).qualified,
      false,
    );
  }

  for (const mutate of [
    (value) => (value[0].processId = "daemon:2"),
    (value) => (value[0].clockId = "wall"),
    (value) => (value[0].clockKind = "date-now"),
    (value) => (value[0].authority.generation = "generation-b"),
    (value) => (value[0].authority.incarnation = "incarnation-b"),
    (value) => (value[0].endedAtMicros = value[1].startedAtMicros + 1),
    (value) => (value[1].endedAtMicros = 500),
    (value) => (value[2].authority.incarnation = "incarnation-a"),
    (value) => (value[3].authority.incarnation = "incarnation-a"),
    (value) => (value[4].authority.incarnation = "incarnation-a"),
    (value) => (value[5].authority.incarnation = null),
    (value) => (value[5].authority.incarnation = "incarnation-stale"),
    (value) => (value[3].startedAtMicros = value[2].endedAtMicros - 1),
    (value) => (value[4].startedAtMicros = value[3].endedAtMicros - 1),
    (value) => (value[5].startedAtMicros = value[4].endedAtMicros - 1),
    (value) => (value[6].startedAtMicros = value[5].endedAtMicros - 1),
    (value) => (value[7].startedAtMicros = value[6].endedAtMicros - 1),
    (value) => (value[8].startedAtMicros = value[7].endedAtMicros - 1),
    (value) => (value[9].startedAtMicros = value[8].endedAtMicros - 1),
  ]) {
    const daemonRecords = daemonTrace(records[0].traceId);
    mutate(daemonRecords);
    assert.equal(
      ansiCursorStageFromRecords({ records, daemonRecords, expected: expectedStage, evidenceKey })
        .qualified,
      false,
    );
  }
  for (const [expectedFailure, mutate] of [
    ["cardinalityExact", (value) => value.push(structuredClone(value[0]))],
    ["processExact", (value) => (value[0].processId = "daemon:2")],
    ["clockExact", (value) => (value[0].clockId = "daemon-other")],
    ["clockKindExact", (value) => (value[0].clockKind = "date-now")],
    ["authorityClassMaskExact", (value) => (value[2].authority.incarnation = "incarnation-a")],
    ["timestampExact", (value) => (value[2].endedAtMicros = value[2].startedAtMicros - 1)],
    ["scenarioExact", (value) => (value[0].scenario = "other")],
    ["orderExact", (value) => (value[3].startedAtMicros = value[2].endedAtMicros - 1)],
  ]) {
    const daemonRecords = daemonTrace(records[0].traceId);
    mutate(daemonRecords);
    const result = ansiCursorStageFromRecords({
      records,
      daemonRecords,
      expected: expectedStage,
      evidenceKey,
    });
    assert.equal(result.firstFailedPredicate, "daemonExact", expectedFailure);
    assert.equal(result.daemonEvidence.firstFailedDaemonPredicate, expectedFailure);
    assert.equal(result.daemonEvidence.stageCountVector.length, 11);
  }
  for (const processId of [undefined, "", "daemon:0", "daemon:not-a-pid", "opentui:42"]) {
    const daemonRecords = daemonTrace(records[0].traceId).map((record) => ({
      ...record,
      processId:
        record.operation === "terminal-delivery-subscriber-lifecycle" ? "daemon:1" : processId,
    }));
    const result = ansiCursorStageFromRecords({
      records,
      daemonRecords,
      expected: expectedStage,
      evidenceKey,
    });
    assert.equal(result.daemonEvidence.firstFailedDaemonPredicate, "processExact");
  }
  const webFanout = daemonTrace(records[0].traceId);
  for (const [offset, source] of webFanout
    .filter((record) =>
      new Set([
        "terminal-delivery-encode-enqueue",
        "pane-stream-socket-send",
        "terminal-delivery-settled",
      ]).has(record.operation),
    )
    .entries()) {
    webFanout.push({
      ...structuredClone(source),
      startedAtMicros: 18 + offset * 2,
      endedAtMicros: 19 + offset * 2,
      terminalDelivery: {
        ...source.terminalDelivery,
        deliveryClientId: "web:1",
        deliverySurface: "web",
        deliveryLaneId: "web:1:lane-1",
        deliveryRequestId: "00000000-0000-4000-8000-000000000011",
        deliveryNonce: "nonce-web",
        transactionId: "transaction-web",
        deliveryOrdinal: 2,
      },
    });
  }
  webFanout.push({
    ...structuredClone(webFanout.find((record) => record.operation.includes("subscriber"))),
    terminalDelivery: {
      ...structuredClone(webFanout.find((record) => record.operation.includes("subscriber")))
        .terminalDelivery,
      deliveryClientId: "web:1",
      deliverySurface: "web",
      deliveryLaneId: "web:1:lane-1",
      deliveryRequestId: "00000000-0000-4000-8000-000000000011",
      deliveryLifecycleOrdinal: 2,
    },
  });
  const webExpected = {
    ...expectedStage,
    deliverySurfaces: ["opentui", "web"],
    deliveryClients: { opentui: "opentui:42", web: "web:1" },
    deliveryTopology: {
      exact: true,
      reason: null,
      lifecycleOrdinal: 2,
      lanes: [
        {
          clientId: "opentui:42",
          surface: "opentui",
          laneId: "opentui:42:lane-1",
          requestId: "00000000-0000-4000-8000-000000000010",
          purpose: "terminal-surface",
        },
        {
          clientId: "web:1",
          surface: "web",
          laneId: "web:1:lane-1",
          requestId: "00000000-0000-4000-8000-000000000011",
          purpose: "terminal-surface",
        },
      ],
    },
  };
  const webDeliveryRecords = (value) =>
    value.filter(
      (record) =>
        record.terminalDelivery?.deliverySurface === "web" &&
        record.operation !== "terminal-delivery-subscriber-lifecycle",
    );
  assert.equal(
    ansiCursorStageFromRecords({
      records,
      daemonRecords: webFanout,
      expected: webExpected,
      evidenceKey,
    }).qualified,
    true,
  );
  const reconnectFanout = structuredClone(webFanout);
  for (const [offset, source] of webDeliveryRecords(reconnectFanout).entries()) {
    reconnectFanout.push({
      ...structuredClone(source),
      startedAtMicros: 24 + offset * 2,
      endedAtMicros: 25 + offset * 2,
      terminalDelivery: {
        ...source.terminalDelivery,
        deliveryLaneId: "web:1:lane-2",
        deliveryRequestId: "00000000-0000-4000-8000-000000000012",
        deliveryNonce: "nonce-web-reconnect",
        transactionId: "transaction-web-reconnect",
        deliveryOrdinal: 3,
      },
    });
  }
  const reconnectLifecycle = structuredClone(
    reconnectFanout.findLast((record) => record.operation.includes("subscriber")),
  );
  reconnectLifecycle.terminalDelivery.deliveryLaneId = "web:1:lane-2";
  reconnectLifecycle.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000012";
  reconnectLifecycle.terminalDelivery.deliveryLifecycleOrdinal = 3;
  reconnectFanout.push(reconnectLifecycle);
  const reconnectExpected = structuredClone(webExpected);
  reconnectExpected.deliveryTopology.lifecycleOrdinal = 3;
  reconnectExpected.deliveryTopology.lanes.push({
    clientId: "web:1",
    surface: "web",
    laneId: "web:1:lane-2",
    requestId: "00000000-0000-4000-8000-000000000012",
    purpose: "terminal-surface",
  });
  const predecessorCatchup = reconnectFanout
    .filter(
      (record) =>
        record.operation === "terminal-delivery-subscriber-lifecycle" ||
        new Set([
          "terminal-delivery-encode-enqueue",
          "pane-stream-socket-send",
          "terminal-delivery-settled",
        ]).has(record.operation),
    )
    .map((record) => {
      const predecessorRecord = structuredClone(record);
      predecessorRecord.traceId = null;
      predecessorRecord.terminalDelivery.canonicalRevision = 7;
      predecessorRecord.terminalDelivery.canonicalStateHash = "fedcba9876543210";
      if (record.operation !== "terminal-delivery-subscriber-lifecycle") {
        predecessorRecord.startedAtMicros += 3_200_000;
        predecessorRecord.endedAtMicros += 3_200_000;
        if (
          record.operation === "terminal-delivery-encode-enqueue" &&
          record.terminalDelivery.deliveryLaneId === "web:1:lane-2"
        ) {
          predecessorRecord.terminalDelivery.representation = "seed";
          predecessorRecord.terminalDelivery.representationBytes = 2_190_000;
        }
      }
      return predecessorRecord;
    });
  for (const [statusOrdinal, lane] of reconnectExpected.deliveryTopology.lanes.entries()) {
    const status = structuredClone(
      predecessorCatchup.find(
        (record) =>
          record.operation === "terminal-delivery-subscriber-lifecycle" &&
          record.terminalDelivery.deliveryLaneId === lane.laneId,
      ),
    );
    status.operation = "terminal-delivery-subscriber-status";
    status.startedAtMicros = 3_500_000 + statusOrdinal;
    status.endedAtMicros = status.startedAtMicros;
    Object.assign(status.terminalDelivery, {
      deliveryPurpose: "terminal-surface",
      deliveryStatusOrdinal: statusOrdinal + 1,
      deliveryVisibility: "visible",
      deliveryBaselineRevision: 7,
      deliveryBaselineHash: "fedcba9876543210",
      deliveryInFlightRevision: null,
      deliveryInFlightHash: null,
      deliveryLatestRevision: null,
      deliveryClientQueueDepth: 0,
    });
    predecessorCatchup.push(status);
  }
  const readinessExpected = {
    deliveryWorkspaceName: "session-a",
    semanticPaneId: "pane-a",
    canonicalGeneration: "generation-a",
    canonicalIncarnation: "incarnation-a",
    daemonProcessId: "daemon:1",
    daemonClockId: "node-performance-now",
    deliveryClients: reconnectExpected.deliveryClients,
    predecessorRevision: 7,
    predecessorStateHash: "fedcba9876543210",
  };
  let watermarkAdvances = 0;
  let inputOperations = 0;
  const hungCatchup = predecessorCatchup.filter(
    (record) =>
      !(
        record.operation === "terminal-delivery-settled" &&
        record.terminalDelivery.deliveryLaneId === "web:1:lane-2"
      ) &&
      !(
        record.operation === "terminal-delivery-subscriber-status" &&
        record.terminalDelivery.deliveryLaneId === "web:1:lane-2"
      ),
  );
  let hungNowMs = 0;
  const hungAction = await runAnsiDeliveryReadyAction({
    readRecords: () => hungCatchup,
    now: () => hungNowMs,
    sleep: async (milliseconds) => {
      hungNowMs += milliseconds;
    },
    expected: readinessExpected,
    takeWatermark: async () => ++watermarkAdvances,
    driveInput: async () => ++inputOperations,
  });
  assert.equal(hungAction.qualified, false);
  assert.equal(hungNowMs, 60_000);
  assert.deepEqual(
    { watermarkAdvances, inputOperations },
    { watermarkAdvances: 0, inputOperations: 0 },
  );
  const replacementBeforeInput = structuredClone(predecessorCatchup);
  const replacementClose = structuredClone(
    replacementBeforeInput.findLast(
      (record) =>
        record.operation === "terminal-delivery-subscriber-lifecycle" &&
        record.terminalDelivery.deliveryLaneId === "web:1:lane-2",
    ),
  );
  replacementClose.terminalDelivery.deliveryLifecycleEvent = "close";
  replacementClose.terminalDelivery.deliveryLifecycleOrdinal = 4;
  const replacementOpen = structuredClone(replacementClose);
  replacementOpen.terminalDelivery.deliveryLifecycleEvent = "open";
  replacementOpen.terminalDelivery.deliveryLifecycleOrdinal = 5;
  replacementOpen.terminalDelivery.deliveryLaneId = "web:1:lane-3";
  replacementOpen.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000013";
  replacementBeforeInput.push(replacementClose, replacementOpen);
  const finalCatchup = structuredClone(replacementBeforeInput);
  for (const [offset, source] of predecessorCatchup
    .filter(
      (record) =>
        record.terminalDelivery?.deliveryLaneId === "web:1:lane-2" &&
        new Set([
          "terminal-delivery-encode-enqueue",
          "pane-stream-socket-send",
          "terminal-delivery-settled",
        ]).has(record.operation),
    )
    .entries()) {
    const lane3 = structuredClone(source);
    lane3.startedAtMicros = 3_600_000 + offset * 2;
    lane3.endedAtMicros = lane3.startedAtMicros + 1;
    Object.assign(lane3.terminalDelivery, {
      deliveryLaneId: "web:1:lane-3",
      deliveryRequestId: "00000000-0000-4000-8000-000000000013",
      deliveryNonce: "nonce-web-current",
      transactionId: "transaction-web-current",
      deliveryOrdinal: 4,
    });
    finalCatchup.push(lane3);
  }
  const lane3Status = structuredClone(
    predecessorCatchup.find(
      (record) =>
        record.operation === "terminal-delivery-subscriber-status" &&
        record.terminalDelivery.deliveryLaneId === "web:1:lane-2",
    ),
  );
  lane3Status.startedAtMicros = 3_600_010;
  lane3Status.endedAtMicros = 3_600_010;
  Object.assign(lane3Status.terminalDelivery, {
    deliveryLaneId: "web:1:lane-3",
    deliveryRequestId: "00000000-0000-4000-8000-000000000013",
    deliveryStatusOrdinal: 4,
  });
  finalCatchup.push(lane3Status);
  let nowMs = 0;
  const readinessAction = await runAnsiDeliveryReadyAction({
    readRecords: () => {
      if (nowMs < 3_200) return hungCatchup;
      if (nowMs < 3_220) return predecessorCatchup;
      if (nowMs < 3_300) return replacementBeforeInput;
      return finalCatchup;
    },
    now: () => nowMs,
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
      if (nowMs === 3_100 || nowMs === 3_250)
        assert.deepEqual(
          { watermarkAdvances, inputOperations },
          { watermarkAdvances: 0, inputOperations: 0 },
        );
    },
    expected: readinessExpected,
    takeWatermark: async () => ++watermarkAdvances,
    driveInput: async () => ++inputOperations,
  });
  assert.equal(readinessAction.qualified, true);
  assert.equal(nowMs, 3_340, "replacement restarts the exact 40ms stable interval");
  assert.equal(readinessAction.topology.lifecycleOrdinal, 5);
  assert.deepEqual(
    { watermarkAdvances, inputOperations },
    { watermarkAdvances: 1, inputOperations: 1 },
  );
  const currentFanout = structuredClone(reconnectFanout);
  for (const record of currentFanout.filter(
    (candidate) =>
      candidate.terminalDelivery?.deliveryLaneId === "web:1:lane-2" &&
      candidate.operation !== "terminal-delivery-subscriber-lifecycle",
  )) {
    record.terminalDelivery.deliveryLaneId = "web:1:lane-3";
    record.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000013";
  }
  currentFanout.push(replacementClose, replacementOpen);
  const currentExpected = structuredClone(reconnectExpected);
  currentExpected.deliveryTopology.lifecycleOrdinal = 5;
  currentExpected.deliveryTopology.lanes.at(-1).laneId = "web:1:lane-3";
  currentExpected.deliveryTopology.lanes.at(-1).requestId = "00000000-0000-4000-8000-000000000013";
  assert.equal(
    ansiCursorStageFromRecords({
      records,
      daemonRecords: currentFanout,
      expected: currentExpected,
      evidenceKey,
    }).qualified,
    true,
    "overlapping replacement terminal lanes for one exact Web client are explicit fanout",
  );
  assert.deepEqual(
    { watermarkAdvances, inputOperations },
    { watermarkAdvances: 1, inputOperations: 1 },
  );
  for (const operation of [
    "terminal-delivery-encode-enqueue",
    "pane-stream-socket-send",
    "terminal-delivery-settled",
  ])
    assert.equal(
      currentFanout.filter((record) => record.operation === operation).length,
      3,
      `${operation} remains exact across all three active lanes`,
    );
  const stageDeliveryTimes = currentFanout
    .filter((record) =>
      new Set([
        "terminal-delivery-encode-enqueue",
        "pane-stream-socket-send",
        "terminal-delivery-settled",
      ]).has(record.operation),
    )
    .flatMap((record) => [record.startedAtMicros, record.endedAtMicros]);
  assert.ok(Math.max(...stageDeliveryTimes) - Math.min(...stageDeliveryTimes) < 3_000_000);
  const unrelatedSibling = structuredClone(webFanout);
  unrelatedSibling.push(
    ...webFanout
      .filter(
        (record) =>
          record.terminalDelivery?.deliverySurface === "web" &&
          record.operation !== "terminal-delivery-subscriber-lifecycle",
      )
      .map((record) => ({
        ...structuredClone(record),
        terminalDelivery: { ...record.terminalDelivery, workspaceName: "other-session" },
      })),
  );
  assert.equal(
    ansiCursorStageFromRecords({
      records,
      daemonRecords: unrelatedSibling,
      expected: webExpected,
      evidenceKey,
    }).qualified,
    true,
  );
  for (const mutate of [
    (value) => value.push(structuredClone(webDeliveryRecords(value).at(-1))),
    (value) => (webDeliveryRecords(value).at(-1).terminalDelivery.deliveryLaneId = "wrong-lane"),
    (value) =>
      (webDeliveryRecords(value).at(-1).terminalDelivery.deliveryClientId = "wrong-client"),
    (value) => (webDeliveryRecords(value).at(-1).terminalDelivery.deliveryNonce = "wrong-nonce"),
    (value) =>
      (webDeliveryRecords(value).at(-1).terminalDelivery.transactionId = "wrong-transaction"),
    (value) => {
      for (const record of webDeliveryRecords(value))
        record.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000013";
    },
    (value) => {
      const opentui = value.filter(
        (record) =>
          record.terminalDelivery?.deliverySurface === "opentui" &&
          record.operation !== "terminal-delivery-subscriber-lifecycle",
      );
      const web = webDeliveryRecords(value);
      for (const record of opentui) {
        record.terminalDelivery.deliveryClientId = "web:1";
        record.terminalDelivery.deliverySurface = "web";
        record.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000011";
      }
      for (const record of web) {
        record.terminalDelivery.deliveryClientId = "opentui:42";
        record.terminalDelivery.deliverySurface = "opentui";
        record.terminalDelivery.deliveryRequestId = "00000000-0000-4000-8000-000000000010";
      }
    },
    (value) => (webDeliveryRecords(value).at(-1).terminalDelivery.canonicalRevision = 9),
    (value) =>
      (webDeliveryRecords(value).at(-1).terminalDelivery.canonicalStateHash = "1111111111111111"),
    (value) => (webDeliveryRecords(value).at(-1).terminalDelivery.workspaceName = "other-session"),
    (value) => (webDeliveryRecords(value).at(-1).terminalDelivery.semanticPaneId = "pane-b"),
    (value) => (webDeliveryRecords(value).at(-1).processId = "daemon:2"),
    (value) => (webDeliveryRecords(value).at(-1).clockId = "other-clock"),
    (value) => (webDeliveryRecords(value).at(-1).clockKind = "date-now"),
    (value) => {
      for (const record of webDeliveryRecords(value)) {
        record.terminalDelivery.deliveryClientId = "opentui:42";
        record.terminalDelivery.deliveryLaneId = "opentui:42:lane-1";
        record.terminalDelivery.deliveryNonce = "nonce-a";
        record.terminalDelivery.transactionId = "transaction-a";
        record.terminalDelivery.deliveryOrdinal = 1;
      }
    },
    (value) => (webDeliveryRecords(value)[1].terminalDelivery.deliveryOrdinal = 3),
    (value) =>
      (value.findLast((record) =>
        record.operation.includes("subscriber"),
      ).terminalDelivery.deliveryPurpose = "mirror"),
    (value) => {
      const lifecycle = structuredClone(
        value.findLast((record) => record.operation.includes("subscriber")),
      );
      lifecycle.terminalDelivery.deliveryLifecycleEvent = "close";
      lifecycle.terminalDelivery.deliveryLifecycleOrdinal = 3;
      value.push(lifecycle);
    },
    (value) => {
      const lifecycle = structuredClone(
        value.findLast((record) => record.operation.includes("subscriber")),
      );
      lifecycle.terminalDelivery.deliveryLaneId = "web:1:late-lane";
      lifecycle.terminalDelivery.deliveryLifecycleOrdinal = 3;
      value.push(lifecycle);
    },
  ]) {
    const malformed = structuredClone(webFanout);
    mutate(malformed);
    assert.equal(
      ansiCursorStageFromRecords({
        records,
        daemonRecords: malformed,
        expected: webExpected,
        evidenceKey,
      }).qualified,
      false,
    );
  }
  for (const clockId of [undefined, "", "performance-now", "arbitrary-clock"]) {
    const daemonRecords = daemonTrace(records[0].traceId).map((record) => ({
      ...record,
      clockId:
        record.operation === "terminal-delivery-subscriber-lifecycle"
          ? "node-performance-now"
          : clockId,
    }));
    const result = ansiCursorStageFromRecords({
      records,
      daemonRecords,
      expected: expectedStage,
      evidenceKey,
    });
    assert.equal(result.daemonEvidence.firstFailedDaemonPredicate, "clockExact");
  }
  for (const malformedExpected of [
    { ...expectedStage, daemonProcessId: "daemon:0" },
    { ...expectedStage, daemonProcessId: "opentui:42" },
    { ...expectedStage, daemonClockId: "arbitrary-clock" },
  ]) {
    const result = ansiCursorStageFromRecords({
      records,
      daemonRecords: daemonTrace(records[0].traceId),
      expected: malformedExpected,
      evidenceKey,
    });
    assert.equal(result.firstFailedPredicate, "daemonExact");
  }
  assert.equal(
    ansiCursorStageFromRecords({
      records,
      daemonRecords: null,
      expected: expectedStage,
      evidenceKey,
    }).qualified,
    false,
  );
  const sourceShaped = daemonTrace(records[0].traceId).map((record, index) => ({
    ...record,
    ...(record.operation === "terminal-delivery-subscriber-lifecycle"
      ? {}
      : {
          startedAtMicros: [
            4031177, 4031177, 4031955, 4032186, 4032496, 4033210, 4033371, 4034379, 4041296,
            4043055, 4043132,
          ][index],
          endedAtMicros: [
            4031177, 4031177, 4032051, 4032228, 4032496, 4033210, 4034328, 4036895, 4042931,
            4043131, 4043132,
          ][index],
        }),
  }));
  assert.equal(
    ansiCursorStageFromRecords({
      records,
      daemonRecords: sourceShaped,
      expected: expectedStage,
      evidenceKey,
    }).qualified,
    true,
  );

  const framebufferHmac = hmac(42);
  const fullRecords = structuredClone(records);
  fullRecords[2].gridWalked = true;
  fullRecords[2].gridRowsRead = 24;
  fullRecords[2].fullWalk = true;
  fullRecords[2].gridRowsReadTotal = 48;
  fullRecords[2].fullWalkTotal = 2;
  fullRecords.splice(2, 0, {
    version: 1,
    type: "performance.terminal-framebuffer-projection",
    ...common,
    traceId: records[0].traceId,
    atMicros: 115,
    cols: 80,
    rows: 25,
    sourceEpoch: 2,
    rendererEpoch: 3,
    cellCount: 16,
    wideContinuationCount: 1,
    combiningCount: 1,
    styledCellCount: 16,
    projectionHmac: framebufferHmac,
  });
  const fullExpected = {
    ...expectedStage,
    gridWalked: true,
    gridRowsRead: 24,
    fullWalk: true,
    framebufferHmac,
    framebufferCellCount: 16,
    framebufferWideContinuationCount: 1,
    framebufferCombiningCount: 1,
    framebufferStyledCellCount: 16,
  };
  assert.equal(
    ansiCursorStageFromRecords({
      records: fullRecords,
      daemonRecords: daemonTrace(records[0].traceId),
      expected: fullExpected,
      evidenceKey,
    }).qualified,
    true,
  );
  const wrongProjection = structuredClone(fullRecords);
  wrongProjection[2].projectionHmac = hmac(43);
  assert.equal(
    ansiCursorStageFromRecords({
      records: wrongProjection,
      daemonRecords: daemonTrace(records[0].traceId),
      expected: fullExpected,
      evidenceKey,
    }).qualified,
    false,
  );
});

const hmac = (ordinal) => ordinal.toString(16).padStart(64, "0");

test("ANSI absolute caps are the validated central reference budgets", () => {
  const budgets = JSON.parse(
    readFileSync(new URL("../../performance/reference-budgets.json", import.meta.url), "utf8"),
  );
  assert.equal(TUI_RSS_ABSOLUTE_CEILING_BYTES, budgets.memory.rssAbsoluteCeilingBytes);
  assert.equal(TUI_HEAP_ABSOLUTE_CEILING_BYTES, budgets.memory.heapAbsoluteCeilingBytes);
  assert.deepEqual(REFERENCE_EVENT_LOOP_BUDGET, budgets.eventLoop);
  assert.deepEqual(REFERENCE_CURSOR_PRESENTATION_BUDGET, budgets.cursorPresentation);
  assert.equal(ANSI_TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS, 33_000);
  assert.equal(ANSI_TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS, 100_000);
  assert.equal(ANSI_CURSOR_P99_BUDGET_MICROS, 33_000);
  const workloadMigration = structuredClone(budgets);
  workloadMigration.eventLoop.workloadP99CeilingMs = 60;
  assert.equal(workloadMigration.cursorPresentation.p99CeilingMicros, 33_000);
});

test("event-loop current and generation-sticky peak ceilings have exact inclusive boundaries", () => {
  for (const eventLoopDelayPeakMicros of [99_999, 100_000])
    assert.equal(
      ansiEventLoopResourceCapStatus({
        eventLoopDelayMicros: 33_000,
        eventLoopDelayPeakMicros,
      }),
      null,
    );
  assert.equal(
    ansiEventLoopResourceCapStatus({
      eventLoopDelayMicros: 33_000,
      eventLoopDelayPeakMicros: 100_001,
    }),
    "event-loop-cap",
  );
  assert.equal(
    ansiEventLoopResourceCapStatus({
      eventLoopDelayMicros: 33_001,
      eventLoopDelayPeakMicros: 100_000,
    }),
    "event-loop-current-cap",
  );
});

test("resource failure facts distinguish exact, saturated, and unavailable values", () => {
  assert.deepEqual(
    boundedAnsiResourceFailureFacts({
      rssBytes: 100,
      heapUsedBytes: 50,
      eventLoopDelayMicros: 1_000,
    }),
    {
      rssBytes: 100,
      rssAtLeastBytes: null,
      rssSizeCapped: false,
      heapBytes: 50,
      heapAtLeastBytes: null,
      heapSizeCapped: false,
      eventLoopDelayMicros: 1_000,
      eventLoopDelayAtLeastMicros: null,
      eventLoopDelaySizeCapped: false,
    },
  );
  assert.deepEqual(
    boundedAnsiResourceFailureFacts({
      rssBytes: 9_000_000_000,
      heapUsedBytes: 8_000_000_000,
      eventLoopDelayMicros: 70_000_000,
    }),
    {
      rssBytes: null,
      rssAtLeastBytes: 2_147_483_649,
      rssSizeCapped: true,
      heapBytes: null,
      heapAtLeastBytes: 1_073_741_825,
      heapSizeCapped: true,
      eventLoopDelayMicros: null,
      eventLoopDelayAtLeastMicros: 60_000_001,
      eventLoopDelaySizeCapped: true,
    },
  );
  assert.equal(
    Object.values(
      boundedAnsiResourceFailureFacts({
        rssBytes: -1,
        heapUsedBytes: Number.NaN,
        eventLoopDelayMicros: null,
      }),
    ).every((value) => value === null),
    true,
  );
  assert.deepEqual(
    boundedAnsiResourcePeakFailureFacts({
      rssPeakBytes: 200,
      heapUsedPeakBytes: 100,
      eventLoopDelayPeakMicros: 60_000,
    }),
    {
      rssPeakBytes: 200,
      rssPeakAtLeastBytes: null,
      rssPeakSizeCapped: false,
      heapPeakBytes: 100,
      heapPeakAtLeastBytes: null,
      heapPeakSizeCapped: false,
      eventLoopDelayPeakMicros: 60_000,
      eventLoopDelayPeakAtLeastMicros: null,
      eventLoopDelayPeakSizeCapped: false,
    },
  );
});

test("resource epoch identity binds every frozen canonical and viewport field", () => {
  const identity = {
    processId: "opentui:1",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    semanticPaneId: "pane.a",
    generation: "11111111-1111-4111-8111-111111111111",
    incarnation: "11111111-1111-4111-8111-111111111111:0",
    revision: 1,
    stateHash: "1111111111111111",
    cols: 132,
    rows: 41,
    sourceEpoch: 1,
    rendererEpoch: 1,
    viewportCols: 132,
    viewportRows: 40,
    acceptedUpdateType: "terminal.seed",
    acceptedRevision: 1,
  };
  assert.equal(ansiResourceEpochIdentityExact(identity, { ...identity }), true);
  for (const field of Object.keys(identity)) {
    const wrong = { ...identity, [field]: `${identity[field]}-wrong` };
    assert.equal(ansiResourceEpochIdentityExact(identity, wrong), false, field);
  }
  assert.equal(ansiResourceEpochIdentityExact(identity, null), false);
});
const expected = Object.freeze({
  processHmac: hmac(900),
  clockId: "opentui-performance-now",
  clockKind: "performance-now",
  paneHmac: hmac(901),
  generationHmac: hmac(902),
  incarnationHmac: hmac(903),
});
const expectedPaneHmac = hmac(999);
const identity = (revision, presentationHmac = hmac(revision + 1)) => ({
  ...expected,
  revision,
  stateHmac: hmac(600 + revision),
  presentationHmac,
  canonicalCols: 80,
  canonicalRows: 25,
  viewportCols: 80,
  viewportRows: 24,
  sourceEpoch: 2,
  rendererEpoch: 3,
});
const stage = (revision, mode, presentationHmac, counters) => ({
  ...identity(revision, presentationHmac),
  alternateScreen: mode.alternateScreen,
  cursor: { x: 4, y: 3, hidden: mode.hidden, style: mode.style, blink: mode.blink },
  framebufferHmac: hmac(800 + revision),
  framebufferCellCount: 16,
  framebufferWideContinuationCount: 1,
  framebufferCombiningCount: 1,
  framebufferStyledCellCount: 16,
  ...counters,
});
const samples = () =>
  Array.from({ length: ANSI_CURSOR_SAMPLE_COUNT }, (_, index) => {
    const ordinal = index + 1;
    const shape = 1 + (ordinal % 6);
    const presentation = {
      ...identity(10 + ordinal, hmac(100 + ordinal)),
      gridWalked: false,
      gridRowsRead: 0,
      fullWalk: false,
      gridRowsReadTotal: 27,
      fullWalkTotal: 1,
      presentationCount: 2 + ordinal,
    };
    return {
      ordinal,
      action: "cursor-next",
      traceHmac: hmac(400 + ordinal),
      gestureHmac: hmac(500 + ordinal),
      durationMicros: ordinal === 30 ? 16_000 : 8_000,
      startedAtMicros: 1_000_000 + ordinal * 20_000,
      presentedAtMicros: 1_000_000 + ordinal * 20_000 + 3_000,
      frameAtMicros: 1_000_000 + ordinal * 20_000 + 6_000,
      fenceAtMicros: 1_000_000 + ordinal * 20_000 + (ordinal === 30 ? 16_000 : 8_000),
      causal: {
        dirtyRows: [],
        gridRowsReadDelta: 0,
        fullWalkDelta: 0,
        presentationCountDelta: 1,
        inputAccepted: true,
        canonicalReceiptExact: true,
        daemonStageCount: 10,
        daemonProcessHmac: hmac(750),
        daemonClockId: "daemon-performance-now",
      },
      cursor: {
        x: 3 + (ordinal % 20) - 1,
        y: 2 + (ordinal % 8) - 1,
        hidden: false,
        canonicalStyle: shape <= 2 ? "block" : shape <= 4 ? "underline" : "bar",
        rendererStyle: shape <= 2 ? "block" : shape <= 4 ? "underline" : "line",
        blink: shape % 2 === 1,
      },
      presentation,
      frame: Object.fromEntries(
        Object.entries(presentation).filter(
          ([key]) =>
            ![
              "gridWalked",
              "gridRowsRead",
              "fullWalk",
              "gridRowsReadTotal",
              "fullWalkTotal",
              "presentationCount",
            ].includes(key),
        ),
      ),
      fence: Object.fromEntries(
        Object.entries(presentation).filter(
          ([key]) =>
            ![
              "gridWalked",
              "gridRowsRead",
              "fullWalk",
              "gridRowsReadTotal",
              "fullWalkTotal",
              "presentationCount",
            ].includes(key),
        ),
      ),
    };
  });

function web() {
  const presentations = [
    ["normal", hmac(200), hmac(210), "normal", 0, 0, false, "block", false],
    ["rich", hmac(201), hmac(211), "normal", 6, 3, false, "bar", true],
    ["cursor-only", hmac(201), hmac(212), "normal", 3, 2, false, "block", false],
    ["alternate", hmac(203), hmac(213), "alternate", 11, 7, true, "underline", false],
    ["restored", hmac(200), hmac(210), "normal", 0, 0, false, "block", false],
  ].map(
    (
      [
        name,
        domRowsHmac,
        domCursorHmac,
        activeBuffer,
        cursorX,
        cursorY,
        cursorHidden,
        cursorStyle,
        cursorBlink,
      ],
      index,
    ) => ({
      stage: name,
      semanticPaneHmac: expectedPaneHmac,
      generationHmac: expected.generationHmac,
      incarnationHmac: expected.incarnationHmac,
      stateHmac: hmac(610 + index),
      deliveryRequestHmac: hmac(640),
      renditionHmac:
        name === "restored" ? hmac(620) : name === "cursor-only" ? hmac(621) : hmac(620 + index),
      positionWrappedHmac:
        name === "restored" ? hmac(630) : name === "cursor-only" ? hmac(631) : hmac(630 + index),
      renditionCellCount:
        name === "rich" || name === "cursor-only" ? 17 : name === "alternate" ? 13 : 9,
      wideContinuationCount:
        name === "rich" || name === "cursor-only" ? 2 : name === "alternate" ? 1 : 0,
      combiningCount: name === "rich" || name === "cursor-only" ? 2 : name === "alternate" ? 1 : 0,
      styledCellCount: name === "rich" || name === "cursor-only" ? 17 : 0,
      domRowsHmac,
      domCursorHmac,
      domSemanticExact: true,
      domRowCountExact: true,
      domTextExact: true,
      domStyleExact: true,
      domFirstMismatchRow: null,
      domFirstMismatchColumn: null,
      domFirstMismatchComponent: null,
      domCursorExact: true,
      rowCount: 24,
      cursorCount: cursorHidden ? 0 : 1,
      cursorVisible: !cursorHidden,
      activeBuffer,
      cursorX,
      cursorY,
      cursorHidden,
      cursorStyle,
      cursorBlink,
      revision: index + 1,
      sourceEpoch: 1,
      rendererEpoch: 3,
      rendererCols: 80,
      rendererRows: 24,
      cols: 80,
      rows: 24,
      gridRowsRead:
        name === "cursor-only" ? 0 : name === "alternate" || name === "restored" ? 24 : 1,
      gridCellsRead:
        name === "cursor-only" ? 0 : name === "alternate" || name === "restored" ? 1_920 : 80,
      fullGridWalks: name === "alternate" || name === "restored" ? 1 : 0,
      canonicalBuffer: activeBuffer,
      canonicalCursorX: cursorX,
      canonicalCursorY: cursorY,
      canonicalCursorHidden: cursorHidden,
      canonicalCursorStyle: cursorStyle,
      canonicalCursorBlink: cursorBlink,
      stableSamples: 2,
    }),
  );
  return {
    readiness: {
      qualified: true,
      normalized: { expectedGroupCount: 1, observedTerminalCount: 1, terminalExact: true },
    },
    stableExactSamples: 2,
    presentations,
  };
}

const expectedSamples = () =>
  samples().map(({ ordinal, action, cursor, traceHmac, gestureHmac, presentation, causal }) => ({
    ordinal,
    action,
    cursor,
    traceHmac,
    gestureHmac,
    daemonProcessHmac: causal.daemonProcessHmac,
    daemonClockId: causal.daemonClockId,
    presentation: { ...presentation },
  }));

function expectedWeb() {
  return {
    semanticPaneHmac: expectedPaneHmac,
    presentations: web().presentations.map(
      ({
        generationHmac,
        incarnationHmac,
        stateHmac,
        deliveryRequestHmac,
        renditionHmac,
        positionWrappedHmac,
        renditionCellCount,
        wideContinuationCount,
        combiningCount,
        styledCellCount,
        revision,
        sourceEpoch,
        rendererEpoch,
        rendererCols,
        rendererRows,
        cols,
        rows,
        gridRowsRead,
        gridCellsRead,
        fullGridWalks,
        activeBuffer,
        cursorX,
        cursorY,
        cursorHidden,
        cursorStyle,
        cursorBlink,
      }) => ({
        generationHmac,
        incarnationHmac,
        stateHmac,
        deliveryRequestHmacs: [deliveryRequestHmac],
        renditionHmac,
        positionWrappedHmac,
        renditionCellCount,
        wideContinuationCount,
        combiningCount,
        styledCellCount,
        revision,
        sourceEpoch,
        rendererEpoch,
        rendererCols,
        rendererRows,
        cols,
        rows,
        gridRowsRead,
        gridCellsRead,
        fullGridWalks,
        activeBuffer,
        cursorX,
        cursorY,
        cursorHidden,
        cursorStyle,
        canonicalCursorStyle: cursorStyle,
        cursorBlink,
      }),
    ),
  };
}

function evidence() {
  const normalMode = { alternateScreen: false, hidden: false, style: "block", blink: false };
  const richMode = { alternateScreen: false, hidden: false, style: "bar", blink: true };
  const alternateMode = { alternateScreen: true, hidden: true, style: "underline", blink: false };
  const restoreMode = { alternateScreen: false, hidden: false, style: "block", blink: false };
  const restoreHmac = hmac(1);
  const baseline = stage(1, normalMode, hmac(1), {
    gridRowsReadTotal: 24,
    fullWalkTotal: 1,
    presentationCount: 1,
  });
  const preAlternateStage = {
    ...stage(41, normalMode, baseline.presentationHmac, {
      gridRowsReadTotal: 30,
      fullWalkTotal: 1,
      presentationCount: 33,
    }),
    stateHmac: baseline.stateHmac,
    cursor: { x: 0, y: 1, hidden: false, style: "block", blink: false },
  };
  const preAlternateIdentity = Object.fromEntries(
    Object.entries(preAlternateStage).filter(
      ([key]) =>
        ![
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
        ].includes(key),
    ),
  );
  return {
    baseline,
    rich: stage(2, richMode, hmac(2), {
      gridRowsReadTotal: 27,
      fullWalkTotal: 1,
      presentationCount: 2,
    }),
    cursorSamples: samples(),
    preAlternate: {
      stage: preAlternateStage,
      sample: {
        startedAtMicros: 2_000_000,
        presentedAtMicros: 2_003_000,
        frameAtMicros: 2_006_000,
        fenceAtMicros: 2_008_000,
        durationMicros: 8_000,
        traceHmac: hmac(541),
        gestureHmac: hmac(542),
        causal: {
          dirtyRows: [],
          gridRowsReadDelta: 3,
          fullWalkDelta: 0,
          presentationCountDelta: 1,
          inputAccepted: true,
          canonicalReceiptExact: true,
          daemonStageCount: 10,
          daemonProcessHmac: hmac(750),
          daemonClockId: "daemon-performance-now",
        },
        action: "pre-alternate-normal",
        cursor: {
          x: 0,
          y: 1,
          hidden: false,
          canonicalStyle: "block",
          rendererStyle: "block",
          blink: false,
        },
        presentation: {
          ...preAlternateIdentity,
          gridWalked: true,
          gridRowsRead: 3,
          fullWalk: false,
          gridRowsReadTotal: preAlternateStage.gridRowsReadTotal,
          fullWalkTotal: preAlternateStage.fullWalkTotal,
          presentationCount: preAlternateStage.presentationCount,
        },
        frame: { ...preAlternateIdentity },
        fence: { ...preAlternateIdentity },
      },
      cardinality: { mode: 1, presentation: 1, frame: 1, fence: 1, traced: true },
      predecessor: {
        revision: samples().at(-1).presentation.revision,
        stateHmac: samples().at(-1).presentation.stateHmac,
      },
      counters: {
        beforeGridRowsReadTotal: 27,
        afterGridRowsReadTotal: 30,
        beforeFullWalkTotal: 1,
        afterFullWalkTotal: 1,
        beforePresentationCount: 32,
        afterPresentationCount: 33,
        gridRowsReadDelta: 3,
        fullWalkDelta: 0,
        presentationCountDelta: 1,
      },
      native: {
        paneCount: 1,
        matchCount: 1,
        mappingExact: true,
        geometryExact: true,
        captureHmac: hmac(889),
      },
    },
    alternate: stage(42, alternateMode, hmac(42), {
      gridRowsReadTotal: 54,
      fullWalkTotal: 1,
      presentationCount: 34,
    }),
    restored: {
      ...stage(43, restoreMode, restoreHmac, {
        gridRowsReadTotal: 78,
        fullWalkTotal: 1,
        presentationCount: 35,
      }),
      stateHmac: baseline.stateHmac,
      cursor: { x: 0, y: 1, hidden: false, style: "block", blink: false },
      framebufferHmac: preAlternateStage.framebufferHmac,
    },
    workload: {
      cycleCount: 24,
      conditioningCycleCount: 8,
      measuredCycleCount: 16,
      bytes: 2 * 1_048_576,
      maxQueueDepth: 4,
      settledDeliveryQueueDepth: 0,
      representationCacheBytes: 1_024,
      rawJournalBytes: 2_048,
      eventLoopP99Ms: 12,
      finalityCycleCount: 24,
      markerCount: 24,
      stableTailMs: 40,
      finalityExact: true,
      drainExact: true,
      faulted: false,
      rebound: false,
    },
    workloadFinalities: Array.from({ length: 24 }, (_, index) => ({
      cycle: index + 1,
      markerHmac: hmac(1_000 + index),
      payloadBytes: Buffer.byteLength(ansiWorkloadPayload("ANSI_TEST", index + 1)),
      producerStatus: "complete",
      producerOrdinal: index + 1,
      producerPayloadHmac: hmac(1_200 + index),
      producerBackpressureCount: index % 2,
      deliveryBytes: 120_000 + index,
      representation: "patch",
      attemptedPatchBytes: 120_000 + index,
      attemptedSeedBytes: null,
      attemptedLegacyPatchBytes: null,
      attemptedLegacySeedBytes: null,
      attemptedCompactPatchBytes: 120_000 + index,
      attemptedCompactSeedBytes: null,
      selectedEncoding: "semantic-compact-v1",
      selectionStatus: "patch-preferred",
      deliveryOrdinal: index + 1,
      deliveryHmac: hmac(1_100 + index),
      originCount: 1,
      canonicalTransitionType: "terminal.patch",
      canonicalTransitionCount: 1,
      frameCount: 1,
      fenceCount: 1,
      settledCount: 1,
      markerCount: 1,
      finalCursorY: 39,
      viewportRows: 40,
      cursorVisible: true,
      queueDepth: 0,
      inFlight: 0,
      inFlightBytes: 0,
      stableTailMs: 40,
      elapsedMs: 16_954,
      noProgressElapsedMs: 454,
      progressCount: 4,
      absoluteDeadlineMs: 30_000,
      noProgressDeadlineMs: 15_000,
      laterTransitionCount: 0,
      laterEnqueueCount: 0,
      laterPaintCount: 0,
      authorityIdentityExact: true,
      finalityExact: true,
      drainExact: true,
      faulted: false,
      rebound: false,
    })),
    resourceSamples: Array.from({ length: 16 }, (_, index) => ({
      endpointOrdinal: index + 1,
      sampleOrdinal: index + 9,
      fenceHmac: hmac(300 + index),
      markerHmac: hmac(1_008 + index),
      processHmac: hmac(900),
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      atMicros: 2_000_000 + index * 20_000,
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
      daemonTraceHmac: hmac(700 + index),
      daemonProcessHmac: hmac(750),
      daemonClockId: "daemon-performance-now",
      daemonClockKind: "performance-now",
      daemonStartedAtMicros: 500_000 + index * 10_000,
      daemonEndedAtMicros: 501_000 + index * 10_000,
      representationCacheBytes: 1_024 + index,
      rawJournalBytes: 2_048 + index,
      deliveryQueueDepth: 0,
      deliveryMaxQueueDepth: 2,
      deliveryInFlight: 0,
      deliveryInFlightBytes: 0,
      rssBytes: 128 * 1_048_576 + index * 1_000,
      heapUsedBytes: 64 * 1_048_576 + index * 500,
      eventLoopDelayMicros: 1_000,
    })),
    resourceLifecycle: Array.from({ length: 26 }, (_, index) => ({
      phase: index === 0 ? "baseline" : index === 25 ? "idle" : "cycle",
      cycle: index,
      sampleOrdinal: index + 1,
      operation: index === 25 ? "idle" : "post-fence",
      resourceEpochArmed: true,
      lowWaterFirstSampleOrdinal: 1,
      lowWaterLastSampleOrdinal: index === 25 ? 1 : 8,
      lowWaterSampleCount: index === 25 ? 1 : 8,
      lowWaterWindowMicros: index === 25 ? 0 : 56_000,
      resourceEpochIdentityHmac: hmac(2_000),
      identityHmac: hmac(2_000 + index),
      stateHmac: hmac(2_100 + index),
      processHmac: hmac(900),
      clockId: "opentui-performance-now",
      clockKind: "performance-now",
      atMicros: 1_000_000 + index * 20_000,
      rssBytes: 128 * 1_048_576 + index * 1_000,
      heapUsedBytes: 64 * 1_048_576 + index * 500,
      eventLoopDelayMicros: 1_000,
      rssPeakBytes: 128 * 1_048_576 + index * 1_000,
      heapUsedPeakBytes: 64 * 1_048_576 + index * 500,
      eventLoopDelayPeakMicros: 1_000,
      eventLoopDelayPeakSource: "endpoint",
      inputPending: 0,
      inputInFlight: 0,
      inputPendingBytes: 0,
      inputPendingPeak: 0,
      inputInFlightPeak: 0,
      inputPendingBytesPeak: 0,
      resourceSamplingFailureCount: 0,
    })),
    idle: {
      durationMs: 10_100,
      frameCount: 0,
      paintCount: 0,
      gridRowsReadDelta: 0,
      fullWalkDelta: 0,
      presentationCountDelta: 0,
      framebufferHmacBefore: hmac(888),
      framebufferHmacAfter: hmac(888),
      queueDepth: 0,
      resourceExact: true,
      resourceSampleOrdinal: 32,
      resourceEpochArmed: true,
      resourceEpochIdentityHmac: hmac(2_000),
      lowWaterFirstSampleOrdinal: 1,
      lowWaterLastSampleOrdinal: 1,
      lowWaterSampleCount: 1,
      lowWaterWindowMicros: 0,
      resourceProcessHmac: hmac(900),
      resourceClockId: "opentui-performance-now",
      resourceClockKind: "performance-now",
      resourceAtMicros: 2_000_000,
      resourceIdentityHmac: hmac(2_025),
      resourceStateHmac: hmac(2_125),
      resourceInputPending: 0,
      resourceInputInFlight: 0,
      resourceInputPendingBytes: 0,
      resourceInputPendingPeak: 0,
      resourceInputInFlightPeak: 0,
      resourceInputPendingBytesPeak: 0,
      resourceSamplingFailureCount: 0,
      rssBytes: 268_435_456,
      heapUsedBytes: 67_108_864,
      eventLoopDelayMicros: 1_000,
      rssPeakBytes: 268_435_456,
      heapUsedPeakBytes: 67_108_864,
      eventLoopDelayPeakMicros: 1_000,
      eventLoopDelayPeakSource: "endpoint",
      idleRetainedSampleCount: 8,
      idleRetainedRssSlopeBytesPerSample: 1_000,
      idleRetainedHeapSlopeBytesPerSample: 500,
      idleRetainedRssGrowthBytes: 7_000,
      idleRetainedHeapGrowthBytes: 3_500,
      idleRetainedRssHighBytes: 268_435_456,
      idleRetainedHeapHighBytes: 67_108_864,
      idleRetainedFirstInvalidOrdinal: null,
      idleRetainedFirstInvalidPredicate: null,
    },
    web: web(),
    tmux: {
      paneCount: 1,
      geometryStable: true,
      markerExact: true,
      baselineCaptureHmac: hmac(889),
      alternateCaptureHmac: hmac(890),
      alternateGeometryStable: true,
      alternateMarkerAbsent: true,
      alternateCursorExact: true,
      finalCaptureHmac: hmac(889),
    },
    writer: { droppedRecords: 0, oversizedRecords: 0, failed: false, pendingCriticalRecords: 0 },
  };
}

function expectedContract() {
  const value = evidence();
  return {
    baseline: structuredClone(value.baseline),
    rich: structuredClone(value.rich),
    cursorSamples: expectedSamples(),
    preAlternate: {
      stage: structuredClone(value.preAlternate.stage),
      predecessorRevision: value.preAlternate.predecessor.revision,
      predecessorStateHmac: value.preAlternate.predecessor.stateHmac,
      presentationHmac: value.baseline.presentationHmac,
      framebufferHmac: value.preAlternate.stage.framebufferHmac,
      nativeCaptureHmac: value.tmux.baselineCaptureHmac,
      cursor: { x: 0, y: 1, hidden: false, style: "block", blink: false },
      beforeGridRowsReadTotal: value.preAlternate.counters.beforeGridRowsReadTotal,
      afterGridRowsReadTotal: value.preAlternate.counters.afterGridRowsReadTotal,
      beforeFullWalkTotal: value.preAlternate.counters.beforeFullWalkTotal,
      afterFullWalkTotal: value.preAlternate.counters.afterFullWalkTotal,
      beforePresentationCount: value.preAlternate.counters.beforePresentationCount,
      afterPresentationCount: value.preAlternate.counters.afterPresentationCount,
      gridRowsReadDelta: 3,
      fullWalkDelta: 0,
      presentationCountDelta: 1,
      daemonProcessHmac: value.preAlternate.sample.causal.daemonProcessHmac,
      daemonClockId: value.preAlternate.sample.causal.daemonClockId,
    },
    alternate: structuredClone(value.alternate),
    restored: structuredClone(value.restored),
    normalBeforeAlternateHmac: value.baseline.presentationHmac,
    workloadFinalities: value.workloadFinalities.map(
      ({ cycle, markerHmac, payloadBytes, producerPayloadHmac }) => ({
        cycle,
        markerHmac,
        payloadBytes,
        producerPayloadHmac,
      }),
    ),
    web: expectedWeb(),
    resourceSamples: value.resourceSamples.map(
      ({
        endpointOrdinal,
        sampleOrdinal,
        fenceHmac,
        markerHmac,
        processHmac,
        clockId,
        atMicros,
        daemonTraceHmac,
        daemonProcessHmac,
        daemonClockId,
      }) => ({
        endpointOrdinal,
        sampleOrdinal,
        fenceHmac,
        markerHmac,
        processHmac,
        clockId,
        fenceAtMicros: atMicros - 1_000,
        daemonTraceHmac,
        daemonProcessHmac,
        daemonClockId,
      }),
    ),
    resourceLifecycle: value.resourceLifecycle.map(
      ({
        phase,
        cycle,
        operation,
        resourceEpochIdentityHmac,
        identityHmac,
        stateHmac,
        processHmac,
        clockId,
        lowWaterFirstSampleOrdinal,
        lowWaterLastSampleOrdinal,
        lowWaterSampleCount,
      }) => ({
        phase,
        cycle,
        operation,
        resourceEpochIdentityHmac,
        identityHmac,
        stateHmac,
        processHmac,
        clockId,
        lowWaterFirstSampleOrdinal,
        lowWaterLastSampleOrdinal,
        lowWaterSampleCount,
      }),
    ),
  };
}

test("qualifies an exact 30-sample integer-micros cursor distribution", () => {
  const result = assessAnsiCursorPresentationSamples(samples(), expectedSamples());
  assert.equal(result.qualified, true);
  assert.equal(result.p95Micros, 8_000);
  assert.equal(result.p99Micros, 16_000);
});

test("uses only 16 exact post-fence quiescent resource endpoints", () => {
  const value = evidence().resourceSamples;
  const expectedResources = expectedContract().resourceSamples;
  assert.equal(assessAnsiQuiescentResourceSamples(value, expectedResources).qualified, true);
  const currentBoundary = structuredClone(value);
  currentBoundary[2].eventLoopDelayMicros = 33_000;
  assert.equal(
    assessAnsiQuiescentResourceSamples(currentBoundary, expectedResources).qualified,
    true,
  );
  for (const mutate of [
    (samples) => samples.pop(),
    (samples) => (samples[2].atMicros = expectedResources[2].fenceAtMicros - 1),
    (samples) => (samples[2].inputPending = 1),
    (samples) => (samples[2].sampleOrdinal = samples[1].sampleOrdinal),
    (samples) => (samples[2].eventLoopDelayMicros = 33_001),
    (samples) => (samples[2].representationCacheBytes = 16_777_217),
    (samples) => (samples[2].rawJournalBytes = 4_194_305),
    (samples) => (samples[2].daemonClockId = "other-daemon-clock"),
    (samples) => (samples[2].daemonTraceHmac = null),
    (samples) => (samples[2].daemonTraceHmac = hmac(9_999)),
    (samples) =>
      ([samples[2].daemonTraceHmac, samples[3].daemonTraceHmac] = [
        samples[3].daemonTraceHmac,
        samples[2].daemonTraceHmac,
      ]),
    (samples) => (samples[2].atMicros = samples[1].atMicros),
    (samples) => (samples[2].daemonStartedAtMicros = samples[1].daemonEndedAtMicros),
  ]) {
    const samples = structuredClone(value);
    mutate(samples);
    assert.equal(assessAnsiQuiescentResourceSamples(samples, expectedResources).qualified, false);
  }
  for (const field of ["fenceHmac", "daemonTraceHmac"]) {
    const replayed = structuredClone(value);
    const replayedExpected = structuredClone(expectedResources);
    replayed[2][field] = replayed[1][field];
    replayedExpected[2][field] = replayedExpected[1][field];
    assert.equal(assessAnsiQuiescentResourceSamples(replayed, replayedExpected).qualified, false);
  }
  const malformed = structuredClone(value);
  malformed[7].rssBytes = -1;
  const malformedAssessment = assessAnsiQuiescentResourceSamples(malformed, expectedResources);
  assert.equal(malformedAssessment.qualified, false);
  assert.equal(malformedAssessment.firstInvalidEndpointOrdinal, 8);
  assert.equal(malformedAssessment.firstInvalidPredicate, "endpoint-shape-or-authority");

  const observedGcSawtooth = structuredClone(value);
  const heapMiB = [84.6, 88, 92, 96, 100, 104, 108, 112, 116, 119.8, 81.4, 85, 89, 93, 96, 99.3];
  for (const [index, sample] of observedGcSawtooth.entries())
    sample.heapUsedBytes = Math.round(heapMiB[index] * 1_048_576);
  const sawtooth = assessAnsiQuiescentResourceSamples(observedGcSawtooth, expectedResources);
  assert.equal(sawtooth.qualified, true);
  assert.ok(sawtooth.heapSlopeBytesPerSample > 131_072);
});

test("uses the fixed idle series for retained-memory slopes", () => {
  const series = Array.from({ length: 8 }, (_, index) => ({
    ordinal: index + 1,
    atMicros: 2_000_000 + index * 1_000_000,
    rssBytes: 300_000_000 + index * 1_000,
    heapUsedBytes: 90_000_000 + index * 500,
    inputPending: 0,
    inputInFlight: 0,
    inputPendingBytes: 0,
  }));
  const timing = { fenceAtMicros: 0, endpointAtMicros: 10_000_000 };
  assert.equal(assessAnsiIdleRetainedResourceSamples(series, timing).qualified, true);
  const rising = structuredClone(series);
  for (const [index, sample] of rising.entries()) sample.heapUsedBytes += index * 200_000;
  assert.equal(
    assessAnsiIdleRetainedResourceSamples(rising, timing).firstInvalidPredicate,
    "heap-slope",
  );
  const retainedStep = structuredClone(series);
  for (const [index, sample] of retainedStep.entries())
    sample.heapUsedBytes = (index === 0 ? 90 : 200) * 1_048_576;
  assert.equal(
    assessAnsiIdleRetainedResourceSamples(retainedStep, timing).firstInvalidPredicate,
    "idle-retained-heap-growth",
  );
  const falling = structuredClone(series);
  for (const [index, sample] of falling.entries()) sample.heapUsedBytes -= index * 1_000_000;
  assert.equal(assessAnsiIdleRetainedResourceSamples(falling, timing).qualified, true);
  for (const mutate of [
    (value) => value.pop(),
    (value) => (value[3].ordinal = 3),
    (value) => (value[3].atMicros = value[2].atMicros + 899_999),
    (value) => (value[3].inputPending = 1),
    (value) => (value[3].heapUsedBytes = 536_870_913),
  ]) {
    const malformed = structuredClone(series);
    mutate(malformed);
    assert.equal(assessAnsiIdleRetainedResourceSamples(malformed, timing).qualified, false);
  }
  const shifted = series.map((sample) => ({ ...sample, atMicros: sample.atMicros + 1_000_000 }));
  assert.equal(
    assessAnsiIdleRetainedResourceSamples(shifted, timing).firstInvalidPredicate,
    "idle-retained-window",
  );
  assert.equal(
    assessAnsiIdleRetainedResourceSamples(series, {
      fenceAtMicros: 1_000_000,
      endpointAtMicros: 11_000_000,
    }).qualified,
    false,
  );
});

test("requires one baseline, all 24 cycle, and one idle resource endpoint", () => {
  const lifecycle = evidence().resourceLifecycle;
  assert.equal(
    assessAnsiResourceLifecycle(lifecycle, expectedContract().resourceLifecycle).qualified,
    true,
  );
  for (const peak of [99_999, 100_000]) {
    const atBoundary = structuredClone(lifecycle);
    for (const sample of atBoundary) sample.eventLoopDelayPeakMicros = peak;
    assert.equal(
      assessAnsiResourceLifecycle(atBoundary, expectedContract().resourceLifecycle).qualified,
      true,
    );
  }
  const stickyBreach = structuredClone(lifecycle);
  for (let index = 9; index < stickyBreach.length; index += 1)
    stickyBreach[index].eventLoopDelayPeakMicros = 100_001;
  assert.equal(
    assessAnsiResourceLifecycle(stickyBreach, expectedContract().resourceLifecycle).qualified,
    false,
  );
  for (const mutate of [
    (value) => value.splice(8, 1),
    (value) => (value[8].phase = "idle"),
    (value) => (value[12].processHmac = hmac(901)),
    (value) => (value[11].identityHmac = hmac(999)),
    (value) => (value[10].stateHmac = hmac(998)),
    (value) => (value[7].inputPending = 1),
    (value) => (value[8].inputInFlight = 1),
    (value) => (value[9].inputPendingBytes = 1),
    (value) => (value[6].inputPendingPeak = 1),
    (value) => (value[7].rssPeakBytes = 1_073_741_825),
    (value) => (value[8].heapUsedPeakBytes = 536_870_913),
    (value) => (value[9].eventLoopDelayPeakMicros = 100_001),
    (value) => {
      value[8].eventLoopDelayPeakMicros = 2_000;
      value[9].eventLoopDelayPeakMicros = 1_999;
    },
    (value) => (value[9].eventLoopDelayPeakSource = "startup"),
    (value) => (value[0].resourceEpochArmed = false),
    (value) => (value[0].resourceEpochIdentityHmac = hmac(2_999)),
    (value) => (value[12].resourceEpochIdentityHmac = hmac(2_999)),
    (value) => (value[10].resourceSamplingFailureCount = 1),
    (value) => (value[10].lowWaterSampleCount = 7),
    (value) => (value[10].lowWaterLastSampleOrdinal = 7),
    (value) => (value[10].lowWaterWindowMicros = 39_999),
    (value) => (value[25].lowWaterSampleCount = 8),
    (value) => (value[13].sampleOrdinal = value[12].sampleOrdinal),
    (value) => (value[14].atMicros = value[13].atMicros - 1),
    (value) => (value[15].rssBytes = 1_073_741_825),
    (value) => (value[16].heapUsedBytes = 536_870_913),
    (value) => (value[17].eventLoopDelayMicros = 33_001),
  ]) {
    const candidate = structuredClone(lifecycle);
    mutate(candidate);
    assert.equal(
      assessAnsiResourceLifecycle(candidate, expectedContract().resourceLifecycle).qualified,
      false,
    );
  }
});

test("requires 24 exact marker, drain, frame, and quiet-tail workload finalities", () => {
  const value = evidence().workloadFinalities;
  const expected = expectedContract().workloadFinalities;
  assert.equal(assessAnsiWorkloadFinalitySamples(value, expected).qualified, true);
  const sizeSelected = structuredClone(value);
  Object.assign(sizeSelected[1], {
    deliveryBytes: 740_307,
    attemptedPatchBytes: 740_307,
    attemptedSeedBytes: 2_194_552,
    attemptedCompactPatchBytes: 740_307,
    attemptedCompactSeedBytes: 2_194_552,
  });
  Object.assign(sizeSelected[2], {
    deliveryBytes: 600_000,
    representation: "seed",
    canonicalTransitionType: "terminal.seed",
    attemptedPatchBytes: 740_307,
    attemptedSeedBytes: 600_000,
    attemptedCompactPatchBytes: 740_307,
    attemptedCompactSeedBytes: 600_000,
    selectionStatus: "seed-preferred",
  });
  assert.equal(assessAnsiWorkloadFinalitySamples(sizeSelected, expected).qualified, true);
  for (const mutate of [
    (samples) => samples.pop(),
    (samples) => (samples[2].cycle = 2),
    (samples) => (samples[2].markerHmac = samples[1].markerHmac),
    (samples) => (samples[2].markerCount = 0),
    (samples) => (samples[2].producerStatus = "error"),
    (samples) => (samples[2].producerOrdinal = 2),
    (samples) => (samples[2].producerPayloadHmac = samples[1].producerPayloadHmac),
    (samples) => (samples[2].producerBackpressureCount = 8_193),
    (samples) => (samples[2].markerCount = 2),
    (samples) => (samples[2].finalCursorY = 40),
    (samples) => (samples[2].finalCursorY = 41),
    (samples) => (samples[2].viewportRows = 41),
    (samples) => (samples[2].cursorVisible = false),
    (samples) => (samples[2].deliveryBytes = 16_777_217),
    (samples) => (samples[2].attemptedPatchBytes = 0),
    (samples) => (samples[2].attemptedSeedBytes = 120_002),
    (samples) => (samples[2].selectedEncoding = "semantic-v1"),
    (samples) => (samples[2].attemptedCompactPatchBytes = 120_003),
    (samples) => (samples[2].attemptedLegacyPatchBytes = -1),
    (samples) => delete samples[2].attemptedCompactSeedBytes,
    (samples) => (samples[2].selectionStatus = "seed-preferred"),
    (samples) => {
      Object.assign(samples[2], {
        deliveryBytes: 740_307,
        representation: "seed",
        attemptedPatchBytes: 740_307,
        attemptedSeedBytes: 740_307,
        attemptedCompactPatchBytes: 740_307,
        attemptedCompactSeedBytes: 740_307,
        selectionStatus: "seed-preferred",
      });
    },
    (samples) => (samples[2].deliveryOrdinal = samples[1].deliveryOrdinal),
    (samples) => (samples[2].deliveryHmac = samples[1].deliveryHmac),
    (samples) => (samples[2].canonicalTransitionType = "terminal.seed"),
    (samples) => (samples[2].canonicalTransitionType = "terminal.tombstone"),
    (samples) => (samples[2].canonicalTransitionCount = 0),
    (samples) => (samples[2].canonicalTransitionCount = 8_193),
    (samples) => (samples[2].queueDepth = 1),
    (samples) => (samples[2].laterTransitionCount = 1),
    (samples) => (samples[2].laterEnqueueCount = 1),
    (samples) => (samples[2].laterPaintCount = 1),
    (samples) => (samples[2].authorityIdentityExact = false),
    (samples) => (samples[2].stableTailMs = 39),
    (samples) => (samples[2].elapsedMs = 30_000),
    (samples) => (samples[2].noProgressElapsedMs = 15_000),
    (samples) => (samples[2].progressCount = 0),
    (samples) => (samples[2].absoluteDeadlineMs = 30_001),
    (samples) => (samples[2].noProgressDeadlineMs = 14_999),
    (samples) => (samples[2].faulted = true),
    (samples) => (samples[2].rebound = true),
  ]) {
    const samples = structuredClone(value);
    mutate(samples);
    assert.equal(assessAnsiWorkloadFinalitySamples(samples, expected).qualified, false);
  }
});

test("joins only the marker revision to its own enqueue and settlement", () => {
  const mode = {
    updateType: "terminal.patch",
    semanticPaneId: "pane-a",
    generation: "generation-a",
    incarnation: "incarnation-a",
    revision: 9,
    stateHash: "0123456789abcdef",
  };
  const expected = {
    workspaceName: "workspace-a",
    semanticPaneId: mode.semanticPaneId,
    daemonProcessId: "daemon:42",
    daemonClockId: "node-performance-now",
    daemonClockKind: "performance-now",
  };
  const delivery = (
    operation,
    revision,
    ordinal,
    transactionId,
    startedAtMicros,
    authority = {},
  ) => ({
    type: "performance.stage",
    operation,
    processId: authority.processId ?? expected.daemonProcessId,
    clockId: authority.clockId ?? expected.daemonClockId,
    clockKind: authority.clockKind ?? expected.daemonClockKind,
    startedAtMicros,
    endedAtMicros: startedAtMicros + 1,
    terminalDelivery: {
      workspaceName: authority.workspaceName ?? expected.workspaceName,
      semanticPaneId: authority.semanticPaneId ?? expected.semanticPaneId,
      canonicalGeneration: mode.generation,
      canonicalIncarnation: mode.incarnation,
      canonicalRevision: revision,
      canonicalStateHash: revision === mode.revision ? mode.stateHash : "fedcba9876543210",
      deliveryOrdinal: ordinal,
      transactionId,
      queueDepth: 0,
      inFlight: 0,
      inFlightBytes: 0,
      ...(operation === "terminal-delivery-encode-enqueue"
        ? { representation: authority.representation ?? "patch" }
        : {}),
    },
  });
  const first = "00000000-0000-4000-8000-000000000101";
  const final = "00000000-0000-4000-8000-000000000102";
  const exact = [
    delivery("terminal-delivery-encode-enqueue", 8, 1, first, 1),
    delivery("terminal-delivery-settled", 8, 1, first, 3),
    delivery("terminal-delivery-encode-enqueue", 9, 2, final, 5),
    delivery("terminal-delivery-settled", 9, 2, final, 7),
  ];
  assert.equal(
    ansiWorkloadDeliveryJoin({ canonical: mode, daemonRecords: exact, expected }).exact,
    true,
  );
  const seedCanonical = { ...mode, updateType: "terminal.seed" };
  const seedExact = structuredClone(exact);
  seedExact[2].terminalDelivery.representation = "seed";
  assert.equal(
    ansiWorkloadDeliveryJoin({ canonical: seedCanonical, daemonRecords: seedExact, expected })
      .exact,
    true,
  );
  for (const mutate of [
    (records) => (records[3].terminalDelivery.canonicalRevision = 8),
    (records) => (records[3].terminalDelivery.canonicalStateHash = "fedcba9876543210"),
    (records) => (records[3].terminalDelivery.deliveryOrdinal = 3),
    (records) => (records[3].terminalDelivery.transactionId = first),
    (records) => (records[3].startedAtMicros = 5),
    (records) => records.push(structuredClone(records[2])),
    (records) => delete records[3].terminalDelivery.workspaceName,
    (records) => (records[3].terminalDelivery.workspaceName = "workspace-b"),
    (records) => delete records[3].terminalDelivery.semanticPaneId,
    (records) => (records[3].terminalDelivery.semanticPaneId = "pane-b"),
    (records) => (records[3].processId = "daemon:43"),
    (records) => (records[3].clockId = "arbitrary-clock"),
    (records) => (records[3].clockKind = "wall-clock"),
    (records) => (records[3].terminalDelivery.canonicalGeneration = "generation-b"),
    (records) => (records[3].terminalDelivery.canonicalIncarnation = "incarnation-b"),
    (records) => (records[2].terminalDelivery.representation = "seed"),
    (records) => delete records[2].terminalDelivery.representation,
    (records) => (records[2].terminalDelivery.representation = "tombstone"),
    (records) => (records[3].terminalDelivery.representation = "seed"),
  ]) {
    const records = structuredClone(exact);
    mutate(records);
    assert.equal(
      ansiWorkloadDeliveryJoin({ canonical: mode, daemonRecords: records, expected }).exact,
      false,
    );
  }
  const seedToPatch = structuredClone(seedExact);
  seedToPatch[2].terminalDelivery.representation = "patch";
  assert.equal(
    ansiWorkloadDeliveryJoin({ canonical: seedCanonical, daemonRecords: seedToPatch, expected })
      .exact,
    false,
  );
  const late = [...exact, delivery("terminal-delivery-encode-enqueue", 10, 3, first, 9)];
  assert.equal(
    ansiWorkloadDeliveryJoin({ canonical: mode, daemonRecords: late, expected }).exact,
    false,
  );
  assert.equal(
    ansiWorkloadDeliveryJoin({ canonical: mode, daemonRecords: late, expected }).enqueueCount,
    3,
  );
  const sibling = [
    ...exact,
    delivery("terminal-delivery-encode-enqueue", 10, 3, first, 9, {
      workspaceName: "workspace-b",
      semanticPaneId: "pane-b",
    }),
    delivery("terminal-delivery-settled", 10, 3, first, 11, {
      workspaceName: "workspace-b",
      semanticPaneId: "pane-b",
    }),
  ];
  const siblingJoin = ansiWorkloadDeliveryJoin({
    canonical: mode,
    daemonRecords: sibling,
    expected,
  });
  assert.equal(siblingJoin.exact, true);
  assert.equal(siblingJoin.enqueueCount, 2);
  assert.equal(siblingJoin.settledCount, 2);
  for (const mutateExpected of [
    (value) => delete value.workspaceName,
    (value) => (value.semanticPaneId = "pane-b"),
    (value) => (value.daemonProcessId = "client:42"),
    (value) => (value.daemonClockId = "arbitrary-clock"),
    (value) => (value.daemonClockKind = "wall-clock"),
  ]) {
    const invalidExpected = structuredClone(expected);
    mutateExpected(invalidExpected);
    assert.equal(
      ansiWorkloadDeliveryJoin({
        canonical: mode,
        daemonRecords: exact,
        expected: invalidExpected,
      }).exact,
      false,
    );
  }
});

test("rejects missing reordered duplicate causal and over-budget samples", () => {
  for (const mutate of [
    (value) => value.pop(),
    (value) => ([value[1], value[0]] = [value[0], value[1]]),
    (value) => (value[1].traceHmac = value[0].traceHmac),
    (value) => value[1].causal.dirtyRows.push(0),
    (value) => (value[1].causal.presentationCountDelta = 0),
    (value) => {
      value[27].durationMicros = 17_000;
      value[27].fenceAtMicros = value[27].startedAtMicros + 17_000;
      value[28].durationMicros = 17_000;
      value[28].fenceAtMicros = value[28].startedAtMicros + 17_000;
    },
    (value) => {
      value[29].durationMicros = 34_000;
      value[29].fenceAtMicros = value[29].startedAtMicros + 34_000;
    },
  ]) {
    const value = structuredClone(samples());
    mutate(value);
    assert.equal(assessAnsiCursorPresentationSamples(value, expectedSamples()).qualified, false);
  }
});

test("qualifies one strict Web projection and rejects splice/missing cursor evidence", () => {
  assert.equal(ansiCursorWebEvidence(web(), expectedWeb()).qualified, true);
  const wrongContract = structuredClone(expectedWeb());
  wrongContract.presentations[1].cursorStyle = "block";
  assert.equal(ansiCursorWebEvidence(web(), wrongContract).qualified, false);
  for (const mutate of [
    (value) => (value.readiness.qualified = false),
    (value) => (value.stableExactSamples = 1),
    (value) => (value.presentations[2].semanticPaneHmac = hmac(998)),
    (value) => (value.presentations[2].deliveryRequestHmac = hmac(999)),
    (value) => (value.presentations[2].cursorCount = 0),
    (value) => (value.presentations[3].cursorCount = 1),
    (value) => (value.presentations[2].cursorHidden = true),
    (value) => (value.presentations[1].cursorStyle = "block"),
    (value) => (value.presentations[0].rendererCols = 162),
    (value) => (value.presentations[3].rendererRows = 51),
    (value) => (value.presentations[3].activeBuffer = "normal"),
    (value) => (value.presentations[1].domSemanticExact = false),
    (value) => (value.presentations[1].domRowCountExact = false),
    (value) => (value.presentations[1].domTextExact = false),
    (value) => (value.presentations[1].domStyleExact = false),
    (value) => {
      value.presentations[1].domFirstMismatchRow = 2;
      value.presentations[1].domFirstMismatchColumn = 3;
      value.presentations[1].domFirstMismatchComponent = "foreground";
    },
    (value) => (value.presentations[2].domCursorExact = false),
    (value) => (value.presentations[4].domRowsHmac = hmac(204)),
    (value) => {
      const first = structuredClone(value.presentations[0]);
      value.presentations = value.presentations.map((stage, index) => ({
        ...first,
        stage: stage.stage,
        semanticPaneHmac: expectedPaneHmac,
        domCursorHmac: hmac(220 + index),
      }));
    },
    (value) => value.presentations.pop(),
  ]) {
    const value = structuredClone(web());
    mutate(value);
    assert.equal(ansiCursorWebEvidence(value, expectedWeb()).qualified, false);
  }

  const benignRawDomRerender = structuredClone(web());
  // Qualified evidence contains normalized DOM semantics only. Raw span
  // serialization and sub-cell geometry are failure-localization inputs and
  // cannot change the restoration verdict.
  assert.equal("rowsHmac" in benignRawDomRerender.presentations[0], false);
  assert.equal("cursorHmac" in benignRawDomRerender.presentations[0], false);
  assert.equal(ansiCursorWebEvidence(benignRawDomRerender, expectedWeb()).qualified, true);

  const coherentWrongDom = structuredClone(web());
  for (const [index, stage] of coherentWrongDom.presentations.entries()) {
    stage.domRowsHmac = hmac(750 + (index === 2 ? 1 : index === 4 ? 0 : index));
    stage.domCursorHmac = hmac(760 + (index === 4 ? 0 : index));
  }
  coherentWrongDom.presentations[1].domSemanticExact = false;
  assert.equal(ansiCursorWebEvidence(coherentWrongDom, expectedWeb()).qualified, false);

  const systematicCursorOffset = structuredClone(web());
  for (const stage of systematicCursorOffset.presentations) stage.domCursorExact = false;
  assert.equal(ansiCursorWebEvidence(systematicCursorOffset, expectedWeb()).qualified, false);
  assert.deepEqual(Object.keys(ansiCursorWebEvidence(web(), expectedWeb()).restorationPredicates), [
    "normalRestoredDomRenditionExact",
    "normalRestoredSemanticRenditionExact",
    "normalRestoredCanonicalCursorExact",
    "normalRestoredDomCursorExact",
    "normalBufferExact",
    "richDomDistinctFromNormalExact",
    "richCursorDomRenditionExact",
    "richCursorSemanticRenditionExact",
    "cursorOnlyZeroGridExact",
    "richCursorDistinctExact",
    "alternateSemanticDistinct",
    "alternateBufferHiddenExact",
    "rendererCanonicalDimensionsExact",
  ]);

  for (const [predicate, mutate] of [
    [
      "normalRestoredDomRenditionExact",
      (value) => (value.presentations[4].domRowsHmac = hmac(701)),
    ],
    [
      "normalRestoredSemanticRenditionExact",
      (value) => (value.presentations[4].renditionHmac = hmac(702)),
    ],
    [
      "normalRestoredCanonicalCursorExact",
      (value) => (value.presentations[4].canonicalCursorX = 1),
    ],
    ["normalRestoredDomCursorExact", (value) => (value.presentations[4].domCursorHmac = hmac(703))],
    ["normalBufferExact", (value) => (value.presentations[4].canonicalBuffer = "alternate")],
    ["richDomDistinctFromNormalExact", (value) => (value.presentations[1].domRowsHmac = hmac(200))],
    ["richCursorDomRenditionExact", (value) => (value.presentations[2].domRowsHmac = hmac(704))],
    [
      "richCursorSemanticRenditionExact",
      (value) => (value.presentations[2].positionWrappedHmac = hmac(705)),
    ],
    ["cursorOnlyZeroGridExact", (value) => (value.presentations[2].gridRowsRead = 1)],
    ["richCursorDistinctExact", (value) => (value.presentations[2].domCursorHmac = hmac(211))],
    ["alternateSemanticDistinct", (value) => (value.presentations[3].domRowsHmac = hmac(201))],
    ["alternateBufferHiddenExact", (value) => (value.presentations[3].cursorVisible = true)],
    ["rendererCanonicalDimensionsExact", (value) => (value.presentations[4].rendererCols = 79)],
  ]) {
    const value = structuredClone(web());
    mutate(value);
    const assessment = ansiCursorWebEvidence(value, expectedWeb());
    assert.equal(assessment.qualified, false);
    assert.equal(assessment.restorationPredicates[predicate], false);
    assert.equal(typeof assessment.firstFailedRestorationPredicate, "string");
  }
  for (const mutate of [
    (value) => delete value.presentations[0].deliveryRequestHmacs,
    (value) => (value.presentations[0].rendererCols = 162),
    (value) => (value.presentations[3].rendererRows = 51),
    (value) => value.presentations[0].deliveryRequestHmacs.push(hmac(640)),
    (value) => (value.presentations[0].deliveryRequestHmacs = ["not-a-hmac"]),
  ]) {
    const contract = structuredClone(expectedWeb());
    mutate(contract);
    assert.equal(ansiCursorWebEvidence(web(), contract).qualified, false);
  }
});

test("qualifies exact baseline-rich-alt-restore lineage and fails every hard component", () => {
  const exactAssessment = assessAnsiCursorAltScreenEvidence(evidence(), expectedContract());
  assert.equal(exactAssessment.qualified, true, JSON.stringify(exactAssessment.predicates));
  assert.equal(Object.values(exactAssessment.workloadPredicates).every(Boolean), true);
  assert.equal(exactAssessment.web.stageExact, true);
  assert.equal(exactAssessment.web.restorationExact, true);
  const inclusivePeak = structuredClone(evidence());
  for (const sample of inclusivePeak.resourceLifecycle) sample.eventLoopDelayPeakMicros = 100_000;
  inclusivePeak.idle.eventLoopDelayPeakMicros = 100_000;
  inclusivePeak.workload.eventLoopP99Ms = 33;
  assert.equal(
    assessAnsiCursorAltScreenEvidence(inclusivePeak, expectedContract()).qualified,
    true,
  );
  const overPeak = structuredClone(inclusivePeak);
  overPeak.resourceLifecycle[9].eventLoopDelayPeakMicros = 100_001;
  assert.equal(assessAnsiCursorAltScreenEvidence(overPeak, expectedContract()).qualified, false);
  const overIdlePeak = structuredClone(inclusivePeak);
  overIdlePeak.idle.eventLoopDelayPeakMicros = 100_001;
  assert.equal(
    assessAnsiCursorAltScreenEvidence(overIdlePeak, expectedContract()).qualified,
    false,
  );
  const overP99 = structuredClone(inclusivePeak);
  overP99.workload.eventLoopP99Ms = 33.001;
  assert.equal(assessAnsiCursorAltScreenEvidence(overP99, expectedContract()).qualified, false);
  for (const mutate of [
    (value) => delete value.rich,
    (value) => delete value.preAlternate,
    (value) => (value.baseline.presentationHmac = hmac(404)),
    (value) => (value.preAlternate.predecessorRevision -= 1),
    (value) => (value.preAlternate.predecessorStateHmac = hmac(404)),
    (value) => (value.preAlternate.nativeCaptureHmac = hmac(404)),
    (value) => (value.cursorSamples[1].traceHmac = value.cursorSamples[0].traceHmac),
    (value) => (value.resourceSamples[2].daemonClockId = "other-clock"),
    (value) => (value.web.presentations[3].activeBuffer = "normal"),
  ]) {
    const contract = structuredClone(expectedContract());
    mutate(contract);
    assert.equal(assessAnsiCursorAltScreenEvidence(evidence(), contract).qualified, false);
  }
  for (const mutate of [
    (value) => delete value.preAlternate,
    (value) => (value.preAlternate.predecessor.revision -= 1),
    (value) => (value.preAlternate.predecessor.stateHmac = hmac(404)),
    (value) => (value.preAlternate.stage.stateHmac = hmac(404)),
    (value) => (value.preAlternate.stage.presentationHmac = hmac(404)),
    (value) => (value.preAlternate.stage.cursor.x = 1),
    (value) => (value.preAlternate.cardinality.mode = 2),
    (value) => (value.preAlternate.cardinality.presentation = 0),
    (value) => (value.preAlternate.counters.afterGridRowsReadTotal += 1),
    (value) => (value.preAlternate.counters.presentationCountDelta = 0),
    (value) => (value.preAlternate.sample.causal.inputAccepted = false),
    (value) => (value.preAlternate.sample.action = "enter-alternate"),
    (value) =>
      (value.preAlternate.sample.frameAtMicros = value.preAlternate.sample.fenceAtMicros + 1),
    (value) => (value.preAlternate.native.geometryExact = false),
    (value) => (value.preAlternate.native.matchCount = 2),
    (value) => (value.preAlternate.native.mappingExact = false),
    (value) => (value.preAlternate.native.captureHmac = hmac(404)),
    (value) => (value.alternate.revision = value.preAlternate.stage.revision + 2),
    (value) => (value.restored.revision = value.alternate.revision + 2),
    (value) => (value.alternate.alternateScreen = false),
    (value) => (value.restored.presentationHmac = hmac(99)),
    (value) => (value.idle.paintCount = 1),
    (value) => (value.idle.idleRetainedRssGrowthBytes = 67_108_865),
    (value) => (value.idle.idleRetainedHeapGrowthBytes = 33_554_433),
    (value) => (value.resourceSamples[15].rssBytes += 100_000_000),
    (value) => (value.writer.droppedRecords = 1),
    (value) => (value.web.presentations[4].domRowsHmac = null),
  ]) {
    const value = structuredClone(evidence());
    mutate(value);
    assert.equal(assessAnsiCursorAltScreenEvidence(value, expectedContract()).qualified, false);
  }
  for (const mutate of [
    (actual, contract) => {
      actual.preAlternate.stage.processHmac = hmac(404);
      contract.preAlternate.stage.processHmac = hmac(404);
    },
    (actual, contract) => {
      actual.preAlternate.stage.paneHmac = hmac(404);
      contract.preAlternate.stage.paneHmac = hmac(404);
    },
    (actual, contract) => {
      actual.preAlternate.stage.clockId = "other-clock";
      contract.preAlternate.stage.clockId = "other-clock";
    },
    (actual, contract) => {
      actual.preAlternate.stage.canonicalCols += 1;
      contract.preAlternate.stage.canonicalCols += 1;
    },
    (actual, contract) => {
      actual.preAlternate.stage.sourceEpoch += 1;
      contract.preAlternate.stage.sourceEpoch += 1;
    },
    (actual, contract) => {
      actual.preAlternate.stage.rendererEpoch += 1;
      contract.preAlternate.stage.rendererEpoch += 1;
    },
    (actual, contract) => {
      actual.preAlternate.sample.causal.daemonProcessHmac = hmac(404);
      contract.preAlternate.daemonProcessHmac = hmac(404);
    },
    (actual, contract) => {
      actual.preAlternate.counters.beforeGridRowsReadTotal += 10;
      actual.preAlternate.counters.afterGridRowsReadTotal += 10;
      contract.preAlternate.beforeGridRowsReadTotal += 10;
      contract.preAlternate.afterGridRowsReadTotal += 10;
    },
  ]) {
    const actual = structuredClone(evidence());
    const contract = structuredClone(expectedContract());
    mutate(actual, contract);
    assert.equal(assessAnsiCursorAltScreenEvidence(actual, contract).qualified, false);
  }
});

test("requires the exact ordered journey boundary cardinality", () => {
  const phases = [
    "ansi-normal-baseline",
    "ansi-rich-presentation",
    "ansi-cursor-only-distribution",
    "ansi-alternate-screen",
    "ansi-normal-restored",
    "ansi-sustained-workload",
    "ansi-idle-quiescent",
    "ansi-web-correlation",
  ];
  const status = (values) =>
    ansiCursorAltJourneyStatus({
      timeline: values.map((phase) => ({ phase })),
      assessment: { qualified: true },
      correlationComplete: true,
    });
  assert.equal(status(phases).status, "passed");
  assert.equal(status([...phases, phases[7]]).status, "failed");
  assert.equal(status([phases[1], phases[0], ...phases.slice(2)]).status, "failed");
  assert.equal(status(phases.slice(1)).status, "failed");
});
