#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, arch, cpus, platform, release, tmpdir, version as osVersion } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  PERFORMANCE_STAGES,
  REFERENCE_REPORT_VERSION,
  gitSourceIdentity,
  sourceArtifactDigest,
  summarize,
  theilSenSlope,
  validateReferenceReport,
} from "./lib/performance-reference-report.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(
  readFileSync(resolve(root, "performance/reference-budgets.json"), "utf8"),
);
const options = parseOptions(process.argv.slice(2));
const reportPath = resolve(root, options.report);
const lifecyclePath = resolve(root, ".tasks/tui-testdrive/performance.jsonl");
const testdriveStatePath = resolve(root, ".tasks/tui-testdrive/home/app-state.json");
const target = `tmux-ide-reference-${process.pid}`;
const referenceProjectDir = mkdtempSync(join(tmpdir(), `${target}-`));
const source = gitSourceIdentity(root);

if (source.dirty)
  throw new Error(
    "Reference measurements require a clean worktree so commit/tree provenance is reproducible",
  );
if (platform() !== budgets.referenceHost.platform || arch() !== budgets.referenceHost.arch)
  throw new Error(
    `Reference measurements require ${budgets.referenceHost.platform}/${budgets.referenceHost.arch}; got ${platform()}/${arch()}`,
  );
preflightCanonicalDaemon();

if (options.build) run("pnpm", ["build:tui"]);
process.env.TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON = "1";
rmSync(testdriveStatePath, { force: true });
const provenance = {
  host: hostname(),
  cpuModel: cpus()[0]?.model ?? "unknown",
  arch: arch(),
  platform: platform(),
  osRelease: release(),
  osVersion: osVersion(),
  nodeVersion: process.version,
  bunVersion: commandVersion("bun", ["--version"]),
  tmuxVersion: commandVersion("tmux", ["-V"]),
  commit: source.commit,
  tree: source.tree,
  dirty: source.dirty,
};

let measurements;
let succeeded = false;
try {
  mkdirSync(join(referenceProjectDir, ".tmux-ide"), { recursive: true });
  writeFileSync(
    join(referenceProjectDir, ".tmux-ide/workspace.yml"),
    [
      "version: 1",
      `name: ${target}`,
      "terminal:",
      "  rows:",
      "    - panes:",
      "        - title: Echo",
      "          focus: true",
      `          command: ${JSON.stringify(`/bin/zsh -f -c 'stty raw -echo; while read -rk 1 ch; do print -rn -- "$ch"; done'`)}`,
      "",
    ].join("\n"),
  );
  await registerReferenceProject();
  const readiness = await launchReferenceWorkspace();
  qualifyBunPaneStream(readiness);
  const startup = await measureStartup();
  const inputTrace = options.inputTrace ?? (await collectInputTrace());
  measurements = {
    startup,
    inputToPaint: measureInputToPaint(inputTrace),
    memory: measureMemory(),
  };
  succeeded = true;
} finally {
  if (!options.keepOnFailure || succeeded) {
    spawnSync("node", ["scripts/tui-testdrive.mjs", "stop"], { cwd: root, stdio: "ignore" });
    spawnSync("tmux", ["kill-session", "-t", `=${target}`], { stdio: "ignore" });
    await unregisterReferenceProject().catch(() => undefined);
    rmSync(referenceProjectDir, { recursive: true, force: true });
  } else {
    process.stderr.write(
      `Reference fixture retained after failure:\n` +
        `  project: ${referenceProjectDir}\n` +
        `  session: ${target}\n` +
        `  TUI: tmux attach -t _tmux-ide-testdrive\n`,
    );
  }
}

