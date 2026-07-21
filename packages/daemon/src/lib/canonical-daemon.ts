import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CanonicalDaemonInfoSchema,
  type CanonicalDaemonInfo,
  DaemonHealthSchema,
  type DaemonHealth,
  DaemonIdentitySchema,
  type DaemonIdentity,
} from "@tmux-ide/contracts";

export type { CanonicalDaemonInfo } from "@tmux-ide/contracts";

const DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
const DAEMON_INFO_FILE = "daemon.json";
const MAX_DAEMON_INFO_BYTES = 64 * 1024;

export type CanonicalDaemonInfoInvalidReason =
  | "symlink"
  | "not-regular-file"
  | "oversized"
  | "wrong-owner"
  | "unsafe-permissions"
  | "changed-while-opening"
  | "unreadable"
  | "malformed-json"
  | "invalid-schema";

export interface CanonicalDaemonInfoObservation {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

/**
 * Ownership decisions must distinguish an absent record from a record which
 * exists but cannot be trusted or understood. Collapsing both to null lets a
 * contender silently become a second canonical owner.
 */
export type CanonicalDaemonInfoState =
  | { status: "missing" }
  | {
      status: "valid";
      info: CanonicalDaemonInfo;
      observation: CanonicalDaemonInfoObservation;
    }
  | {
      status: "invalid";
      reason: CanonicalDaemonInfoInvalidReason;
      detail: string;
      /** Present only when it came from a securely opened JSON object. */
      ownerPid: number | null;
      observation: CanonicalDaemonInfoObservation | null;
    };

function nonEmptyEnvironmentValue(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function getCanonicalDaemonInfoPath(): string {
  const dir =
    nonEmptyEnvironmentValue(DAEMON_INFO_DIR_ENV) ??
    nonEmptyEnvironmentValue(REGISTRY_DIR_ENV) ??
    join(homedir(), ".tmux-ide");
  return join(dir, DAEMON_INFO_FILE);
}

function observation(stat: Stats): CanonicalDaemonInfoObservation {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameObservation(
  left: CanonicalDaemonInfoObservation,
  right: CanonicalDaemonInfoObservation,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function invalidState(
  reason: CanonicalDaemonInfoInvalidReason,
  detail: string,
  ownerPid: number | null = null,
  observed: CanonicalDaemonInfoObservation | null = null,
): CanonicalDaemonInfoState {
  return { status: "invalid", reason, detail, ownerPid, observation: observed };
}

function ownerPidFromRaw(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || !("pid" in raw)) return null;
  const pid = (raw as { pid?: unknown }).pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function writeCanonicalDaemonInfo(info: CanonicalDaemonInfo): void {
  const path = getCanonicalDaemonInfoPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const persisted: CanonicalDaemonInfo = {
    pid: info.pid,
    port: info.port,
    protocolVersion: info.protocolVersion,
    productVersion: info.productVersion,
    instanceId: info.instanceId,
    startedAt: info.startedAt,
    bindHostname: info.bindHostname,
    authToken: info.authToken,
  };
  writeFileSync(tmpPath, JSON.stringify(persisted, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
}

export function inspectCanonicalDaemonInfo(): CanonicalDaemonInfoState {
  const path = getCanonicalDaemonInfoPath();
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    const pathObservation = observation(pathStat);
    if (pathStat.isSymbolicLink()) {
      return invalidState(
        "symlink",
        "daemon.json must not be a symbolic link",
        null,
        pathObservation,
      );
    }
    if (!pathStat.isFile()) {
      return invalidState(
        "not-regular-file",
        "daemon.json must be a regular file",
        null,
        pathObservation,
      );
    }
    if (pathStat.size > MAX_DAEMON_INFO_BYTES) {
      return invalidState("oversized", "daemon.json exceeds the size limit", null, pathObservation);
    }
    if (typeof process.getuid === "function" && pathStat.uid !== process.getuid()) {
      return invalidState(
        "wrong-owner",
        "daemon.json is not owned by the current user",
        null,
        pathObservation,
      );
    }
    if ((pathStat.mode & 0o077) !== 0) {
      return invalidState(
        "unsafe-permissions",
        "daemon.json must be readable and writable only by its owner",
        null,
        pathObservation,
      );
    }

    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = fstatSync(descriptor);
    const openedObservation = observation(openedStat);
    if (
      !openedStat.isFile() ||
      !sameObservation(pathObservation, openedObservation) ||
      (typeof process.getuid === "function" && openedStat.uid !== process.getuid()) ||
      (openedStat.mode & 0o077) !== 0
    ) {
      return invalidState(
        "changed-while-opening",
        "daemon.json changed or became unsafe while it was opened",
        null,
        openedObservation,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(descriptor, "utf-8"));
    } catch (error) {
      return invalidState(
        "malformed-json",
        error instanceof Error ? error.message : "daemon.json is not valid JSON",
        null,
        openedObservation,
      );
    }
    const parsed = CanonicalDaemonInfoSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidState(
        "invalid-schema",
        parsed.error.issues.map((issue) => issue.message).join("; "),
        ownerPidFromRaw(raw),
        openedObservation,
      );
    }
    return { status: "valid", info: parsed.data, observation: openedObservation };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return invalidState(
      "unreadable",
      error instanceof Error ? error.message : "daemon.json could not be read",
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Convenience for non-ownership consumers. Startup and takeover code must use
 * inspectCanonicalDaemonInfo() so an invalid record is never treated as absent.
 */
export function readCanonicalDaemonInfo(): CanonicalDaemonInfo | null {
  const state = inspectCanonicalDaemonInfo();
  return state.status === "valid" ? state.info : null;
}

export function clearCanonicalDaemonInfo(): void {
  rmSync(getCanonicalDaemonInfoPath(), { force: true });
}

/** Avoid deleting a replacement record published after our observation. */
export function clearCanonicalDaemonInfoIfUnchanged(state: CanonicalDaemonInfoState): boolean {
  if (state.status === "missing" || !state.observation) return false;
  try {
    const current = observation(lstatSync(getCanonicalDaemonInfoPath()));
    if (!sameObservation(state.observation, current)) return false;
    rmSync(getCanonicalDaemonInfoPath());
    return true;
  } catch {
    return false;
  }
}

type PidLiveness = "alive" | "dead" | "unknown";

function pidLiveness(pid: number): PidLiveness {
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

/** Unknown process state is retained as ownership, never mistaken for death. */
export async function isCanonicalDaemonAlive(info: CanonicalDaemonInfo): Promise<boolean> {
  return pidLiveness(info.pid) !== "dead";
}

/**
 * Invalid but securely-read records may expose a trusted positive PID. Only an
 * explicit ESRCH proves it stale; missing/untrusted/indeterminate owners block
 * automatic replacement.
 */
export async function isCanonicalDaemonRecordOwnerProvenDead(
  state: Exclude<CanonicalDaemonInfoState, { status: "missing" }>,
): Promise<boolean> {
  const pid = state.status === "valid" ? state.info.pid : state.ownerPid;
  return pid !== null && pidLiveness(pid) === "dead";
}

function connectHostname(bindHostname: string): string {
  if (bindHostname === "0.0.0.0") return "127.0.0.1";
  if (bindHostname === "::") return "::1";
  return bindHostname;
}

function urlHostname(bindHostname: string): string {
  const hostname = connectHostname(bindHostname).replace(/^\[|\]$/gu, "");
  if (/[/?#@]/u.test(hostname)) throw new TypeError("Invalid daemon bind hostname");
  const escaped = hostname.replace(/%/gu, "%25");
  return escaped.includes(":") ? `[${escaped}]` : escaped;
}

/** Format HTTP/WS endpoints without producing invalid unbracketed IPv6 URLs. */
export function canonicalDaemonUrl(
  protocol: "http" | "ws",
  bindHostname: string,
  port: number,
  path = "",
): string {
  const suffix = path.length === 0 ? "" : path.startsWith("/") ? path : `/${path}`;
  return `${protocol}://${urlHostname(bindHostname)}:${port}${suffix}`;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

/** Package-version skew is diagnostic only; protocolVersion owns compatibility. */
export function warnOnDaemonVersionSkew(
  info: CanonicalDaemonInfo,
  expectedProductVersion: string,
): void {
  if (info.productVersion === expectedProductVersion) return;
  console.warn(
    `[tmux-ide] canonical daemon product-version skew: daemon.json reports ` +
      `"${info.productVersion}" but this client expects "${expectedProductVersion}". ` +
      `Wire compatibility is governed independently by protocolVersion.`,
  );
}

/** Probe health separately from ownership so callers can report precise state. */
export async function probeCanonicalDaemonHealth(
  info: CanonicalDaemonInfo,
): Promise<DaemonHealth | null> {
  if (!(await isCanonicalDaemonAlive(info))) return null;
  try {
    const res = await fetch(canonicalDaemonUrl("http", info.bindHostname, info.port, "/health"), {
      signal: timeoutSignal(750),
    });
    if (!res.ok) return null;
    const parsed = DaemonHealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Credential-free endpoint binding probe; callers compare instanceId to daemon.json. */
export async function probeCanonicalDaemonIdentity(
  info: CanonicalDaemonInfo,
): Promise<DaemonIdentity | null> {
  if (!(await isCanonicalDaemonAlive(info))) return null;
  try {
    const res = await fetch(canonicalDaemonUrl("http", info.bindHostname, info.port, "/identity"), {
      signal: timeoutSignal(750),
    });
    if (!res.ok) return null;
    const parsed = DaemonIdentitySchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
