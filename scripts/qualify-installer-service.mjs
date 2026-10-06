#!/usr/bin/env node
// Real published-version installer transactions, controlled by the packed
// candidate's public service CLI. Never targets the user's normal namespace.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  capturePackedInstallEnvironment,
  privatePackedInstallEnvironment,
} from "./lib/packed-install-environment.mjs";
import {
  capturePackedTmuxWitness,
  packedTmuxWitnessDifferences,
  retirePackedTmuxSocket,
} from "./lib/packed-install-cleanup.mjs";

assert(["darwin", "linux"].includes(process.platform), "Unsupported platform");
assert(process.getuid() > 0, "Requires a non-root user with an available user manager");
assert(
  process.argv[2],
  "Usage: node scripts/qualify-installer-service.mjs <new-evidence-directory>",
);
const repo = resolve(import.meta.dirname, "..");
const evidence = resolve(process.argv[2]);
mkdirSync(evidence, { recursive: false });
const root = mkdtempSync(join(realpathSync(tmpdir()), "ti-install-service-"));
const home = join(root, "home"),
  state = join(root, "state");
const prefix = join(root, "prefix with spaces"),
  socket = join(root, "tmux.sock");
const controller = join(root, "controller");
for (const dir of [home, state, controller]) mkdirSync(dir, { mode: 0o700 });
const installer = join(repo, "docs/public/install.sh");
const managed = join(prefix, "share/tmux-ide"),
  launcher = join(prefix, "bin/tmux-ide");
const cli = join(controller, "node_modules/tmux-ide/bin/cli.js");
const platform = `${process.platform}-${process.arch}`;
const launchd = process.platform === "darwin";
const hash = (data) => createHash("sha256").update(data).digest("hex");
const target = launchd
  ? `gui/${process.getuid()}/com.tmux-ide.${hash(state).slice(0, 24)}`
  : `tmux-ide.${hash(state).slice(0, 24)}.service`;
const unit = launchd
  ? join(home, "Library/LaunchAgents", target.split("/").at(-1) + ".plist")
  : join(home, ".config/systemd/user", target);
const env = privatePackedInstallEnvironment(capturePackedInstallEnvironment(process.env), {
  home,
  cache: join(root, "cache"),
  overrides: {
    PATH: "/usr/bin:/bin",
    TMUX_IDE_HOME: state,
    TMUX_IDE_DAEMON_INFO_DIR: state,
    TMUX_IDE_REGISTRY_DIR: state,
    TMUX_IDE_SETTINGS_DIR: state,
    TMUX_IDE_CONFIG: join(state, "config.json"),
    TMUX_IDE_TMUX_SOCKET_PATH: socket,
    NO_COLOR: "1",
    LC_ALL: "C",
    LANG: "C",
    // The manager bus belongs to the current user; only this fixture's unique
    // unit and private HOME are installed. The fixture never enables lingering.
    ...(!launchd && process.env.XDG_RUNTIME_DIR
      ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
      : {}),
  },
});
const receipt = {
  platform,
  root,
  target,
  startedAt: new Date().toISOString(),
  scope:
    "Published 2.9.0-beta.50 to 2.9.2 install/managed restart/rollback; candidate supplies service controller, not downloaded runtime",
  runtimeVersions: ["2.9.0-beta.50", "2.9.2"],
  runtimeArtifacts: [],
  installerSha256: hash(readFileSync(installer)),
  steps: [],
  cleanup: {},
};
let timedOut = false,
  tmux,
  witness,
  tmuxAttempted = false,
  serviceAttempted = false;
