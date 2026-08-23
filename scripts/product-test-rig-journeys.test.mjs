import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createScratchFleet } from "../apps/desktop-renderer/e2e/fixtures/scratch-fleet.ts";
import {
  productCoherentFrameTimeoutObservation,
  summarizeProductInputDistribution,
} from "./lib/product-first-input.mjs";

import {
  PRODUCT_DIAGNOSTIC_BUNDLE_FILES,
  PRODUCT_JOURNEY_REGISTRY,
  ProductJourneyAttemptError,
  auditProductJourneyScope,
  bufferOwnedTuiRuntimeEvidence,
  collectProductRigCleanupFailures,
  createProductRigCleanupReceipt,
  createProductDiagnosticBundle,
  createIsolatedTargetedTuiCwd,
  dispatchProductJourneyExecutor,
  expandProductJourneyEntries,
  isCleanLegacyStoppedProductRigState,
  parseProductDiagnoseOptions,
  prepareIsolatedTargetedTuiCwd,
  prepareOwnedTuiRuntime,
  prepareProductDiagnosticBundlePublication,
  productDiagnosticRunId,
  productRigCleanupAcknowledgesRequest,
  productRigCleanupBarrierFailures,
  productRigTerminalFailureError,
  productRigTerminalFailureState,
  resolveProductJourneyPlan,
  runIsolatedProductJourneyAttempt,
  runConfiglessProductJourneyOwnerBoot,
  runCoherentFirstPaneOwnerBoot,
  runFirstKeyPasteOwnerBoot,
  runFocusOwnerBoot,
  runKeyboardPointerResizeOwnerBoot,
  runSelectionCopyAppMouseOwnerBoot,
  runAnsiCursorAltScreenOwnerBoot,
  runWindowLifecycleOwnerBoot,
  runProductJourneyPlan,
  settleInternalProductRigCleanup,
  startOwnedProductRigDaemon,
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
    daemon: { status: "started", instanceId: "daemon-generation-1", pid: 1002 },
    namespaceDigest: "a".repeat(64),
    ownerDead: true,
    daemonDead: true,
    pathsAbsent: true,
    pathAbsence: {
      runtimeRoot: true,
      tmuxSocket: true,
      hostTmuxSocket: true,
      daemonInfo: true,
      tuiRuntime: true,
    },
    failureCount: 0,
    ...overrides,
  };
}

test("golden registry enables only accepted direct journey executors", () => {
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
  assert.ok(golden.slice(0, 8).every(({ implementation }) => implementation === "implemented"));
  assert.ok(golden.slice(8).every(({ implementation }) => implementation === "pending"));
  assert.deepEqual(auditProductJourneyScope(), {
    complete: false,
    declarationComplete: true,
    executableComplete: false,
    missing: [],
    pendingJourneyIds: expected.slice(8),
  });
  assert.deepEqual(auditProductJourneyScope(golden.slice(1)), {
    complete: false,
    declarationComplete: false,
    executableComplete: false,
    missing: ["configless", "cold-start"],
    pendingJourneyIds: expected.slice(8),
  });
});

test("window lifecycle owner preserves exact create switch rename Web ordering and boundaries", async () => {
  const calls = [];
  const renamedValue = Object.freeze({ windows: ["post-rename"] });
  const operation =
    (name, value = {}) =>
    async () => (calls.push(name), value);
  const operations = {
    onBoundary: (boundary) => calls.push(`boundary:${boundary}`),
    createWindowNamespace: operation("namespace"),
    startCanonicalDaemon: operation("daemon"),
    openCanonicalWorkspace: operation("workspace"),
    buildBeforeMeasurement: operation("build"),
    launchWindowTui: operation("tui-started"),
    waitForWindowHostReady: operation("host"),
    waitForWindowTuiCoherent: operation("tui"),
    proveWindowBaseline: operation("baseline"),
    createWindow: operation("create"),
    primeCreatedWindow: operation("prime"),
    renameWindow: operation("rename", renamedValue),
    driveWarmSwitches: async (...args) => {
      calls.push("switch");
      assert.equal(args[6], renamedValue);
      return {};
    },
    startWebAfterWindowLifecycle: operation("web"),
  };
  await runWindowLifecycleOwnerBoot(operations);
  assert.deepEqual(calls, [
    "boundary:window-namespace-ready",
    "namespace",
    "boundary:window-daemon-ready",
    "daemon",
    "boundary:window-daemon-ready",
    "workspace",
    "boundary:window-tui-build",
    "build",
    "boundary:window-tui-started",
    "tui-started",
    "boundary:window-host-ready",
    "host",
    "boundary:window-tui-coherent",
    "tui",
    "boundary:window-baseline",
    "baseline",
    "boundary:window-create-proved",
    "create",
    "boundary:window-switch-visible",
    "prime",
    "boundary:window-rename-visible",
    "rename",
    "boundary:window-switch-distribution",
    "switch",
    "boundary:window-web-correlation",
    "web",
  ]);
  for (const [method, boundary] of [
    ["createWindowNamespace", "window-namespace-ready"],
    ["startCanonicalDaemon", "window-daemon-ready"],
    ["openCanonicalWorkspace", "window-daemon-ready"],
    ["buildBeforeMeasurement", "window-tui-build"],
    ["launchWindowTui", "window-tui-started"],
    ["waitForWindowHostReady", "window-host-ready"],
    ["waitForWindowTuiCoherent", "window-tui-coherent"],
    ["proveWindowBaseline", "window-baseline"],
    ["createWindow", "window-create-proved"],
    ["primeCreatedWindow", "window-switch-visible"],
    ["renameWindow", "window-rename-visible"],
    ["driveWarmSwitches", "window-switch-distribution"],
    ["startWebAfterWindowLifecycle", "window-web-correlation"],
  ]) {
    await assert.rejects(
      runWindowLifecycleOwnerBoot({
        ...operations,
        [method]: async () => {
          throw new Error(`failed ${method}`);
        },
      }),
      (error) => error?.boundary === boundary,
    );
  }
});

test("resize owner preserves exact keyboard preview release Web ordering and boundaries", async () => {
  const calls = [];
  const operation = (name) => async () => (calls.push(name), Object.freeze({ name }));
  const operations = {
    onBoundary: (boundary) => calls.push(`boundary:${boundary}`),
    createResizeNamespace: operation("namespace"),
    startCanonicalDaemon: operation("daemon"),
    openCanonicalWorkspace: operation("workspace"),
    buildBeforeMeasurement: operation("build"),
    launchResizeTui: operation("start"),
    waitForResizeHostReady: operation("host"),
    waitForResizeTuiCoherent: operation("coherent"),
    proveResizeBaseline: operation("baseline"),
    driveKeyboardResize: operation("keyboard"),
    drivePointerPreviews: operation("previews"),
    drivePointerRelease: operation("release"),
    startWebAfterResize: operation("web"),
  };
  await runKeyboardPointerResizeOwnerBoot(operations);
  assert.deepEqual(calls, [
    "boundary:resize-namespace-ready",
    "namespace",
    "boundary:resize-daemon-ready",
    "daemon",
    "boundary:resize-daemon-ready",
    "workspace",
    "boundary:resize-tui-build",
    "build",
    "boundary:resize-tui-started",
    "start",
    "boundary:resize-host-ready",
    "host",
    "boundary:resize-tui-coherent",
    "coherent",
    "boundary:resize-baseline",
    "baseline",
    "boundary:resize-keyboard-proved",
    "keyboard",
    "boundary:resize-pointer-preview-distribution",
    "previews",
    "boundary:resize-pointer-release-proved",
    "release",
    "boundary:resize-web-correlation",
    "web",
  ]);
  for (const [method, boundary] of [
    ["createResizeNamespace", "resize-namespace-ready"],
    ["startCanonicalDaemon", "resize-daemon-ready"],
    ["openCanonicalWorkspace", "resize-daemon-ready"],
    ["buildBeforeMeasurement", "resize-tui-build"],
    ["launchResizeTui", "resize-tui-started"],
    ["waitForResizeHostReady", "resize-host-ready"],
    ["waitForResizeTuiCoherent", "resize-tui-coherent"],
    ["proveResizeBaseline", "resize-baseline"],
    ["driveKeyboardResize", "resize-keyboard-proved"],
    ["drivePointerPreviews", "resize-pointer-preview-distribution"],
    ["drivePointerRelease", "resize-pointer-release-proved"],
    ["startWebAfterResize", "resize-web-correlation"],
  ]) {
    await assert.rejects(
      runKeyboardPointerResizeOwnerBoot({
        ...operations,
        [method]: async () => {
          throw new Error(String(method));
        },
      }),
      (error) => error?.boundary === boundary,
    );
  }
});

