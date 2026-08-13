#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  notMeasuredEvidence,
  qualifyCoherentTerminalEvidence,
  qualifyDeterministicCaptureEvidence,
  qualifyLatencyEvidence,
  qualifyMemoryEvidence,
  qualifyStartupEvidence,
  qualifyTmuxCapabilityEvidence,
} from "./lib/portable-performance-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const budgets = JSON.parse(
  readFileSync(resolve(root, "performance/reference-budgets.json"), "utf8"),
);
const output = resolve(
  root,
  process.env.TMUX_IDE_PORTABLE_EVIDENCE_REPORT ?? "artifacts/performance-portable-evidence.json",
);
const uid = process.getuid?.() ?? process.pid;
const socket = `tmux-ide-testdrive-${uid}`;
const target = `performance-evidence-${process.pid}`;
const lifecyclePath = resolve(root, ".tasks/tui-testdrive/performance.jsonl");
const compiledTui = resolve(root, "packages/daemon/dist/tui/tmux-ide-tui");
const startupSamples = Number(process.env.TMUX_IDE_PORTABLE_STARTUP_SAMPLES ?? 3);
const memorySamples = Number(process.env.TMUX_IDE_PORTABLE_MEMORY_SAMPLES ?? 16);
if (!Number.isSafeInteger(startupSamples) || startupSamples < 3)
  throw new TypeError("startup samples must be >= 3");
if (!Number.isSafeInteger(memorySamples) || memorySamples < 4)
  throw new TypeError("memory samples must be >= 4");
if (!existsSync(compiledTui))
  throw new Error("portable startup evidence requires `pnpm build:tui`");

const tmux = (args, stdio = "ignore") =>
  spawnSync("tmux", ["-L", socket, ...args], { cwd: root, stdio });
const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  return result.stdout;
};