async function registerReferenceProject() {
  const daemon = readDaemonInfo();
  const response = await fetch(`http://${daemon.bindHostname}:${daemon.port}/api/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      dir: referenceProjectDir,
      name: target,
      // The canonical daemon must see the fixture so this measures the real
      // product path, but a benchmark crash must never bookmark it for the
      // user. Volatile registrations are live-only daemon state.
      persistence: "volatile",
    }),
  });
  if (!response.ok)
    throw new Error(
      `Unable to register reference project (${response.status}): ${await response.text()}`,
    );
}

async function launchReferenceWorkspace() {
  const daemon = readDaemonInfo();
  const response = await fetch(
    `http://${daemon.bindHostname}:${daemon.port}/api/v2/action/project.launch`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: target }),
    },
  );
  const result = await response.json();
  if (!response.ok || result?.ok !== true)
    throw new Error(
      `Unable to launch reference workspace (${response.status}): ${JSON.stringify(result)}`,
    );
  const deadline = Date.now() + 10_000;
  let lastCatalog = null;
  let lastPanes = null;
  let lastApplicationShell = null;
  while (Date.now() < deadline) {
    const catalogResponse = await fetch(
      `http://${daemon.bindHostname}:${daemon.port}/api/resources/workspace-catalog?version=2`,
      { headers: { authorization: `Bearer ${daemon.authToken}` } },
    );
    const catalog = await responseJson(catalogResponse);
    lastCatalog = { status: catalogResponse.status, body: catalog };
    const published = catalog?.intents?.some(
      ({ workspaceName, sessionName, availability }) =>
        workspaceName === target && sessionName === target && availability === "live",
    );
    if (published) {
      const panesResponse = await fetch(
        `http://${daemon.bindHostname}:${daemon.port}/api/project/${encodeURIComponent(target)}/panes`,
        { headers: { authorization: `Bearer ${daemon.authToken}` } },
      );
      const paneResource = await responseJson(panesResponse);
      lastPanes = { status: panesResponse.status, body: paneResource };
      if (panesResponse.ok) {
        const applicationShellResponse = await fetch(
          `http://${daemon.bindHostname}:${daemon.port}/api/project/${encodeURIComponent(target)}/application-shell?version=3`,
          { headers: { authorization: `Bearer ${daemon.authToken}` } },
        );
        const applicationShell = await responseJson(applicationShellResponse);
        lastApplicationShell = {
          status: applicationShellResponse.status,
          body: applicationShell,
        };
        const resources = applicationShell?.resource?.terminalInventory?.resources;
        const attachable = Array.isArray(resources)
          ? resources.filter(
              ({ attachability }) =>
                attachability?.status === "available" &&
                typeof attachability.semanticPaneId === "string" &&
                attachability.semanticPaneId.length > 0,
            )
          : [];
        if (
          Array.isArray(paneResource.panes) &&
          paneResource.panes.length > 0 &&
          applicationShellResponse.ok &&
          attachable.length > 0
        ) {
          return {
            catalogWorkspace: catalog.workspaces.find(
              ({ workspaceName, sessionName }) =>
                workspaceName === target && sessionName === target,
            ),
            panes: paneResource.panes,
            terminalResources: attachable,
          };
        }
      }
    }
    await delay(25);
  }
  throw new Error(
    `Canonical reference workspace did not publish an attachable application-shell terminal.\n` +
      diagnosticJson({
        catalog: lastCatalog,
        panes: lastPanes,
        applicationShell: lastApplicationShell,
      }),
  );
}

async function responseJson(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { invalidJson: text };
  }
}

function diagnosticJson(value) {
  return JSON.stringify(value, null, 2);
}

async function unregisterReferenceProject() {
  const daemon = readDaemonInfo();
  await fetch(
    `http://${daemon.bindHostname}:${daemon.port}/api/projects/${encodeURIComponent(target)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${daemon.authToken}` },
    },
  );
}