test("selection owner preserves exact local copy app-mouse local-mode Web ordering", async () => {
  const calls = [];
  const operation = (name) => async () => (calls.push(name), Object.freeze({ name }));
  await runSelectionCopyAppMouseOwnerBoot({
    onBoundary: (boundary) => calls.push(`boundary:${boundary}`),
    createNamespace: operation("namespace"),
    startDaemon: operation("daemon"),
    openWorkspace: operation("workspace"),
    build: operation("build"),
    launch: operation("start"),
    waitHost: operation("host"),
    waitCoherent: operation("coherent"),
    proveBaseline: operation("baseline"),
    driveSelection: operation("selection"),
    driveCopy: operation("copy"),
    driveAppMouse: operation("app-mouse"),
    driveLocalMode: operation("local-mode"),
    startWeb: operation("web"),
  });
  assert.deepEqual(calls, [
    "boundary:selection-namespace-ready",
    "namespace",
    "boundary:selection-daemon-ready",
    "daemon",
    "boundary:selection-daemon-ready",
    "workspace",
    "boundary:selection-tui-build",
    "build",
    "boundary:selection-tui-started",
    "start",
    "boundary:selection-host-ready",
    "host",
    "boundary:selection-tui-coherent",
    "coherent",
    "boundary:selection-baseline",
    "baseline",
    "boundary:selection-visible",
    "selection",
    "boundary:selection-copy-proved",
    "copy",
    "boundary:application-mouse-forwarded",
    "app-mouse",
    "boundary:selection-local-mode-proved",
    "local-mode",
    "boundary:selection-web-correlation",
    "web",
  ]);
});

test("ANSI owner preserves normal cursor alternate restore workload idle Web ordering", async () => {
  const calls = [];
  const operation = (name) => async () => (calls.push(name), Object.freeze({ name }));
  await runAnsiCursorAltScreenOwnerBoot({
    onBoundary: (boundary) => calls.push(`boundary:${boundary}`),
    createNamespace: operation("namespace"),
    startDaemon: operation("daemon"),
    openWorkspace: operation("workspace"),
    build: operation("build"),
    launch: operation("start"),
    waitHost: operation("host"),
    waitCoherent: operation("coherent"),
    proveNormalBaseline: operation("baseline"),
    driveRichAnsi: operation("rich"),
    driveCursorDistribution: operation("cursor"),
    enterAlternateScreen: operation("alternate"),
    restoreNormalScreen: operation("restore"),
    runSustainedWorkload: operation("sustained"),
    proveIdle: operation("idle"),
    startWeb: operation("web"),
  });
  assert.deepEqual(
    calls.filter((value) => !value.startsWith("boundary:")),
    [
      "namespace",
      "daemon",
      "workspace",
      "build",
      "start",
      "host",
      "coherent",
      "baseline",
      "rich",
      "cursor",
      "alternate",
      "restore",
      "sustained",
      "idle",
      "web",
    ],
  );
  assert.equal(calls.at(-2), "boundary:ansi-web-correlation");
});

test("window lifecycle owner preserves the bounded owned-action predicate at rename boundary", async () => {
  const observation = Object.freeze({
    version: 1,
    operation: "window-owned-action",
    predicate: "action-result",
    action: "workspace.rename",
    operationId: "12345678-1234-4234-8234-123456789abc",
    status: 200,
    ok: false,
    resultPresent: false,
    code: "operation_conflict",
    reason: "controller_conflict",
    issueCount: 0,
  });
  const operation =
    (value = {}) =>
    async () =>
      value;
  await assert.rejects(
    runWindowLifecycleOwnerBoot({
      createWindowNamespace: operation(),
      startCanonicalDaemon: operation(),
      openCanonicalWorkspace: operation(),
      buildBeforeMeasurement: operation(),
      launchWindowTui: operation(),
      waitForWindowHostReady: operation(),
      waitForWindowTuiCoherent: operation(),
      proveWindowBaseline: operation(),
      createWindow: operation(),
      primeCreatedWindow: operation(),
      renameWindow: async () => {
        const error = new Error("owned action failed");
        error.observation = observation;
        throw error;
      },
      driveWarmSwitches: operation(),
      startWebAfterWindowLifecycle: operation(),
    }),
    (error) => error?.boundary === "window-rename-visible" && error?.observation === observation,
  );
});

test("scratch fleet rejects unsafe preseed markers before creating any namespace", async () => {
  const slug = `unsafe-marker-${process.pid}`;
  const before = new Set(readdirSync("/tmp").filter((entry) => entry.includes(slug)));
  await assert.rejects(
    createScratchFleet({ sessions: 1, slug, initialPaneMarker: "RIG_SAFE'; touch /tmp/pwned; '" }),
    /bounded safe ProductRig token/u,
  );
  assert.deepEqual(new Set(readdirSync("/tmp").filter((entry) => entry.includes(slug))), before);
});

test("scratch fleet starts an exact argv command in the initial pane before orchestration", async () => {
  const fleet = await createScratchFleet({
    sessions: 1,
    slug: `initial-command-${process.pid}`,
    initialPaneCommand: {
      executable: "sh",
      args: ["-c", "printf 'DIRECT_FIXTURE_READY\\n'; exec sh -i"],
    },
  });
  try {
    assert.match(fleet.capturePane(fleet.sessionNames[0]), /DIRECT_FIXTURE_READY/u);
    assert.equal(fleet.initialPanes.length, 1);
    assert.equal(fleet.initialPanes[0].sessionName, fleet.sessionNames[0]);
    assert.match(fleet.initialPanes[0].paneId, /^%[0-9]+$/u);
    assert.ok(fleet.initialPanes[0].width > 0 && fleet.initialPanes[0].height > 0);
    const semanticStamp = spawnSync(
      "tmux",
      [
        "-S",
        fleet.socketPath,
        "display-message",
        "-p",
        "-t",
        fleet.initialPanes[0].paneId,
        "#{@tmux_ide_pane_id}",
      ],
      { encoding: "utf8" },
    );
    assert.equal(semanticStamp.status, 0);
    assert.equal(semanticStamp.stdout.trim(), "");
  } finally {
    await fleet.dispose();
  }
});

test("scratch fleet preserves two-window default and supports exact one-window lifecycle namespace", async () => {
  for (const [suffix, windowsPerSession, expectedWindows] of [
    ["default", undefined, ["one", "two"]],
    ["one-window", 1, ["one"]],
  ]) {
    const fleet = await createScratchFleet({
      sessions: 1,
      slug: `window-count-${suffix}-${process.pid}`,
      ...(windowsPerSession === undefined ? {} : { windowsPerSession }),
    });
    try {
      const session = fleet.sessionNames[0];
      assert.ok(session);
      assert.deepEqual(fleet.listWindows(session), expectedWindows);
      assert.equal(fleet.countPanes(session), expectedWindows.length);
      assert.equal(fleet.currentWindow(session), "one");
      assert.equal(fleet.initialPanes.filter((pane) => pane.sessionName === session).length, 1);
    } finally {
      await fleet.dispose();
    }
  }
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
  assert.deepEqual(
    resolveProductJourneyPlan(
      parseProductDiagnoseOptions(["--journey", "coherent-first-pane", "--repeat", "1", "--json"]),
    ).map(({ journey, repetition, variant }) => [journey.id, repetition, variant]),
    [["coherent-first-pane", 1, null]],
  );
  assert.deepEqual(
    resolveProductJourneyPlan(
      parseProductDiagnoseOptions([
        "--journey",
        "ansi-cursor-alt-screen",
        "--repeat",
        "1",
        "--json",
      ]),
    ).map(({ journey, repetition, variant }) => [journey.id, repetition, variant]),
    [["ansi-cursor-alt-screen", 1, null]],
  );
  assert.deepEqual(
    resolveProductJourneyPlan(
      parseProductDiagnoseOptions([
        "--journey",
        "selection-copy-app-mouse",
        "--repeat",
        "1",
        "--json",
      ]),
    ).map(({ journey, repetition, variant }) => [journey.id, repetition, variant]),
    [["selection-copy-app-mouse", 1, null]],
  );
});

