import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { devServerProcessIsRunning } from "../apps/desktop-renderer/e2e/fixtures/dev-server.ts";
import {
  PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
  PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS,
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
  createProductRigAttemptTimelineClock,
  inputPaintSamples,
  paneBodyRegion,
  paneGeometryIdentity,
  productInputQueuesSettled,
  productRigSourceTraceIncludesPath,
  productRigSourceTraceDiffArgs,
  productRigSourceTraceUntrackedArgs,
  readBoundedSourceTraceFiles,
  productResourceCycleCommands,
  productResourceCyclePlan,
  productResourceEndpointEpochState,
  productResourceGeometryIdentity,
  productResourceMeasuredEndpointTraceIds,
  productResourceProbeCells,
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

test("focus Web readiness detects dev-server exit and signal death", () => {
  assert.equal(devServerProcessIsRunning({ exitCode: null, signalCode: null }), true);
  assert.equal(devServerProcessIsRunning({ exitCode: 1, signalCode: null }), false);
  assert.equal(devServerProcessIsRunning({ exitCode: null, signalCode: "SIGTERM" }), false);
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
    ownerPid: 99,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.deepEqual(calls, [
    {
      command: "/usr/bin/caffeinate",
      args: ["-i", "-w", "99"],
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
    ownerPid: 99,
    spawnProcess: () => child,
  });
  child.exitCode = 9;
  child.emit("close", 9, null);
  await assert.rejects(assertion.failure, /exited unexpectedly \(9\)/u);
  assert.equal(assertion.active(), false);
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