function qualifyBunPaneStream(readiness) {
  const semanticPaneId = readiness.terminalResources[0]?.attachability?.semanticPaneId;
  if (!semanticPaneId) throw new Error("Reference readiness omitted its semantic pane identity");
  const result = spawnSync("bun", ["scripts/performance-reference-pane-stream.ts"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      TMUX_IDE_REFERENCE_WORKSPACE: target,
      TMUX_IDE_REFERENCE_PANE: semanticPaneId,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `Bun pane-stream live preflight failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function readDaemonInfo() {
  const path = resolve(process.env.HOME ?? "", ".tmux-ide/daemon.json");
  const daemon = JSON.parse(readFileSync(path, "utf8"));
  if (!daemon.authToken || !daemon.port || !daemon.bindHostname)
    throw new Error("Reference qualification requires the canonical daemon");
  return daemon;
}

function preflightCanonicalDaemon() {
  const daemon = readDaemonInfo();
  const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const commitTimestamp = Date.parse(
    commandOutput("git", ["show", "-s", "--format=%cI", source.commit]),
  );
  const daemonTimestamp = Date.parse(daemon.startedAt ?? "");
  if (daemon.productVersion !== packageVersion)
    throw new Error(
      `Canonical daemon product ${daemon.productVersion ?? "unknown"} does not match checkout ${packageVersion}`,
    );
  if (!Number.isFinite(daemonTimestamp) || daemonTimestamp < commitTimestamp)
    throw new Error(
      "Canonical daemon predates the measured commit. Rebuild/restart the daemon from this clean checkout before running reference qualification.",
    );
}
const report = {
  version: REFERENCE_REPORT_VERSION,
  measuredAt: new Date().toISOString(),
  status: Object.values(measurements).some(({ status }) => status === "failed")
    ? "failed"
    : Object.values(measurements).every(({ status }) => status === "passed")
      ? "passed"
      : "incomplete",
  provenance,
  measurements,
};
validateReferenceReport(report, source);
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`Reference qualification: ${report.status}\nReport: ${reportPath}\n`);
if (report.status === "failed" || (options.requireComplete && report.status !== "passed"))
  process.exitCode = 1;

async function measureStartup() {
  const rawSamples = [];
  for (let ordinal = 0; ordinal < options.startupSamples; ordinal += 1) {
    rmSync(lifecyclePath, { force: true });
    run("node", [
      "scripts/tui-testdrive.mjs",
      "start",
      "--target",
      target,
      "--cols",
      "160",
      "--rows",
      "44",
    ]);
    const marks = await waitForLifecycleMarks([
      "entry-start",
      "root-import-end",
      "renderer-create-end",
      "solid-mounted",
      "first-frame",
      "first-terminal-frame",
    ]);
    rawSamples.push({
      ordinal,
      class: ordinal === 0 ? "process-cold" : "warm-repeat",
      phases: Object.fromEntries(marks.map((mark) => [mark.phase, mark.elapsedMs])),
      firstUsableMs: Math.max(
        ...marks
          .filter(({ phase }) => phase === "first-frame" || phase === "first-terminal-frame")
          .map(({ elapsedMs }) => elapsedMs),
      ),
    });
    run("node", ["scripts/tui-testdrive.mjs", "stop"]);
  }
  const cold = summarize(
    rawSamples.filter(({ class: kind }) => kind === "process-cold").map((x) => x.firstUsableMs),
  );
  const warmValues = rawSamples
    .filter(({ class: kind }) => kind === "warm-repeat")
    .map(({ firstUsableMs }) => firstUsableMs);
  const warm = warmValues.length > 0 ? summarize(warmValues) : cold;
  const passed =
    cold.p95 <= budgets.startup.processColdFirstUsableP95Ms &&
    warm.p95 <= budgets.startup.warmFirstUsableP95Ms;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary: { processColdFirstUsableMs: cold, warmFirstUsableMs: warm },
    budgets: budgets.startup,
    semantics: {
      processCold: "first fresh process after one production TUI build; OS caches are not purged",
      warmRepeat: "subsequent fresh processes using the same binary and ordinary warm OS caches",
      firstUsable:
        "later of the first OpenTUI frame and the first acknowledged native frame containing a non-empty semantic terminal layout",
    },
  };
}

async function collectInputTrace() {
  const tracePath = resolve(root, "artifacts/performance-reference-trace.jsonl");
  rmSync(tracePath, { force: true });
  const traceEnvironment = {
    ...process.env,
    TMUX_IDE_PERFORMANCE_TRACE_LOG: tracePath,
    TMUX_IDE_PERFORMANCE_TRACE_COMMIT: source.commit,
    TMUX_IDE_PERFORMANCE_TRACE_TREE: source.tree,
  };
  run(
    "node",
    [
      "scripts/tui-testdrive.mjs",
      "start",
      "--target",
      target,
      "--cols",
      "160",
      "--rows",
      "44",
      "--debug",
    ],
    traceEnvironment,
  );
  try {
    // `--target` starts on Terminals, but the first live pane can claim input
    // while the shell is still settling. Re-assert the workspace mode only
    // after the semantic Echo pane is visibly ready. F2 is the product-owned
    // terminal-focus command; a pointer coordinate would couple this gate to
    // adaptive sidebar, dock, and one-pane geometry.
    const canvasFrame = await waitForCapturedFrame(
      (frame) =>
        frame.includes(target) && frame.includes("TERMINAL INPUT") && frame.includes("Echo"),
      10_000,
    );
    tmux(["send-keys", "-t", "=_tmux-ide-testdrive:0.0", "F2"]);
    await waitForCapturedFrame(
      (frame) =>
        frame.includes(target) && frame.includes("TERMINAL INPUT") && frame.includes("Echo"),
      2_000,
    );
    await delay(50);
    for (let ordinal = 0; ordinal < options.inputSamples; ordinal += 1) {
      const prior = countCompletedLocalTraces(tracePath);
      // Keep the measured host free of a second Node startup/teardown per
      // keystroke. The trace clock begins inside OpenTUI, but that short-lived
      // wrapper still competes with the render process after injecting input.
      tmux(["send-keys", "-t", "=_tmux-ide-testdrive:0.0", "-l", ordinal % 2 === 0 ? "x" : "y"]);
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && countCompletedLocalTraces(tracePath) <= prior) await delay(5);
      if (countCompletedLocalTraces(tracePath) <= prior)
        throw new Error(
          `Timed out waiting for input-to-paint sample ${ordinal + 1}\n\n` +
            `--- initial canvas ---\n${canvasFrame}\n\n` +
            `--- current frame ---\n${captureTestdrive()}\n\n` +
            `--- stderr ---\n${readFileSync(resolve(root, ".tasks/tui-testdrive/stderr.log"), "utf8")}`,
        );
    }
  } finally {
    run("node", ["scripts/tui-testdrive.mjs", "stop"]);
  }
  return tracePath;
}

async function waitForCapturedFrame(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    frame = captureTestdrive();
    if (predicate(frame)) return frame;
    await delay(25);
  }
  throw new Error(`Timed out waiting for reference canvas\n\n${frame}`);
}

function captureTestdrive() {
  const result = spawnSync("node", ["scripts/tui-testdrive.mjs", "capture"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 ? result.stdout : `(capture unavailable: ${result.stderr.trim()})`;
}

function countCompletedLocalTraces(path) {
  if (!existsSync(path)) return 0;
  return readJsonLines(path).filter(
    ({ type, stage }) => type === "performance.stage" && stage === "paint",
  ).length;
}

function measureInputToPaint(inputPath) {
  if (!inputPath)
    return {
      status: "not-measured",
      reason:
        "Pass --input-trace <jsonl> from the opt-in production trace sink; timings are never synthesized.",
      budgets: budgets.inputToPaint,
    };
  const absolutePath = resolve(root, inputPath);
  const events = readJsonLines(absolutePath);
  const header = events.find(({ type }) => type === "performance.trace.header");
  if (!header || header.commit !== source.commit || header.tree !== source.tree)
    throw new Error("Input trace header does not match the measured source commit/tree");
  const groups = new Map();
  for (const event of events) {
    if (event.type !== "performance.stage") continue;
    validateStageEvent(event);
    const group = groups.get(event.traceId) ?? [];
    group.push(event);
    groups.set(event.traceId, group);
  }
  const rawSamples = [];
  for (const [traceId, spans] of groups) {
    const input = spans.find(({ stage }) => stage === "input");
    const paint = spans.find(({ stage }) => stage === "paint");
    if (!input || !paint) continue;
    if (
      input.processId !== paint.processId ||
      input.clockId !== paint.clockId ||
      input.clockKind !== paint.clockKind ||
      input.clockKind !== "performance-now"
    )
      throw new Error(`Trace ${traceId} input/paint endpoints do not share one client clock`);
    if (input.endedAtMicros > paint.startedAtMicros)
      throw new Error(`Trace ${traceId} paint begins before input is consumed`);
    rawSamples.push({
      traceId,
      authority: input.authority ?? paint.authority ?? null,
      localInputToConsumedPaintMs: (paint.endedAtMicros - input.startedAtMicros) / 1_000,
      stages: Object.fromEntries(
        PERFORMANCE_STAGES.flatMap((stage) => {
          const span = spans.find((candidate) => candidate.stage === stage);
          return span ? [[stage, (span.endedAtMicros - span.startedAtMicros) / 1_000]] : [];
        }),
      ),
    });
  }
  const summary = summarize(
    rawSamples.map(({ localInputToConsumedPaintMs }) => localInputToConsumedPaintMs),
  );
  const stageSummaries = Object.fromEntries(
    PERFORMANCE_STAGES.map((stage) => {
      const values = rawSamples.flatMap(({ stages }) =>
        typeof stages[stage] === "number" ? [stages[stage]] : [],
      );
      return [stage, values.length > 0 ? summarize(values) : null];
    }),
  );
  const passed =
    rawSamples.length >= budgets.inputToPaint.minimumSamples &&
    summary.p95 <= budgets.inputToPaint.p95Ms;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary: { localInputToConsumedPaintMs: summary, stages: stageSummaries },
    budgets: budgets.inputToPaint,
    sourceArtifact: { path: absolutePath, sha256: sourceArtifactDigest(absolutePath) },
  };
}

function measureMemory() {
  const result = spawnSync("bun", ["--expose-gc", "scripts/performance-reference-memory.ts"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
    env: {
      ...process.env,
      TMUX_IDE_REFERENCE_MEMORY_SAMPLES: String(options.memorySamples),
    },
  });
  if (result.status !== 0)
    throw new Error(`Reference memory worker failed: ${(result.stderr ?? result.stdout).trim()}`);
  const worker = JSON.parse(result.stdout.trim());
  const rawSamples = worker.samples;
  const rss = rawSamples.map(({ rssBytes }) => rssBytes);
  const heap = rawSamples.map(({ heapUsedBytes }) => heapUsedBytes);
  const summary = {
    rssBytes: summarize(rss),
    heapUsedBytes: summarize(heap),
    rssRobustSlopeBytesPerSample: theilSenSlope(rss),
    heapRobustSlopeBytesPerSample: theilSenSlope(heap),
    rssGrowthBytes: Math.max(...rss) - Math.min(...rss),
    heapGrowthBytes: Math.max(...heap) - Math.min(...heap),
    maxQueueDepth: Math.max(...rawSamples.map(({ queueDepth }) => queueDepth)),
    maxRepresentationCacheBytes: Math.max(
      ...rawSamples.map(({ representationCacheBytes }) => representationCacheBytes),
    ),
    maxRawJournalBytes: Math.max(...rawSamples.map(({ rawJournalBytes }) => rawJournalBytes)),
  };
  const passed =
    rawSamples.length >= budgets.memory.minimumSamples &&
    summary.rssRobustSlopeBytesPerSample <= budgets.memory.rssRobustSlopeBytesPerSample &&
    summary.heapRobustSlopeBytesPerSample <= budgets.memory.heapRobustSlopeBytesPerSample &&
    summary.rssGrowthBytes <= budgets.memory.rssGrowthCeilingBytes &&
    summary.heapGrowthBytes <= budgets.memory.heapGrowthCeilingBytes &&
    Math.max(...rss) <= budgets.memory.rssAbsoluteCeilingBytes &&
    Math.max(...heap) <= budgets.memory.heapAbsoluteCeilingBytes &&
    summary.maxQueueDepth <= budgets.memory.settledQueueDepth &&
    summary.maxRepresentationCacheBytes <= budgets.memory.representationCacheCeilingBytes &&
    summary.maxRawJournalBytes <= budgets.memory.rawJournalCeilingBytes;
  return {
    status: passed ? "passed" : "failed",
    passed,
    sampleCount: rawSamples.length,
    rawSamples,
    summary,
    budgets: budgets.memory,
    workload: {
      runtime: worker.runtime,
      explicitGc: worker.explicitGc,
      clientCount: worker.clientCount,
      warmupCycles: worker.warmupCycles,
      writesPerCycle: worker.writesPerCycle,
    },
    semantics: {
      slope: "Theil-Sen median pairwise slope after warmup and two explicit full GC passes",
      ceiling: "maximum minus minimum post-GC sample, plus canonical queue/cache hard ceilings",
    },
  };
}

async function waitForLifecycleMarks(required) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(lifecyclePath)) {
      const marks = readJsonLines(lifecyclePath);
      if (required.every((phase) => marks.some((mark) => mark.phase === phase)))
        return required.map((phase) => marks.find((mark) => mark.phase === phase));
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for lifecycle marks: ${required.join(", ")}`);
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}`);
      }
    });
}

function validateStageEvent(event) {
  for (const field of ["traceId", "stage", "processId", "clockId", "clockKind"])
    if (typeof event[field] !== "string" || event[field].length === 0)
      throw new TypeError(`Trace event ${field} must be a non-empty string`);
  if (!PERFORMANCE_STAGES.includes(event.stage)) throw new TypeError("Unknown trace stage");
  if (
    !Number.isSafeInteger(event.startedAtMicros) ||
    !Number.isSafeInteger(event.endedAtMicros) ||
    event.startedAtMicros < 0 ||
    event.endedAtMicros < event.startedAtMicros
  )
    throw new TypeError("Trace event endpoints must be ordered safe monotonic microseconds");
}

function parseOptions(args) {
  const parsed = {
    report: "artifacts/performance-reference.json",
    startupSamples: 6,
    memorySamples: 24,
    inputSamples: 36,
    inputTrace: null,
    build: true,
    requireComplete: false,
    keepOnFailure: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--report") parsed.report = args[++index];
    else if (arg === "--startup-samples") parsed.startupSamples = Number(args[++index]);
    else if (arg === "--memory-samples") parsed.memorySamples = Number(args[++index]);
    else if (arg === "--input-samples") parsed.inputSamples = Number(args[++index]);
    else if (arg === "--input-trace") parsed.inputTrace = args[++index];
    else if (arg === "--no-build") parsed.build = false;
    else if (arg === "--require-complete") parsed.requireComplete = true;
    else if (arg === "--keep-on-failure") parsed.keepOnFailure = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  for (const field of ["startupSamples", "memorySamples", "inputSamples"])
    if (
      !Number.isSafeInteger(parsed[field]) ||
      parsed[field] < (field === "startupSamples" ? 2 : 4)
    )
      throw new TypeError(`${field} is too small`);
  return parsed;
}

function run(command, args, env = process.env) {
  execFileSync(command, args, { cwd: root, env, stdio: "pipe" });
}

function tmux(args) {
  execFileSync("tmux", args, {
    cwd: root,
    env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
    stdio: "pipe",
  });
}

function commandVersion(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`Unable to read ${command} version`);
  return result.stdout.trim();
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) throw new Error(`Unable to run ${command} ${args.join(" ")}`);
  return result.stdout.trim();
}