test("coherent-first-pane owner preserves targeted preseed-to-Web ordering", async () => {
  const calls = [];
  const operation = (name, result) => async () => {
    calls.push(name);
    return result;
  };
  const result = await runCoherentFirstPaneOwnerBoot({
    createTargetedNamespace: operation("preseed", { seed: "before-start" }),
    startCanonicalDaemon: operation("daemon", { generation: "generation" }),
    openCanonicalWorkspace: operation("workspace", { workspaceName: "workspace" }),
    buildBeforeMeasurement: operation("build"),
    prepareTargetedTuiCwd: operation("cwd", "/isolated/tui/home"),
    launchTargetedTui: operation("targeted-tui", { processId: "opentui:1" }),
    proveCoherentPublication: operation("coherent", { semanticPaneId: "pane.one" }),
    startWebAfterCoherentBoundary: operation("web", { connected: true }),
  });
  assert.deepEqual(calls, [
    "preseed",
    "daemon",
    "workspace",
    "build",
    "cwd",
    "targeted-tui",
    "coherent",
    "web",
  ]);
  assert.equal(result.namespace.seed, "before-start");
  assert.equal(result.coherent.semanticPaneId, "pane.one");
});

test("coherent production owner prepares the exact isolated TUI cwd before launch", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "coherent-targeted-cwd-"));
  const runtimeDir = join(temporary, "tui");
  const calls = [];
  try {
    await runCoherentFirstPaneOwnerBoot({
      createTargetedNamespace: async () => {
        const cwd = createIsolatedTargetedTuiCwd(runtimeDir);
        assert.equal(cwd, join(runtimeDir, "home"));
        return { tui: { runtimeDir } };
      },
      startCanonicalDaemon: async () => ({}),
      openCanonicalWorkspace: async () => ({}),
      buildBeforeMeasurement: async () => calls.push("build"),
      prepareTargetedTuiCwd: async (namespace) => {
        calls.push("prepare");
        return prepareIsolatedTargetedTuiCwd(namespace.tui.runtimeDir);
      },
      launchTargetedTui: async () => {
        calls.push("launch");
        const cwd = join(runtimeDir, "home");
        assert.equal(statSync(cwd).isDirectory(), true);
        assert.equal(lstatSync(cwd).isSymbolicLink(), false);
        assert.equal(statSync(cwd).mode & 0o777, 0o700);
        return {};
      },
      proveCoherentPublication: async () => ({}),
      startWebAfterCoherentBoundary: async () => ({}),
    });
    assert.deepEqual(calls, ["build", "prepare", "launch"]);

    const blockedRuntime = join(temporary, "blocked");
    writeFileSync(blockedRuntime, "not a directory");
    await assert.rejects(
      runCoherentFirstPaneOwnerBoot({
        createTargetedNamespace: async () => ({ tui: { runtimeDir: blockedRuntime } }),
        startCanonicalDaemon: async () => ({}),
        openCanonicalWorkspace: async () => ({}),
        buildBeforeMeasurement: async () => undefined,
        prepareTargetedTuiCwd: async (namespace) =>
          prepareIsolatedTargetedTuiCwd(namespace.tui.runtimeDir),
        launchTargetedTui: () => assert.fail("launch must not follow cwd failure"),
        proveCoherentPublication: async () => ({}),
        startWebAfterCoherentBoundary: async () => ({}),
      }),
      (error) => {
        assert.equal(error.boundary, "targeted-tui-connect");
        assert.deepEqual(error.observation, {
          operation: "prepare-isolated-tui-cwd",
          reason: "runtime-not-exact-directory",
          runtimeKind: "product-rig-testdrive",
        });
        const state = productRigTerminalFailureState(error, "product-rig-startup");
        assert.equal(state.firstBrokenBoundary, "targeted-tui-connect");
        assert.equal(state.failureObservation, error.observation);
        return true;
      },
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("targeted launch validation rejects a missing home without external mutation", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "coherent-targeted-missing-home-"));
  const runtimeDir = join(temporary, "runtime");
  const external = join(temporary, "external");
  try {
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(external, { mode: 0o755 });
    chmodSync(external, 0o755);
    writeFileSync(join(external, "sentinel"), "unchanged");
    await assert.rejects(
      runCoherentFirstPaneOwnerBoot({
        createTargetedNamespace: async () => ({ tui: { runtimeDir } }),
        startCanonicalDaemon: async () => ({}),
        openCanonicalWorkspace: async () => ({}),
        buildBeforeMeasurement: async () => undefined,
        prepareTargetedTuiCwd: async (namespace) =>
          prepareIsolatedTargetedTuiCwd(namespace.tui.runtimeDir),
        launchTargetedTui: () => assert.fail("launch must not follow missing cwd"),
        proveCoherentPublication: async () => ({}),
        startWebAfterCoherentBoundary: async () => ({}),
      }),
      (error) =>
        error.boundary === "targeted-tui-connect" && error.observation?.reason === "home-missing",
    );
    assert.equal(statSync(external).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "unchanged");
    assert.equal(existsSync(join(runtimeDir, "home")), false);
  } finally {
    removeTestTree(temporary);
  }
});

test("targeted launch validation rejects permission mismatches without repair", () => {
  for (const mismatched of ["runtime", "home"]) {
    const temporary = mkdtempSync(join(tmpdir(), `coherent-targeted-mode-${mismatched}-`));
    const runtimeDir = join(temporary, "runtime");
    const home = join(runtimeDir, "home");
    try {
      createIsolatedTargetedTuiCwd(runtimeDir);
      writeFileSync(join(home, "sentinel"), "unchanged");
      chmodSync(mismatched === "runtime" ? runtimeDir : home, 0o755);
      assert.throws(
        () => prepareIsolatedTargetedTuiCwd(runtimeDir),
        (error) =>
          error.boundary === "targeted-tui-connect" &&
          error.observation?.reason === `${mismatched}-permission-mismatch`,
      );
      assert.equal(statSync(mismatched === "runtime" ? runtimeDir : home).mode & 0o777, 0o755);
      assert.equal(readFileSync(join(home, "sentinel"), "utf8"), "unchanged");
    } finally {
      removeTestTree(temporary);
    }
  }
});

test("targeted TUI cwd preparation never follows runtime or home symlinks", () => {
  const temporary = mkdtempSync(join(tmpdir(), "coherent-targeted-symlink-"));
  try {
    const external = join(temporary, "external");
    mkdirSync(external, { mode: 0o755 });
    chmodSync(external, 0o755);
    const runtimeDir = join(temporary, "runtime");
    mkdirSync(runtimeDir, { mode: 0o700 });
    symlinkSync(external, join(runtimeDir, "home"), "dir");
    assert.throws(
      () => prepareIsolatedTargetedTuiCwd(runtimeDir),
      (error) =>
        error.boundary === "targeted-tui-connect" &&
        error.observation?.reason === "home-not-exact-directory",
    );
    assert.equal(statSync(external).mode & 0o777, 0o755);

    const runtimeLink = join(temporary, "runtime-link");
    symlinkSync(external, runtimeLink, "dir");
    assert.throws(
      () => prepareIsolatedTargetedTuiCwd(runtimeLink),
      (error) =>
        error.boundary === "targeted-tui-connect" &&
        error.observation?.reason === "runtime-not-exact-directory",
    );
    assert.equal(statSync(external).mode & 0o777, 0o755);
  } finally {
    for (const link of [join(temporary, "runtime", "home"), join(temporary, "runtime-link")]) {
      try {
        unlinkSync(link);
      } catch {
        // The assertion may have failed before a given symlink was created.
      }
    }
    removeTestTree(temporary);
  }
});

