/**
 * Daemon identity and log provenance.
 *
 * Two halves:
 *
 * 1. `captureDaemonProvenance` — run by the daemon at startup. It records how
 *    the process was launched (headless vs embedded, which supervisor), and
 *    where its stdout/stderr ACTUALLY go (file path + dev/ino, tty, pipe,
 *    socket, /dev/null). The result is stamped into the daemon record so a
 *    later triage derives the live log destination from the record instead of
 *    guessing file names. It never throws: anything it cannot determine
 *    degrades to `unknown` plus a warning.
 *
 * 2. `buildDaemonProvenanceReport` (pure) + `collectDaemonProvenanceReport`
 *    (io) — the credential-free triage report behind `tmux-ide daemon info`
 *    and the doctor row. Discovered log files are labeled `current` only when
 *    they are the live destination; everything else is `historical` (with the
 *    pid they belong to when recorded) or `unattributed`. Files are only ever
 *    read, never modified.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  CanonicalDaemonInfo,
  DaemonLogStream,
  DaemonProvenance,
  DaemonSupervisorKind,
} from "@tmux-ide/contracts";
import {
  getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfo,
  type CanonicalDaemonInfoState,
} from "./canonical-daemon.ts";
import { redactText } from "./log-sanitize.ts";
import { resolveRuntimeNamespace } from "./runtime-namespace.ts";

export type DaemonLauncher = DaemonProvenance["launcher"];
export type PidLiveness = "alive" | "dead" | "unknown";

// ---------------------------------------------------------------------------
// Startup capture
// ---------------------------------------------------------------------------

export interface SupervisorFacts {
  readonly launcher: DaemonLauncher;
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly parentPid: number;
  readonly supervisionId?: string;
}

/**
 * PURE — classify the supervising process from launch facts. Environment
 * evidence wins over the reservation id hint; an explicit reservation without
 * environment evidence still counts as that supervisor because the operator
 * asserted it when reserving the namespace.
 */
export function classifySupervisor(facts: SupervisorFacts): {
  kind: DaemonSupervisorKind;
  evidence: string;
} {
  if (facts.launcher === "embedded")
    return { kind: "embedded", evidence: "startEmbeddedDaemon host" };
  const { env, platform, parentPid, supervisionId } = facts;
  if (env.INVOCATION_ID || env.JOURNAL_STREAM || env.SYSTEMD_EXEC_PID) {
    const markers = ["INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID"].filter((k) => env[k]);
    return { kind: "systemd", evidence: `env ${markers.join(",")}` };
  }
  if (platform === "darwin") {
    const xpc = env.XPC_SERVICE_NAME;
    if (xpc && xpc !== "0" && !xpc.startsWith("application.")) {
      return { kind: "launchd", evidence: `XPC_SERVICE_NAME=${xpc}` };
    }
    if (parentPid === 1 && supervisionId) return { kind: "launchd", evidence: "parent pid 1" };
  }
  if (supervisionId) {
    if (/\.(service|socket|timer)$/u.test(supervisionId)) {
      return { kind: "systemd", evidence: `reservation ${supervisionId}` };
    }
    if (platform === "darwin") return { kind: "launchd", evidence: `reservation ${supervisionId}` };
  }
  return {
    kind: "manual",
    evidence: parentPid === 1 ? "detached (parent pid 1)" : "foreground or detached shell",
  };
}

export interface StreamStat {
  readonly isFile: boolean;
  readonly isFIFO: boolean;
  readonly isSocket: boolean;
  readonly isCharacterDevice: boolean;
  readonly dev: number;
  readonly ino: number;
}

/** PURE — describe one stdio stream from its fstat and (optional) resolved path. */
export function describeStream(
  stat: StreamStat | null,
  path: string | undefined,
  isTTY: boolean,
): DaemonLogStream {
  if (!stat) return { kind: "unknown", detail: "fstat failed" };
  if (isTTY) return { kind: "tty", ...(path ? { path } : {}) };
  if (stat.isFile) {
    return {
      kind: "file",
      ...(path ? { path } : {}),
      dev: Number(stat.dev),
      ino: Number(stat.ino),
    };
  }
  if (stat.isFIFO) return { kind: "pipe", ...(path ? { path } : {}) };
  if (stat.isSocket) return { kind: "socket", ...(path ? { path } : {}) };
  if (stat.isCharacterDevice) {
    if (!path || path === "/dev/null") return { kind: "null", path: "/dev/null" };
    return { kind: "unknown", path, detail: "character device" };
  }
  return { kind: "unknown", detail: "unrecognized stream type" };
}

