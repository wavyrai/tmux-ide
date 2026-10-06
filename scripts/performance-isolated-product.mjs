#!/usr/bin/env node
// Qualification-only orchestration. Build and commit the CLI artifact before
// running: startDaemon's mandatory rebuild must be byte-identical to that commit.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createScratchFleet } from "./lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "./lib/product-fixtures/daemon.ts";
import { createPackedCancellation } from "./lib/packed-cancellation.mjs";
import { prepareStartupDiagnostic } from "./lib/startup-launch-diagnostic.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? ".tasks/isolated-product-performance");
// Never overwrite a previous run, including one that failed before startup.
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
mkdirSync(output, { mode: 0o700 });
const preflightOnly = process.argv[3] === "--preflight-only";
const portableOnly = process.argv[3] === "--portable-only";
const startupDiagnostic = process.argv[3] === "--startup-diagnostic";
const referenceOnly = process.argv[3] === "--reference-only";
if (process.argv[3] && !preflightOnly && !portableOnly && !startupDiagnostic && !referenceOnly)
  throw new Error("Unknown qualification mode");
const cancellation = createPackedCancellation();
const base = { ...process.env };
for (const key of Object.keys(base))
  if (/^(TMUX|TMUX_IDE_|NODE_OPTIONS$|NODE_PATH$)/u.test(key)) {
    delete base[key];
    delete process.env[key];
  }
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
const clean = () => {
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error(
      "Qualification requires a clean tree, including the deterministic CLI artifact",
    );
};
let provenance = null;
const snapshot = () => ({
  commit: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  dirty: Boolean(git("status", "--porcelain", "--untracked-files=all")),
  cliSha256: existsSync(join(root, "bin/cli.js")) ? sha(join(root, "bin/cli.js")) : null,
  tuiSha256: existsSync(join(root, "packages/daemon/dist/tui/tmux-ide-tui"))
    ? sha(join(root, "packages/daemon/dist/tui/tmux-ide-tui"))
    : null,
  driverSha256: sha(fileURLToPath(import.meta.url)),
});
async function run(name, args, env, timeout = 180000) {
  const result = await cancellation.command(process.execPath, args, {
    cwd: root,
    env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(join(output, `${name}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`, {
    mode: 0o600,
  });
  if (result.status !== 0) throw new Error(`${name} failed; see retained private log`);
}
let fleet;
let daemon;
const rigEnv = { ...base, TMUX_IDE_PRODUCT_RIG_DIR: join(output, "rig") };
let rigAttempted = false;
const failures = [];
const cleanup = { rig: "not-started", daemon: "not-started", fleet: "not-started" };
let deterministicRebuildVerified = false;
let rigArtifactsVerified = false;
let startupDiagnosticProvenance = null;
let startupDiagnosticArtifactsVerified = false;
try {
  provenance = snapshot();
  writeFileSync(join(output, "source.json"), JSON.stringify(provenance, null, 2), { mode: 0o600 });
  clean();
  if (startupDiagnostic)
    startupDiagnosticProvenance = prepareStartupDiagnostic(join(output, "startup-diagnostic"));
  if (!provenance.cliSha256 || !provenance.tuiSha256)
    throw new Error("Build both CLI and TUI before qualification");
  if (!portableOnly) {
    // Single-client paint lane: no ProductTestRig browser/TUI competes here.
    fleet = await createScratchFleet({ sessions: 1, slug: `paint-${process.pid}` });
    cleanup.fleet = "pending";
    daemon = await startDaemon(fleet);
    cleanup.daemon = "pending";
    clean();
    if (sha(join(root, "bin/cli.js")) !== provenance.cliSha256)
      throw new Error("startDaemon rebuilt a different CLI artifact");
    deterministicRebuildVerified = true;
    const referenceEnv = {
      ...base,
      ...fleet.environment,
      TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
      TMUX_IDE_TESTDRIVE_CANONICAL_HOME: fleet.daemonInfoDir,
      TMUX_IDE_TESTDRIVE_RUNTIME_DIR: join(output, "reference-tui"),
      TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: fleet.socketPath,
      TMUX_IDE_TESTDRIVE_HOST_SESSION: `_paint-${process.pid}`,
    };
    await run(
      "reference",
      [
        "scripts/performance-reference.mjs",
        "--no-build",
        "--input-samples",
        "36",
        "--report",
        join(output, "reference.json"),
        "--require-complete",
        ...(preflightOnly ? ["--preflight-only"] : []),
        ...(startupDiagnostic
          ? ["--startup-diagnostic-root", join(output, "startup-diagnostic")]
          : []),
      ],
      referenceEnv,
    );
    if (startupDiagnostic) {
      if (JSON.stringify(snapshot()) !== JSON.stringify(provenance))
        throw new Error("Startup diagnostic changed frozen source or artifacts");
      startupDiagnosticArtifactsVerified = true;
    }
    await daemon.stop();
    daemon = null;
    cleanup.daemon = "confirmed";
    await fleet.dispose();
    fleet = null;
    cleanup.fleet = "confirmed";
  }

  if (!startupDiagnostic && !referenceOnly) {
    // Separate multi-client coherence lane: actual rig Web+TUI are intentional.
    rigAttempted = true;
    cleanup.rig = "pending";
    await run("rig-start", ["scripts/product-test-rig.mjs", "start", "--json"], rigEnv);
    clean();
    if (
      sha(join(root, "bin/cli.js")) !== provenance.cliSha256 ||
      sha(join(root, "packages/daemon/dist/tui/tmux-ide-tui")) !== provenance.tuiSha256
    )
      throw new Error("ProductTestRig changed frozen artifacts");
    rigArtifactsVerified = true;
    if (!preflightOnly)
      await run("portable", ["scripts/performance-portable-evidence.mjs"], {
        ...rigEnv,
        TMUX_IDE_PRODUCT_RIG_STATE: join(output, "rig/state.json"),
        TMUX_IDE_PORTABLE_EVIDENCE_REPORT: join(output, "portable.json"),
      });
  }
} catch (error) {
  failures.push(error);
} finally {
  cancellation.beginCleanup();
  const settle = async (name, work) => {
    try {
      await work();
      cleanup[name] = "confirmed";
    } catch (error) {
      cleanup[name] = "failed";
      failures.push(error);
    }
  };
  if (rigAttempted)
    await settle("rig", () =>
      run("rig-stop", ["scripts/product-test-rig.mjs", "stop", "--json"], rigEnv, 60000),
    );
  if (daemon) await settle("daemon", () => daemon.stop());
  if (fleet) await settle("fleet", () => fleet.dispose());
  const cancellationFacts = cancellation.facts();
  if (cancellationFacts.uncertainCommand)
    failures.push(new Error("Command-tree retirement unconfirmed"));
  let finalSource = null;
  try {
    if (
      startupDiagnosticProvenance &&
      sha(join(output, "startup-diagnostic/preexec")) !== startupDiagnosticProvenance.binarySha256
    )
      failures.push(new Error("Startup diagnostic executable changed during measurement"));
    finalSource = snapshot();
    if (provenance && JSON.stringify(finalSource) !== JSON.stringify(provenance))
      failures.push(new Error("Frozen source or artifact identity changed during qualification"));
    if (finalSource.dirty) failures.push(new Error("Qualification ended with a dirty source tree"));
  } catch (error) {
    failures.push(error);
  }
  cancellation.dispose();
  try {
    writeFileSync(
      join(output, "terminal-proof.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          completed: failures.length === 0,
          mode: preflightOnly
            ? "preflight-only"
            : portableOnly
              ? "portable-only"
              : referenceOnly
                ? "reference-only"
                : "measurement",
          ...(startupDiagnostic
            ? {
                mode: "startup-diagnostic",
                timingQualification: false,
                startupDiagnosticProvenance,
                startupDiagnosticArtifactsVerified,
              }
            : {}),
          source: provenance,
          finalSource,
          deterministicRebuildVerified,
          rigArtifactsVerified,
          cancellation: cancellationFacts,
          cleanup,
          // Preserve the initial failure first; cleanup must not replace it.
          failures: failures.map((error) => ({
            name: error instanceof Error ? error.name : "UnknownError",
            message: error instanceof Error ? error.message : String(error),
          })),
        },
        null,
        2,
      ),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length) throw new AggregateError(failures, "Owned product qualification failed");
