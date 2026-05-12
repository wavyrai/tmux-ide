/**
 * ensureDaemon — discovery + spawn glue.
 *
 *   1. Read the lock file. If it parses + the daemon is alive, return its
 *      { port, token } directly.
 *   2. If the lock parses but the daemon is dead, clear the lock and fall
 *      through to spawn.
 *   3. If absent, spawn the daemon detached from the parent process group
 *      so it survives a CLI exit, then poll /healthz until ready (or the
 *      timeout fires) and return the new { port, token }.
 *
 * The actual "how do I run the daemon" is parameterized via the `spawn`
 * option so callers can wire in their preferred entry point — typically
 * `node packages/daemon/dist/bin.js` or `bun bin/cli.ts daemon`.
 *
 * No global state. Pure-input/pure-output for testability — pass a custom
 * `now`, `spawn`, `fetchImpl`, `lockPath` to override the world.
 */

import { isDaemonAlive, type HealthOptions } from "./health.ts";
import { clearLock, defaultLockPath, readLock, type LockData } from "./lock.ts";

export interface EnsureDaemonOptions {
  /**
   * Spawn the daemon. Implementation is host-specific; the library doesn't
   * pick a runtime. Must NOT block; the daemon should run detached so the
   * caller's await resolves once /healthz reports ok.
   */
  spawn: () => void | Promise<void>;
  /** Lock file path. Defaults to ~/.tmux-ide/daemon.lock. */
  lockPath?: string;
  /** Health probe options forwarded to isDaemonAlive. */
  health?: HealthOptions;
  /** Total time to wait for the spawned daemon to become healthy. Default 10s. */
  spawnTimeoutMs?: number;
  /** Polling interval while waiting. Default 100ms. */
  spawnPollMs?: number;
  /** Override clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface EnsureDaemonResult {
  port: number;
  token: string;
  /** True when the existing lock was reused; false when we spawned a new daemon. */
  reused: boolean;
}

export async function ensureDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const lockPath = opts.lockPath ?? defaultLockPath();
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.spawnTimeoutMs ?? 10_000;
  const pollMs = opts.spawnPollMs ?? 100;

  const existing = readLock(lockPath);
  if (existing) {
    if (await isDaemonAlive(existing, opts.health)) {
      return { port: existing.port, token: existing.token, reused: true };
    }
    // Stale — clear and proceed to spawn.
    clearLock(lockPath);
  }

  await opts.spawn();

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const fresh = readLock(lockPath);
    if (fresh && (await isDaemonAlive(fresh, opts.health))) {
      return { port: fresh.port, token: fresh.token, reused: false };
    }
    await sleep(pollMs);
  }

  throw new Error(
    `ensureDaemon: spawned daemon did not become healthy within ${timeoutMs}ms (lock=${lockPath})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Convenience: stale-lock discovery without spawning. Returns the live lock
 * if the daemon answers, else clears the stale lock and returns null.
 */
export async function discoverDaemon(
  options: { lockPath?: string; health?: HealthOptions } = {},
): Promise<LockData | null> {
  const lockPath = options.lockPath ?? defaultLockPath();
  const lock = readLock(lockPath);
  if (!lock) return null;
  if (await isDaemonAlive(lock, options.health)) return lock;
  clearLock(lockPath);
  return null;
}