export type FdPathResolver = (
  fd: number,
  pid: number,
  platform: NodeJS.Platform,
) => string | undefined;

/**
 * Resolve where a file descriptor points. Linux answers via /proc; macOS has
 * no /proc, so `lsof` (present on every stock install) is consulted once per
 * fd with a short timeout. Returns undefined rather than throwing.
 */
export const resolveFdPath: FdPathResolver = (fd, pid, platform) => {
  if (platform === "linux") {
    try {
      return readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      return undefined;
    }
  }
  if (platform === "darwin") {
    try {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", String(fd), "-F", "fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      });
      const lines = out.split("\n");
      const index = lines.indexOf(`f${fd}`);
      if (index === -1) return undefined;
      const name = lines.slice(index + 1).find((line) => line.startsWith("n"));
      return name ? name.slice(1) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export interface CaptureDaemonProvenanceOptions {
  readonly launcher: DaemonLauncher;
  readonly supervisionId?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly parentPid?: number;
  readonly pid?: number;
  readonly fdPath?: FdPathResolver;
  readonly fstat?: (fd: number) => StreamStat;
  readonly isTTY?: (fd: number) => boolean;
  /** Identity of /dev/null, compared against character-device streams. */
  readonly nullDevice?: () => { dev: number; ino: number } | null;
}

function defaultNullDevice(): { dev: number; ino: number } | null {
  try {
    const stat = statSync("/dev/null");
    return { dev: Number(stat.dev), ino: Number(stat.ino) };
  } catch {
    return null;
  }
}

function defaultFstat(fd: number): StreamStat {
  const stat = fstatSync(fd);
  return {
    isFile: stat.isFile(),
    isFIFO: stat.isFIFO(),
    isSocket: stat.isSocket(),
    isCharacterDevice: stat.isCharacterDevice(),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function defaultIsTTY(fd: number): boolean {
  return fd === 1
    ? process.stdout.isTTY === true
    : fd === 2
      ? process.stderr.isTTY === true
      : false;
}

/**
 * Capture launch + log-destination provenance for the current process.
 * Never throws; partial knowledge is reported with warnings so startup can
 * continue and the report can say what it could not determine.
 */
export function captureDaemonProvenance(options: CaptureDaemonProvenanceOptions): DaemonProvenance {
  const warnings: string[] = [];
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const parentPid = options.parentPid ?? process.ppid;
  const pid = options.pid ?? process.pid;
  const fdPath = options.fdPath ?? resolveFdPath;
  const fstat = options.fstat ?? defaultFstat;
  const isTTY = options.isTTY ?? defaultIsTTY;
  const nullDevice = options.nullDevice ?? defaultNullDevice;
  const supervisor = classifySupervisor({
    launcher: options.launcher,
    platform,
    env,
    parentPid,
    ...(options.supervisionId ? { supervisionId: options.supervisionId } : {}),
  });
  const capture = (fd: number, name: string): DaemonLogStream => {
    let stat: StreamStat;
    try {
      stat = fstat(fd);
    } catch (error) {
      warnings.push(`${name}: fstat failed (${errorMessage(error)})`);
      return { kind: "unknown", detail: "fstat failed" };
    }
    let path: string | undefined;
    let tty = false;
    try {
      tty = isTTY(fd);
    } catch {
      // treat as non-tty
    }
    if (tty) return describeStream(stat, undefined, true);
    if (stat.isCharacterDevice) {
      // Cheap and exact: /dev/null is identified by inode, no path lookup.
      const devNull = nullDevice();
      if (devNull && devNull.dev === Number(stat.dev) && devNull.ino === Number(stat.ino)) {
        return { kind: "null", path: "/dev/null" };
      }
      return { kind: "unknown", detail: "character device" };
    }
    if (stat.isFile) {
      // The only case that needs a path lookup (lsof on macOS, /proc on Linux).
      try {
        path = fdPath(fd, pid, platform);
      } catch (error) {
        warnings.push(`${name}: path resolution failed (${errorMessage(error)})`);
      }
      if (!path) warnings.push(`${name}: regular file but its path could not be resolved`);
    }
    return describeStream(stat, path, false);
  };
  const stdout = capture(1, "stdout");
  const stderr = capture(2, "stderr");
  return {
    launcher: options.launcher,
    supervisor: supervisor.kind,
    parentPid,
    stdout,
    stderr,
    ...(warnings.length ? { warnings: warnings.slice(0, 8).map((w) => w.slice(0, 256)) } : {}),
  };
}

function errorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error)).slice(0, 160);
}