test("targeted TUI cwd preparation retains its runtime inode across child preparation", () => {
  const temporary = mkdtempSync(join(tmpdir(), "coherent-targeted-parent-swap-"));
  const runtimeDir = join(temporary, "runtime");
  const retainedRuntime = join(temporary, "runtime-retained");
  const external = join(temporary, "external");
  const externalHome = join(external, "home");
  try {
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(external, { mode: 0o755 });
    mkdirSync(externalHome, { mode: 0o755 });
    chmodSync(external, 0o755);
    chmodSync(externalHome, 0o755);
    writeFileSync(join(externalHome, "sentinel"), "unchanged");
    assert.throws(
      () =>
        prepareIsolatedTargetedTuiCwd(runtimeDir, {
          afterRuntimeValidated: () => {
            renameSync(runtimeDir, retainedRuntime);
            symlinkSync(external, runtimeDir, "dir");
          },
        }),
      (error) =>
        error.boundary === "targeted-tui-connect" &&
        error.observation?.reason === "runtime-identity-changed",
    );
    assert.equal(statSync(external).mode & 0o777, 0o755);
    assert.equal(statSync(externalHome).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(externalHome, "sentinel"), "utf8"), "unchanged");
  } finally {
    try {
      unlinkSync(runtimeDir);
    } catch {
      // The swap may not have completed.
    }
    if (existsSync(retainedRuntime)) renameSync(retainedRuntime, runtimeDir);
    removeTestTree(temporary);
  }
});

test("coherent-first-pane owner decorates every raw phase failure with its first boundary", async () => {
  const cases = [
    ["createTargetedNamespace", "targeted-namespace-preseeded"],
    ["startCanonicalDaemon", "targeted-daemon-ready"],
    ["openCanonicalWorkspace", "targeted-daemon-ready"],
    ["buildBeforeMeasurement", "targeted-tui-connect"],
    ["prepareTargetedTuiCwd", "targeted-tui-connect"],
    ["launchTargetedTui", "targeted-tui-connect"],
    ["proveCoherentPublication", "coherent-terminal-publication"],
    ["startWebAfterCoherentBoundary", "web-started-after-coherent-boundary"],
  ];
  for (const [failedOperation, expectedBoundary] of cases) {
    const operations = Object.fromEntries(
      cases.map(([name]) => [
        name,
        async () => {
          if (name === failedOperation) throw new Error(`failed ${name}`);
          return Object.freeze({ name });
        },
      ]),
    );
    await assert.rejects(runCoherentFirstPaneOwnerBoot(operations), (error) => {
      assert.equal(error.boundary, expectedBoundary);
      assert.match(error.message, new RegExp(`failed ${failedOperation}`, "u"));
      return true;
    });
  }
});

test("coherent proof boundary survives strict cleanup into its sealed failure bundle", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "coherent-boundary-bundle-"));
  const entry = {
    ...attemptEntry("20260818131500000-coherent-first-pane-r1-proof"),
    journey: { id: "coherent-first-pane" },
  };
  let cleaned = false;
  try {
    await assert.rejects(
      runIsolatedProductJourneyAttempt(entry, {
        preCleanup: async () => undefined,
        drive: () =>
          runCoherentFirstPaneOwnerBoot({
            createTargetedNamespace: async () => ({}),
            startCanonicalDaemon: async () => ({}),
            openCanonicalWorkspace: async () => ({}),
            buildBeforeMeasurement: async () => undefined,
            prepareTargetedTuiCwd: async () => undefined,
            launchTargetedTui: async () => ({}),
            proveCoherentPublication: async () => {
              throw new Error("target frame never published");
            },
            startWebAfterCoherentBoundary: async () => ({}),
          }),
        currentBoundary: () => "product-rig-startup",
        postCleanup: async () => {
          cleaned = true;
        },
        retryCleanup: () => assert.fail("cleanup succeeded"),
        prepareFailure: async (error, boundary) => ({
          evidence: failureEvidence(boundary, error.message),
        }),
        appendCleanupFailure: () => assert.fail("no cleanup failure"),
        publishFailure: async ({ evidence }) => {
          assert.equal(cleaned, true);
          return createProductDiagnosticBundle({ root: temporary, runId: entry.runId, evidence });
        },
        publishSuccess: () => assert.fail("proof failure cannot publish success"),
      }),
      (error) => {
        assert.ok(error instanceof ProductJourneyAttemptError);
        assert.equal(error.boundary, "coherent-terminal-publication");
        const report = JSON.parse(readFileSync(join(error.bundle.runDir, "report.json"), "utf8"));
        assert.equal(report.firstBrokenBoundary, "coherent-terminal-publication");
        return true;
      },
    );
  } finally {
    removeTestTree(temporary);
  }
});

test("clock calibration failure observation stays bounded and path-free in the sealed bundle", () => {
  const temporary = mkdtempSync(join(tmpdir(), "clock-calibration-bundle-"));
  const runId = "20260818174500000-first-key-paste-key-r1-clock";
  const failureObservation = {
    firstFailedPredicate: "clock-calibration",
    predicates: [
      {
        id: "clock-calibration",
        status: "failed",
        reason: "timeout-no-sample",
        attemptedProbes: 1,
        receivedProbes: 0,
        validProbes: 0,
        selectedProbes: 0,
        selectedProbe: null,
      },
    ],
  };
  const evidence = failureEvidence("input-clock-calibration", "clock calibration unavailable");
  evidence.report.failureObservation = failureObservation;
  evidence.alignment.failureObservation = failureObservation;
  evidence.clientState.failureObservation = failureObservation;
  try {
    const bundle = createProductDiagnosticBundle({ root: temporary, runId, evidence });
    const report = JSON.parse(readFileSync(join(bundle.runDir, "report.json"), "utf8"));
    const alignment = JSON.parse(readFileSync(join(bundle.runDir, "alignment.json"), "utf8"));
    const client = JSON.parse(readFileSync(join(bundle.runDir, "client-state.json"), "utf8"));
    assert.deepEqual(report.failureObservation, failureObservation);
    assert.deepEqual(alignment.failureObservation, failureObservation);
    assert.deepEqual(client.failureObservation, failureObservation);
    const serialized = JSON.stringify(failureObservation);
    assert.ok(serialized.length < 2_048);
    assert.doesNotMatch(serialized, /[\\/]/u);
  } finally {
    removeTestTree(temporary);
  }
});

test("coherent timeout observation is preserved in report and alignment after cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "coherent-timeout-bundle-"));
  const runId = "20260818174500000-first-key-paste-key-r1-frame";
  const generation = "226826d4-5f72-4b59-be54-9f75e85640d4";
  const failureObservation = productCoherentFrameTimeoutObservation({
    processId: "opentui:4934",
    daemonGeneration: generation,
    detailMode: "0",
    lifecycleRecords: [
      {
        phase: "generation-host-internal-snapshot-publication",
        publicationPhase: "internal-snapshot-published",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        daemonGeneration: generation,
        rendererEpoch: 1,
        monotonicMicros: 100,
      },
    ],
    traceRecords: [
      {
        type: "performance.terminal-canonical-paint",
        processId: "opentui:4934",
        clockId: "opentui-performance-now",
        generation,
        atMicros: 200,
      },
    ],
  });
  const evidence = failureEvidence("distribution-lane-fresh", "coherent frame unavailable");
  evidence.report.failureObservation = failureObservation;
  evidence.alignment.failureObservation = failureObservation;
  evidence.clientState.failureObservation = failureObservation;
  try {
    const bundle = createProductDiagnosticBundle({ root: temporary, runId, evidence });
    for (const file of ["report.json", "alignment.json", "client-state.json"]) {
      const sealed = JSON.parse(readFileSync(join(bundle.runDir, file), "utf8"));
      assert.deepEqual(sealed.failureObservation, failureObservation);
    }
    const serialized = JSON.stringify(failureObservation);
    assert.ok(serialized.length < 2_048);
    assert.doesNotMatch(serialized, /[\\/]/u);
  } finally {
    removeTestTree(temporary);
  }
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
  const selected = resolveProductJourneyPlan(
    parseProductDiagnoseOptions([
      "--journey",
      "first-key-paste",
      "--variant",
      "paste",
      "--repeat",
      "2",
    ]),
  );
  assert.deepEqual(
    selected.map(({ repetition, variant }) => [repetition, variant]),
    [
      [1, "paste"],
      [2, "paste"],
    ],
  );
  assert.throws(
    () =>
      resolveProductJourneyPlan(
        parseProductDiagnoseOptions(["--journey", "runtime-qualification", "--variant", "paste"]),
      ),
    /only valid with --journey first-key-paste/u,
  );
});

