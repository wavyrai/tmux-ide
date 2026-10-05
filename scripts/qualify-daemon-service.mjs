#!/usr/bin/env node
// Real OS-manager qualification. Requires an existing non-root user manager;
// never enables login lingering or touches the user's ordinary tmux server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert(["darwin", "linux"].includes(process.platform), "Unsupported service platform");
assert(process.getuid() > 0, "Run as a non-root user with an available user manager");
const repo = resolve(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "tmux-ide-svc-"));
const home = join(root, "home");
const state = join(root, "state");
const socket = join(root, "tmux.sock");
const installed = join(root, "installed");
mkdirSync(home);
mkdirSync(installed);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(TMUX_IDE_|BUN_|NODE_)/u.test(key) &&
      !["TMUX", "XPC_SERVICE_NAME", "INVOCATION_ID", "XDG_CONFIG_HOME"].includes(key),
  ),
);
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  TMUX_IDE_HOME: state,
  TMUX_IDE_DAEMON_INFO_DIR: state,
  TMUX_IDE_REGISTRY_DIR: state,
  TMUX_IDE_SETTINGS_DIR: state,
  TMUX_IDE_TMUX_SOCKET_PATH: socket,
  LC_ALL: "C",
  LANG: "C",
});
const hash = (data) => createHash("sha256").update(data).digest("hex");
const identity = hash(state).slice(0, 24);
const launchd = process.platform === "darwin";
const target = launchd
  ? `gui/${process.getuid()}/com.tmux-ide.${identity}`
  : `tmux-ide.${identity}.service`;
const unitPath = launchd
  ? join(home, "Library", "LaunchAgents", `com.tmux-ide.${identity}.plist`)
  : join(home, ".config", "systemd", "user", target);