// ---------------------------------------------------------------------------
// Report (pure core)
// ---------------------------------------------------------------------------

export interface LogFileObservation {
  readonly path: string;
  readonly bytes: number;
  readonly lastWriteAt: string;
  readonly dev: number;
  readonly ino: number;
  /** Last daemon pid the file mentions, when recorded. */
  readonly pid?: number;
  readonly instanceId?: string;
  readonly productVersion?: string;
  readonly readError?: string;
}

export type LogFileStatus = "current" | "historical" | "unattributed";

export interface ProvenanceLogFile extends LogFileObservation {
  readonly status: LogFileStatus;
  readonly reason: string;
  readonly pidLiveness?: PidLiveness;
}

export interface ProvenanceDaemon {
  readonly instanceId: string;
  readonly productVersion: string;
  readonly protocolVersion: number;
  readonly pid: number;
  readonly port: number;
  readonly bindHostname: string;
  readonly startedAt: string;
  readonly supervisionId: string | null;
  readonly liveness: PidLiveness;
  readonly launcher: DaemonLauncher | null;
  readonly supervisor: DaemonSupervisorKind | null;
  readonly parentPid: number | null;
  /** False for records written by a daemon that predates provenance stamping. */
  readonly provenanceRecorded: boolean;
  readonly logs: {
    readonly stdout: DaemonLogStream | null;
    readonly stderr: DaemonLogStream | null;
  };
  /** One-line human description of where the live daemon writes its logs. */
  readonly logDestination: string;
  readonly provenanceWarnings: readonly string[];
}

export type ProvenanceStatus = "running" | "stale-record" | "not-running" | "record-invalid";

export interface DaemonProvenanceReport {
  readonly generatedAt: string;
  readonly status: ProvenanceStatus;
  readonly namespace: {
    readonly mode: string;
    readonly stateHome: string;
    readonly daemonInfoDir: string;
    readonly logsDir: string;
    readonly recordPath: string;
  };
  readonly record:
    | { readonly status: "valid" }
    | { readonly status: "missing" }
    | { readonly status: "reserved"; readonly supervisionId: string; readonly reservedAt: string }
    | { readonly status: "invalid"; readonly reason: string; readonly detail: string };
  readonly daemon: ProvenanceDaemon | null;
  readonly logFiles: readonly ProvenanceLogFile[];
  readonly warnings: readonly string[];
}

export interface BuildDaemonProvenanceReportInput {
  readonly namespace: DaemonProvenanceReport["namespace"];
  readonly recordState: CanonicalDaemonInfoState;
  readonly files: readonly LogFileObservation[];
  readonly pidLiveness: (pid: number) => PidLiveness;
  readonly now?: () => Date;
  readonly warnings?: readonly string[];
}

/** PURE — human description of a stream destination. */
export function describeLogDestination(
  stream: DaemonLogStream | null,
  supervisor: DaemonSupervisorKind | null,
): string {
  if (!stream) return "unknown (record predates provenance stamping)";
  switch (stream.kind) {
    case "file":
      return stream.path
        ? `file ${stream.path}`
        : `file (unresolved path, dev ${stream.dev} ino ${stream.ino})`;
    case "tty":
      return stream.path ? `terminal ${stream.path}` : "terminal";
    case "pipe":
      return supervisor === "embedded"
        ? "pipe to the embedding host"
        : "pipe to the parent process";
    case "socket":
      return supervisor === "systemd" ? "systemd journal (socket; use journalctl)" : "socket";
    case "null":
      return "discarded (/dev/null)";
    default:
      return stream.detail ? `unknown (${stream.detail})` : "unknown";
  }
}

function sameFile(stream: DaemonLogStream | null, file: LogFileObservation): boolean {
  if (!stream || stream.kind !== "file") return false;
  if (stream.dev !== undefined && stream.ino !== undefined) {
    return stream.dev === file.dev && stream.ino === file.ino;
  }
  return stream.path !== undefined && stream.path === file.path;
}