let startup;
const resizeSamples = [];
const captureSamples = [];
let testdriveEnv = null;
try {
  // RuntimeNamespace performance/testdrive uses this owned non-default socket;
  // no command in this runner addresses the user's canonical tmux server.
  tmux(["kill-server"]);
  tmux(["new-session", "-d", "-s", target, "/bin/sh"]);
  const privateSocketPath = tmux(["display-message", "-p", "#{socket_path}"], "pipe")
    .stdout?.toString()
    .trim();
  if (!privateSocketPath) throw new Error("isolated tmux server did not report its socket path");
  // The hidden test-drive host and target session share one owned tmux server,
  // exactly like ProductTestRig. No default/canonical tmux server is touched.
  testdriveEnv = {
    ...process.env,
    TMUX_IDE_TESTDRIVE_TARGET_SOCKET_NAME: socket,
    TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: privateSocketPath,
    TMUX_IDE_TESTDRIVE_HOST_SESSION: `_tmux-ide-performance-${process.pid}`,
  };
  const rawSamples = [];
  for (let ordinal = 0; ordinal < startupSamples; ordinal += 1) {
    rmSync(lifecyclePath, { force: true });
    run(
      "node",
      ["scripts/tui-testdrive.mjs", "start", "--target", target, "--cols", "160", "--rows", "44"],
      testdriveEnv,
    );
    const required = ["module-loaded", "renderer-created", "first-frame", "solid-mounted"];
    const deadline = Date.now() + 10_000;
    let marks = readJsonLines(lifecyclePath);
    while (
      Date.now() < deadline &&
      !required.every((phase) => marks.some((mark) => mark.phase === phase))
    ) {
      await delay(25);
      marks = readJsonLines(lifecyclePath);
    }
    if (!required.every((phase) => marks.some((mark) => mark.phase === phase))) {
      throw new Error(
        `startup evidence lacks lifecycle marks: ${required.filter((phase) => !marks.some((mark) => mark.phase === phase)).join(", ")}`,
      );
    }
    const phases = Object.fromEntries(
      required.map((phase) => [phase, marks.find((mark) => mark.phase === phase).elapsedMs]),
    );
    rawSamples.push({
      ordinal,
      class: ordinal === 0 ? "process-cold" : "warm-repeat",
      phases,
      // The isolated empty tmux server has no semantic terminal inventory, so
      // first usable is the mounted application frame. A live terminal frame
      // remains part of the visible reference workflow, never invented here.
      firstUsableMs: Math.max(phases["first-frame"], phases["solid-mounted"]),
    });
    await delay(25);
    // The first capture after a freshly mounted process is an explicit visual
    // warm-up observation. `solid-mounted` proves the app exists, not that the
    // tmux capture client has observed the final idle document (the cold path
    // can still be publishing its first post-mount status frame). Preserve the
    // warm-up hash as evidence, then compare two subsequent captures; a real
    // steady-state mismatch still fails qualification.
    const warmupFrame = run(
      "node",
      ["scripts/tui-testdrive.mjs", "capture", "--ansi"],
      testdriveEnv,
    );
    const firstFrame = run(
      "node",
      ["scripts/tui-testdrive.mjs", "capture", "--ansi"],
      testdriveEnv,
    );
    const secondFrame = run(
      "node",
      ["scripts/tui-testdrive.mjs", "capture", "--ansi"],
      testdriveEnv,
    );
    captureSamples.push({
      ordinal,
      warmupSha256: sha256(warmupFrame),
      firstSha256: sha256(firstFrame),
      secondSha256: sha256(secondFrame),
      bytes: Buffer.byteLength(firstFrame),
    });
    if (ordinal === startupSamples - 1) {
      const resizePairs = Array.from(
        { length: budgets.resizeResponsiveness.minimumSamples },
        (_value, resizeOrdinal) => (resizeOrdinal % 2 === 0 ? ["132", "38"] : ["148", "42"]),
      ).flat();
      const resizeSequence = JSON.parse(
        run(
          "node",
          ["scripts/tui-testdrive.mjs", "resize-sequence", ...resizePairs, "--json"],
          testdriveEnv,
        ),
      );
      resizeSamples.push(...resizeSequence.samples);
    }
    run("node", ["scripts/tui-testdrive.mjs", "stop"], testdriveEnv);
  }
  startup = qualifyStartupEvidence(rawSamples, budgets.startup);
} finally {
  if (testdriveEnv)
    spawnSync("node", ["scripts/tui-testdrive.mjs", "stop"], {
      cwd: root,
      env: testdriveEnv,
      stdio: "ignore",
    });
  tmux(["kill-server"]);
}

const resizeResponsiveness = qualifyLatencyEvidence(resizeSamples, budgets.resizeResponsiveness);
const visualDeterminism = qualifyDeterministicCaptureEvidence(
  captureSamples,
  budgets.visualDeterminism,
);