test("first-key-paste owner preserves direct phase order and named failures", async () => {
  const calls = [];
  const operations = {
    createInputNamespace: async () => (calls.push("namespace"), {}),
    startCanonicalDaemon: async () => (calls.push("daemon"), {}),
    openCanonicalWorkspace: async () => (calls.push("workspace"), {}),
    buildBeforeMeasurement: async () => calls.push("build"),
    prepareFirstTui: async () => calls.push("prepare"),
    launchFirstTui: async () => (calls.push("first-tui"), {}),
    proveNoPriorHostedInput: async () => (calls.push("baseline"), {}),
    driveFirstInput: async () => (calls.push("first-input"), {}),
    rehostDistributionTui: async () => (calls.push("rehost"), {}),
    driveDistribution: async () => (calls.push("distribution"), {}),
    startWebAfterInput: async () => (calls.push("web"), {}),
  };
  await runFirstKeyPasteOwnerBoot(operations);
  assert.deepEqual(calls, [
    "namespace",
    "daemon",
    "workspace",
    "build",
    "prepare",
    "first-tui",
    "baseline",
    "first-input",
    "rehost",
    "distribution",
    "web",
  ]);
  for (const [method, boundary] of [
    ["createInputNamespace", "first-input-namespace-ready"],
    ["startCanonicalDaemon", "first-input-daemon-ready"],
    ["launchFirstTui", "first-input-tui-coherent"],
    ["proveNoPriorHostedInput", "first-input-no-prior-hosted-input"],
    ["driveFirstInput", "first-input-causal-paint"],
    ["rehostDistributionTui", "distribution-lane-fresh"],
    ["driveDistribution", "distribution-samples"],
    ["startWebAfterInput", "first-input-web-correlation"],
  ]) {
    await assert.rejects(
      runFirstKeyPasteOwnerBoot({
        ...operations,
        [method]: async () => {
          throw new Error(`failed ${method}`);
        },
      }),
      (error) => error.boundary === boundary,
    );
  }
});

test("focus owner preserves blur before reclaim and names every failure boundary", async () => {
  const calls = [];
  const operations = {
    createFocusNamespace: async () => (calls.push("namespace"), {}),
    startCanonicalDaemon: async () => (calls.push("daemon"), {}),
    openCanonicalWorkspace: async () => (calls.push("workspace"), {}),
    buildBeforeMeasurement: async () => calls.push("build"),
    launchFocusTui: async () => (calls.push("tui-start"), {}),
    waitForFocusHostReady: async () => (calls.push("host-ready"), {}),
    waitForFocusTuiCoherent: async () => (calls.push("tui-coherent"), {}),
    proveFocusBaseline: async () => (calls.push("baseline"), {}),
    driveBlur: async () => (calls.push("blur"), {}),
    driveFocus: async () => (calls.push("focus"), {}),
    startWebAfterFocus: async () => (calls.push("web"), {}),
  };
  const framebufferObservation = Object.freeze({
    operation: "wait-for-focus-framebuffer-capture",
    reason: "semantic-chrome-missing",
    attempts: 8,
    matchCount: 0,
  });
  await assert.rejects(
    runFocusOwnerBoot({
      ...operations,
      driveBlur: async () => {
        const error = new Error("focus framebuffer capture did not stabilize");
        error.boundary = "focus-framebuffer-capture";
        error.observation = framebufferObservation;
        throw error;
      },
    }),
    (error) =>
      error.boundary === "focus-framebuffer-capture" &&
      error.observation === framebufferObservation,
  );
  calls.length = 0;
  await runFocusOwnerBoot(operations);
  assert.deepEqual(calls, [
    "namespace",
    "daemon",
    "workspace",
    "build",
    "tui-start",
    "host-ready",
    "tui-coherent",
    "baseline",
    "blur",
    "focus",
    "web",
  ]);
  for (const [method, boundary] of [
    ["createFocusNamespace", "focus-namespace-ready"],
    ["startCanonicalDaemon", "focus-daemon-ready"],
    ["buildBeforeMeasurement", "focus-tui-build"],
    ["launchFocusTui", "focus-tui-started"],
    ["waitForFocusHostReady", "focus-host-ready"],
    ["waitForFocusTuiCoherent", "focus-tui-coherent"],
    ["proveFocusBaseline", "focus-baseline"],
    ["driveBlur", "focus-blur-proved"],
    ["driveFocus", "focus-reclaim-proved"],
    ["startWebAfterFocus", "focus-web-correlation"],
  ]) {
    await assert.rejects(
      runFocusOwnerBoot({
        ...operations,
        [method]: async () => {
          throw new Error(`failed ${method}`);
        },
      }),
      (error) => error.boundary === boundary,
    );
  }
});

test("focus framebuffer failure observation is bounded and sealed before artifact gating", () => {
  const temporary = mkdtempSync(join(tmpdir(), "focus-framebuffer-bundle-"));
  const runId = "20260818211500000-focus-r1-framebuffer";
  const failureObservation = {
    operation: "wait-for-focus-framebuffer-capture",
    reason: "semantic-chrome-missing",
    attempts: 8,
    matchCount: 0,
    positions: [],
    frameRows: 44,
    frameMaxWidth: 160,
    frameHash: "a".repeat(64),
    projectedDigest: "b".repeat(64),
    nativeDigest: "c".repeat(64),
    expectedMarker: "○",
    latestTrace: [],
  };
  const evidence = failureEvidence(
    "focus-framebuffer-capture",
    "focus framebuffer capture did not stabilize",
  );
  evidence.report.failureObservation = failureObservation;
  evidence.alignment.failureObservation = failureObservation;
  evidence.clientState.failureObservation = failureObservation;
  try {
    const bundle = createProductDiagnosticBundle({ root: temporary, runId, evidence });
    for (const artifact of ["report.json", "alignment.json", "client-state.json"]) {
      const value = JSON.parse(readFileSync(join(bundle.runDir, artifact), "utf8"));
      assert.deepEqual(value.failureObservation, failureObservation);
    }
    const serialized = JSON.stringify(failureObservation);
    assert.ok(serialized.length < 2_048);
    assert.doesNotMatch(serialized, /[\\/]/u);
  } finally {
    removeTestTree(temporary);
  }
});

test("focus Web readiness failure preserves bounded structural predicates in every sealed view", () => {
  const temporary = mkdtempSync(join(tmpdir(), "focus-web-bundle-"));
  const runId = "20260820090000000-focus-r1-web";
  const failureObservation = {
    operation: "wait-for-focus-web-semantic",
    reason: "deadline",
    attempts: 41,
    elapsedMs: 60_001,
    deadlineMs: 60_000,
    firstFailedPredicate: "web-window-group-count",
    stableExactSamples: 0,
    expectedGroupCount: 2,
    latest: {
      runtimeShellExact: true,
      daemonGenerationExact: true,
      visible: true,
      focused: true,
      workspaceCount: 1,
      observedWindowCount: 1,
      activeWindowCount: 1,
      availableResourceCount: 2,
      observedTerminalCount: 1,
      connectedTerminalCount: 1,
      windowMembershipExact: false,
      terminalExact: false,
      strictQualified: false,
      digest: "a".repeat(64),
    },
    predicates: [{ id: "web-window-group-count", passed: false }],
  };
  const evidence = failureEvidence("focus-web-correlation", "focus Web readiness deadline");
  evidence.report.failureObservation = failureObservation;
  evidence.alignment.failureObservation = failureObservation;
  evidence.clientState.failureObservation = failureObservation;
  try {
    const bundle = createProductDiagnosticBundle({ root: temporary, runId, evidence });
    for (const artifact of ["report.json", "alignment.json", "client-state.json"]) {
      const value = JSON.parse(readFileSync(join(bundle.runDir, artifact), "utf8"));
      assert.deepEqual(value.failureObservation, failureObservation);
    }
    const serialized = JSON.stringify(failureObservation);
    assert.ok(serialized.length < 2_048);
    assert.doesNotMatch(serialized, /[\\/]|pane\.|window\.|workspace-/u);
  } finally {
    removeTestTree(temporary);
  }
});

