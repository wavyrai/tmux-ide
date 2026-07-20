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
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CanonicalDaemonInfoSchema,
  type CanonicalDaemonInfo,
  DaemonHealthSchema,
  type DaemonHealth,
} from "@tmux-ide/contracts";

export type { CanonicalDaemonInfo } from "@tmux-ide/contracts";

const DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
const DAEMON_INFO_FILE = "daemon.json";
const MAX_DAEMON_INFO_BYTES = 64 * 1024;

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

function parseCanonicalDaemonInfo(raw: unknown): CanonicalDaemonInfo | null {
  const parsed = CanonicalDaemonInfoSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function writeCanonicalDaemonInfo(info: CanonicalDaemonInfo): void {
  const path = getCanonicalDaemonInfoPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const persisted: CanonicalDaemonInfo = {
    pid: info.pid,
    port: info.port,
    protocolVersion: info.protocolVersion,
    version: info.version,
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

export function readCanonicalDaemonInfo(): CanonicalDaemonInfo | null {
  const path = getCanonicalDaemonInfoPath();
  let descriptor: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_DAEMON_INFO_BYTES) {
      return null;
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.size > MAX_DAEMON_INFO_BYTES ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      return null;
    }
    const info = parseCanonicalDaemonInfo(JSON.parse(readFileSync(descriptor, "utf-8")));
    if (!info) return null;
    const ownerMismatch =
      typeof process.getuid === "function" && openedStat.uid !== process.getuid();
    if (info.authToken !== null && (ownerMismatch || (openedStat.mode & 0o077) !== 0)) return null;
    return info;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function clearCanonicalDaemonInfo(): void {
  rmSync(getCanonicalDaemonInfoPath(), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function probeHostname(bindHostname: string): string {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

/** Package-version skew is diagnostic only; protocolVersion owns compatibility. */
export function warnOnDaemonVersionSkew(info: CanonicalDaemonInfo, expectedVersion: string): void {
  if (info.version === expectedVersion) return;
  console.warn(
    `[tmux-ide] canonical daemon version skew: daemon.json reports ` +
      `"${info.version}" but this client expects "${expectedVersion}". ` +
      `Wire compatibility is governed independently by protocolVersion.`,
  );
}

/**
 * Ownership liveness is deliberately PID-only. An unreachable or incompatible
 * live daemon still owns the canonical slot and must not be replaced.
 */
export async function isCanonicalDaemonAlive(info: CanonicalDaemonInfo): Promise<boolean> {
  return isPidAlive(info.pid);
}

/** Probe health separately from ownership so callers can report precise state. */
export async function probeCanonicalDaemonHealth(
  info: CanonicalDaemonInfo,
): Promise<DaemonHealth | null> {
  if (!isPidAlive(info.pid)) return null;
  try {
    const res = await fetch(`http://${probeHostname(info.bindHostname)}:${info.port}/health`, {
      signal: timeoutSignal(750),
    });
    if (!res.ok) return null;
    const parsed = DaemonHealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
