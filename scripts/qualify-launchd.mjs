#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createMacProcessIdentity } from "./lib/owned-ssh-fixture.mjs";
import {
  capturePackedTmuxWitness,
  retirePackedTmuxSocket,
  settlePackedChildren,
} from "./lib/packed-install-cleanup.mjs";
import { privatePackedInstallEnvironment } from "./lib/packed-install-environment.mjs";
import {
  launchdDefinition,
  ownedLaunchdJob,
  publishLaunchdEntry,
  privateRootReferences,
  verifyLaunchdDaemonIdentity,
  launchdCommandDiagnostic,
} from "./lib/owned-launchd-fixture.mjs";

const source = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const evidence = process.argv[2] && resolve(process.argv[2]);
if (process.platform !== "darwin" || !evidence || process.getuid() === 0)
  throw new Error(
    "Usage: node --import tsx scripts/qualify-launchd.mjs <new-evidence-directory> (nonroot macOS)",
  );
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: source,
    encoding: "utf8",
  }).trim()
)
  throw new Error("clean committed source required");
process.umask(0o077);
mkdirSync(evidence, { mode: 0o700 });
const root = realpathSync(mkdtempSync("/private/tmp/ti12-launchd-"));
const rootWitness = lstatSync(root);
const hash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const receipt = {
  ok: false,
  sourceCommit,
  root,
  node: process.execPath,
  nodeVersion: process.version,
  stages: [],
  witnessed: [],
  syntheticOldVersion: true,
  cleanup: {},
};
let stage = "prepare",
  cleaning = false,
  job,
  witness,
  witnessFiles,
  definition,
  tmuxPid,
  socketWitness,
  packedSocketWitness;
let stageDeadline = Date.now() + 30000;
function setStage(value) {
  stage = value;
  stageDeadline = Date.now() + 30000;
}
const owners = new Map();
const commandChildren = [],
  commandExits = new Map();
const controller = new AbortController();
const cancel = () => controller.abort(new Error("qualification-cancelled"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
const wholeTimer = setTimeout(cancel, 180000);
const home = join(root, "home"),
  state = join(root, "state"),
  socket = join(root, "tmux.sock");
let tmux, env;
function command(executable, args, extra = {}) {
  return new Promise((resolveCommand) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: cleaning ? 30000 : Math.max(1, Math.min(30000, stageDeadline - Date.now())),
        killSignal: "SIGKILL",
        maxBuffer: 65536,
        ...(!cleaning ? { signal: controller.signal } : {}),
        ...extra,
      },
      (error, stdout, stderr) => {
        const result = {
          code: error ? (Number.isInteger(error.code) ? error.code : -1) : 0,
          stdout,
          stderr,
        };
        if (executable === "/bin/launchctl") {
          receipt.launchctl ??= [];
          if (receipt.launchctl.length < 300)
            receipt.launchctl.push(launchdCommandDiagnostic(args[0], result));
        }
        resolveCommand(result);
      },
    );
    commandChildren.push(child);
    commandExits.set(child, new Promise((resolveExit) => child.once("close", resolveExit)));
  });
}
async function checked(executable, args) {
  const result = await command(executable, args);
  if (result.code !== 0) throw new Error("fixture-command-refused");
  return result.stdout;
}
const tm = (...args) => checked(tmux, ["-S", socket, "-f", "/dev/null", ...args]);
async function until(fn) {
  const deadline = cleaning ? Date.now() + 30000 : Math.min(Date.now() + 30000, stageDeadline);
  while (Date.now() < deadline) {
    if (!cleaning && controller.signal.aborted) throw new Error("qualification-cancelled");
    const value = await fn();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("fixture-stage-timeout");
}
function readIdentityRecord() {
  const path = join(state, "daemon.json");
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 16384 || stat.mode & 0o077)
    throw new Error("unsafe-daemon-record");
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !Number.isInteger(value.protocolVersion) ||
    typeof value.startedAt !== "string" ||
    typeof value.productVersion !== "string" ||
    typeof value.instanceId !== "string" ||
    typeof value.authToken !== "string"
  )
    throw new Error("invalid-daemon-record");
  return value;
}
async function identity() {
  const verified = await verifyLaunchdDaemonIdentity({
    read: readIdentityRecord,
    identify: (pid) => witness.identify(pid),
    request: async (value) => {
      const response = await fetch(`http://127.0.0.1:${value.port}/identity`, {
        signal: AbortSignal.timeout(1000),
      });
      return { ok: response.ok, identity: await response.json() };
    },
  });
  if (!verified) return null;
  const { value, birth } = verified;
  const previous = owners.get(value.pid);
  if (previous && previous !== birth) throw new Error("owner-incarnation-changed");
  owners.set(value.pid, birth);
  return value;
}