const memoryWorker = JSON.parse(
  run("bun", ["--expose-gc", "scripts/performance-reference-memory.ts"], {
    ...process.env,
    TMUX_IDE_RUNTIME_MODE: "performance",
    TMUX_IDE_HOME: resolve(root, `.tasks/performance-${process.pid}/home`),
    TMUX_IDE_REGISTRY_DIR: resolve(root, `.tasks/performance-${process.pid}/registry`),
    TMUX_IDE_DAEMON_INFO_DIR: resolve(root, `.tasks/performance-${process.pid}/daemon`),
    TMUX_IDE_TMUX_SOCKET_NAME: `tmux-ide-performance-${process.pid}`,
    TMUX_IDE_CLEANUP_TOKEN: `performance:evidence:${process.pid}`,
    TMUX_IDE_REFERENCE_MEMORY_WARMUP: "16",
    TMUX_IDE_REFERENCE_MEMORY_SAMPLES: String(memorySamples),
  }).trim(),
);
const memory = qualifyMemoryEvidence(memoryWorker, {
  ...budgets.memory,
  minimumSamples: memorySamples,
});
const tmuxSupportMatrix = JSON.parse(
  readFileSync(resolve(root, "performance/tmux-support-matrix.json"), "utf8"),
);
const tmuxSupport = qualifyTmuxCapabilityEvidence(
  {
    version: run("tmux", ["-V"]),
    commands: run("tmux", ["list-commands"]),
    featureProbes: observeTmuxFeatureProbes(tmuxSupportMatrix),
  },
  tmuxSupportMatrix,
);
const coherentTerminalFrame = await readProductRigCoherentFrame();
const dragResponsiveness = notMeasuredEvidence(
  "The headless OpenTUI runner has no browser pointer/preview clock. Run the ProductTestRig pane-manipulation probe for measured drag evidence.",
  budgets.dragResponsiveness,
);
const inputToPaint = notMeasuredEvidence(
  "A visible terminal and one client monotonic input/consumed-paint clock are required; this headless runner does not synthesize them.",
  budgets.inputToPaint,
);
const measured = [
  startup,
  memory,
  resizeResponsiveness,
  visualDeterminism,
  tmuxSupport,
  ...(coherentTerminalFrame.status === "not-measured" ? [] : [coherentTerminalFrame]),
];
const failed = measured.some(({ status }) => status === "failed");
const hasLimitations = [coherentTerminalFrame, dragResponsiveness, inputToPaint].some(
  ({ status }) => status === "not-measured",
);
const report = {
  version: 2,
  generatedAt: new Date().toISOString(),
  status: failed ? "failed" : hasLimitations ? "passed-with-limitations" : "passed",
  isolation: {
    runtimeMode: "performance",
    stateHome: "ephemeral",
    tmuxSocket: "owned-non-default",
  },
  measurements: {
    startup,
    memory,
    coherentTerminalFrame,
    inputToPaint,
    resizeResponsiveness,
    dragResponsiveness,
    visualDeterminism,
    tmuxSupport,
  },
};
mkdirSync(dirname(output), { recursive: true });
await import("node:fs").then(({ writeFileSync }) =>
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`),
);
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "failed" ? 1 : 0;

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readProductRigCoherentFrame() {
  const requested = process.env.TMUX_IDE_PRODUCT_RIG_STATE?.trim();
  if (!requested)
    return notMeasuredEvidence(
      "Set TMUX_IDE_PRODUCT_RIG_STATE to a ready ProductTestRig state file; app chrome is not a coherent terminal frame.",
      budgets.coherentTerminalFrame,
    );
  const state = JSON.parse(readFileSync(resolve(root, requested), "utf8"));
  const webMs = state.web?.coherentTerminalFrameMs;
  const openTuiMs = state.tui?.readiness?.coherentTerminalFrameMs;
  if (state.status !== "ready" || !Number.isFinite(webMs) || !Number.isFinite(openTuiMs))
    return notMeasuredEvidence(
      "The explicit ProductTestRig state is not ready or lacks both coherent terminal marks.",
      budgets.coherentTerminalFrame,
    );
  const productRigEnv = {
    ...process.env,
    TMUX_IDE_TESTDRIVE_RUNTIME_DIR: state.tui.runtimeDir,
    TMUX_IDE_TESTDRIVE_HOST_SESSION: state.tui.hostSession,
    TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: state.runtimeNamespace.tmuxSocketPath,
    TMUX_IDE_TESTDRIVE_USE_CANONICAL_DAEMON: "1",
    TMUX_IDE_TESTDRIVE_CANONICAL_HOME: state.runtimeNamespace.daemonInfoDir,
  };
  let warmup = null;
  const warmSamples = [];
  const rehostCount = budgets.coherentTerminalFrame.minimumWarmSamples + 1;
  for (let ordinal = 0; ordinal < rehostCount; ordinal += 1) {
    run("node", ["scripts/tui-testdrive.mjs", "stop"], productRigEnv);
    run(
      "node",
      [
        "scripts/tui-testdrive.mjs",
        "start",
        "--target",
        state.session,
        "--cols",
        "160",
        "--rows",
        "44",
      ],
      productRigEnv,
    );
    run("node", ["scripts/tui-testdrive.mjs", "key", "F2"], productRigEnv);
    const deadline = Date.now() + budgets.coherentTerminalFrame.hardPortabilityCeilingMs;
    let status = null;
    while (Date.now() < deadline) {
      status = JSON.parse(
        run("node", ["scripts/tui-testdrive.mjs", "status", "--json"], productRigEnv),
      );
      if (Number.isFinite(status.readiness?.coherentTerminalFrameMs)) break;
      await delay(25);
    }
    if (!Number.isFinite(status?.readiness?.coherentTerminalFrameMs))
      throw new Error(`ProductTestRig rehost coherent frame ${ordinal + 1} exceeded hard ceiling`);
    const sample = {
      class: ordinal === 0 ? "product-rig-warmup" : "product-rig-warm",
      ordinal: ordinal === 0 ? 0 : ordinal - 1,
      elapsedMs: status.readiness.coherentTerminalFrameMs,
      appChromeFrameMs: status.readiness.appChromeFrameMs,
      phases: criticalPathFromLifecycle(resolve(state.tui.runtimeDir, "performance.jsonl")),
    };
    if (ordinal === 0) warmup = sample;
    else warmSamples.push(sample);
  }
  return qualifyCoherentTerminalEvidence(
    {
      webColdMs: webMs,
      openTuiColdMs: openTuiMs,
      openTuiWarmup: warmup,
      openTuiWarmSamples: warmSamples,
    },
    budgets.coherentTerminalFrame,
  );
}

function criticalPathFromLifecycle(path) {
  const interesting = new Set([
    "module-loaded",
    "renderer-created",
    "solid-mounted",
    "first-frame",
    "application-shell-state",
    "runtime-lane-connecting",
    "runtime-lane-layout",
    "runtime-lane-connected",
    "first-terminal-frame",
  ]);
  const marks = readJsonLines(path);
  const firstTerminalFrameMs = marks.find(
    ({ phase }) => phase === "first-terminal-frame",
  )?.elapsedMs;
  return marks
    .filter(
      ({ phase, elapsedMs }) =>
        interesting.has(phase) &&
        (!Number.isFinite(firstTerminalFrameMs) || elapsedMs <= firstTerminalFrameMs),
    )
    .map(({ phase, elapsedMs, statePhase, request }) => ({
      phase,
      elapsedMs,
      ...(statePhase ? { statePhase } : {}),
      ...(request ? { request } : {}),
    }));
}

function observeTmuxFeatureProbes(support) {
  const probeSocket = `tmux-ide-capability-${process.pid}`;
  const session = `capability-${process.pid}`;
  const probeTmux = (args) =>
    spawnSync("tmux", ["-L", probeSocket, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  probeTmux(["kill-server"]);
  const created = probeTmux(["new-session", "-d", "-s", session, "/bin/sh"]);
  if (created.status !== 0) throw new Error("could not create isolated tmux capability probe");
  try {
    return Object.fromEntries(
      Object.entries(support.features).map(([name, requirement]) => {
        if (!requirement.probe) return [name, null];
        const args = [
          requirement.probe.command,
          ...requirement.probe.args.map((arg) => arg.replace("{session}", session)),
        ];
        const result = probeTmux(args);
        const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
        const rejected = /unknown (?:command|flag|option)|invalid (?:flag|option)/iu.test(output);
        return [
          name,
          {
            status: rejected ? "rejected" : "accepted",
            exitCode: result.status,
            // An attach probe has no terminal by design. Expose only the
            // classification; raw paths/TTY diagnostics are not release data.
            diagnostic: rejected ? "unsupported-option" : "syntax-accepted-without-client",
          },
        ];
      }),
    );
  } finally {
    probeTmux(["kill-server"]);
  }
}