const receipt = {
  root,
  platform: `${process.platform}-${process.arch}`,
  target,
  startedAt: new Date().toISOString(),
  steps: [],
  cleanup: {},
};
const output = resolve(process.argv[2] ?? join(root, "receipt.json"));
const run = (file, args, options = {}) =>
  spawnSync(file, args, {
    cwd: home,
    env,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
function checked(file, args, options) {
  const result = run(file, args, options);
  // Do not copy subprocess output into errors: manager output can contain secrets.
  assert.equal(
    result.status,
    0,
    `${file} ${args[0]} failed (${result.status ?? result.error?.code})`,
  );
  return result.stdout;
}
function sourceIdentity() {
  const git = (...args) => checked("git", args, { cwd: repo });
  return {
    commit: git("rev-parse", "HEAD").trim(),
    tree: git("rev-parse", "HEAD^{tree}").trim(),
    trackedDiffSha256: hash(git("diff", "--binary", "HEAD", "--")),
    trackedChanges: git("diff", "--name-only", "-z", "HEAD", "--").split("\0").filter(Boolean),
    untrackedPaths: git("ls-files", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean),
  };
}
function managerAbsent() {
  if (launchd) {
    const result = run("/bin/launchctl", ["print", target]);
    return result.status === 113 && result.stderr.includes("Could not find service");
  }
  const result = run("systemctl", [
    "--user",
    "show",
    target,
    "--property=LoadState,ActiveState,MainPID",
  ]);
  return (
    [0, 4].includes(result.status) &&
    /^LoadState=not-found$/mu.test(result.stdout) &&
    /^MainPID=0$/mu.test(result.stdout)
  );
}
const cliPath = join(installed, "node_modules", "tmux-ide", "bin", "cli.js");
const tmux = join(
  installed,
  "node_modules",
  "tmux-ide",
  "packages",
  "daemon",
  "dist",
  "native",
  "tmux",
  receipt.platform,
  "tmux",
);
function cli(...args) {
  const result = run(process.execPath, [cliPath, "daemon", "service", ...args, "--json"]);
  const step = { action: args[0], exitCode: result.status, signal: result.signal };
  receipt.steps.push(step);
  if (result.status !== 0) {
    // These manager error messages contain only a fixed operation label, never
    // subprocess output. Preserve the failing boundary without publishing logs.
    step.managerFailureOperation =
      result.stderr.match(
        /(?:launchd|systemd) user service ([a-z /]+) failed; check the user manager/u,
      )?.[1] ?? null;
    step.failureCode = result.stderr.match(/code: '(DAEMON_[A-Z_]+)'/u)?.[1] ?? null;
    if (!launchd) {
      const inspected = run("systemctl", [
        "--user",
        "show",
        target,
        "--property=LoadState,ActiveState,MainPID,FragmentPath,Result",
      ]);
      step.managerState = inspected.stdout
        .split("\n")
        .filter((line) => /^(LoadState|ActiveState|MainPID|FragmentPath|Result)=/u.test(line));
    }
  }
  assert.equal(
    result.status,
    0,
    `Service ${args[0]} failed (${result.status ?? result.error?.code})`,
  );
  const value = JSON.parse(result.stdout);
  // Only publish known non-secret service identity fields.
  for (const key of ["status", "pid", "instanceId", "reservationMatches"]) {
    if (value[key] !== undefined) step[key] = value[key];
  }
  return value;
}
let serviceAttempted = false;
let tmuxAttempted = false;
try {
  receipt.source = sourceIdentity();
  receipt.commit = receipt.source.commit;
  receipt.dirty =
    receipt.source.trackedChanges.length > 0 || receipt.source.untrackedPaths.length > 0;
  checked(
    launchd ? "/bin/launchctl" : "systemctl",
    launchd ? ["print-disabled", `gui/${process.getuid()}`] : ["--user", "show-environment"],
  );
  assert(managerAbsent(), "Fresh private service target must be absent");
  const packed = JSON.parse(
    checked("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: repo,
      timeout: 180_000,
    }),
  );
  const tarball = join(root, packed[0].filename);
  receipt.packageSha256 = hash(readFileSync(tarball));
  checked(
    "npm",
    ["install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { timeout: 180_000 },
  );
  receipt.cliSha256 = hash(readFileSync(cliPath));
  receipt.tmuxSha256 = hash(readFileSync(tmux));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = join(root, "launcher");
  const launchReceipt = join(root, "launch.json");
  const preload = join(root, "launch-receipt.mjs");
  writeFileSync(
    preload,
    `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(launchReceipt)}, JSON.stringify({pid:process.pid,entry:process.argv[1]}));
`,
  );
  const firstLauncher = join(root, "release-one");
  const nextLauncher = join(root, "release-two");
  const failedLauncher = join(root, "release-failed");
  const nextInstalled = join(root, "next-installed");
  cpSync(installed, nextInstalled, { recursive: true });
  const nextCliPath = join(nextInstalled, "node_modules", "tmux-ide", "bin", "cli.js");
  for (const [path, entry] of [
    [firstLauncher, cliPath],
    [nextLauncher, nextCliPath],
  ])
    writeFileSync(
      path,
      `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(preload)} ${quote(entry)} "$@"\n`,
      { mode: 0o700 },
    );
  const failedLaunchMarker = join(root, "failed-launch-marker");
  writeFileSync(
    failedLauncher,
    `#!/bin/sh\nprintf failed > ${quote(failedLaunchMarker)}\nexit 42\n`,
    { mode: 0o700 },
  );
  const activate = (path) => {
    const staged = `${launcher}.next`;
    symlinkSync(path, staged);
    renameSync(staged, launcher);
  };
  const assertLaunched = (result, entry) => {
    assert.deepEqual(JSON.parse(readFileSync(launchReceipt, "utf8")), { pid: result.pid, entry });
  };
  activate(firstLauncher);
  tmuxAttempted = true;
  checked(tmux, ["-S", socket, "new-session", "-d", "-s", "service-fixture"]);
  const panePid = () =>
    checked(tmux, [
      "-S",
      socket,
      "display-message",
      "-p",
      "-t",
      "service-fixture",
      "#{pane_pid}",
    ]).trim();
  const before = panePid();
  assert.match(before, /^[1-9][0-9]*$/u);
  serviceAttempted = true;
  const first = cli("install", launcher);
  assert.equal(first.status, "running");
  assert.equal(first.target, target);
  assertLaunched(first, cliPath);
  const status = cli("status");
  assert.equal(status.status, "running");
  assert.equal(status.pid, first.pid);
  assert.equal(status.reservationMatches, true);
  activate(nextLauncher);
  assert.equal(cli("status").pid, first.pid, "Activation must not retire a running service");
  const second = cli("restart");
  assert.equal(second.status, "running");
  assert.equal(typeof second.instanceId, "string");
  assert.notEqual(first.instanceId, second.instanceId);
  assert.notEqual(first.pid, second.pid);
  assertLaunched(second, nextCliPath);
  receipt.stableLauncherUpdate = true;
  assert.equal(panePid(), before, "Restart must preserve existing pane work");
  activate(failedLauncher);
  const interrupted = spawn(process.execPath, [cliPath, "daemon", "service", "restart", "--json"], {
    cwd: home,
    env,
    stdio: "ignore",
  });
  const exited = new Promise((resolveExit, rejectExit) => {
    interrupted.once("error", rejectExit);
    interrupted.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  try {
    const deadline = Date.now() + 10_000;
    while (
      !existsSync(failedLaunchMarker) &&
      Date.now() < deadline &&
      interrupted.exitCode === null &&
      interrupted.signalCode === null
    )
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert(
      existsSync(failedLaunchMarker),
      "Cancellation trigger must observe the failed replacement launch",
    );
  } finally {
    interrupted.kill("SIGTERM");
    const terminationDeadline = setTimeout(() => interrupted.kill("SIGKILL"), 5_000);
    try {
      const exit = await exited;
      assert.equal(exit.signal, "SIGTERM", "Interrupted restart must terminate promptly");
    } finally {
      clearTimeout(terminationDeadline);
    }
  }
  assert(existsSync(join(state, "service.json")), "Cancellation must retain service ownership");
  assert.equal(cli("status").reservationMatches, true);
  assert.equal(panePid(), before, "Cancellation must preserve pane work");
  receipt.interruptedRestartPreservedOwnership = true;
  const failedRestart = run(process.execPath, [cliPath, "daemon", "service", "restart", "--json"]);
  assert.notEqual(failedRestart.status, 0, "Failed launcher must not report a ready daemon");
  assert.equal(
    failedRestart.signal,
    null,
    "Readiness refusal must finish without external termination",
  );
  assert.match(
    failedRestart.stderr,
    /Service did not publish a verified daemon before the deadline/u,
  );
  assert(
    existsSync(join(state, "service.json")),
    "Failed activation must retain service ownership",
  );
  assert.equal(cli("status").reservationMatches, true);
  assert.equal(panePid(), before, "Failed service activation must preserve pane work");
  receipt.failedRestart = {
    exitCode: failedRestart.status,
    signal: failedRestart.signal,
    readinessRefused: true,
  };
  activate(nextLauncher);
  const recovered = cli("restart");
  assert.equal(recovered.status, "running");
  assertLaunched(recovered, nextCliPath);
  assert.notEqual(recovered.instanceId, second.instanceId);
  assert.equal(panePid(), before, "Rollback and recovery must preserve pane work");
  receipt.failedLauncherRecovery = true;
  assert.equal(cli("remove", "--yes").status, "removed");
  assert.equal(panePid(), before, "Service removal must preserve existing pane work");
  assert.equal(cli("status").status, "not-installed");
  receipt.panePreserved = true;
  receipt.sourceAfter = sourceIdentity();
  receipt.sourceStable =
    receipt.source.commit === receipt.sourceAfter.commit &&
    receipt.source.trackedDiffSha256 === receipt.sourceAfter.trackedDiffSha256;
  assert(receipt.sourceStable, "Tracked source changed during service qualification");
} catch (error) {
  receipt.failure = error.message;
} finally {
  if (serviceAttempted && existsSync(join(state, "service.json"))) {
    try {
      cli("remove", "--yes");
    } catch {
      receipt.cleanup.publicRemoveFailed = true;
    }
  }
  // Emergency cleanup is restricted to the unique target created by this run.
  if (serviceAttempted && !managerAbsent()) {
    run(
      launchd ? "/bin/launchctl" : "systemctl",
      launchd ? ["bootout", target] : ["--user", "disable", "--now", target],
    );
  }
  receipt.cleanup.managerAbsent = managerAbsent();
  receipt.cleanup.serviceRecordAbsent = !existsSync(join(state, "service.json"));
  receipt.cleanup.reservationAbsent = !existsSync(join(state, "daemon.json"));
  receipt.cleanup.unitAbsent = !existsSync(unitPath);
  if (tmuxAttempted) {
    run(tmux, ["-S", socket, "kill-server"]);
    const result = run(tmux, ["-S", socket, "list-sessions"]);
    receipt.cleanup.tmuxStopped =
      result.status === 1 &&
      /no server running|error connecting|failed to connect/u.test(result.stderr);
  }
  receipt.passed =
    !receipt.failure &&
    receipt.sourceStable === true &&
    receipt.panePreserved === true &&
    receipt.stableLauncherUpdate === true &&
    receipt.failedLauncherRecovery === true &&
    receipt.interruptedRestartPreservedOwnership === true &&
    receipt.cleanup.managerAbsent &&
    receipt.cleanup.serviceRecordAbsent &&
    receipt.cleanup.reservationAbsent &&
    receipt.cleanup.unitAbsent &&
    receipt.cleanup.tmuxStopped;
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(
    JSON.stringify({ passed: receipt.passed, receipt: output, failure: receipt.failure }),
  );
  if (!receipt.passed) process.exitCode = 1;
}
