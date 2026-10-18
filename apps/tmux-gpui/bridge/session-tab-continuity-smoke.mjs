// Isolated canonical daemon + source or explicitly selected packaged browser. No GUI, input, resize or personal discovery.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import { access, stat, readFile, rm, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { stopFixtureChild } from "./fixture-child.mjs";
// Validate an explicit package before CLI checks or any scratch allocation. Never fall back.
const app = process.env.TMUX_GPUI_TEST_APP;
const qualifyRetention = process.env.TMUX_GPUI_TEST_RETAINED === "1";
if (app !== undefined) {
  assert.ok(isAbsolute(app), "TMUX_GPUI_TEST_APP must be a nonempty absolute path");
  assert.ok((await stat(app)).isDirectory(), "TMUX_GPUI_TEST_APP must be a directory");
  for (const file of ["node", "bridge/browser.bundle.mjs", "bridge/live.bundle.mjs"]) {
    const path = join(app, "Contents/Resources", file);
    assert.ok((await stat(path)).isFile(), "Packaged helper must be a regular file");
    await access(path, file === "node" ? constants.X_OK : constants.R_OK);
  }
}
const browserNode = app === undefined ? process.execPath : join(app, "Contents/Resources/node");
const browserEntry =
  app === undefined
    ? fileURLToPath(new URL("./browser.ts", import.meta.url))
    : join(app, "Contents/Resources/bridge/browser.bundle.mjs");
const cli = process.env.TMUX_GPUI_TEST_CLI;
assert.ok(cli && isAbsolute(cli), "Explicit absolute private CLI required");
assert.ok((await stat(cli)).isFile());
await access(cli, constants.R_OK);
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
const fleet = await createScratchFleet({
  sessions: 2,
  windowsPerSession: 1,
  slug: "session-tab-continuity",
});
const canonical = join(fleet.root, "canonical"),
  temporary = join(fleet.root, "tmp");
