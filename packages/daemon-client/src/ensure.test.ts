import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDaemon, ensureDaemon } from "./ensure.ts";
import { readLock, writeLock, type LockData } from "./lock.ts";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daemon-client-ensure-"));
  lockPath = join(dir, "daemon.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function liveLockSample(overrides: Partial<LockData> = {}): LockData {
  return {
    pid: process.pid, // self — guaranteed alive for kill -0
    port: 6060,
    token: "tok-live",
    startedAt: "2026-05-08T15:00:00.000Z",
    ...overrides,
  };
}

function staleLockSample(overrides: Partial<LockData> = {}): LockData {
  return {
    pid: 999_999_999, // implausible PID — kill -0 will fail with ESRCH
    port: 6060,
    token: "tok-stale",
    startedAt: "2026-05-08T15:00:00.000Z",
    ...overrides,
  };
}

describe("ensureDaemon", () => {
  it("returns existing lock when daemon is alive", async () => {
    const lock = liveLockSample();
    writeLock(lock, lockPath);
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    let spawned = false;
    const result = await ensureDaemon({
      lockPath,
      health: { fetchImpl: fakeFetch },
      spawn: () => {
        spawned = true;
      },
    });

    expect(result.reused).toBe(true);
    expect(result.port).toBe(lock.port);
    expect(result.token).toBe(lock.token);
    expect(spawned).toBe(false);
  });

  it("clears stale lock and spawns when PID is dead", async () => {
    writeLock(staleLockSample(), lockPath);

    let spawnCalled = false;
    const newLock = liveLockSample({ port: 6061, token: "tok-new" });
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    const result = await ensureDaemon({
      lockPath,
      health: { fetchImpl: fakeFetch },
      spawnPollMs: 5,
      spawn: () => {
        spawnCalled = true;
        // Simulate the daemon writing its lock at startup.
        writeLock(newLock, lockPath);
      },
    });

    expect(spawnCalled).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.port).toBe(6061);
    expect(result.token).toBe("tok-new");
  });

  it("spawns when no lock exists", async () => {
    expect(existsSync(lockPath)).toBe(false);
    let spawnCalled = false;
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

    const result = await ensureDaemon({
      lockPath,
      health: { fetchImpl: fakeFetch },
      spawnPollMs: 5,
      spawn: () => {
        spawnCalled = true;
        writeLock(liveLockSample({ port: 6062, token: "tok-fresh" }), lockPath);
      },
    });

    expect(spawnCalled).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.port).toBe(6062);
  });

  it("times out when the spawned daemon never writes a healthy lock", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    await expect(
      ensureDaemon({
        lockPath,
        health: { fetchImpl: fakeFetch },
        spawn: () => {
          /* never writes lock */
        },
        spawnTimeoutMs: 50,
        spawnPollMs: 10,
      }),
    ).rejects.toThrow(/did not become healthy/);
  });
});

describe("discoverDaemon", () => {
  it("returns null when no lock exists", async () => {
    expect(await discoverDaemon({ lockPath })).toBeNull();
  });

  it("clears stale lock and returns null", async () => {
    writeLock(staleLockSample(), lockPath);
    const out = await discoverDaemon({ lockPath });
    expect(out).toBeNull();
    expect(readLock(lockPath)).toBeNull(); // cleared
  });

  it("returns the live lock without modification", async () => {
    const lock = liveLockSample();
    writeLock(lock, lockPath);
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    const out = await discoverDaemon({ lockPath, health: { fetchImpl: fakeFetch } });
    expect(out).toEqual(lock);
  });
});
