/** Test-only Linux payload. Executed solely inside the exact owned systemd fixture. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  readlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import {
  systemdFixtureDefinition,
  parseSystemdUnit,
  linuxBirth,
  sha256,
  verifySystemdDependencyInputs,
  verifySystemdDependencyLinks,
  observeSystemdOwner,
} from "./lib/owned-systemd-fixture.mjs";
import {
  readLaunchdSupervisedRecord,
  verifyLaunchdDaemonIdentity,
  publishLaunchdEntry,
} from "./lib/owned-launchd-fixture.mjs";
import { privatePackedInstallEnvironment } from "./lib/packed-install-environment.mjs";
import { settlePackedChildren } from "./lib/packed-install-cleanup.mjs";
const root = "/qualification",
  source = join(root, "source");
const [phase] = process.argv.slice(2);
if (
  process.platform !== "linux" ||
  process.getuid() !== 1000 ||
  !["prepare", "journey", "cold", "cleanup"].includes(phase)
)
  throw new Error("fixture-context-refused");
process.umask(0o077);
const descriptor = JSON.parse(readFileSync(join(root, "descriptor.json"), "utf8"));
const d = systemdFixtureDefinition(descriptor.nonce);
const state = join(root, "state"),
  socket = join(root, "tmux.sock");
const env = privatePackedInstallEnvironment(
  { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
  {
    home: join(root, "home"),
    cache: join(root, "cache"),
    overrides: {
      TMUX: "",
      TMUX_IDE_DAEMON_INFO_DIR: state,
      TMUX_IDE_REGISTRY_DIR: state,
      TMUX_IDE_SETTINGS_DIR: state,
      TMUX_IDE_TMUX_SOCKET_PATH: socket,
      TMUX_IDE_TMUX_BIN: "/opt/native/tmux/tmux",
      NO_COLOR: "1",
    },
  },
);
const children = [],
  exits = new Map(),
  controller = new AbortController();
const cancel = () => controller.abort();
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
let cleaning = false,
  stage = phase,
  deadline = Date.now() + 30000;
const receipt = { phase, ok: false, stages: [], samples: [], node: process.version };
function command(executable, args, timeout = 30000) {
  return new Promise((resolveCommand, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: source,
        env,
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
        ...(!cleaning ? { signal: controller.signal } : {}),
      },
      (error, stdout) => {
        if (error) reject(new Error("fixture-command-refused"));
        else resolveCommand(stdout);
      },
    );
    children.push(child);
    exits.set(child, new Promise((r) => child.once("close", r)));
  });
}
const cli = (...args) => command(process.execPath, [join(source, "bin/cli.js"), ...args, "--json"]);
const tm = (...args) =>
  command("/opt/native/tmux/tmux", ["-S", socket, "-f", "/dev/null", ...args]);
const facts = (v) => ({
  pid: v.pid,
  instanceId: v.instanceId,
  productVersion: v.productVersion,
  startedAt: v.startedAt,
});
function birth(pid) {
  try {
    return linuxBirth(
      readFileSync(`/proc/${pid}/stat`, "utf8"),
      readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
      readlinkSync(`/proc/${pid}/ns/pid`),
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function readRecord() {
  const path = join(state, "daemon.json");
  if (!existsSync(path)) return null;
  const s = lstatSync(path);
  if (!s.isFile() || s.uid !== 1000 || s.size > 16384 || s.mode & 0o077)
    throw new Error("record-ownership-refused");
  return readLaunchdSupervisedRecord(JSON.parse(readFileSync(path, "utf8")), d.supervisionId);
}
async function identity() {
  const result = await verifyLaunchdDaemonIdentity({
    read: readRecord,
    identify: async (pid) => {
      const b = birth(pid);
      return b ? JSON.stringify(b) : null;
    },
    request: async (v) => {
      const response = await fetch(`http://127.0.0.1:${v.port}/identity`, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      });
      return { ok: response.ok, identity: await response.json() };
    },
  });
  return result?.value ?? null;
}
async function unit() {
  if (sha256(readFileSync(`/etc/systemd/system/${d.unit}`)) !== d.unitHash)
    throw new Error("service-definition-changed");
  return parseSystemdUnit(
    await command("/bin/systemctl", [
      "show",
      d.unit,
      "--no-pager",
      "--property=Id,FragmentPath,LoadState,MainPID,User,Group,Restart,KillMode,ActiveState,SubState",
    ]),
    d,
  );
}
async function until(fn) {
  while (Date.now() < deadline) {
    if (controller.signal.aborted) throw new Error("fixture-cancelled");
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("fixture-stage-timeout");
}
function next(name) {
  stage = name;
  deadline = Date.now() + 30000;
}
async function serviceOwner(version) {
  return until(async () => {
    const sample = await observeSystemdOwner({ identity, unit, birth });
    if (!sample.confirmed || sample.owner.productVersion !== version) return null;
    return sample.owner;
  });
}
async function sentinel() {
  const marker = `SYSTEMD_${randomUUID()}`;
  await tm(
    "send-keys",
    "-t",
    "keep",
    `printf '%s' ${Buffer.from(marker).toString("base64")} | /usr/bin/base64 -d`,
    "Enter",
  );
  await until(async () =>
    (await tm("capture-pane", "-p", "-S", "-", "-t", "keep")).includes(marker),
  );
  return (await tm("display-message", "-p", "-t", "keep", "#{pid}|#{pane_id}|#{pane_pid}")).trim();
}
const save = () => {
  const temporary = join(root, `${phase}.json.tmp`);
  writeFileSync(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  renameSync(temporary, join(root, `${phase}.json`));
};
try {
  for (const path of [state, env.HOME, join(root, "cache")])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  if (phase === "prepare") {
    receipt.dependencies = {
      inputs: verifySystemdDependencyInputs(source, "/opt/source-snapshot"),
      links: verifySystemdDependencyLinks(source),
    };
    await command(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import {validateBundledTmux} from ${JSON.stringify(join(source, "packages/daemon/src/lib/bundled-tmux.ts"))}; validateBundledTmux("/opt/native/tmux");`,
    ]);
    await command(process.execPath, [join(source, "scripts/build-cli.mjs")]);
    const olderSource = join(root, "older.ts"),
      olderBundle = join(root, "older.mjs");
    writeFileSync(
      olderSource,
      `import {runHeadlessDaemon} from ${JSON.stringify(join(source, "packages/daemon/src/lib/headless-daemon.ts"))}; await runHeadlessDaemon({expectedVersion:"2.9.0-beta.9",json:true,supervisionId:${JSON.stringify(d.supervisionId)}}); await new Promise(r=>process.stdout.write("",r)); process.exit(0);`,
    );
    await build({
      entryPoints: [olderSource],
      outfile: olderBundle,
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
      cli: sha256(readFileSync(join(source, "bin/cli.js"))),
      older: sha256(readFileSync(olderBundle)),
      node: sha256(readFileSync(process.execPath)),
      tmux: sha256(readFileSync("/opt/native/tmux/tmux")),
      nativeProvenance: sha256(readFileSync("/opt/native/tmux/manifest.json")),
    };
    receipt.oldEntry = publishLaunchdEntry(join(root, "stable.mjs"), olderBundle, env);
    await cli("daemon", "reserve-supervisor", d.supervisionId);
    receipt.reserved = true;
    next("prepare-external-sentinel");
    await tm("new-session", "-d", "-s", "keep", "-x", "80", "-y", "24", "/bin/sh");
    const pane = await sentinel();
    const [serverPid, , panePid] = pane.split("|");
    receipt.sentinel = {
      identity: pane,
      server: birth(Number(serverPid)),
      pane: birth(Number(panePid)),
    };
  } else if (phase === "journey") {
    next("initial-service");
    const initial = await serviceOwner("2.9.0-beta.9");
    receipt.stages.push({ stage, ...facts(initial), birth: birth(initial.pid) });
    const prepared = JSON.parse(readFileSync(join(root, "prepare.json"), "utf8"));
    const pane = prepared.sentinel.identity;
    const serverPid = prepared.sentinel.server.pid;
    if (
      JSON.stringify(birth(serverPid)) !== JSON.stringify(prepared.sentinel.server) ||
      (await sentinel()) !== pane ||
      readFileSync(`/proc/${serverPid}/cgroup`, "utf8").includes(`/${d.unit}`)
    )
      throw new Error("external-sentinel-changed");
    receipt.sentinel = prepared.sentinel;
    receipt.sentinelOutsideService = true;
    next("same-version-restart");
    await cli("daemon", "restart");
    const restarted = await serviceOwner("2.9.0-beta.9");
    if (
      restarted.pid !== initial.pid ||
      restarted.instanceId === initial.instanceId ||
      (await sentinel()) !== pane
    )
      throw new Error("runtime-restart-refused");
    receipt.stages.push({ stage, ...facts(restarted) });
    next("installed-upgrade");
    receipt.newEntry = publishLaunchdEntry(
      join(root, "stable.mjs"),
      join(source, "bin/cli.js"),
      env,
    );
    let sampling = true,
      samplingFailure = null;
    const sampler = (async () => {
      while (sampling) {
        const sample = await observeSystemdOwner({ identity, unit, birth });
        if (receipt.samples.length < 300)
          receipt.samples.push({
            owner: sample.owner ? facts(sample.owner) : null,
            servicePid: sample.servicePid,
            confirmed: sample.confirmed,
          });
        await new Promise((r) => setTimeout(r, 100));
      }
    })().catch((error) => {
      samplingFailure =
        error.message === "daemon-escaped-supervisor"
          ? error.message
          : "upgrade-observation-refused";
    });
    const updates = await Promise.allSettled([
      cli("update", "--daemon", "--if-running"),
      cli("update", "--daemon", "--if-running"),
    ]);
    sampling = false;
    await sampler;
    if (samplingFailure) throw new Error(samplingFailure);
    const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    const upgraded = await serviceOwner(version);
    if (
      updates.some(
        (r) => r.status !== "fulfilled" || JSON.parse(r.value).instanceId !== upgraded.instanceId,
      ) ||
      upgraded.instanceId === restarted.instanceId ||
      (await sentinel()) !== pane
    )
      throw new Error("upgrade-convergence-refused");
    await until(async () => birth(initial.pid) === null);
    receipt.stages.push({
      stage,
      ...facts(upgraded),
      birth: birth(upgraded.pid),
      concurrentRequests: 2,
    });
    receipt.sentinelPreserved = true;
    receipt.beforeCold = {
      ...facts(upgraded),
      birth: birth(upgraded.pid),
      recordHash: sha256(readFileSync(join(state, "daemon.json"))),
    };
  } else if (phase === "cold") {
    const prior = JSON.parse(readFileSync(join(root, "journey.json"), "utf8"));
    next("cold-init");
    const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    const owner = await serviceOwner(version);
    if (owner.instanceId === prior.beforeCold.instanceId)
      throw new Error("cold-generation-unchanged");
    receipt.owner = { ...facts(owner), birth: birth(owner.pid) };
    receipt.pidReused = owner.pid === prior.beforeCold.pid;
    receipt.kernelBootChanged = receipt.owner.birth.bootId !== prior.beforeCold.birth.bootId;
    receipt.namespaceChanged = receipt.owner.birth.namespace !== prior.beforeCold.birth.namespace;
    receipt.reservationReinstalled = false;
  } else {
    const service = await unit();
    if (service.pid !== 0) throw new Error("service-still-live");
    await cli("daemon", "release-supervisor", d.supervisionId, "--yes");
    receipt.reservationReleased = !existsSync(join(state, "daemon.json"));
    // Cold init can leave the old socket inode without a server. Neither that
    // inode nor a newly reused PID authorizes adopting or deleting it here.
    receipt.socketPresent = existsSync(socket);
    receipt.socketRetirement = "deferred-to-exact-container-stop-and-removal";
  }
  receipt.ok = true;
} catch (error) {
  receipt.failure = {
    stage,
    code:
      error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "fixture-refused",
  };
  // Safe retained facts on cold-init refusal; no raw canonical record or bearer.
  if (phase === "cold") {
    try {
      const record = readRecord();
      receipt.retained = record ? { ...facts(record), currentBirth: birth(record.pid) } : null;
      receipt.service = await unit();
    } catch {
      receipt.diagnosticRefused = true;
    }
  }
} finally {
  cleaning = true;
  receipt.children = await settlePackedChildren(children, exits);
  receipt.commandPids = children.map((c) => c.pid).filter(Boolean);
  receipt.ok &&= receipt.children.confirmed;
  save();
  process.off("SIGTERM", cancel);
  process.off("SIGINT", cancel);
}
console.log(JSON.stringify({ phase, ok: receipt.ok }));
if (!receipt.ok) process.exitCode = 1;