const env = {
  ...process.env,
  ...fleet.environment,
  TMUX: "",
  TMPDIR: temporary,
  TMUX_IDE_DAEMON_INFO_DIR: canonical,
  TMUX_IDE_REGISTRY_DIR: canonical,
  TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
};
delete env.TMUX_IDE_TMUX_SOCKET_NAME;
const tmux = (...args) =>
  execFileSync(env.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
const source = () =>
  tmux("list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}")
    .trim()
    .split("\n")
    .sort();
let before;
let ownedCleanupPassed = false;
let identityRecreationPassed = false;
let rapidSwitchPassed = false;
let daemon,
  browser,
  latest,
  record,
  fatal,
  closing = false,
  buffer = "",
  stderrBytes = 0,
  request = 0,
  publications = 0;
const failures = [];
const switches = [];
let measurement = null;
let firstRetainedRequest = null;
let expectedPreviewSession = null;
const coherentFingerprints = new Map();
const fingerprint = (snapshot) =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
let fingerprintChecks = 0;
let appearanceInvalidationPassed = false;
let homeCancellationRequest = null;
let expiryPassed = false,
  homeCancellationPassed = false;
// Bounded metadata only: no frame contents, canonical keys, capability UUIDs or credentials.
const trace = [];
let phase = "startup",
  lastTrace = "";
const traceState = (event) => {
  const value = {
    phase,
    event,
    request: latest?.request,
    sequence: latest?.sequence,
    catalog: latest?.sessionCatalogComplete,
    frame: !!latest?.snapshot,
    retainedPreview: !!latest?.retainedPreview,
    input: latest?.inputReady === true,
    tabs: latest?.sessionTabs?.rows.length ?? 0,
    pendingTab: !!latest?.sessionTabs?.pending,
  };
  const signature = JSON.stringify({ ...value, sequence: undefined });
  if (signature !== lastTrace) {
    lastTrace = signature;
    if (trace.length === 256) trace.shift();
    trace.push(value);
  }
};
const deadline = Date.now() + 180000;
const cancel = () => {
  fatal ??= new Error("Tab continuity fixture cancelled");
};
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const own = (child) => {
  child.on("error", () => {
    fatal ??= new Error("Owned child spawn failed");
  });
  child.on("exit", () => {
    if (!closing) fatal ??= new Error("Owned child exited early");
  });
  return child;
};
async function until(predicate, timeout = 45000) {
  const phaseDeadline = Date.now() + timeout;
  for (;;) {
    if (fatal) throw fatal;
    if (await predicate()) return;
    assert.ok(
      Date.now() < Math.min(deadline, phaseDeadline),
      `Tab continuity phase deadline (${phase})`,
    );
    await delay(20);
  }
}
const send = (value) => {
  traceState(`send:${value.type}:${value.request ?? "presence"}`);
  browser.stdin.write(JSON.stringify(value) + "\n");
};
async function completeCatalog(expected) {
  traceState("await-catalog");
  await until(
    () =>
      latest?.request === request &&
      latest.sessionCatalogComplete === true &&
      latest.preferredPane &&
      latest.selectedSession === expected.sessionId,
  );
  traceState("catalog-ready");
  assert.equal(latest.inputReady, false);
  const pane = latest.preferredPane;
  assert.ok(latest.panes.some((p) => p.id === pane));
  send({ type: "pane", request: ++request, id: pane });
  await until(
    () =>
      latest?.request === request &&
      latest.selectedSession === expected.sessionId &&
      latest.selectedPane === pane &&
      latest.snapshot &&
      latest.inputReady === true,
  );
  traceState("live-ready");
  await until(() => !!latest.sessionTabs?.active);
  return pane;
}
try {
  await mkdir(canonical, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  before = source();
  daemon = own(
    spawn(process.execPath, [cli, "--headless"], {
      env,
      cwd: fleet.projectDir,
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  daemon.stderr.on("data", (data) => {
    stderrBytes += data.length;
    if (stderrBytes > 65536) fatal ??= new Error("Diagnostic bound exceeded");
  });
  daemon.stderr.on("error", cancel);
  await until(async () => {
    try {
      record = JSON.parse(await readFile(canonical + "/daemon.json", "utf8"));
      return record.pid === daemon.pid;
    } catch {
      return false;
    }
  });
  browser = own(
    spawn(
      browserNode,
      [
        ...(app === undefined ? ["--import", import.meta.resolve("tsx")] : []),
        browserEntry,
        "--local",
      ],
      { env, stdio: ["pipe", "pipe", "pipe"], ...(app === undefined ? {} : { cwd: fleet.root }) },
    ),
  );
  for (const stream of [browser.stdin, browser.stdout, browser.stderr]) stream.on("error", cancel);
  browser.stderr.on("data", (data) => {
    stderrBytes += data.length;
    if (stderrBytes > 65536) fatal ??= new Error("Diagnostic bound exceeded");
  });
  browser.stdout.setEncoding("utf8");
  browser.stdout.on("data", (data) => {
    try {
      buffer += data;
      assert.ok(Buffer.byteLength(buffer) <= 8 * 1024 * 1024);
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        assert.ok(++publications <= 20000, "Publication count overflow");
        latest = JSON.parse(buffer.slice(0, end));
        traceState("publication");
        if (firstRetainedRequest === latest.request) {
          assert.ok(latest.retainedPreview, "First activation publication must retain pixels");
          firstRetainedRequest = null;
        }
        if (homeCancellationRequest !== null && latest.request >= homeCancellationRequest) {
          assert.equal(
            latest.retainedPreview,
            null,
            "Home cancellation must not resurrect preview",
          );
          assert.equal(latest.inputReady, false);
        }
        if (latest.snapshot && latest.inputReady && latest.selectedSession)
          coherentFingerprints.set(latest.selectedSession, fingerprint(latest.snapshot));
        if (latest.retainedPreview) {
          assert.ok(latest.retainedPreview.snapshot);
          assert.ok(expectedPreviewSession && coherentFingerprints.has(expectedPreviewSession));
          assert.equal(
            fingerprint(latest.retainedPreview.snapshot),
            coherentFingerprints.get(expectedPreviewSession),
            "Retained pixels must match the target's last coherent frame",
          );
          fingerprintChecks++;
          assert.equal(latest.snapshot, null, "Retained preview is not a live frame");
          assert.equal(latest.inputReady, false);
          assert.equal(latest.selectedPane, null);
          assert.equal(latest.copyRegion, null);
          assert.deepEqual(latest.regions, []);
          assert.equal(latest.resizeToken, null);
          assert.equal(latest.splitLayout, null);
          assert.equal(latest.splitGesture, null);
          assert.equal(latest.resizeGesture, null);
          assert.equal(latest.resizeGestureSupported, false);
          assert.equal(latest.paneActions, null);
        }
        if (measurement && latest.request >= measurement.request) {
          measurement.publications++;
          if (latest.retainedPreview) measurement.retainedPreviewPublications++;
          else if (latest.snapshot) measurement.liveFramePublications++;
          else measurement.emptyFramePublications++;
          if (latest.snapshot && !latest.inputReady) measurement.nonReadyFramePublications++;
        }
        buffer = buffer.slice(end + 1);
      }
    } catch {
      fatal ??= new Error("Invalid publication");
    }
  });
  browser.stdout.on("end", () => {
    if (!closing || buffer.length)
      fatal ??= new Error("Browser publication stream ended unexpectedly");
  });
  send({ type: "presence", active: true, revision: 1 });
  await until(
    () =>
      latest?.presenceRevision === 1 &&
      latest.home?.phase === "live" &&
      latest.fleet?.preferences?.phase === "ready" &&
      latest.fleet.groups.find((g) => g.id === "local")?.sessions.length === 2 &&
      latest.sessions.length === 2,
  );
  const [a, b] = latest.fleet.groups.find((g) => g.id === "local").sessions;
  assert.ok(a.selection && b.selection);
  assert.notEqual(a.id, b.id);
  phase = "open-a";
  send({ type: "session", request: ++request, id: a.sessionId });
  await completeCatalog(a);
  const aTab = latest.sessionTabs.active;
  phase = "open-b";
  const freshB = latest.fleet.groups
    .find((g) => g.id === "local")
    .sessions.find((s) => s.id === b.id);
  assert.ok(freshB?.selection);
  send({ type: "fleet-session", request: ++request, selection: freshB.selection });
  await completeCatalog(b);
  const bTab = latest.sessionTabs.active;
  assert.notEqual(aTab, bTab);
  // Start a measured A/B/A round-trip only after both retained tabs exist.
  for (const [name, tab, target] of [
    ["a", aTab, a],
    ["b", bTab, b],
    ["a", aTab, a],
  ]) {
    phase = `activate-${name}`;
    const tabs = latest.sessionTabs;
    const row = tabs.rows.find((row) => row.id === tab);
    assert.ok(row?.available && row.activate);
    const fromRequest = latest.request;
    measurement = {
      target: name,
      request: ++request,
      publications: 0,
      emptyFramePublications: 0,
      liveFramePublications: 0,
      retainedPreviewPublications: 0,
      nonReadyFramePublications: 0,
    };
    expectedPreviewSession = target.sessionId;
    const started = performance.now();
    send({
      type: "session-tab",
      request,
      fromRequest,
      revision: tabs.revision,
      action: row.activate,
    });
    await completeCatalog(target);
    assert.equal(latest.sessionTabs.active, tab);
    if (qualifyRetention) assert.ok(measurement.retainedPreviewPublications > 0);
    switches.push({
      ...measurement,
      freshReady: true,
      elapsedMs: Math.round(performance.now() - started),
    });
    measurement = null;
  }
  if (qualifyRetention) {
    const activateWithoutPane = async (tab, target) => {
      const tabs = latest.sessionTabs;
      const row = tabs.rows.find((row) => row.id === tab);
      assert.ok(row?.available && row.activate);
      const fromRequest = latest.request;
      expectedPreviewSession = target.sessionId;
      firstRetainedRequest = ++request;
      send({
        type: "session-tab",
        request,
        fromRequest,
        revision: tabs.revision,
        action: row.activate,
      });
      await until(
        () =>
          latest?.request === request &&
          latest.sessionCatalogComplete &&
          latest.selectedSession === target.sessionId &&
          latest.preferredPane,
      );
      assert.equal(firstRetainedRequest, null);
      assert.ok(latest.retainedPreview, "Metadata completion must retain pending preview");
      assert.equal(latest.inputReady, false);
    };
    phase = "retained-expiry";
    await activateWithoutPane(bTab, b);
    await until(() => latest.request === request && !latest.retainedPreview, 6000);
    assert.equal(latest.inputReady, false);
    assert.equal(latest.snapshot, null);
    expiryPassed = true;
    // Finish the normal continuation to regain an active tab before a separate cancellation.
    await completeCatalog(b);
    phase = "retained-home-cancel";
    await activateWithoutPane(aTab, a);
    homeCancellationRequest = ++request;
    send({ type: "home", request });
    await until(() => latest?.request === request && latest.surface === "home");
    const holdUntil = Date.now() + 5500;
    await until(() => Date.now() >= holdUntil, 6000);
    assert.equal(latest.retainedPreview, null);
    assert.equal(latest.inputReady, false);
    homeCancellationPassed = true;
    homeCancellationRequest = null;
    phase = "appearance-warm-b";
    await activateWithoutPane(bTab, b);
    await completeCatalog(b);
    phase = "retained-appearance-invalidation";
    await activateWithoutPane(aTab, a);
    send({ type: "theme", id: "dracula" });
    await until(() => latest?.appearance?.selected === "dracula");
    assert.equal(latest.retainedPreview, null);
    assert.equal(latest.inputReady, false);
    assert.equal(latest.snapshot, null);
    appearanceInvalidationPassed = true;
    assert.ok(fingerprintChecks > 0);
    // Warm both caches under the changed appearance before testing cancellation/identity.
    await completeCatalog(a);
    phase = "identity-warm-b";
    let tabs = latest.sessionTabs;
    send({
      type: "session-tab",
      request: ++request,
      fromRequest: latest.request,
      revision: tabs.revision,
      action: tabs.rows.find((r) => r.id === bTab).activate,
    });
    await completeCatalog(b);
    phase = "rapid-a-b";
    await activateWithoutPane(aTab, a);
    // Supersede A before its pane continuation; only B may become live.
    await activateWithoutPane(bTab, b);
    await completeCatalog(b);
    assert.equal(latest.selectedSession, b.sessionId);
    rapidSwitchPassed = true;
    phase = "delete-pending-a";
    const expectedSurvivor = tmux(
      "list-panes",
      "-s",
      "-t",
      `=${b.name}`,
      "-F",
      "#{pane_id}|#{pane_pid}|#{pane_birth_id}",
    )
      .trim()
      .split("\n")
      .sort();
    await activateWithoutPane(aTab, a);
    fleet.killSession(a.name);
    await until(
      () =>
        !latest.retainedPreview &&
        latest.sessionTabs?.rows.find((r) => r.id === aTab)?.available === false,
    );
    assert.equal(latest.inputReady, false);
    assert.equal(latest.snapshot, null);
    phase = "recreate-same-name-a";
    fleet.createSession(a.name);
    await until(() =>
      latest.fleet?.groups
        .find((g) => g.id === "local")
        ?.sessions.some((s) => s.name === a.name && s.sessionId !== a.sessionId),
    );
    const replacement = latest.fleet.groups
      .find((g) => g.id === "local")
      .sessions.find((s) => s.name === a.name);
    assert.notEqual(replacement.id, a.id);
    assert.notEqual(replacement.sessionId, a.sessionId);
    tabs = latest.sessionTabs;
    const old = tabs.rows.find((r) => r.id === aTab);
    assert.equal(old.available, false);
    const priorRequest = latest.request;
    send({
      type: "session-tab",
      request: ++request,
      fromRequest: priorRequest,
      revision: tabs.revision,
      action: old.activate,
    });
    await until(
      () =>
        latest.sessionTabResult?.request === request &&
        latest.sessionTabResult.outcome === "rejected",
    );
    assert.equal(latest.request, priorRequest);
    assert.equal(latest.retainedPreview, null);
    assert.equal(latest.inputReady, false);
    assert.deepEqual(
      tmux("list-panes", "-s", "-t", `=${b.name}`, "-F", "#{pane_id}|#{pane_pid}|#{pane_birth_id}")
        .trim()
        .split("\n")
        .sort(),
      expectedSurvivor,
    );
    identityRecreationPassed = true;
  }
  if (!qualifyRetention)
    assert.deepEqual(source(), before, "Source pane births and processes survive tab navigation");
} catch (error) {
  failures.push(error);
} finally {
  closing = true;
  let childCleanupFailed = false;
  for (const cleanup of [
    () => browser && stopFixtureChild(browser),
    () => daemon && stopFixtureChild(daemon),
  ])
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
      childCleanupFailed = true;
    }
  // Bounded cleanup addresses only the server created by this fixture. Retain its root on failure.
  try {
    tmux("kill-server");
    if (!childCleanupFailed) {
      await rm(fleet.root, { recursive: true, force: true });
      ownedCleanupPassed = true;
    }
  } catch (error) {
    failures.push(error);
  }
}
if (fatal && !failures.includes(fatal)) failures.push(fatal);
process.off("SIGINT", cancel);
process.off("SIGTERM", cancel);
const result = {
  passed: failures.length === 0,
  sourceBrowser: app === undefined,
  packagedBrowser: app !== undefined,
  canonicalDaemon: true,
  tabRoundTrip: "A/B/A",
  retentionQualification: qualifyRetention,
  retainedExpiry: expiryPassed,
  retainedHomeCancellation: homeCancellationPassed,
  retainedAppearanceInvalidation: appearanceInvalidationPassed,
  targetFingerprintChecks: fingerprintChecks,
  rapidSwitch: rapidSwitchPassed,
  sameNameRecreationRejected: identityRecreationPassed,
  intentionallyRecreatedTarget: qualifyRetention,
  switches,
  sourceBirthsPreserved: !qualifyRetention && failures.length === 0,
  survivorBirthsPreserved: qualifyRetention && identityRecreationPassed,
  inputSent: false,
  resizeSent: false,
  nativeUi: false,
  ownedCleanup: ownedCleanupPassed,
  trace,
};
console.log(JSON.stringify(result));
if (failures.length) process.exitCode = 1;
