import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
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
const DAEMON_CLAIM_DIR = "daemon.claim";
const DAEMON_CLAIM_OWNER_FILE = "owner.json";
const MAX_DAEMON_INFO_BYTES = 64 * 1024;
const MAX_DAEMON_CLAIM_BYTES = 4 * 1024;

export interface CanonicalDaemonClaim {
  readonly claimId: string;
  readonly pid: number;
  readonly acquiredAt: string;
}

export type CanonicalDaemonClaimAttempt =
  | { status: "acquired"; claim: CanonicalDaemonClaim }
  | { status: "busy"; owner: CanonicalDaemonClaim }
  | { status: "invalid"; detail: string };

type CanonicalDaemonClaimState =
  | { status: "missing" }
  | { status: "valid"; claim: CanonicalDaemonClaim }
  | { status: "invalid"; detail: string };

const activeClaims = new Set<string>();

export type CanonicalDaemonInfoInvalidReason =
  | "parent-symlink"
  | "parent-not-directory"
  | "parent-wrong-owner"
  | "parent-unsafe-permissions"
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

export function getCanonicalDaemonClaimPath(): string {
  return join(dirname(getCanonicalDaemonInfoPath()), DAEMON_CLAIM_DIR);
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

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalDaemonRootError(detail: string): Error {
  return new Error(`canonical daemon parent ${detail}`);
}

/**
 * Create or harden the daemon record parent without ever path-chmodding an
 * untrusted endpoint. The directory descriptor pins the object being changed;
 * the final lstat proves the configured path still names that same object.
 */
function prepareCanonicalDaemonRoot(root: string): void {
  let descriptor: number | undefined;
  try {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    } catch (error) {
      // Recursive mkdir reports EEXIST for a non-directory endpoint. Let the
      // lstat below classify it deterministically instead of trusting it.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const pathStat = lstatSync(root);
    if (pathStat.isSymbolicLink()) {
      throw canonicalDaemonRootError("must not be a symbolic link");
    }
    if (!pathStat.isDirectory()) {
      throw canonicalDaemonRootError("must be a directory");
    }
    if (typeof process.getuid === "function" && pathStat.uid !== process.getuid()) {
      throw canonicalDaemonRootError("must be owned by the current user");
    }

    descriptor = openSync(
      root,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0),
    );
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isDirectory() ||
      !sameFileIdentity(pathStat, openedStat) ||
      (typeof process.getuid === "function" && openedStat.uid !== process.getuid())
    ) {
      throw canonicalDaemonRootError("changed or became unsafe while it was opened");
    }

    fchmodSync(descriptor, 0o700);
    const hardenedStat = fstatSync(descriptor);
    const currentPathStat = lstatSync(root);
    if (
      !hardenedStat.isDirectory() ||
      !sameFileIdentity(openedStat, hardenedStat) ||
      (typeof process.getuid === "function" && hardenedStat.uid !== process.getuid()) ||
      (hardenedStat.mode & 0o077) !== 0 ||
      currentPathStat.isSymbolicLink() ||
      !currentPathStat.isDirectory() ||
      !sameFileIdentity(hardenedStat, currentPathStat) ||
      (typeof process.getuid === "function" && currentPathStat.uid !== process.getuid()) ||
      (currentPathStat.mode & 0o077) !== 0
    ) {
      throw canonicalDaemonRootError("changed or became unsafe while it was hardened");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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

function inspectCanonicalDaemonInfoPath(path: string): CanonicalDaemonInfoState {
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    const pathObservation = observation(pathStat);
    const parentStat = lstatSync(dirname(path));
    if (parentStat.isSymbolicLink()) {
      return invalidState(
        "parent-symlink",
        "daemon.json parent must not be a symbolic link",
        null,
        pathObservation,
      );
    }
    if (!parentStat.isDirectory()) {
      return invalidState(
        "parent-not-directory",
        "daemon.json parent must be a directory",
        null,
        pathObservation,
      );
    }
    if (typeof process.getuid === "function" && parentStat.uid !== process.getuid()) {
      return invalidState(
        "parent-wrong-owner",
        "daemon.json parent is not owned by the current user",
        null,
        pathObservation,
      );
    }
    if ((parentStat.mode & 0o077) !== 0) {
      return invalidState(
        "parent-unsafe-permissions",
        "daemon.json parent must be accessible only by its owner",
        null,
        pathObservation,
      );
    }
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
    const reopenedParentStat = lstatSync(dirname(path));
    if (
      !openedStat.isFile() ||
      !sameObservation(pathObservation, openedObservation) ||
      !sameFileIdentity(parentStat, reopenedParentStat) ||
      !reopenedParentStat.isDirectory() ||
      (typeof process.getuid === "function" && openedStat.uid !== process.getuid()) ||
      (openedStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && reopenedParentStat.uid !== process.getuid()) ||
      (reopenedParentStat.mode & 0o077) !== 0
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

function inspectCanonicalDaemonClaimPath(path: string): CanonicalDaemonClaimState {
  let descriptor: number | undefined;
  try {
    const claimStat = lstatSync(path);
    if (claimStat.isSymbolicLink() || !claimStat.isDirectory()) {
      return { status: "invalid", detail: "daemon claim must be a real directory" };
    }
    if (typeof process.getuid === "function" && claimStat.uid !== process.getuid()) {
      return { status: "invalid", detail: "daemon claim is owned by another user" };
    }
    if ((claimStat.mode & 0o077) !== 0) {
      return { status: "invalid", detail: "daemon claim directory is not owner-only" };
    }

    const ownerPath = join(path, DAEMON_CLAIM_OWNER_FILE);
    const ownerStat = lstatSync(ownerPath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
      return { status: "invalid", detail: "daemon claim owner must be a real file" };
    }
    if (ownerStat.size > MAX_DAEMON_CLAIM_BYTES) {
      return { status: "invalid", detail: "daemon claim owner exceeds the size limit" };
    }
    if (typeof process.getuid === "function" && ownerStat.uid !== process.getuid()) {
      return { status: "invalid", detail: "daemon claim owner is owned by another user" };
    }
    if ((ownerStat.mode & 0o077) !== 0) {
      return { status: "invalid", detail: "daemon claim owner is not owner-only" };
    }
    descriptor = openSync(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== ownerStat.dev ||
      openedStat.ino !== ownerStat.ino ||
      openedStat.size !== ownerStat.size
    ) {
      return { status: "invalid", detail: "daemon claim changed while it was opened" };
    }
    const raw = JSON.parse(readFileSync(descriptor, "utf-8")) as Record<string, unknown>;
    if (
      typeof raw.claimId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(raw.claimId) ||
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(raw.acquiredAt))
    ) {
      return { status: "invalid", detail: "daemon claim owner has invalid metadata" };
    }
    return {
      status: "valid",
      claim: { claimId: raw.claimId, pid: raw.pid, acquiredAt: raw.acquiredAt },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return {
      status: "invalid",
      detail: error instanceof Error ? error.message : "daemon claim could not be read",
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function restoreCapturedFile(capturedPath: string, canonicalPath: string): void {
  try {
    linkSync(capturedPath, canonicalPath);
    rmSync(capturedPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A concurrently published canonical record wins. Keep the captured file
    // as forensic recovery data rather than deleting either generation.
  }
}

function retireCanonicalClaimIfMatches(expected: CanonicalDaemonClaim): boolean {
  const path = getCanonicalDaemonClaimPath();
  const captured = `${path}.${expected.claimId}.${randomUUID()}.retired`;
  try {
    renameSync(path, captured);
  } catch {
    return false;
  }
  const moved = inspectCanonicalDaemonClaimPath(captured);
  if (
    moved.status === "valid" &&
    moved.claim.claimId === expected.claimId &&
    moved.claim.pid === expected.pid
  ) {
    rmSync(captured, { recursive: true, force: true });
    return true;
  }
  try {
    renameSync(captured, path);
  } catch {
    // Never delete a claim generation that was not the one we intended to retire.
  }
  return false;
}

/**
 * Publish a complete, process-lifetime startup claim with one atomic rename.
 * The winner holds it until daemon shutdown; contenders cannot pass inspection,
 * bind, or publication concurrently.
 */
export function tryAcquireCanonicalDaemonClaim(): CanonicalDaemonClaimAttempt {
  const path = getCanonicalDaemonClaimPath();
  const root = dirname(path);
  try {
    prepareCanonicalDaemonRoot(root);
  } catch (error) {
    return {
      status: "invalid",
      detail:
        error instanceof Error ? error.message : "canonical daemon parent could not be prepared",
    };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim: CanonicalDaemonClaim = {
      claimId: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    const candidate = `${path}.${claim.claimId}.candidate`;
    mkdirSync(candidate, { mode: 0o700 });
    writeFileSync(join(candidate, DAEMON_CLAIM_OWNER_FILE), `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      renameSync(candidate, path);
      activeClaims.add(claim.claimId);
      return { status: "acquired", claim };
    } catch (error) {
      rmSync(candidate, { recursive: true, force: true });
      const existing = inspectCanonicalDaemonClaimPath(path);
      if (existing.status === "missing") {
        if (attempt < 2) continue;
        return { status: "invalid", detail: "daemon claim changed during acquisition" };
      }
      if (existing.status === "invalid") return existing;
      if (pidLiveness(existing.claim.pid) !== "dead") {
        return { status: "busy", owner: existing.claim };
      }
      if (!retireCanonicalClaimIfMatches(existing.claim) && attempt === 2) {
        return { status: "invalid", detail: "stale daemon claim changed during recovery" };
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && attempt === 2) throw error;
    }
  }
  return { status: "invalid", detail: "daemon claim could not be acquired" };
}

function assertCanonicalDaemonClaimHeld(claim: CanonicalDaemonClaim): void {
  if (!activeClaims.has(claim.claimId)) throw new Error("canonical daemon claim is not active");
  const current = inspectCanonicalDaemonClaimPath(getCanonicalDaemonClaimPath());
  if (
    current.status !== "valid" ||
    current.claim.claimId !== claim.claimId ||
    current.claim.pid !== claim.pid
  ) {
    throw new Error("canonical daemon claim ownership was lost");
  }
}

export function releaseCanonicalDaemonClaim(claim: CanonicalDaemonClaim): boolean {
  if (!activeClaims.has(claim.claimId)) return false;
  try {
    return retireCanonicalClaimIfMatches(claim);
  } finally {
    activeClaims.delete(claim.claimId);
  }
}

export function writeCanonicalDaemonInfo(
  info: CanonicalDaemonInfo,
  claim: CanonicalDaemonClaim,
): void {
  assertCanonicalDaemonClaimHeld(claim);
  const path = getCanonicalDaemonInfoPath();
  prepareCanonicalDaemonRoot(dirname(path));
  const tmpPath = `${path}.${claim.claimId}.${randomUUID()}.tmp`;
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
  try {
    // link(2) is an atomic create-if-absent publication. It cannot overwrite a
    // canonical generation published by another process.
    linkSync(tmpPath, path);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

export function inspectCanonicalDaemonInfo(): CanonicalDaemonInfoState {
  return inspectCanonicalDaemonInfoPath(getCanonicalDaemonInfoPath());
}

/**
 * Convenience for non-ownership consumers. Startup and takeover code must use
 * inspectCanonicalDaemonInfo() so an invalid record is never treated as absent.
 */
export function readCanonicalDaemonInfo(): CanonicalDaemonInfo | null {
  const state = inspectCanonicalDaemonInfo();
  return state.status === "valid" ? state.info : null;
}

function captureCanonicalDaemonInfo(claim: CanonicalDaemonClaim): string | null {
  assertCanonicalDaemonClaimHeld(claim);
  const path = getCanonicalDaemonInfoPath();
  const captured = `${path}.${claim.claimId}.${randomUUID()}.retired`;
  try {
    renameSync(path, captured);
    return captured;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Atomically capture and remove only the observed canonical generation. */
export function clearCanonicalDaemonInfoIfUnchanged(
  state: CanonicalDaemonInfoState,
  claim: CanonicalDaemonClaim,
): boolean {
  if (state.status === "missing" || !state.observation) return false;
  const path = getCanonicalDaemonInfoPath();
  const captured = captureCanonicalDaemonInfo(claim);
  if (!captured) return false;
  try {
    const current = observation(lstatSync(captured));
    if (sameObservation(state.observation, current)) {
      rmSync(captured, { recursive: true, force: true });
      return true;
    }
    restoreCapturedFile(captured, path);
    return false;
  } catch (error) {
    restoreCapturedFile(captured, path);
    throw error;
  }
}

/** Atomically capture and remove only this daemon instance's record. */
export function clearCanonicalDaemonInfoIfOwned(
  instanceId: string,
  claim: CanonicalDaemonClaim,
): boolean {
  const path = getCanonicalDaemonInfoPath();
  const captured = captureCanonicalDaemonInfo(claim);
  if (!captured) return false;
  const state = inspectCanonicalDaemonInfoPath(captured);
  if (state.status === "valid" && state.info.instanceId === instanceId) {
    rmSync(captured, { recursive: true, force: true });
    return true;
  }
  restoreCapturedFile(captured, path);
  return false;
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
