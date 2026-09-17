import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, lstatSync } from "node:fs";
import { join, sep } from "node:path";

export const systemdFixtureImage =
  "sha256:8eccebb2bb9371dcc1b10594f1dee44bf7c23ef2b22e58635488f3e5bd4ce0cd";
export const systemdFixtureInit =
  'test "$(cat /proc/self/cgroup)" = "0::/" || exit 42; mount -o remount,rw /sys/fs/cgroup || exit 43; exec /sbin/init';
const refuse = () => new Error("systemd-fixture-ownership-refused");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function systemdFixtureDefinition(nonce) {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw refuse();
  const name = `tmux-ide-d12-systemd-${nonce}`;
  const unit = `tmux-ide-qualification-${nonce}.service`;
  const supervisionId = `systemd.${nonce}`;
  const labels = { "org.tmux-ide.qualification": "d12-systemd", "org.tmux-ide.nonce": nonce };
  const unitText = `[Unit]\nDescription=Private tmux-ide qualification\nAfter=basic.target\n[Service]\nType=simple\nUser=1000\nGroup=1000\nWorkingDirectory=/qualification/source\nExecStart=/usr/local/bin/node /qualification/stable.mjs --headless --supervised ${supervisionId} --json\nRestart=always\nRestartSec=1\nKillMode=process\nTimeoutStopSec=10\nStandardOutput=journal\nStandardError=journal\nLogRateLimitIntervalSec=30s\nLogRateLimitBurst=30\n[Install]\nWantedBy=multi-user.target\n`;
  return { nonce, name, unit, supervisionId, labels, unitText, unitHash: sha256(unitText) };
}

export function systemdContainerArguments(definition) {
  return [
    "create",
    "--name",
    definition.name,
    ...Object.entries(definition.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--user",
    "0:0",
    "--memory",
    "512m",
    "--pids-limit",
    "256",
    "--network",
    "none",
    "--cgroupns",
    "private",
    "--cap-add",
    "SYS_ADMIN",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--tmpfs",
    "/tmp",
    "--stop-signal",
    "SIGRTMIN+3",
    "--entrypoint",
    "/bin/sh",
    systemdFixtureImage,
    "-c",
    systemdFixtureInit,
  ];
}

/** Complete raw inspect payload required; names alone never authorize a mutation. */
export function inspectSystemdContainer(raw, definition, expectedId) {
  if (!raw || !/^[a-f0-9]{64}$/.test(raw.Id) || (expectedId && raw.Id !== expectedId))
    throw refuse();
  const h = raw.HostConfig,
    c = raw.Config,
    n = raw.NetworkSettings;
  if (
    !h ||
    !c ||
    !n ||
    raw.Image !== systemdFixtureImage ||
    raw.Name !== `/${definition.name}` ||
    c.Image !== systemdFixtureImage ||
    c.User !== "0:0" ||
    c.StopSignal !== "SIGRTMIN+3" ||
    !equal(c.Entrypoint, ["/bin/sh"]) ||
    !equal(c.Cmd, ["-c", systemdFixtureInit]) ||
    Object.entries(definition.labels).some(([k, v]) => c.Labels?.[k] !== v) ||
    h.Privileged !== false ||
    h.NetworkMode !== "none" ||
    h.CgroupnsMode !== "private" ||
    h.Memory !== 536870912 ||
    h.PidsLimit !== 256 ||
    h.ReadonlyRootfs !== false ||
    !(equal(h.CapAdd, ["SYS_ADMIN"]) || equal(h.CapAdd, ["CAP_SYS_ADMIN"])) ||
    !equal(h.SecurityOpt, ["no-new-privileges"]) ||
    !(h.Binds === null || equal(h.Binds, [])) ||
    !(h.Devices === null || equal(h.Devices, [])) ||
    !equal(Object.keys(h.Tmpfs ?? {}).sort(), ["/run", "/run/lock", "/tmp"]) ||
    !Object.values(h.Tmpfs).every((v) => v === "") ||
    !(h.PortBindings === null || equal(h.PortBindings, {})) ||
    !Array.isArray(raw.Mounts) ||
    raw.Mounts.some(
      (m) =>
        m.Type !== "tmpfs" ||
        !["/run", "/run/lock", "/tmp"].includes(m.Destination) ||
        m.RW !== true,
    ) ||
    !equal(Object.keys(n.Networks ?? {}), ["none"]) ||
    !(n.Ports === null || equal(n.Ports, {})) ||
    typeof raw.State?.Running !== "boolean" ||
    typeof raw.State?.OOMKilled !== "boolean" ||
    !Number.isSafeInteger(raw.State?.Pid)
  )
    throw refuse();
  return {
    id: raw.Id,
    running: raw.State.Running,
    pid: raw.State.Pid,
    oomKilled: raw.State.OOMKilled,
  };
}

export function parseSystemdUnit(text, definition) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384) throw refuse();
  const values = Object.create(null);
  for (const line of text.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || Object.hasOwn(values, line.slice(0, at))) throw refuse();
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  if (
    values.Id !== definition.unit ||
    values.FragmentPath !== `/etc/systemd/system/${definition.unit}` ||
    values.LoadState !== "loaded" ||
    !/^(0|[1-9][0-9]*)$/.test(values.MainPID) ||
    !Number.isSafeInteger(Number(values.MainPID)) ||
    typeof values.SubState !== "string" ||
    !values.SubState ||
    values.SubState.length > 128 ||
    values.User !== "1000" ||
    values.Group !== "1000" ||
    values.Restart !== "always" ||
    values.KillMode !== "process" ||
    !["active", "activating", "inactive", "deactivating", "failed"].includes(values.ActiveState)
  )
    throw refuse();
  const result = { pid: Number(values.MainPID), active: values.ActiveState, sub: values.SubState };
  for (const key of ["ExecMainCode", "ExecMainStatus", "ExecMainPID", "NRestarts"]) {
    if (values[key] !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(values[key]) || !Number.isSafeInteger(Number(values[key])))
        throw refuse();
      result[key] = Number(values[key]);
    }
  }
  if (values.Result !== undefined)
    result.result = [
      "success",
      "exit-code",
      "signal",
      "core-dump",
      "watchdog",
      "start-limit-hit",
      "resources",
      "protocol",
      "timeout",
      "oom-kill",
    ].includes(values.Result)
      ? values.Result
      : "other";
  return result;
}

