import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function validateOwnedWorktree({ common, local, dirty }) {
  if (common === local)
    throw new Error(
      "Owned capture requires an isolated linked worktree; primary builds are forbidden",
    );
  if (dirty) throw new Error("Owned capture requires clean source before building");
}
export function assertOwnedReferenceWorktree(root, rendererManifest) {
  if (!isAbsolute(rendererManifest ?? "") || !existsSync(rendererManifest))
    throw new Error("Owned capture requires an absolute qualified renderer manifest");
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  validateOwnedWorktree({
    common: realpathSync(resolve(root, git(["rev-parse", "--git-common-dir"]))),
    local: realpathSync(resolve(root, git(["rev-parse", "--git-dir"]))),
    dirty: git(["status", "--porcelain=v1", "--untracked-files=all"]),
  });
}
function sanitizedBaseEnvironment(base) {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      key === "TMUX" ||
      key.startsWith("TMUX_") ||
      ["NODE_OPTIONS", "NODE_PATH", "XDG_CONFIG_HOME"].includes(key)
    )
      delete env[key];
  return env;
}
export function ownedReferenceEnvironment(base, fleet, tracePath, tuiPath) {
  const locator = fleet.environment.TMUX;
  const parts = typeof locator === "string" ? locator.split(",") : [];
  const canonicalSocket = (path) => join(realpathSync(dirname(path)), basename(path));
  if (
    parts.length !== 3 ||
    !isAbsolute(parts[0]) ||
    !/^[1-9][0-9]*$/.test(parts[1]) ||
    !/^[0-9]+$/.test(parts[2]) ||
    !Number.isSafeInteger(Number(parts[1])) ||
    canonicalSocket(parts[0]) !== canonicalSocket(fleet.socketPath)
  )
    throw new Error("Owned capture requires the exact private fleet TMUX locator");
  return {
    ...sanitizedBaseEnvironment(base),
    ...fleet.environment,
    TMUX: locator,
    TMUX_IDE_TMUX_SOCKET_PATH: fleet.socketPath,
    TMUX_IDE_SESSION_RUNTIME_TRACE_LOG: tracePath,
    TMUX_IDE_TESTDRIVE_CANONICAL_HOME: fleet.daemonInfoDir,
    TMUX_IDE_TESTDRIVE_DAEMON_INFO_DIR: fleet.daemonInfoDir,
    TMUX_IDE_TESTDRIVE_RUNTIME_DIR: join(fleet.root, "reference-tui"),
    TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: fleet.socketPath,
    TMUX_IDE_TESTDRIVE_HOST_SESSION: `_reference-${process.pid}`,
    TMUX_IDE_TESTDRIVE_TUI_BIN: tuiPath,
    TMUX_IDE_PERFORMANCE_TRACE_INPUT_DETAIL: "1",
  };
}
const replaceEnv = (env) => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
};
export function prepareOwnedReferenceArtifact(root, rendererManifest, execute = execFileSync) {
  execute("pnpm", ["build:tui", "--release-scroll-manifest", rendererManifest], {
    cwd: root,
    stdio: "pipe",
    timeout: 120000,
  });
  return join(root, "packages/daemon/dist/tui/tmux-ide-tui");
}
function nativeIdentity(fleet) {
  const pid = Number(
    execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      ["-S", fleet.socketPath, "display-message", "-p", "#{pid}"],
      { env: fleet.environment, encoding: "utf8", timeout: 5000 },
    ).trim(),
  );
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Owned native PID unavailable");
  return pid;
}
async function retireFleet(fleet, pid, { retainRoot = false } = {}) {
  try {
    execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, "kill-server"], {
      env: fleet.environment,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    /* Already retired is checked by exact PID below. */
  }
  if (!pid) throw new Error("Native PID unavailable after owned socket retirement; root retained");
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  for (let n = 0; n < 20 && alive(); n++) await delay(50);
  if (alive()) throw new Error("Owned native server still live; fixture root retained");
  if (!retainRoot) await fleet.dispose();
}
/** Owns only the existing fixtures. Source identity is captured before either artifact build. */
export async function withOwnedReferenceCapture({
  createFleet,
  startDaemon,
  run,
  root,
  output,
  source,
  rendererManifest,
  environment = process.env,
  prepare = prepareOwnedReferenceArtifact,
  inspectNative = nativeIdentity,
  retire = retireFleet,
}) {
  if (existsSync(output)) throw new Error("Owned capture output already exists");
  await mkdir(output, { recursive: true });
  let fleet, daemon, nativePid, artifacts, metadata;
  const errors = [];
  let result;
  let retainRoot = false;
  const retained = [];
  const daemonOutput = [];
  const persistDaemonOutput = async (phase) => {
    const text = daemon.output();
    const limit = 2 * 1024 * 1024;
    const totalBytes = Buffer.byteLength(text);
    const suffix = Buffer.from(text.slice(-limit));
    const tail = suffix.subarray(Math.max(0, suffix.length - limit));
    const path = join(
      output,
      phase === "before-stop" ? "daemon-output.before-stop.log" : "daemon-output.log",
    );
    const record = {
      phase,
      path,
      totalBytes,
      bytes: tail.length,
      truncated: totalBytes > tail.length,
      persisted: false,
    };
    daemonOutput.push(record);
    await writeFile(path, tail, { mode: 0o600 });
    record.persisted = true;
    record.sha256 = hash(path);
  };
  const original = { ...process.env };
  const tracePath = join(output, "daemon.jsonl");
  try {
    replaceEnv(sanitizedBaseEnvironment(environment));
    const rendererManifestSha256 = hash(rendererManifest);
    const tuiPath = await prepare(root, rendererManifest); // Clean source embeds the correct TUI identity before CLI build.
    fleet = await createFleet({ sessions: 0, slug: "reference" });
    nativePid = inspectNative(fleet);
    const env = ownedReferenceEnvironment(environment, fleet, tracePath, tuiPath);
    replaceEnv(env); // startDaemon merges process.env: sanitize the actual parent before it spawns.
    daemon = await startDaemon({ ...fleet, environment: env });
    artifacts = {
      cli: { path: join(root, "bin/cli.js"), sha256: hash(join(root, "bin/cli.js")) },
      tui: { path: tuiPath, sha256: hash(tuiPath) },
      renderer: { manifestPath: rendererManifest, manifestSha256: rendererManifestSha256 },
      native: fleet.environment.TMUX_IDE_TMUX_BIN
        ? {
            path: fleet.environment.TMUX_IDE_TMUX_BIN,
            sha256: hash(fleet.environment.TMUX_IDE_TMUX_BIN),
            version: execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-V"], {
              encoding: "utf8",
              timeout: 5000,
            }).trim(),
          }
        : null,
      sourceBeforeBuild: source,
      generatedWorktreeState:
        "Artifacts built after clean source capture; current generated bytes are bound separately",
    };
    metadata = {
      source,
      artifacts,
      daemon: { pid: daemon.record.pid, instanceId: daemon.record.instanceId },
      cleanupErrors: [],
    };
    result = await run(env, metadata);
    if (
      result?.inputAdmission?.complete !== true ||
      result?.controllerMapping?.status !== "matched"
    )
      throw new Error("TUI trace/controller admission incomplete");
  } catch (error) {
    errors.push(error);
  } finally {
    for (const error of metadata?.cleanupErrors ?? []) errors.push(new Error(error));
    if (daemon) {
      try {
        await persistDaemonOutput("before-stop");
      } catch (error) {
        errors.push(error);
      }
      try {
        await daemon.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await persistDaemonOutput("after-stop");
      } catch (error) {
        errors.push(error);
      }
    }
    if (fleet) {
      for (const name of ["input-trace.jsonl", "input-trace.jsonl.controller-attempts.json"]) {
        const path = join(fleet.root, "reference-tui", name),
          destination = join(output, name);
        try {
          if (!existsSync(path)) {
            retainRoot = true;
            errors.push(new Error(`Missing retained artifact ${name}`));
            continue;
          }
          await copyFile(path, destination);
          retained.push({ name, path: destination, sha256: hash(destination) });
        } catch (error) {
          retainRoot = true;
          errors.push(error);
        }
      }
      if (result?.reportPath && existsSync(result.reportPath))
        try {
          const report = JSON.parse(readFileSync(result.reportPath, "utf8"));
          const measurement = report.measurements.inputToPaint;
          for (const [field, name] of [
            ["sourceArtifact", "input-trace.jsonl"],
            ["controllerMapping", "input-trace.jsonl.controller-attempts.json"],
          ]) {
            const artifact = retained.find((item) => item.name === name);
            if (artifact)
              measurement[field] = {
                ...measurement[field],
                path: artifact.path,
                sha256: artifact.sha256,
              };
          }
          await writeFile(result.reportPath, JSON.stringify(report, null, 2));
        } catch (error) {
          errors.push(error);
        }
      try {
        if (!nativePid) {
          retainRoot = true;
          errors.push(new Error("Native identity unavailable; root retained"));
        }
        await retire(fleet, nativePid, { retainRoot });
      } catch (error) {
        retainRoot = true;
        errors.push(error);
      }
    }
    replaceEnv(original);
    try {
      await writeFile(
        join(output, "owner-result.json"),
        JSON.stringify(
          {
            source,
            artifacts,
            status: errors.length ? "failed" : "captured",
            errors: errors.map((e) => e.message),
            result,
            retained,
            daemonOutput,
            nativePid,
            retainedSourceRoot: retainRoot ? fleet?.root : null,
            scope:
              "Owned two-stream diagnostic, not full reference qualification or six-boundary acceptance",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Owned reference capture failed");
}