function stripCredentials(info: CanonicalDaemonInfo): Omit<CanonicalDaemonInfo, "authToken"> {
  // Explicit copy so a future record field named like a credential still has
  // to be added here deliberately.
  const rest: Record<string, unknown> = { ...info };
  delete rest.authToken;
  return rest as Omit<CanonicalDaemonInfo, "authToken">;
}

function classifyFile(
  file: LogFileObservation,
  daemon: ProvenanceDaemon | null,
  pidLiveness: (pid: number) => PidLiveness,
): ProvenanceLogFile {
  const liveness = file.pid !== undefined ? pidLiveness(file.pid) : undefined;
  const withLiveness = (status: LogFileStatus, reason: string): ProvenanceLogFile => ({
    ...file,
    status,
    reason,
    ...(liveness ? { pidLiveness: liveness } : {}),
  });
  if (daemon && daemon.liveness !== "dead") {
    if (sameFile(daemon.logs.stdout, file) || sameFile(daemon.logs.stderr, file)) {
      return withLiveness("current", `live destination of daemon pid ${daemon.pid}`);
    }
    if (file.pid !== undefined && file.pid !== daemon.pid) {
      return withLiveness(
        "historical",
        liveness === "dead"
          ? `written by pid ${file.pid}, which is no longer running; the current daemon is pid ${daemon.pid}`
          : `written by pid ${file.pid}, not the current daemon pid ${daemon.pid}`,
      );
    }
    if (file.pid === daemon.pid) {
      return withLiveness(
        "historical",
        `mentions the current pid ${daemon.pid} but is not its live log destination`,
      );
    }
    if (Date.parse(file.lastWriteAt) < Date.parse(daemon.startedAt)) {
      return withLiveness(
        "historical",
        `last written before the current daemon started (${daemon.startedAt})`,
      );
    }
    return withLiveness(
      "unattributed",
      "no daemon identity recorded in the file and it is not the live destination",
    );
  }
  if (file.pid !== undefined) {
    return withLiveness(
      "historical",
      liveness === "dead"
        ? `written by pid ${file.pid}, which is no longer running`
        : `written by pid ${file.pid}; no live canonical daemon record`,
    );
  }
  return withLiveness("unattributed", "no daemon identity recorded in the file");
}

/** PURE — assemble the credential-free report from observed facts. */
export function buildDaemonProvenanceReport(
  input: BuildDaemonProvenanceReportInput,
): DaemonProvenanceReport {
  const warnings = [...(input.warnings ?? [])];
  const generatedAt = (input.now ?? (() => new Date()))().toISOString();
  const { recordState } = input;
  let daemon: ProvenanceDaemon | null = null;
  let status: ProvenanceStatus;
  let record: DaemonProvenanceReport["record"];
  if (recordState.status === "missing") {
    status = "not-running";
    record = { status: "missing" };
  } else if (recordState.status === "reserved") {
    // A supervisor reservation without a published owner: no daemon, and the
    // namespace is held for that supervisor.
    status = "not-running";
    record = {
      status: "reserved",
      supervisionId: recordState.reservation.supervisionId,
      reservedAt: recordState.reservation.reservedAt,
    };
  } else if (recordState.status === "invalid") {
    status = "record-invalid";
    record = {
      status: "invalid",
      reason: recordState.reason,
      detail: redactText(recordState.detail),
    };
  } else {
    record = { status: "valid" };
    const info = stripCredentials(recordState.info);
    const liveness = input.pidLiveness(info.pid);
    const provenance = info.provenance ?? null;
    status = liveness === "dead" ? "stale-record" : "running";
    daemon = {
      instanceId: info.instanceId,
      productVersion: info.productVersion,
      protocolVersion: info.protocolVersion,
      pid: info.pid,
      port: info.port,
      bindHostname: info.bindHostname,
      startedAt: info.startedAt,
      supervisionId: info.supervisionId ?? null,
      liveness,
      launcher: provenance?.launcher ?? null,
      supervisor: provenance?.supervisor ?? null,
      parentPid: provenance?.parentPid ?? null,
      provenanceRecorded: provenance !== null,
      logs: { stdout: provenance?.stdout ?? null, stderr: provenance?.stderr ?? null },
      logDestination: describeLogDestination(
        provenance?.stdout ?? null,
        provenance?.supervisor ?? null,
      ),
      provenanceWarnings: provenance?.warnings ?? [],
    };
    if (!provenance)
      warnings.push("daemon record predates provenance stamping; log destination unknown");
    if (liveness === "dead")
      warnings.push(`daemon record names pid ${info.pid}, which is not running (stale record)`);
    if (liveness === "unknown")
      warnings.push(`liveness of pid ${info.pid} could not be determined`);
  }
  const logFiles = input.files
    .map((file) => classifyFile(file, daemon, input.pidLiveness))
    .sort((a, b) => Date.parse(b.lastWriteAt) - Date.parse(a.lastWriteAt));
  return { generatedAt, status, namespace: input.namespace, record, daemon, logFiles, warnings };
}

