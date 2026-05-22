import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLock, readLock, writeLock, type LockData } from "./lock.ts";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daemon-client-lock-"));
  lockPath = join(dir, "daemon.lock");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE: LockData = {
  pid: 12345,
  port: 6060,
  token: "abc123",
  startedAt: "2026-05-08T15:00:00.000Z",
};

describe("lock", () => {
  it("write+read round-trips", () => {
    writeLock(SAMPLE, lockPath);
    expect(readLock(lockPath)).toEqual(SAMPLE);
  });

  it("readLock returns null when the file is absent", () => {
    expect(readLock(lockPath)).toBeNull();
  });

  it("readLock returns null on unparseable content", () => {
    writeFileSync(lockPath, "not json", "utf8");
    expect(readLock(lockPath)).toBeNull();
  });

  it("readLock returns null when fields are missing", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 1, port: 6060 }), "utf8");
    expect(readLock(lockPath)).toBeNull();
  });

  it("readLock returns null when types are wrong", () => {
    writeFileSync(lockPath, JSON.stringify({ ...SAMPLE, pid: "string-pid" }), "utf8");
    expect(readLock(lockPath)).toBeNull();
  });

  it("readLock returns null when pid <= 0", () => {
    writeFileSync(lockPath, JSON.stringify({ ...SAMPLE, pid: 0 }), "utf8");
    expect(readLock(lockPath)).toBeNull();
  });

  it("writeLock rejects bad data", () => {
    expect(() => writeLock({ ...SAMPLE, pid: -1 }, lockPath)).toThrow();
    expect(() => writeLock({ ...SAMPLE, port: 0 }, lockPath)).toThrow();
  });

  it("writeLock creates the parent directory", () => {
    const nested = join(dir, "deep", "nested", "daemon.lock");
    writeLock(SAMPLE, nested);
    expect(existsSync(nested)).toBe(true);
    expect(readLock(nested)).toEqual(SAMPLE);
  });

  it("writeLock overwrites an existing lock atomically", () => {
    writeLock(SAMPLE, lockPath);
    const next = { ...SAMPLE, port: 6061 };
    writeLock(next, lockPath);
    expect(readLock(lockPath)).toEqual(next);
  });

  it("clearLock deletes the file", () => {
    writeLock(SAMPLE, lockPath);
    clearLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("clearLock is a no-op when the file is absent", () => {
    expect(() => clearLock(lockPath)).not.toThrow();
  });
});