const facts = (value) => ({
  pid: value.pid,
  instanceId: value.instanceId,
  productVersion: value.productVersion,
});
async function observeService() {
  const value = await job.inspect();
  if (value?.pid) {
    const birth = await witness.identify(value.pid);
    if (birth) {
      if (owners.has(value.pid) && owners.get(value.pid) !== birth)
        throw new Error("owner-incarnation-changed");
      owners.set(value.pid, birth);
    }
  }
  return value;
}
async function serviceOwner(version) {
  return until(async () => {
    const value = await identity();
    if (!value || value.productVersion !== version) return null;
    const service = await observeService();
    if (!service?.pid) return null;
    if (service.pid !== value.pid) throw new Error("daemon-escaped-supervisor");
    return value;
  });
}
async function sentinel(marker) {
  await tm(
    "send-keys",
    "-t",
    "keep",
    `printf '%s\\n' ${Buffer.from(marker).toString("base64")} | /usr/bin/base64 -D`,
    "Enter",
  );
  await until(async () =>
    (await tm("capture-pane", "-p", "-S", "-", "-t", "keep")).includes(marker),
  );
  return (await tm("display-message", "-p", "-t", "keep", "#{pid}|#{pane_id}|#{pane_pid}")).trim();
}
function requireNoReferences(references) {
  if (references.length) throw new Error("fixture-root-still-referenced");
}
function removeRoot() {
  const current = lstatSync(root);
  if (
    !current.isDirectory() ||
    current.dev !== rootWitness.dev ||
    current.ino !== rootWitness.ino ||
    current.uid !== process.getuid() ||
    (current.mode & 0o777) !== 0o700
  )
    throw new Error("fixture-root-changed");
  rmSync(root, { recursive: true });
}
async function stopOwners() {
  let discoveryFailed = false;
  try {
    await identity();
  } catch {
    discoveryFailed = true;
  }
  const outcomes = await Promise.allSettled(
    [...owners].map(async ([pid, birth]) => {
      const current = await witness.identify(pid);
      if (current === null) return;
      if (current !== birth) throw new Error("owner-changed");
      process.kill(pid, "SIGTERM");
      await until(async () => (await witness.identify(pid)) === null);
    }),
  );
  if (discoveryFailed || outcomes.some((value) => value.status === "rejected"))
    throw new Error("owner-cleanup-refused");
}
async function stopTmux() {
  if (!tmuxPid) return;
  const current = await witness.identify(tmuxPid);
  if (current !== null && current !== receipt.tmux.birth) throw new Error("tmux-owner-changed");
  if (current) await tm("kill-server");
  await until(async () => (await witness.identify(tmuxPid)) === null);
  receipt.cleanup.socket = await retirePackedTmuxSocket(packedSocketWitness);
  if (receipt.pane) await until(async () => (await witness.identify(receipt.pane.pid)) === null);
}
const logGuard = setInterval(() => {
  for (const name of ["service.stdout", "service.stderr"]) {
    const path = join(root, name);
    if (existsSync(path) && lstatSync(path).size > 262144) cancel();
  }
}, 100);
try {
  for (const path of [home, state]) mkdirSync(path, { mode: 0o700 });
  tmux = execFileSync("/usr/bin/which", ["tmux"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  }).trim();
  env = privatePackedInstallEnvironment(
    { PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`, LANG: "en_US.UTF-8" },
    {
      home,
      cache: join(root, "cache"),
      overrides: {
        TMUX: "",
        NODE_OPTIONS: "",
        NODE_PATH: "",
        BASH_ENV: "",
        ENV: "",
        TMUX_IDE_TMUX_BIN: tmux,
        TMUX_IDE_TMUX_SOCKET_PATH: socket,
        TMUX_IDE_DAEMON_INFO_DIR: state,
        TMUX_IDE_REGISTRY_DIR: state,
        TMUX_IDE_SETTINGS_DIR: state,
        NO_COLOR: "1",
      },
    },
  );
  witness = await createMacProcessIdentity({
    parent: root,
    onAllocated: (value) => {
      witnessFiles = value;
    },
  });
  receipt.kernelHelper = { sha256: witness.artifactHash, sourceSha256: witness.sourceHash };
  symlinkSync(join(source, "node_modules"), join(root, "node_modules"));
  const oldSource = join(root, "older.ts"),
    oldBundle = join(root, "older.mjs"),
    stable = join(root, "stable.mjs"),
    cli = join(root, "installed/bin/cli.js");
  mkdirSync(join(root, "installed/bin"), { recursive: true, mode: 0o700 });
  copyFileSync(join(source, "package.json"), join(root, "installed/package.json"));
  copyFileSync(join(source, "bin/cli.js"), cli);
  writeFileSync(
    oldSource,
    `import { runHeadlessDaemon } from ${JSON.stringify(join(source, "packages/daemon/src/lib/headless-daemon.ts"))}; await runHeadlessDaemon({expectedVersion:"2.9.0-beta.9",json:true}); await new Promise(r=>process.stdout.write("",r)); process.exit(0);\n`,
    { mode: 0o600 },
  );
  await build({
    entryPoints: [oldSource],
    outfile: oldBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
    plugins: [
      {
        name: "external-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.kind === "entry-point" ||
              args.path.startsWith(".") ||
              args.path.startsWith("/") ||
              args.path.startsWith("@tmux-ide/") ||
              args.path === "@xterm/addon-unicode11"
            )
              return;
            return { external: true };
          });
        },
      },
    ],
  });
  receipt.artifacts = {
    node: hash(process.execPath),
    olderBundle: hash(oldBundle),
    currentCli: hash(cli),
    tmux: hash(tmux),
  };
  receipt.oldEntry = publishLaunchdEntry(stable, oldBundle, env);
  definition = launchdDefinition({ root, node: process.execPath, entry: stable, env });
  receipt.job = {
    label: definition.label,
    target: definition.target,
    plistSha256: definition.sha256,
  };
  writeFileSync(join(evidence, "descriptor.json"), JSON.stringify(receipt, null, 2));
  job = ownedLaunchdJob({ definition, run: (args) => command("/bin/launchctl", args) });
  await tm("new-session", "-d", "-s", "keep", "-x", "80", "-y", "24", "/bin/sh");
  tmuxPid = Number((await tm("display-message", "-p", "-t", "keep", "#{pid}")).trim());
  const tmuxBirth = await witness.identify(tmuxPid);
  if (!tmuxBirth) throw new Error("tmux-owner-missing");
  receipt.tmux = { pid: tmuxPid, birth: tmuxBirth };
  socketWitness = lstatSync(socket);
  packedSocketWitness = capturePackedTmuxWitness(socket, tmuxPid);
  const firstMarker = `LAUNCHD_BEFORE_${randomUUID()}`;
  const beforePane = await sentinel(firstMarker);
  const panePid = Number(beforePane.split("|")[2]);
  const paneBirth = await witness.identify(panePid);
  if (!paneBirth) throw new Error("sentinel-process-missing");
  receipt.pane = { pid: panePid, birth: paneBirth };
  setStage("initial-service");
  await job.bootstrap();
  const prior = await serviceOwner("2.9.0-beta.9");
  receipt.stages.push({ stage, ...facts(prior) });
  setStage("same-version-restart");
  await checked(process.execPath, [cli, "daemon", "restart", "--json"]);
  const restarted = await serviceOwner("2.9.0-beta.9");
  if (restarted.pid !== prior.pid || restarted.instanceId === prior.instanceId)
    throw new Error("same-version-owner-changed");
  receipt.stages.push({ stage, ...facts(restarted) });
  if ((await sentinel(`LAUNCHD_RESTART_${randomUUID()}`)) !== beforePane)
    throw new Error("restart-sentinel-replaced");
  setStage("installed-upgrade");
  receipt.newEntry = publishLaunchdEntry(stable, cli, env);
  let sampling = true;
  receipt.upgradeSamples = [];
  let samplingFailure = false;
  const sampler = (async () => {
    while (sampling) {
      try {
        const value = await identity();
        const service = await observeService();
        if (receipt.upgradeSamples.length < 300)
          receipt.upgradeSamples.push({
            at: Date.now(),
            servicePid: service?.pid ?? null,
            owner: value ? facts(value) : null,
          });
      } catch {
        samplingFailure = true;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  })();
  const settledUpdates = await Promise.allSettled(
    [0, 1].map(() =>
      checked(process.execPath, [cli, "update", "--daemon", "--if-running", "--json"]),
    ),
  );
  sampling = false;
  await sampler;
  if (samplingFailure) throw new Error("upgrade-observation-refused");
  if (settledUpdates.some((value) => value.status === "rejected"))
    throw new Error("update-command-refused");
  const results = settledUpdates.map((value) => value.value);
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  const next = await serviceOwner(version);
  for (const result of results) {
    const value = JSON.parse(result);
    if (!value.ok || value.instanceId !== next.instanceId)
      throw new Error("concurrent-update-disagreed");
  }
  if (next.instanceId === restarted.instanceId) throw new Error("generation-not-replaced");
  await until(async () => (await witness.identify(prior.pid)) === null);
  receipt.stages.push({ stage, ...facts(next), concurrentRequests: 2 });
  const afterPane = await sentinel(`LAUNCHD_AFTER_${randomUUID()}`);
  const nowSocket = lstatSync(socket);
  if (
    beforePane !== afterPane ||
    nowSocket.ino !== socketWitness.ino ||
    nowSocket.dev !== socketWitness.dev
  )
    throw new Error("sentinel-replaced");
  if (!(await tm("capture-pane", "-p", "-S", "-", "-t", "keep")).includes(firstMarker))
    throw new Error("sentinel-history-lost");
  receipt.sentinelPreserved = true;
  receipt.ok = true;
} catch (error) {
  receipt.failure = {
    stage,
    code:
      error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "fixture-refused",
  };
} finally {
  cleaning = true;
  clearTimeout(wholeTimer);
  clearInterval(logGuard);
  receipt.cleanup.commands = await settlePackedChildren(commandChildren, commandExits);
  try {
    await job?.retire();
    receipt.cleanup.job = true;
  } catch {
    receipt.cleanup.job = false;
  }
  // Only after the service is retired may a private detached upgrade owner be stopped.
  if (receipt.cleanup.job && witness) {
    try {
      await stopOwners();
      receipt.cleanup.owners = true;
    } catch {
      receipt.cleanup.owners = false;
    }
  }
  try {
    await stopTmux();
    receipt.cleanup.tmux = true;
  } catch {
    receipt.cleanup.tmux = false;
  }
  receipt.commandPids = commandChildren.map((child) => child.pid).filter(Boolean);
  receipt.witnessed = [...owners].map(([pid, birth]) => ({ pid, birth }));
  if (
    receipt.cleanup.job &&
    receipt.cleanup.owners &&
    receipt.cleanup.tmux &&
    receipt.cleanup.commands.confirmed
  ) {
    try {
      const references = privateRootReferences(
        await command("/usr/sbin/lsof", ["-n", "-P", "-F", "p", "+D", root], {
          cwd: source,
          timeout: 5000,
          maxBuffer: 1048576,
        }),
      );
      receipt.cleanup.openRootPids = references;
      requireNoReferences(references);
      await witnessFiles?.disposeFiles();
      removeRoot();
      receipt.cleanup.root = true;
    } catch {
      receipt.cleanup.root = false;
    }
  }
  receipt.cleanup.commands = await settlePackedChildren(commandChildren, commandExits);
  receipt.commandPids = commandChildren.map((child) => child.pid).filter(Boolean);
  receipt.ok =
    receipt.ok &&
    Object.values(receipt.cleanup).every(Boolean) &&
    receipt.cleanup.root === true &&
    receipt.cleanup.commands.confirmed;
  writeFileSync(join(evidence, "qualification.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
console.log(JSON.stringify({ ok: receipt.ok, stage, evidence }));
if (!receipt.ok) process.exitCode = 1;