/** PURE — human rendering of the report for the non-JSON CLI path. */
export function formatDaemonProvenanceReport(report: DaemonProvenanceReport): string[] {
  const lines: string[] = [];
  const d = report.daemon;
  switch (report.status) {
    case "running":
      lines.push(`Canonical daemon: running (pid ${d!.pid}, v${d!.productVersion})`);
      break;
    case "stale-record":
      lines.push(
        `Canonical daemon: not running (stale record names pid ${d!.pid}, v${d!.productVersion})`,
      );
      break;
    case "not-running":
      lines.push(
        report.record.status === "reserved"
          ? `Canonical daemon: not running (namespace reserved for supervisor ${report.record.supervisionId})`
          : "Canonical daemon: not running (no record)",
      );
      break;
    case "record-invalid":
      lines.push(
        `Canonical daemon: record invalid (${report.record.status === "invalid" ? report.record.reason : "unknown"})`,
      );
      break;
  }
  lines.push(`  record: ${report.namespace.recordPath}`);
  if (d) {
    lines.push(`  instance: ${d.instanceId}`);
    lines.push(
      `  started: ${d.startedAt}  protocol ${d.protocolVersion}  ${d.bindHostname}:${d.port}`,
    );
    lines.push(
      `  supervisor: ${d.supervisor ?? "unknown"}${d.supervisionId ? ` (${d.supervisionId})` : ""}` +
        `${d.launcher ? `, launcher ${d.launcher}` : ""}${d.parentPid !== null ? `, parent pid ${d.parentPid}` : ""}`,
    );
    lines.push(`  logs: stdout → ${d.logDestination}`);
    if (d.logs.stderr && JSON.stringify(d.logs.stderr) !== JSON.stringify(d.logs.stdout)) {
      lines.push(`        stderr → ${describeLogDestination(d.logs.stderr, d.supervisor)}`);
    }
  }
  if (report.logFiles.length) {
    lines.push("Log files:");
    for (const file of report.logFiles) {
      const who =
        file.pid !== undefined
          ? ` pid ${file.pid}${file.pidLiveness ? ` (${file.pidLiveness})` : ""}`
          : "";
      lines.push(
        `  [${file.status}] ${file.path} — ${file.bytes} bytes, last write ${file.lastWriteAt}${who}`,
      );
      lines.push(`      ${file.reason}`);
    }
  } else {
    lines.push("Log files: none discovered");
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Observation (io)
// ---------------------------------------------------------------------------

const LOG_FILE_NAME = /\.(log|out|err)$/iu;
const MAX_DISCOVERED_FILES = 64;
const READ_WINDOW_BYTES = 64 * 1024;
const PID_MARKERS = [/\(pid (\d{1,10})\)/gu, /"pid":\s*(\d{1,10})/gu];
const INSTANCE_MARKER = /"instanceId":\s*"([0-9a-f-]{36})"/giu;
const VERSION_MARKER = /"(?:version|productVersion)":\s*"([^"]{1,64})"/gu;

function lastMatch(pattern: RegExp, text: string): string | undefined {
  let found: string | undefined;
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) found = match[1];
  return found;
}

/** PURE — extract the last daemon identity markers from a bounded text window. */
export function extractLogIdentity(text: string): {
  pid?: number;
  instanceId?: string;
  productVersion?: string;
} {
  const out: { pid?: number; instanceId?: string; productVersion?: string } = {};
  let lastPidIndex = -1;
  for (const pattern of PID_MARKERS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined && match.index > lastPidIndex) {
        lastPidIndex = match.index;
        out.pid = Number(match[1]);
      }
    }
  }
  const instanceId = lastMatch(INSTANCE_MARKER, text);
  if (instanceId) out.instanceId = instanceId.toLowerCase();
  const version = lastMatch(VERSION_MARKER, text);
  if (version) out.productVersion = version;
  return out;
}

