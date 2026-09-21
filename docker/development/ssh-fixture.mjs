import process from "node:process";
import { Buffer } from "node:buffer";
import { setInterval, clearInterval } from "node:timers";
import {
  startControlledSshListener,
  requestSshStop,
  waitForSshRetirement,
} from "./ssh-control.mjs";
/** Private test-only SSH fixture. No daemon startup, Docker access or host configuration. */
import { spawn, execFileSync } from "node:child_process";
import {
  constants,
  realpathSync,
  mkdirSync,
  lstatSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const ROOT = "/state/ssh";
const SCRIPT = "/opt/fixture/ssh-fixture.mjs";
const NODE = "/usr/local/bin/node";
const MANAGER = "/workspace/tree/scripts/development-instance.mjs";
function refuse() {
  throw new Error("SSH fixture configuration or authority is unavailable");
}
function privateRoot() {
  if (realpathSync(ROOT) !== ROOT) refuse();
  const stat = lstatSync(ROOT);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    refuse();
}
function readPrivate(path) {
  privateRoot();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      stat.nlink !== 1 ||
      stat.size > 65536
    )
      refuse();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function writePrivate(name, contents) {
  privateRoot();
  const temporary = `${ROOT}/${name}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  let failure;
  try {
    renameSync(temporary, `${ROOT}/${name}`);
  } catch (error) {
    failure = error;
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error.code !== "ENOENT") failure ??= error;
  }
  if (failure) throw failure;
}
export function validateFixtureLease(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.worktree !== "/workspace/tree" ||
    value.store !== "/state/instances" ||
    !/^ti-dev-[a-f0-9]{24}$/u.test(value.name) ||
    !/^dev-[a-f0-9]{24}$/u.test(value.instanceId) ||
    !/^build-[a-f0-9-]{36}$/u.test(value.generation) ||
    !/^[a-f0-9]{64}$/u.test(value.manifestHash) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    typeof value.daemonId !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.daemonId) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isInteger(value.protocolVersion) ||
    value.protocolVersion < 1 ||
    typeof value.productVersion !== "string" ||
    !/^[A-Za-z0-9.+-]{1,80}$/u.test(value.productVersion)
  )
    refuse();
  return value;
}
export function authorizedPublicKey(value) {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?\n?$/u.exec(value);
  if (!match || value.length > 1024) refuse();
  const blob = Buffer.from(match[1], "base64");
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString() !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32
  )
    refuse();
  return `ssh-ed25519 ${blob.toString("base64")}\n`;
}
export function renderFixtureSshConfig(lease) {
  validateFixtureLease(lease);
  return `Port 2222
AddressFamily inet
ListenAddress 0.0.0.0
HostKey ${ROOT}/host_ed25519
PidFile ${ROOT}/sshd.pid
AuthorizedKeysFile ${ROOT}/authorized_keys
StrictModes yes
AllowUsers node
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
UsePAM no
HostbasedAuthentication no
GSSAPIAuthentication no
PermitUserEnvironment no
PermitUserRC no
PermitTTY no
X11Forwarding no
AllowAgentForwarding no
AllowStreamLocalForwarding no
PermitTunnel no
AllowTcpForwarding local
PermitOpen 127.0.0.1:${lease.port}
PermitListen none
GatewayPorts no
ForceCommand ${NODE} ${SCRIPT} dispatch
LoginGraceTime 15
MaxAuthTries 3
MaxSessions 2
MaxStartups 3:30:6
PrintMotd no
PrintLastLog no
LogLevel ERROR
`;
}
export function requireFixtureOriginalCommand(command) {
  if (command !== "tmux-ide remote-daemon-info --json") refuse();
}
function managerArgs(name, describe) {
  if (!/^ti-dev-[a-f0-9]{24}$/u.test(name)) refuse();
  return [
    MANAGER,
    "ssh-info",
    "--json",
    "--worktree",
    "/workspace/tree",
    "--store",
    "/state/instances",
    "--name",
    name,
    ...(describe ? ["--ssh-describe"] : []),
  ];
}
function manager(name, describe) {
  // No inherited NODE_OPTIONS, TMUX, SSH or process-authority overrides.
  try {
    return execFileSync(NODE, managerArgs(name, describe), {
      cwd: "/workspace/tree",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/node" },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    refuse();
  }
}
function readLease() {
  try {
    return validateFixtureLease(JSON.parse(readPrivate(`${ROOT}/lease.json`)));
  } catch {
    refuse();
  }
}
function sameLease(a, b) {
  if (
    Object.keys(a).length !== Object.keys(b).length ||
    Object.entries(a).some(([key, value]) => b[key] !== value)
  )
    refuse();
}
function refuseExistingServe() {
  for (const name of ["serve.json", "sshd.pid"]) {
    try {
      lstatSync(`${ROOT}/${name}`);
      refuse();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
async function runFixtureCommand(args, environment, releaseAdmission = () => {}) {
  if (process.getuid?.() !== 1000) refuse();
  const [command, ...rest] = args;
  if (command === "idle" && rest.length === 0) {
    const timer = setInterval(() => {}, 30000);
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        clearInterval(timer);
        process.exit(0);
      });
  } else if (command === "init" && rest.length === 2) {
    mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    privateRoot();
    refuseExistingServe();
    const lease = validateFixtureLease(JSON.parse(manager(rest[0], true)));
    const publicStat = lstatSync(rest[1]);
    if (!publicStat.isFile() || publicStat.isSymbolicLink() || publicStat.size > 1024) refuse();
    const publicKey = authorizedPublicKey(readFileSync(rest[1], "utf8"));
    try {
      const existing = readPrivate(`${ROOT}/authorized_keys`);
      if (existing !== publicKey) refuse();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      readPrivate(`${ROOT}/host_ed25519`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      execFileSync(
        "/usr/bin/ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-f", `${ROOT}/host_ed25519`],
        { stdio: "ignore", timeout: 5000 },
      );
    }
    writePrivate("authorized_keys", publicKey);
    writePrivate("lease.json", `${JSON.stringify(lease)}\n`);
    writePrivate("sshd_config", renderFixtureSshConfig(lease));
    // Host key trust comes from an independently verified Docker exec channel, not keyscan.
    const hostPublic = execFileSync("/usr/bin/ssh-keygen", ["-y", "-f", `${ROOT}/host_ed25519`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(authorizedPublicKey(hostPublic));
  } else if (command === "dispatch" && rest.length === 0) {
    requireFixtureOriginalCommand(environment.SSH_ORIGINAL_COMMAND);
    const lease = readLease();
    process.stdout.write(manager(lease.name, false));
  } else if (command === "stop" && rest.length === 0) {
    let record;
    try {
      record = JSON.parse(readPrivate(`${ROOT}/serve.json`));
    } catch {
      refuse();
    }
    if (!record || typeof record.nonce !== "string" || !/^[a-f0-9-]{36}$/u.test(record.nonce))
      refuse();
    const receipt = await requestSshStop(`${ROOT}/control.sock`, record.nonce);
    await waitForSshRetirement(ROOT);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } else if (command === "serve" && rest.length === 0) {
    const lease = readLease();
    refuseExistingServe();
    sameLease(lease, validateFixtureLease(JSON.parse(manager(lease.name, true))));
    const config = readPrivate(`${ROOT}/sshd_config`);
    if (config !== renderFixtureSshConfig(lease)) refuse();
    readPrivate(`${ROOT}/authorized_keys`);
    readPrivate(`${ROOT}/host_ed25519`);
    execFileSync("/usr/sbin/sshd", ["-t", "-f", `${ROOT}/sshd_config`], {
      timeout: 5000,
      stdio: "ignore",
    });
    const serveRecord = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    writeFileSync(`${ROOT}/serve.json`, serveRecord, {
      flag: "wx",
      mode: 0o600,
    });
    let completion = Promise.resolve(0);
    const { child, control } = await startControlledSshListener(
      `${ROOT}/control.sock`,
      JSON.parse(serveRecord).nonce,
      () => {
        const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", `${ROOT}/sshd_config`], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        completion = new Promise((resolve) => {
          child.once("error", () => resolve(1));
          child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
        });
        return child;
      },
    );
    let tail = Buffer.alloc(0);
    child?.stderr.on("data", (chunk) => {
      tail = Buffer.concat([tail, chunk]).subarray(-65536);
    });
    const stop = (signal) => child?.kill(signal);
    const interrupt = () => stop("SIGINT"),
      terminate = () => stop("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const code = await completion;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    writePrivate("sshd-error.log", tail);
    // This process owns the exclusive serve record; unknown interrupted admissions remain protected.
    if (readPrivate(`${ROOT}/serve.json`) !== serveRecord) refuse();
    try {
      if (readPrivate(`${ROOT}/sshd.pid`).trim() !== String(child?.pid)) refuse();
      unlinkSync(`${ROOT}/sshd.pid`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    unlinkSync(`${ROOT}/serve.json`);
    await control.finish();
    releaseAdmission();
    process.exitCode = code === 143 ? 0 : code;
  } else refuse();
}
/** Exclusive private SSH transition admission. Interrupted admission is never auto-cleared. */
export async function fixtureMain(args, environment = process.env) {
  if (process.getuid?.() !== 1000) refuse();
  process.umask(0o077);
  if (!["init", "serve"].includes(args[0])) return runFixtureCommand(args, environment);
  if (args[0] === "init") mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  privateRoot();
  const admission = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  writeFileSync(`${ROOT}/admission.json`, admission, { flag: "wx", mode: 0o600 });
  let released = false;
  const release = () => {
    if (released) return;
    if (readPrivate(`${ROOT}/admission.json`) !== admission) refuse();
    unlinkSync(`${ROOT}/admission.json`);
    released = true;
  };
  try {
    return await runFixtureCommand(args, environment, release);
  } finally {
    release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fixtureMain(process.argv.slice(2)).catch(() => {
    process.stderr.write("SSH fixture unavailable\n");
    process.exitCode = 1;
  });
}