/** Stable diagnostic witness only; this fixture never uses it to weaken product admission. */
export function linuxBirth(stat, bootId, namespace) {
  const end = stat.lastIndexOf(")");
  const pid = Number(stat.slice(0, stat.indexOf(" ")));
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (
    end < 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !/^[0-9]+$/.test(fields[19] ?? "") ||
    !/^[a-f0-9-]{36}$/.test(bootId.trim()) ||
    !/^pid:\[[0-9]+\]$/.test(namespace)
  )
    throw refuse();
  return { pid, startTicks: fields[19], bootId: bootId.trim(), namespace };
}

export function verifySystemdDependencyInputs(candidate, historical) {
  const hashes = {};
  for (const path of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".bun-version"]) {
    hashes[path] = sha256(readFileSync(join(candidate, path)));
    if (hashes[path] !== sha256(readFileSync(join(historical, path))))
      throw new Error("dependency-input-mismatch");
  }
  const manifests = [
    "package.json",
    "docs/package.json",
    ...["packages", "apps"].flatMap((group) =>
      readdirSync(join(candidate, group))
        .filter((p) => lstatSync(join(candidate, group, p)).isDirectory())
        .map((p) => `${group}/${p}/package.json`),
    ),
  ];
  const keys = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "pnpm",
    "packageManager",
    "engines",
  ];
  for (const path of manifests) {
    const a = JSON.parse(readFileSync(join(candidate, path), "utf8")),
      b = JSON.parse(readFileSync(join(historical, path), "utf8"));
    for (const key of keys)
      if (!equal(a[key], b[key])) throw new Error("dependency-input-mismatch");
  }
  return { hashes, manifests: manifests.length };
}

export function verifySystemdDependencyLinks(candidate) {
  const root = realpathSync(candidate);
  let links = 0,
    entries = 0;
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (++entries > 300000) throw new Error("dependency-entry-bound");
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        if (!realpathSync(child).startsWith(root + sep)) throw new Error("dependency-link-escape");
        links++;
      } else if (entry.isDirectory()) walk(child);
    }
  };
  if (realpathSync(join(root, "node_modules")) !== join(root, "node_modules"))
    throw new Error("dependency-link-escape");
  walk(join(root, "node_modules"));
  for (const path of [
    "docs",
    ...["packages", "apps"].flatMap((group) =>
      readdirSync(join(root, group)).map((name) => `${group}/${name}`),
    ),
  ]) {
    const modules = join(root, path, "node_modules");
    let stat;
    try {
      stat = lstatSync(modules);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("dependency-link-escape");
    walk(modules);
  }
  for (const name of ["contracts", "daemon-client", "core"]) {
    const actual = realpathSync(join(root, "packages/daemon/node_modules/@tmux-ide", name));
    if (actual !== join(root, "packages", name)) throw new Error("workspace-link-mismatch");
  }
  return { links, entries, candidateRelative: true };
}