function readWindow(path: string, size: number): string {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(Math.min(size, READ_WINDOW_BYTES));
    const headRead = readSync(fd, head, 0, head.length, 0);
    if (size <= READ_WINDOW_BYTES) return head.subarray(0, headRead).toString("utf8");
    const tail = Buffer.alloc(READ_WINDOW_BYTES);
    const tailRead = readSync(fd, tail, 0, tail.length, size - READ_WINDOW_BYTES);
    return `${head.subarray(0, headRead).toString("utf8")}\n${tail.subarray(0, tailRead).toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

/** Observe one candidate log file read-only; read errors degrade to `readError`. */
export function observeLogFile(path: string): LogFileObservation | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const base: LogFileObservation = {
    path,
    bytes: stat.size,
    lastWriteAt: stat.mtime.toISOString(),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
  };
  try {
    const identity = extractLogIdentity(readWindow(path, stat.size));
    return { ...base, ...identity };
  } catch (error) {
    return { ...base, readError: errorMessage(error) };
  }
}

export interface DiscoverLogFilesOptions {
  readonly directories: readonly string[];
  /** Explicit paths (e.g. the record's stdout path) included even outside the directories. */
  readonly extraPaths?: readonly string[];
}

/** Discover candidate log files non-recursively; never throws. */
export function discoverLogFiles(options: DiscoverLogFilesOptions): {
  files: LogFileObservation[];
  warnings: string[];
} {
  const seen = new Set<string>();
  const files: LogFileObservation[] = [];
  const warnings: string[] = [];
  const consider = (path: string): void => {
    let key = path;
    try {
      key = realpathSync(path);
    } catch {
      // keep the given path as the identity
    }
    if (seen.has(key) || files.length >= MAX_DISCOVERED_FILES) return;
    seen.add(key);
    const observed = observeLogFile(path);
    if (observed) files.push(observed);
  };
  for (const dir of options.directories) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") warnings.push(`cannot list ${dir} (${errorMessage(error)})`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !LOG_FILE_NAME.test(entry.name)) continue;
      consider(join(dir, entry.name));
    }
  }
  for (const path of options.extraPaths ?? []) consider(resolve(path));
  if (files.length >= MAX_DISCOVERED_FILES)
    warnings.push(`log discovery capped at ${MAX_DISCOVERED_FILES} files`);
  return { files, warnings };
}

export function pidLivenessProbe(pid: number): PidLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

export interface CollectDaemonProvenanceOptions {
  readonly recordState?: CanonicalDaemonInfoState;
  readonly pidLiveness?: (pid: number) => PidLiveness;
  readonly now?: () => Date;
}

/** io — inspect the record, discover log files, and build the report. */
export function collectDaemonProvenanceReport(
  options: CollectDaemonProvenanceOptions = {},
): DaemonProvenanceReport {
  const namespace = resolveRuntimeNamespace();
  const recordPath = getCanonicalDaemonInfoPath();
  const recordState = options.recordState ?? inspectCanonicalDaemonInfo();
  const extraPaths: string[] = [];
  if (recordState.status === "valid") {
    for (const stream of [
      recordState.info.provenance?.stdout,
      recordState.info.provenance?.stderr,
    ]) {
      if (stream?.kind === "file" && stream.path) extraPaths.push(stream.path);
    }
  }
  const directories = [
    ...new Set([namespace.logsDir, namespace.daemonInfoDir, namespace.stateHome]),
  ];
  const discovered = discoverLogFiles({ directories, extraPaths });
  return buildDaemonProvenanceReport({
    namespace: {
      mode: namespace.mode,
      stateHome: namespace.stateHome,
      daemonInfoDir: namespace.daemonInfoDir,
      logsDir: namespace.logsDir,
      recordPath,
    },
    recordState,
    files: discovered.files,
    pidLiveness: options.pidLiveness ?? pidLivenessProbe,
    ...(options.now ? { now: options.now } : {}),
    warnings: discovered.warnings,
  });
}
