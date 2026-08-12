#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  qualifyMemoryEvidence,
  qualifyStartupEvidence,
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
try {
  // RuntimeNamespace performance/testdrive uses this owned non-default socket;
  // no command in this runner addresses the user's canonical tmux server.
  tmux(["kill-server"]);
  tmux(["new-session", "-d", "-s", target, "/bin/sh"]);
  const rawSamples = [];
  for (let ordinal = 0; ordinal < startupSamples; ordinal += 1) {
    rmSync(lifecyclePath, { force: true });
    run(
      "node",
      ["scripts/tui-testdrive.mjs", "start", "--target", target, "--cols", "160", "--rows", "44"],
      { ...process.env, TMUX_IDE_TESTDRIVE_TARGET_SOCKET_NAME: socket },
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
    run("node", ["scripts/tui-testdrive.mjs", "stop"], {
      ...process.env,
      TMUX_IDE_TESTDRIVE_TARGET_SOCKET_NAME: socket,
    });
  }
  startup = qualifyStartupEvidence(rawSamples, budgets.startup);
} finally {
  spawnSync("node", ["scripts/tui-testdrive.mjs", "stop"], { cwd: root, stdio: "ignore" });
  tmux(["kill-server"]);
}

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
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  status: startup.passed && memory.passed ? "passed" : "failed",
  isolation: {
    runtimeMode: "performance",
    stateHome: "ephemeral",
    tmuxSocket: "owned-non-default",
  },
  measurements: {
    startup,
    memory,
    inputToPaint: {
      status: "not-measured",
      reason:
        "A visible terminal and one client monotonic input/paint clock are required; this headless runner does not synthesize them.",
      budgets: budgets.inputToPaint,
    },
  },
};
mkdirSync(dirname(output), { recursive: true });
await import("node:fs").then(({ writeFileSync }) =>
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`),
);
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.status === "passed" ? 0 : 1;

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