const observedDaemons = new Set();
function raw(file, args, options = {}) {
  const result = spawnSync(file, args, {
    env,
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  if (result.error) timedOut = true;
  return result;
}
function checked(file, args, options) {
  const result = raw(file, args, options);
  assert.equal(
    result.status,
    0,
    `${file} ${args[0]} failed (${result.status ?? result.error?.code})`,
  );
  return result.stdout.trim();
}
function sourceIdentity() {
  const git = (...args) => checked("git", args, { cwd: repo });
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    trackedDiffSha256: hash(git("diff", "--binary", "HEAD", "--")),
    trackedChanges: git("diff", "--name-only", "HEAD", "--").split("\n").filter(Boolean),
    untrackedPaths: git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean),
  };
}
function managerAbsent() {
  if (launchd) {
    const result = raw("/bin/launchctl", ["print", target]);
    return result.status === 113 && result.stderr.includes("Could not find service");
  }
  const result = raw("systemctl", ["--user", "show", target, "--property=LoadState,MainPID"]);
  return (
    [0, 4].includes(result.status) &&
    /^LoadState=not-found$/mu.test(result.stdout) &&
    /^MainPID=0$/mu.test(result.stdout)
  );
}
function service(action, ...args) {
  const result = raw(process.execPath, [cli, "daemon", "service", action, ...args, "--json"]);
  const step = { service: action, exitCode: result.status, signal: result.signal };
  receipt.steps.push(step);
  assert.equal(
    result.status,
    0,
    `Service ${action} failed (${result.status ?? result.error?.code})`,
  );
  const value = JSON.parse(result.stdout);
  for (const key of ["status", "pid", "instanceId", "reservationMatches"])
    if (value[key] !== undefined) step[key] = value[key];
  if (value.pid) observedDaemons.add(value.pid);
  return value;
}
function install(name, args, success = true) {
  console.log(`Installer stage: ${name}`);
  const result = raw("/bin/sh", [installer, "--prefix", prefix, ...args], { timeout: 900_000 });
  writeFileSync(join(evidence, `${name}.log`), (result.stdout ?? "") + (result.stderr ?? ""));
  receipt.steps.push({ install: name, exitCode: result.status, signal: result.signal });
  assert(!result.error, `Installer ${name} subprocess did not finish`);
  assert.equal(result.status === 0, success, `Installer ${name} result`);
}
function pane() {
  return checked(tmux, [
    "-S",
    socket,
    "display-message",
    "-p",
    "-t",
    "installer-proof",
    "#{pid}|#{pane_id}|#{pane_pid}",
  ]);
}
function recordRuntime(release, version) {
  const pkg = join(release, "npm/lib/node_modules/tmux-ide");
  const native = join(pkg, "packages/daemon/dist/native/tmux", platform);
  const files = {
    node: join(release, "node/bin/node"),
    cli: join(pkg, "bin/cli.js"),
    package: join(pkg, "package.json"),
    nativeManifest: join(native, "manifest.json"),
    tmux: join(native, "tmux"),
    tui: join(state, "bin", `tmux-ide-tui-${platform}-${version}`),
  };
  receipt.runtimeArtifacts.push({
    version,
    nodeVersion: checked(files.node, ["--version"]),
    sha256: Object.fromEntries(
      Object.entries(files).map(([name, path]) => [name, hash(readFileSync(path))]),
    ),
  });
}
async function health(expected, version) {
  const info = JSON.parse(readFileSync(join(state, "daemon.json"), "utf8"));
  assert.equal(info.instanceId, expected.instanceId);
  assert.equal(info.pid, expected.pid);
  assert.equal(info.productVersion, version);
  observedDaemons.add(info.pid);
  const identity = await (
    await fetch(`http://127.0.0.1:${info.port}/identity`, { signal: AbortSignal.timeout(5_000) })
  ).json();
  assert.equal(identity.instanceId, expected.instanceId);
  assert.equal(identity.pid, expected.pid);
  assert.equal(pane(), receipt.paneBefore, "Original pane and tmux server must survive");
}
try {
  receipt.source = sourceIdentity();
  assert(
    receipt.source.trackedChanges.every((path) => path === "bin/cli.js"),
    "Commit source changes before qualification; only the generated CLI may differ",
  );
  checked(
    launchd ? "/bin/launchctl" : "systemctl",
    launchd ? ["print-disabled", `gui/${process.getuid()}`] : ["--user", "show-environment"],
  );
  assert(managerAbsent(), "Private service must not exist before qualification");
  // Controller setup may use the build host's Node/npm. Every installer and
  // installed launcher invocation uses the restricted PATH above.
  const npm = realpathSync(spawnSync("which", ["npm"], { encoding: "utf8" }).stdout.trim());
  const controllerEnv = { ...env, PATH: dirname(process.execPath) + ":/usr/bin:/bin" };
  const rebuiltCli = join(root, "source-cli.js");
  checked(process.execPath, [join(repo, "scripts/build-cli.mjs"), "--outfile", rebuiltCli], {
    cwd: repo,
    env: controllerEnv,
  });
  receipt.sourceCliSha256 = hash(readFileSync(rebuiltCli));
  assert.equal(
    hash(readFileSync(join(repo, "bin/cli.js"))),
    receipt.sourceCliSha256,
    "Run pnpm build:cli before qualification; packed controller must match current source",
  );
  const packed = JSON.parse(
    checked(
      process.execPath,
      [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: repo, env: controllerEnv, timeout: 180_000 },
    ),
  );
  const tarball = join(root, packed[0].filename);
  receipt.controllerPackageSha256 = hash(readFileSync(tarball));
  checked(
    process.execPath,
    [
      npm,
      "install",
      "--prefix",
      controller,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    { env: controllerEnv, timeout: 180_000 },
  );
  receipt.controllerCliSha256 = hash(readFileSync(cli));
  assert.equal(receipt.controllerCliSha256, receipt.sourceCliSha256);
  install("install-beta50", ["--version", "2.9.0-beta.50"]);
  assert.equal(checked(launcher, ["--version"]), "tmux-ide v2.9.0-beta.50");
  const oldRelease = realpathSync(join(managed, "current"));
  recordRuntime(oldRelease, "2.9.0-beta.50");
  tmux = join(
    oldRelease,
    "npm/lib/node_modules/tmux-ide/packages/daemon/dist/native/tmux",
    platform,
    "tmux",
  );
  receipt.oldTmuxSha256 = hash(readFileSync(tmux));
  tmuxAttempted = true;
  checked(tmux, [
    "-S",
    socket,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "installer-proof",
    "exec sleep 1800",
  ]);
  receipt.paneBefore = pane();
  witness = capturePackedTmuxWitness(socket, Number(receipt.paneBefore.split("|")[0]));
  serviceAttempted = true;
  const first = service("install", launcher);
  assert.equal(first.status, "running");
  await health(first, "2.9.0-beta.50");
  install("update-2.9.2", ["--version", "2.9.2"]);
  assert.equal(checked(launcher, ["--version"]), "tmux-ide v2.9.2");
  const newRelease = realpathSync(join(managed, "current"));
  recordRuntime(newRelease, "2.9.2");
  assert.notEqual(newRelease, oldRelease);
  await health(first, "2.9.0-beta.50");
  const doctor = JSON.parse(checked(launcher, ["doctor", "--json"]));
  assert.equal(doctor.ok, true, "Installed required doctor checks must pass");
  receipt.doctor = doctor.checks.map(({ label, pass, optional }) => ({ label, pass, optional }));
  install("failed-update", ["--version", "0.0.0-pf01-nonexistent"], false);
  assert.equal(realpathSync(join(managed, "current")), newRelease);
  await health(first, "2.9.0-beta.50");
  const second = service("restart");
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.instanceId, first.instanceId);
  await health(second, "2.9.2");
  install("rollback", ["--rollback"]);
  assert.equal(realpathSync(join(managed, "current")), oldRelease);
  await health(second, "2.9.2");
  const rolled = service("restart");
  await health(rolled, "2.9.0-beta.50");
  install("roll-forward", ["--rollback"]);
  assert.equal(realpathSync(join(managed, "current")), newRelease);
  await health(rolled, "2.9.0-beta.50");
  const forward = service("restart");
  await health(forward, "2.9.2");
  assert.equal(service("remove", "--yes").status, "removed");
  assert.equal(pane(), receipt.paneBefore);
  assert(managerAbsent());
  install("uninstall", ["--uninstall"]);
  assert(!existsSync(launcher));
  assert.equal(pane(), receipt.paneBefore);
  receipt.completed = true;
} catch (error) {
  receipt.failure = String(error);
} finally {
  try {
    if (serviceAttempted && existsSync(join(state, "service.json"))) {
      try {
        service("remove", "--yes");
      } catch {
        receipt.cleanup.publicRemoveFailed = true;
      }
    }
    if (serviceAttempted && !managerAbsent())
      raw(
        launchd ? "/bin/launchctl" : "systemctl",
        launchd ? ["bootout", target] : ["--user", "disable", "--now", target],
      );
    receipt.cleanup.managerAbsent = managerAbsent();
    assert(receipt.cleanup.managerAbsent);
    receipt.cleanup.serviceRecordAbsent = !existsSync(join(state, "service.json"));
    receipt.cleanup.reservationAbsent = !existsSync(join(state, "daemon.json"));
    receipt.cleanup.unitAbsent = !existsSync(unit);
    receipt.cleanup.observedDaemonsAbsent = [...observedDaemons].every((pid) => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return error.code === "ESRCH";
      }
    });
    assert(
      receipt.cleanup.observedDaemonsAbsent,
      "Retaining roots while an observed daemon is alive",
    );
    assert(!tmuxAttempted || witness, "Retaining roots without a tmux owner witness");
    if (witness) {
      assert.deepEqual(
        packedTmuxWitnessDifferences(witness, capturePackedTmuxWitness(socket, witness.pid)),
        [],
      );
      checked(tmux, ["-S", socket, "kill-server"]);
      receipt.cleanup.tmux = await retirePackedTmuxSocket(witness);
      assert(receipt.cleanup.tmux.ownerDead && receipt.cleanup.tmux.socketRemoved);
    }
    assert(!timedOut, "Retaining roots after an uncertain subprocess exit");
    assert(
      receipt.cleanup.serviceRecordAbsent &&
        receipt.cleanup.reservationAbsent &&
        receipt.cleanup.unitAbsent,
    );
    rmSync(root, { recursive: true });
    receipt.cleanup.rootRemoved = !existsSync(root);
  } catch (error) {
    receipt.cleanup.failure = String(error);
  }
  receipt.sourceAfter = sourceIdentity();
  receipt.sourceStable =
    receipt.source?.commit === receipt.sourceAfter.commit &&
    receipt.source?.trackedDiffSha256 === receipt.sourceAfter.trackedDiffSha256 &&
    receipt.installerSha256 === hash(readFileSync(installer));
  receipt.observedDaemonPids = [...observedDaemons];
  receipt.passed =
    receipt.completed === true &&
    receipt.sourceStable &&
    !receipt.failure &&
    !receipt.cleanup.failure &&
    receipt.cleanup.rootRemoved === true;
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      passed: receipt.passed,
      evidence,
      failure: receipt.failure,
      cleanupFailure: receipt.cleanup.failure,
    }),
  );
  if (!receipt.passed) process.exitCode = 1;
}
