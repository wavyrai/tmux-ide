import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CanonicalDaemonInfo {
  readonly pid: number;
  readonly port: number;
  readonly version: string;
  readonly startedAt: string;
  readonly bindHostname: string;
  readonly authToken: string | null;
}

const DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
const REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
const DAEMON_INFO_FILE = "daemon.json";

export function getCanonicalDaemonInfoPath(): string {
  const dir =
    process.env[DAEMON_INFO_DIR_ENV] ??
    process.env[REGISTRY_DIR_ENV] ??
    join(homedir(), ".tmux-ide");
  return join(dir, DAEMON_INFO_FILE);
}

function parseCanonicalDaemonInfo(raw: unknown): CanonicalDaemonInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const info = raw as Partial<CanonicalDaemonInfo>;
  const pid = info.pid;
  const port = info.port;
  if (typeof pid !== "number" || typeof port !== "number") return null;
  if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
  if (typeof info.version !== "string" || typeof info.startedAt !== "string") return null;
  if (typeof info.bindHostname !== "string") return null;
  if (info.authToken !== null && typeof info.authToken !== "string") return null;
  return {
    pid,
    port,
    version: info.version,
    startedAt: info.startedAt,
    bindHostname: info.bindHostname,
    authToken: info.authToken,
  };
}

export function writeCanonicalDaemonInfo(info: CanonicalDaemonInfo): void {
  const path = getCanonicalDaemonInfoPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const persisted: CanonicalDaemonInfo = {
    pid: info.pid,
    port: info.port,
    version: info.version,
    startedAt: info.startedAt,
    bindHostname: info.bindHostname,
    authToken: info.authToken,
  };
  writeFileSync(tmpPath, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function readCanonicalDaemonInfo(): CanonicalDaemonInfo | null {
  const path = getCanonicalDaemonInfoPath();
  if (!existsSync(path)) return null;
  try {
    return parseCanonicalDaemonInfo(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

export function clearCanonicalDaemonInfo(): void {
  rmSync(getCanonicalDaemonInfoPath(), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

/**
 * Version-skew guard. A client (desktop app, editor extension, second
 * CLI) attaching to the canonical daemon compiles in the daemon
 * version it expects. If the live daemon advertises a different
 * `version`, the wire contract may have drifted — warn loudly rather
 * than failing silently on a mismatched action/WS schema.
 */
export function warnOnDaemonVersionSkew(info: CanonicalDaemonInfo, expectedVersion: string): void {
  if (info.version === expectedVersion) return;
  console.warn(
    `[tmux-ide] canonical daemon version skew: daemon.json reports ` +
      `"${info.version}" but this client expects "${expectedVersion}". ` +
      `The action/WS contract may have drifted — restart the canonical ` +
      `daemon (tmux-ide) so it matches this client build.`,
  );
}

export async function isCanonicalDaemonAlive(info: CanonicalDaemonInfo): Promise<boolean> {
  if (!isPidAlive(info.pid)) return false;
  try {
    const res = await fetch(`http://${probeHostname(info.bindHostname)}:${info.port}/health`, {
      signal: timeoutSignal(750),
    });
    return res.ok;
  } catch {
    return false;
  }
}