test("focus host readiness failure observation remains bounded and sealed after cleanup", () => {
  const temporary = mkdtempSync(join(tmpdir(), "focus-host-ready-bundle-"));
  const runId = "20260818213000000-focus-r1-host-ready";
  const failureObservation = {
    operation: "focus-host-ready",
    reason: "host-status-timeout",
    stage: "atomic-host-display",
    attempts: 6,
    elapsedMs: 10_000,
    deadlineMs: 10_000,
    metadataPresent: true,
    metadataProcessId: 27415,
    metadataProcessAlive: true,
    currentHostIdentity: null,
    lifecycleCount: 41,
    latestLifecyclePhase: "generation-workspace-client-state",
    stderrBytes: 0,
    stderrSha256: "a".repeat(64),
  };
  const evidence = failureEvidence("focus-host-ready", "focus host readiness failed");
  evidence.report.failureObservation = failureObservation;
  evidence.alignment.failureObservation = failureObservation;
  evidence.clientState.failureObservation = failureObservation;
  try {
    const bundle = createProductDiagnosticBundle({ root: temporary, runId, evidence });
    for (const artifact of ["report.json", "alignment.json", "client-state.json"]) {
      const value = JSON.parse(readFileSync(join(bundle.runDir, artifact), "utf8"));
      assert.deepEqual(value.failureObservation, failureObservation);
    }
    assert.doesNotMatch(JSON.stringify(failureObservation), /[\\/]/u);
  } finally {
    removeTestTree(temporary);
  }
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
    () =>
      resolveProductJourneyPlan(parseProductDiagnoseOptions(["--journey", "cross-client-handoff"])),
    /not implemented: cross-client-handoff; missing evidence is a failure/u,
  );
  assert.throws(
    () => resolveProductJourneyPlan(parseProductDiagnoseOptions(["--journey", "all"])),
    /not implemented: cross-client-handoff/u,
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

test("CLI rejects the next pending journey before creating ProductRig state", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-cli-plan-"));
  try {
    const rigRoot = join(temporary, "rig");
    const diagnosticRoot = join(temporary, "diagnostics");
    const result = spawnSync(
      process.execPath,
      ["scripts/product-test-rig.mjs", "diagnose", "--journey", "cross-client-handoff", "--json"],
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
    assert.match(
      result.stderr,
      /not implemented: cross-client-handoff; missing evidence is a failure/u,
    );
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
    const distribution = {
      sampleCount: 30,
      samples: Array.from({ length: 30 }, (_, index) => ({
        traceId: `trace-${index}`,
        durationMs: index + 1,
        parserOrigin: "keyboard",
        queueBefore: { inputPending: 0, inputInFlight: 0, inputPendingBytes: 0 },
        queueAfter: { inputPending: 0, inputInFlight: 0, inputPendingBytes: 0 },
        dirtyRowProved: true,
        fenceHealth: { droppedRecords: 0, oversizedRecords: 0, failed: false },
      })),
    };
    const evidence = {
      report: {
        status: "failed",
        distribution,
      },
      alignment: { firstBrokenBoundary: "release-to-receipt" },
      timeline:
        [
          "first-input-namespace-ready",
          "first-input-daemon-ready",
          "first-input-no-prior-hosted-input",
          "first-input-causal-paint",
          "distribution-lane-fresh",
          "distribution-samples",
          "first-input-web-correlation",
        ]
          .map((phase) =>
            JSON.stringify(
              phase === "distribution-samples"
                ? { phase, ...summarizeProductInputDistribution(distribution) }
                : { phase },
            ),
          )
          .join("\n") + "\n",
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
    const sealedReport = JSON.parse(readFileSync(join(bundle.runDir, "report.json"), "utf8"));
    assert.equal(sealedReport.distribution.samples.length, 30);
    assert.equal(sealedReport.distribution.samples[29].fenceHealth.failed, false);
    const sealedTimeline = readFileSync(join(bundle.runDir, "timeline.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      sealedTimeline.map(({ phase }) => phase),
      [
        "first-input-namespace-ready",
        "first-input-daemon-ready",
        "first-input-no-prior-hosted-input",
        "first-input-causal-paint",
        "distribution-lane-fresh",
        "distribution-samples",
        "first-input-web-correlation",
      ],
    );
    assert.equal(sealedTimeline[5].sampleCount, 30);
    assert.equal("samples" in sealedTimeline[5], false);
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
  const receipt = cleanupReceipt(entry.runId, { daemon: { status: "not-started" } });
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
        currentBoundary: () => "first-input-namespace-ready",
        postCleanup: async () => {
          events.push("cleanup:after");
          return receipt;
        },
        retryCleanup: () => assert.fail("successful cleanup cannot retry"),
        prepareFailure: async (error, boundary) => {
          events.push(`prepare:${boundary}`);
          return { evidence: failureEvidence(boundary, error.message) };
        },
        appendCleanupFailure: () => assert.fail("unexpected secondary cleanup failure"),
        publishFailure: async ({ evidence }, cleanupReceiptValue) => {
          events.push("publish:failure");
          const prepared = prepareProductDiagnosticBundlePublication({
            root: temporary,
            runId: entry.runId,
            report: evidence.report,
            evidence,
            cleanupReceipt: cleanupReceiptValue,
          });
          return createProductDiagnosticBundle({
            root: temporary,
            runId: entry.runId,
            evidence: prepared.evidence,
          });
        },
        publishSuccess: () => assert.fail("startup failure cannot publish success"),
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ProductJourneyAttemptError);
    assert.equal(caught.originalCause, cause);
    assert.equal(caught.boundary, "first-input-namespace-ready");
    assert.deepEqual(events, [
      "phase:pre-attempt-cleanup",
      "cleanup:before",
      "phase:product-rig-startup",
      "drive",
      "phase:attempt-cleanup",
      "cleanup:after",
      "phase:post-cleanup-validation",
      "prepare:first-input-namespace-ready",
      "phase:failure-bundle-publication",
      "publish:failure",
    ]);
    assert.deepEqual(
      readdirSync(caught.bundle.runDir).sort(),
      [...PRODUCT_DIAGNOSTIC_BUNDLE_FILES].sort(),
    );
    const report = JSON.parse(readFileSync(join(caught.bundle.runDir, "report.json"), "utf8"));
    assert.equal(report.firstBrokenBoundary, "first-input-namespace-ready");
    assert.deepEqual(report.cleanupReceipt.daemon, { status: "not-started" });
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
    cleanupReceipt(runId, { daemon: { status: "started", instanceId: "generation" } }),
    cleanupReceipt(runId, { daemon: { status: "not-started", pid: 1002 } }),
    cleanupReceipt(runId, {
      pathAbsence: {
        runtimeRoot: true,
        tmuxSocket: true,
        hostTmuxSocket: true,
        daemonInfo: true,
        tuiRuntime: false,
      },
    }),
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
        status: "started",
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

test("post-cleanup provenance drift replaces success before immutable publication", async () => {
  const entry = attemptEntry("20260818060000000-window-lifecycle-r1-source-drift");
  const receipt = cleanupReceipt(entry.runId);
  const drift = new Error("source changed after cleanup");
  drift.boundary = "source-provenance";
  drift.observation = { reason: "source-drift", changedCount: 1 };
  await assert.rejects(
    runIsolatedProductJourneyAttempt(entry, {
      preCleanup: async () => undefined,
      drive: async () => ({ report: { status: "passed" } }),
      currentBoundary: () => "window-web-correlation",
      postCleanup: async () => receipt,
      retryCleanup: () => assert.fail("cleanup passed"),
      validateAfterCleanup: () => {
        throw drift;
      },
      prepareFailure: async (error, boundary, cleanup) => ({ error, boundary, cleanup }),
      appendCleanupFailure: () => assert.fail("no prior failure"),
      publishFailure: async (prepared, cleanup) => {
        assert.equal(prepared.error, drift);
        assert.equal(prepared.boundary, "source-provenance");
        assert.equal(prepared.cleanup, receipt);
        assert.equal(cleanup, receipt);
        return { runDir: "/immutable/source-drift" };
      },
      publishSuccess: () => assert.fail("drift cannot publish success"),
    }),
    (error) =>
      error instanceof ProductJourneyAttemptError &&
      error.boundary === "source-provenance" &&
      error.originalCause === drift,
  );
});

test("post-cleanup provenance drift remains structured beside an earlier journey failure", async () => {
  const entry = attemptEntry("20260818060000000-window-lifecycle-r1-source-drift-secondary");
  const receipt = cleanupReceipt(entry.runId);
  const journey = new Error("window action failed");
  const drift = new Error("source changed after cleanup");
  drift.boundary = "source-provenance";
  drift.observation = { reason: "source-drift", changedCount: 2 };
  await assert.rejects(
    runIsolatedProductJourneyAttempt(entry, {
      preCleanup: async () => undefined,
      drive: async () => {
        throw journey;
      },
      currentBoundary: () => "window-rename-visible",
      postCleanup: async () => receipt,
      retryCleanup: () => assert.fail("cleanup passed"),
      validateAfterCleanup: () => {
        throw drift;
      },
      prepareFailure: async (error, boundary) => ({ error, boundary }),
      appendCleanupFailure: () => assert.fail("drift is not cleanup failure text"),
      appendValidationFailure: (prepared, error) => {
        prepared.sourceProvenanceFailure = error.observation;
      },
      publishFailure: async (prepared) => {
        assert.equal(prepared.error, journey);
        assert.equal(prepared.boundary, "window-rename-visible");
        assert.deepEqual(prepared.sourceProvenanceFailure, drift.observation);
        return { runDir: "/immutable/source-drift-secondary" };
      },
      publishSuccess: () => assert.fail("journey failed"),
    }),
    (error) =>
      error instanceof ProductJourneyAttemptError &&
      error.boundary === "window-rename-visible" &&
      error.originalCause === journey,
  );
});

test("cleanup receipt builder rejects live identity or namespace residue", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-cleanup-receipt-"));
  const entry = attemptEntry("20260818060000000-configless-cold-start-r1-builder");
  const state = {
    ownerPid: 2_000_000_001,
    daemonLifecycle: "started",
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
    assert.equal(receipt.daemon.status, "started");
    assert.doesNotMatch(JSON.stringify(receipt), /cleanupToken|ownerToken|\/tmp\//u);
    mkdirSync(state.runtimeNamespace.root);
    assert.throws(() => createProductRigCleanupReceipt(entry, state, 1), /cleanup receipt/u);
    assert.throws(
      () => createProductRigCleanupReceipt(entry, { ...state, ownerPid: process.pid }, 1),
      /cleanup receipt/u,
    );
    rmSync(state.runtimeNamespace.root, { recursive: true, force: true });
    const stateWithoutDaemon = { ...state };
    delete stateWithoutDaemon.daemon;
    const notStarted = createProductRigCleanupReceipt(
      entry,
      {
        ...stateWithoutDaemon,
        daemonLifecycle: "not-started",
        ownedTuiRuntimeDirs: [join(temporary, "absent-tui")],
      },
      1,
    );
    assert.deepEqual(notStarted.daemon, { status: "not-started" });
    assert.equal(notStarted.pathAbsence.tuiRuntime, true);
    assert.throws(
      () =>
        createProductRigCleanupReceipt(
          entry,
          {
            ...state,
            daemon: { pid: 2_000_000_002 },
          },
          1,
        ),
      /source is incomplete/u,
    );
    for (const invalidDaemonState of [
      { ...state, daemonLifecycle: "not-started" },
      { ...state, daemonLifecycle: "starting" },
      { ...state, daemon: null, daemonLifecycle: "not-started" },
      { ...state, daemon: undefined, daemonLifecycle: "not-started" },
      { ...state, daemonLifecycle: "started", daemon: undefined },
    ])
      assert.throws(
        () => createProductRigCleanupReceipt(entry, invalidDaemonState, 1),
        /source is incomplete/u,
      );
    const tuiResidue = join(temporary, "tui-residue");
    mkdirSync(tuiResidue);
    assert.throws(
      () =>
        createProductRigCleanupReceipt(
          entry,
          {
            ...stateWithoutDaemon,
            daemonLifecycle: "not-started",
            ownedTuiRuntimeDirs: [tuiResidue],
          },
          1,
        ),
      /cleanup receipt/u,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("command preflight seals one explicit no-resource receipt without fabricated path absence", () => {
  const entry = attemptEntry("20260822030000000-ansi-cursor-alt-screen-r1-preflight");
  const preflight = {
    operation: "product-rig-namespace-preflight",
    stage: "ansi-initial-pane-command",
    outcome: "command-rejected",
    resourcesCreated: false,
    pathsClaimed: 0,
    daemonStarted: false,
  };
  const state = {
    status: "failed",
    ownerPid: 2_000_000_111,
    daemonLifecycle: "not-started",
    firstBrokenBoundary: "ansi-namespace-ready",
    failureObservation: preflight,
    diagnosticAttempt: {
      runId: entry.runId,
      resourcesCreated: false,
      sourceProvenance: {
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        manifestDigest: "c".repeat(64),
      },
      preflight,
    },
    cleanup: {
      requestId: "ansi-preflight-cleanup",
      status: "passed",
      cleanupToken: null,
      failures: [],
      completedAt: "2026-08-22T03:00:01.000Z",
    },
  };
  const receipt = createProductRigCleanupReceipt(entry, state, 1);
  assert.deepEqual(receipt.daemon, { status: "not-started" });
  assert.equal(receipt.scope, "preflight-no-resources");
  assert.equal(receipt.resourcesCreated, false);
  assert.equal(receipt.pathsClaimed, 0);
  assert.equal(Object.hasOwn(receipt, "pathsAbsent"), false);
  assert.equal(Object.hasOwn(receipt, "pathAbsence"), false);
  const prepared = prepareProductDiagnosticBundlePublication({
    root: "/immutable",
    runId: entry.runId,
    report: { version: 1, status: "failed", reportPath: null },
    evidence: { alignment: {} },
    cleanupReceipt: receipt,
  });
  assert.equal(prepared.report.cleanupReceipt.scope, "preflight-no-resources");
  for (const mutate of [
    (value) => (value.diagnosticAttempt.runId = `${entry.runId}-wrong`),
    (value) => (value.diagnosticAttempt.resourcesCreated = true),
    (value) => (value.diagnosticAttempt.preflight.pathsClaimed = 1),
    (value) => (value.diagnosticAttempt.preflight.outcome = "other"),
    (value) => (value.diagnosticAttempt.preflight.rawPath = "/tmp/forbidden"),
    (value) => (value.failureObservation.pathsClaimed = 1),
    (value) => (value.firstBrokenBoundary = "other"),
    (value) => (value.runtimeNamespace = {}),
    (value) => (value.cleanup.cleanupToken = "fabricated"),
  ]) {
    const invalid = structuredClone(state);
    mutate(invalid);
    assert.throws(() => createProductRigCleanupReceipt(entry, invalid, 1), /cleanup receipt/u);
  }
});

test("TUI cleanup buffers active evidence and removes every owned runtime path", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-tui-buffer-"));
  const first = join(temporary, "first");
  const active = join(temporary, "active");
  const artifacts = join(temporary, "artifacts");
  mkdirSync(first);
  mkdirSync(active);
  writeFileSync(join(first, "stderr.log"), "first stderr\n");
  writeFileSync(join(active, "stderr.log"), "active stderr\n");
  writeFileSync(join(active, "trace.jsonl"), '{"type":"trace"}\n');
  try {
    const buffered = bufferOwnedTuiRuntimeEvidence({
      ownedRuntimeDirs: [first, active],
      activeTui: { runtimeDir: active, performanceTracePath: join(active, "trace.jsonl") },
      artifactDir: artifacts,
      pathExists: existsSync,
      ensureArtifactDir: (path) => mkdirSync(path, { recursive: true }),
      moveRuntimeDir: renameSync,
    });
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(active), false);
    assert.equal(
      readFileSync(join(artifacts, "tui-runtime-1", "stderr.log"), "utf8"),
      "first stderr\n",
    );
    assert.equal(readFileSync(join(buffered.runtimeDir, "stderr.log"), "utf8"), "active stderr\n");
    assert.equal(readFileSync(buffered.performanceTracePath, "utf8"), '{"type":"trace"}\n');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("TUI evidence relocation recovers after a later move fails", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-tui-buffer-retry-"));
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  const artifacts = join(temporary, "artifacts");
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "stderr.log"), "retained stderr\n");
  writeFileSync(join(first, "trace.jsonl"), '{"retained":true}\n');
  let activeTui = { runtimeDir: first, performanceTracePath: join(first, "trace.jsonl") };
  let failSecond = true;
  const operations = {
    ownedRuntimeDirs: [first, second],
    artifactDir: artifacts,
    pathExists: existsSync,
    ensureArtifactDir: (path) => mkdirSync(path, { recursive: true }),
    moveRuntimeDir: (source, destination) => {
      if (source === second && failSecond) {
        failSecond = false;
        throw new Error("injected second move failure");
      }
      renameSync(source, destination);
    },
    onActiveTuiRelocated: (tui) => {
      activeTui = tui;
    },
  };
  try {
    assert.throws(
      () => bufferOwnedTuiRuntimeEvidence({ ...operations, activeTui }),
      /second move failure/u,
    );
    assert.equal(activeTui.runtimeDir, join(artifacts, "tui-runtime-1"));
    assert.equal(readFileSync(activeTui.performanceTracePath, "utf8"), '{"retained":true}\n');
    activeTui = bufferOwnedTuiRuntimeEvidence({ ...operations, activeTui });
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
    assert.equal(
      readFileSync(join(activeTui.runtimeDir, "stderr.log"), "utf8"),
      "retained stderr\n",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("namespace ownership is published before provenance and runtime setup failures", () => {
  for (const failure of ["provenance", "runtime"]) {
    const publications = [];
    assert.throws(
      () =>
        prepareOwnedTuiRuntime({
          ownership: { session: "session-a", runtimeNamespace: { root: "/tmp/owned" } },
          intendedTui: {
            runtimeDir: "/tmp/owned-tui",
            performanceTracePath: "/tmp/owned-tui/trace.jsonl",
          },
          publish: (value) => publications.push(value),
          resolveProvenance: () => {
            if (failure === "provenance") throw new Error("provenance failed");
            return { commit: "a".repeat(40), tree: "b".repeat(40) };
          },
          createRuntimeDir: () => {
            if (failure === "runtime") throw new Error("runtime failed");
          },
        }),
      new RegExp(`${failure} failed`, "u"),
    );
    assert.deepEqual(publications[0], {
      session: "session-a",
      runtimeNamespace: { root: "/tmp/owned" },
      tui: {
        runtimeDir: "/tmp/owned-tui",
        performanceTracePath: "/tmp/owned-tui/trace.jsonl",
      },
      ownedTuiRuntimeDirs: ["/tmp/owned-tui"],
    });
    if (failure === "runtime") {
      assert.equal(publications.length, 2);
      assert.equal(publications[1].tui.performanceTraceCommit, "a".repeat(40));
    }
  }
});

test("pre-daemon fixture failure retains non-vacuous ownership through cleanup and sealed publication", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-ansi-early-failure-"));
  const runtimeNamespace = {
    root: temporary,
    tmuxSocketPath: join(temporary, "tmux.sock"),
    hostTmuxSocketPath: join(temporary, "host.sock"),
    daemonInfoDir: join(temporary, "daemon"),
    cleanupToken: "product-test-rig:ansi-early-failure",
  };
  const state = { ownerPid: 2_000_000_101, daemonLifecycle: "not-started" };
  const publish = (value) => Object.assign(state, value);
  const entry = attemptEntry("20260822013000000-ansi-cursor-alt-screen-r1-early");
  let sealedReceipt = null;
  try {
    await assert.rejects(
      runIsolatedProductJourneyAttempt(entry, {
        preCleanup: async () => undefined,
        drive: async () => {
          prepareOwnedTuiRuntime({
            ownership: { session: "ansi-session", runtimeNamespace },
            intendedTui: {
              runtimeDir: join(temporary, "tui-ansi"),
              performanceTracePath: join(temporary, "tui-ansi", "performance.jsonl"),
            },
            publish,
            resolveProvenance: () => ({
              commit: "a".repeat(40),
              tree: "b".repeat(40),
              manifestDigest: "c".repeat(64),
            }),
            createRuntimeDir: (path) => mkdirSync(path, { recursive: true }),
          });
          const error = new Error("ANSI tmux fixture did not reach exact stable geometry");
          error.boundary = "ansi-namespace-ready";
          error.observation = { stage: "ansi-tmux-precondition", outcome: "list-timeout" };
          throw error;
        },
        currentBoundary: () => "ansi-namespace-ready",
        postCleanup: async () => {
          removeTestTree(temporary);
          Object.assign(state, {
            status: "failed",
            cleanup: {
              requestId: "ansi-cleanup-1",
              status: "passed",
              cleanupToken: runtimeNamespace.cleanupToken,
              failures: [],
              completedAt: "2026-08-22T01:30:01.000Z",
            },
          });
          return createProductRigCleanupReceipt(entry, state, 1);
        },
        retryCleanup: () => assert.fail("exact early cleanup must not retry"),
        prepareFailure: async (error, boundary, receipt) => ({ error, boundary, receipt }),
        appendCleanupFailure: () => assert.fail("cleanup passed"),
        publishFailure: async (prepared, receipt) => {
          assert.equal(prepared.boundary, "ansi-namespace-ready");
          assert.equal(prepared.error.observation.stage, "ansi-tmux-precondition");
          assert.equal(receipt, prepared.receipt);
          assert.equal(receipt.daemon.status, "not-started");
          assert.equal(receipt.pathsAbsent, true);
          assert.match(receipt.namespaceDigest, /^[0-9a-f]{64}$/u);
          sealedReceipt = receipt;
          return { runDir: "/immutable/ansi-early-failure" };
        },
        publishSuccess: () => assert.fail("fixture failure cannot publish success"),
      }),
      (error) =>
        error instanceof ProductJourneyAttemptError &&
        error.boundary === "ansi-namespace-ready" &&
        error.bundle.runDir === "/immutable/ansi-early-failure",
    );
    assert.equal(sealedReceipt?.passed, true);
    assert.doesNotMatch(JSON.stringify(sealedReceipt), /cleanupToken|ansi-session|tmux\.sock/u);
  } finally {
    removeTestTree(temporary);
  }
});

test("a partially-created distribution runtime is owned before failure and remains cleanable", () => {
  const temporary = mkdtempSync(join(tmpdir(), "product-rig-distribution-ownership-"));
  const firstRuntime = join(temporary, "tui-first-input");
  const distributionRuntime = join(temporary, "tui-input-distribution");
  const artifacts = join(temporary, "artifacts");
  mkdirSync(firstRuntime, { recursive: true });
  writeFileSync(join(firstRuntime, "first.log"), "first\n");
  const state = { ownedTuiRuntimeDirs: [firstRuntime] };
  const publish = (value) => Object.assign(state, value);
  try {
    assert.throws(
      () =>
        prepareOwnedTuiRuntime({
          ownership: {},
          intendedTui: {
            runtimeDir: distributionRuntime,
            performanceTracePath: join(distributionRuntime, "performance-trace.jsonl"),
          },
          ownedTuiRuntimeDirs: state.ownedTuiRuntimeDirs,
          publish,
          resolveProvenance: () => ({ commit: "a".repeat(40), tree: "b".repeat(40) }),
          createRuntimeDir: (runtimeDir) => {
            mkdirSync(runtimeDir, { recursive: true });
            writeFileSync(join(runtimeDir, "partial.log"), "retained partial evidence\n");
            throw new Error("partial distribution creation failed");
          },
        }),
      /partial distribution creation failed/u,
    );
    assert.deepEqual(state.ownedTuiRuntimeDirs, [firstRuntime, distributionRuntime]);
    bufferOwnedTuiRuntimeEvidence({
      ownedRuntimeDirs: state.ownedTuiRuntimeDirs,
      activeTui: state.tui,
      artifactDir: artifacts,
      pathExists: existsSync,
      ensureArtifactDir: (path) => mkdirSync(path, { recursive: true }),
      moveRuntimeDir: renameSync,
    });
    assert.equal(existsSync(firstRuntime), false);
    assert.equal(existsSync(distributionRuntime), false);
    assert.equal(
      readFileSync(join(artifacts, "tui-runtime-2", "partial.log"), "utf8"),
      "retained partial evidence\n",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("daemon identity is published before readiness can fail", async () => {
  const record = { instanceId: "generation-a", pid: 2_000_000_002 };
  const publications = [];
  await assert.rejects(
    startOwnedProductRigDaemon({
      start: async () => ({ record }),
      publish: (value) => publications.push(value),
      waitUntilReady: async () => {
        throw new Error("readiness failed");
      },
    }),
    /readiness failed/u,
  );
  assert.deepEqual(publications, [
    { daemonLifecycle: "starting" },
    { daemonLifecycle: "started", daemon: record },
  ]);
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
  const tuiRuntime = join(temporary, "tui-runtime");
  writeFileSync(socket, "owned");
  mkdirSync(tuiRuntime);
  const state = {
    status: "stopped",
    ownerPid: process.pid,
    daemon: { pid: 987_654_321 },
    ownedTuiRuntimeDirs: [tuiRuntime],
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
    assert.ok(premature.includes("tui-runtime-present"));
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
