#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { assessPackedInterruption } from "./lib/packed-interruption-qualification.mjs";
import { checkedReleaseSourceState } from "./lib/release-source-state.mjs";
import { spawnSync } from "node:child_process";

const source = fileURLToPath(new URL("..", import.meta.url));
if (process.argv.length !== 3)
  throw new Error("Usage: qualify-packed-interruption.mjs <fresh-evidence-directory>");
const root = resolve(process.argv[2]);
mkdirSync(root, { mode: 0o700 });
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
  timeout: 5000,
}).trim();
const clean = () =>
  checkedReleaseSourceState(
    spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: source,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1048576,
    }),
  ) === "clean";
const receipt = { sourceCommit: commit, node: process.version, ok: false, cases: [] };
const save = () =>
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let stopping = false;
let current = null;
const stop = () => {
  stopping = true;
  try {
    current?.kill("SIGTERM");
  } catch {
    receipt.signalForwardingFailed = true;
  }
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
save();
try {
  if (!clean()) throw new Error("source-not-clean");
  if (process.env.DEVELOPMENT_CANDIDATE_SHA && process.env.DEVELOPMENT_CANDIDATE_SHA !== commit)
    throw new Error("candidate-mismatch");
  for (const mode of ["hold-input-ready", "fail-input-ready"]) {
    if (stopping) throw new Error("qualification-cancelled");
    const directory = join(root, mode);
    mkdirSync(directory, { mode: 0o700 });
    const evidence = join(directory, "package");
    const started = performance.now();
    const entry = { mode, ok: false };
    receipt.cases.push(entry);
    let closed = false;
    let output = Buffer.alloc(0);
    let outputBytes = 0;
    const child = spawn(process.execPath, ["scripts/pack-check-run.mjs"], {
      cwd: source,
      env: {
        ...process.env,
        TMUX_IDE_PACK_EVIDENCE_DIR: evidence,
        TMUX_IDE_PACK_INTERRUPT_AT: mode,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    current = child;
    entry.pid = child.pid;
    const signalChild = (signal) => {
      try {
        return child.kill(signal);
      } catch {
        entry.signalFailed = true;
        return false;
      }
    };
    const log = (chunk) => {
      outputBytes += chunk.length;
      output = Buffer.concat([output, chunk]).subarray(-1048576);
    };
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.on("error", () => {
      entry.spawnError = true;
    });
    child.on("close", (code, signal) => {
      closed = true;
      entry.exitCode = code;
      entry.signal = signal;
    });
    save();
    try {
      const readyPath = join(evidence, "interruption-ready.json");
      const deadline = performance.now() + 360000;
      while (!closed && !stopping && !existsSync(readyPath) && performance.now() < deadline)
        await pause(50);
      if (stopping) throw new Error("qualification-cancelled");
      if (!existsSync(readyPath)) throw new Error("input-ready-not-reached");
      const ready = JSON.parse(readFileSync(readyPath, "utf8"));
      if (ready.runnerPid !== child.pid || ready.mode !== mode)
        throw new Error("ready-owner-mismatch");
      entry.readyAfterMs = Math.round(performance.now() - started);
      let signalled = null;
      if (mode === "hold-input-ready") {
        signalled = performance.now();
        if (!signalChild("SIGTERM")) throw new Error("signal-not-delivered");
      }
      const closeDeadline = performance.now() + 210000;
      while (!closed && performance.now() < closeDeadline) await pause(25);
      if (!closed) {
        entry.closeWaitExpired = true;
        throw new Error("runner-exit-unconfirmed");
      }
      if (stopping) throw new Error("qualification-cancelled");
      if (signalled !== null) entry.signalToExitMs = Math.round(performance.now() - signalled);
      const bytes = readFileSync(join(evidence, "proof.json"));
      const proof = JSON.parse(bytes);
      entry.proofSha256 = sha(bytes);
      if (proof.commit !== commit || proof.sourceState !== "clean")
        throw new Error("proof-source-mismatch");
      const audit = assessPackedInterruption({
        mode,
        pid: child.pid,
        exitCode: entry.exitCode,
        signal: entry.signal,
        ready,
        proof,
        absentPid: (pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            return error.code === "ESRCH";
          }
        },
        absentPath: (path) => {
          try {
            lstatSync(path);
            return false;
          } catch (error) {
            return error.code === "ENOENT";
          }
        },
      });
      entry.audit = audit;
      entry.cleanup = proof.cleanup;
      entry.artifactsVerified = 0;
      if (!Array.isArray(proof.artifacts) || proof.artifacts.length !== 5)
        throw new Error("artifact-inventory");
      for (const artifact of proof.artifacts) {
        if (basename(artifact.name) !== artifact.name) throw new Error("artifact-name");
        const artifactBytes = readFileSync(join(evidence, artifact.name));
        if (artifactBytes.length !== artifact.bytes || sha(artifactBytes) !== artifact.sha256)
          throw new Error("artifact-mismatch");
        entry.artifactsVerified++;
      }
      if (!audit.ok) throw new Error("owned-cleanup-unconfirmed");
      if (!clean()) throw new Error("source-changed");
      entry.ok = true;
    } catch (error) {
      entry.failure = error.message;
    } finally {
      if (!closed) {
        signalChild("SIGTERM");
        const deadline = performance.now() + (entry.closeWaitExpired ? 0 : 210000);
        while (!closed && performance.now() < deadline) await pause(50);
        if (!closed) {
          signalChild("SIGKILL");
          const killDeadline = performance.now() + 2000;
          while (!closed && performance.now() < killDeadline) await pause(25);
        }
        entry.cleanupUnconfirmed = true;
        entry.ok = false;
        if (!closed) {
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          entry.logMayBeIncomplete = true;
        }
      }
      entry.runnerClosed = closed;
      entry.elapsedMs = Math.round(performance.now() - started);
      entry.logBytes = outputBytes;
      entry.logTruncated = outputBytes > output.length;
      writeFileSync(join(directory, "run.private.log"), output, { mode: 0o600 });
      current = null;
      save();
    }
    if (!entry.ok) break;
  }
  receipt.ok = !stopping && receipt.cases.length === 2 && receipt.cases.every((entry) => entry.ok);
} catch (error) {
  receipt.failure = error.message;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  save();
}
console.log(
  JSON.stringify({
    sourceCommit: commit,
    ok: receipt.ok,
    cases: receipt.cases.map(({ mode, ok, failure }) => ({ mode, ok, failure })),
  }),
);
process.exitCode = receipt.ok ? 0 : 1;