/** Raw private journal bytes never leave this classifier. */
export function systemdFailureDiagnostic(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 131072)
    throw new Error("journal-bound");
  const codes = [
    "DAEMON_SUPERVISOR_RESERVATION_REQUIRED",
    "DAEMON_INFO_INVALID",
    "DAEMON_STARTUP_TIMEOUT",
    "DAEMON_INFO_MISSING",
    "DAEMON_IDENTITY_MISMATCH",
    "DAEMON_IDENTITY_UNAVAILABLE",
    "DAEMON_PROTOCOL_MISMATCH",
    "DAEMON_UNHEALTHY",
    ...[
      "PORT_IN_USE",
      "PORT_INVALID",
      "BIND_FAILED",
      "TMUX_SESSION_MISSING",
      "CANONICAL_ALREADY_RUNNING",
      "CANONICAL_RECORD_INVALID",
      "CANONICAL_CLAIM_BUSY",
      "CANONICAL_PUBLICATION_LOST",
      "CANONICAL_TAKEOVER_REFUSED",
      "CANONICAL_TAKEOVER_TIMEOUT",
      "CANONICAL_TAKEOVER_IDENTITY_MISMATCH",
    ].map((reason) => `DAEMON_${reason}`),
  ];
  return {
    bytes: Buffer.byteLength(text),
    lines: text.split("\n").filter(Boolean).length,
    startupCodes: codes.filter((code) => new RegExp(`"code"\\s*:\\s*"${code}"`).test(text)),
    statuses: ["ready", "already-running"].filter((status) =>
      new RegExp(`"status"\\s*:\\s*"${status}"`).test(text),
    ),
    categories: Object.entries({
      reservation: /Matching supervisor reservation|required before startup|supervisor binding/i,
      claim: /canonical(?: daemon)?[ _]claim|startup claim/i,
      ownerNotDead: /owner is not proven dead|already running/i,
      permission: /EACCES|EPERM|permission denied/i,
      missingDependency: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|cannot find module/i,
      addressInUse: /EADDRINUSE|address already in use/i,
      serviceExit: /Main process exited|Failed with result|Failed to start/i,
      serviceSpawn: /Failed at step|Failed to execute|Failed to determine user credentials/i,
      tmuxAuthority:
        /tmux.{0,40}(?:unavailable|missing|failed|refused)|(?:unavailable|missing|failed|refused).{0,40}tmux/i,
    })
      .filter(([, pattern]) => pattern.test(text))
      .map(([category]) => category),
  };
}

/** Only for a mode0600 artifact in the private fixture evidence directory. */
export function privateSystemdJournal(text, token) {
  if (typeof text !== "string" || typeof token !== "string" || token.length > 4096)
    throw new Error("journal-input-refused");
  const redacted = token ? text.replaceAll(token, "[REDACTED-FIXTURE-TOKEN]") : text;
  return Buffer.from(redacted).subarray(-131068).toString("utf8");
}

/** Fixed classifications only; command output may contain private paths or data. */
export function systemdPreparationDiagnostic(stdout, stderr) {
  if (typeof stdout !== "string" || typeof stderr !== "string")
    throw new Error("diagnostic-input-refused");
  const bounded = (value) => value.slice(0, 16384) + value.slice(-16384);
  const text = bounded(stdout) + "\n" + bounded(stderr);
  return {
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    truncated: stdout.length > 32768 || stderr.length > 32768,
    categories: Object.entries({
      dependencyInput: /dependency-input-mismatch/,
      offlinePackage:
        /ERR_PNPM_NO_OFFLINE_META|ERR_PNPM_NO_OFFLINE_TARBALL|ERR_PNPM_MISSING_PACKAGE_FROM_LOCKFILE/,
      frozenLockfile: /ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_FROZEN_LOCKFILE/,
      fileExists: /EEXIST|[Ff]ile exists/,
      missingFile: /ENOENT|[Nn]o such file or directory/,
      permission: /EACCES|EPERM|[Pp]ermission denied/,
      memory: /ENOMEM|out of memory|Killed signal terminated program|fatal error: Killed/,
      diskSpace: /ENOSPC|[Nn]o space left on device/,
      nativeBuild: /gyp ERR!|make(?:\[[0-9]+\])?: .*Error/,
      missingModule: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module/,
      syntax: /SyntaxError/,
      type: /TypeError/,
    })
      .filter(([, pattern]) => pattern.test(text))
      .map(([category]) => category),
  };
}

/** Reject only a stable, reauthenticated owner outside the observed service.
 * Transitional samples remain pending; no sampled PID authorizes signalling.
 */
export async function observeSystemdOwner({ identity, unit, birth }) {
  const owner = await identity();
  const firstBirth = owner ? await birth(owner.pid) : null;
  const service = await unit();
  const pending = { owner, servicePid: service.pid, confirmed: false };
  if (!owner || !firstBirth) return pending;
  const currentOwner = await identity();
  const currentService = await unit();
  const currentBirth = await birth(owner.pid);
  if (
    !currentOwner ||
    !currentBirth ||
    !equal(owner, currentOwner) ||
    !equal(firstBirth, currentBirth) ||
    service.pid !== currentService.pid
  )
    return pending;
  if (owner.pid !== service.pid) throw new Error("daemon-escaped-supervisor");
  return { owner: currentOwner, servicePid: currentService.pid, confirmed: true };
}
