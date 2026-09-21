import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  chmodSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTuiDownloadLock } from "../tui-download-lock.ts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tui-lock-test-"));
  roots.push(root);
  return { root, lock: join(root, "asset.lock") };
}
function missing() {
  throw Object.assign(new Error("gone"), { code: "ESRCH" });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("TUI download owner lock", () => {
  it("recovers a fresh dead legacy lock and serializes concurrent claimers", async () => {
    const { lock, root } = fixture();
    writeFileSync(lock, "1234567\n", { mode: 0o600 });
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 1234567) return missing();
      return true;
    });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const release = await acquireTuiDownloadLock(lock, 1000);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        release();
      }),
    );
    expect(peak).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });
  it("does not evict an old live owner", async () => {
    const { lock } = fixture();
    writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    utimesSync(lock, new Date(0), new Date(0));
    await expect(acquireTuiDownloadLock(lock, 15)).rejects.toThrow("timed out");
    expect(readFileSync(lock, "utf8")).toBe(`${process.pid}\n`);
  });
  it("refuses uncertain liveness without deleting the owner", async () => {
    const { lock } = fixture();
    writeFileSync(lock, "1234567\n", { mode: 0o600 });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("unknown"), { code: "EPERM" });
    });
    await expect(acquireTuiDownloadLock(lock, 15)).rejects.toThrow("timed out");
    expect(existsSync(lock)).toBe(true);
  });
  it.each(["garbage", "0\n", "999999999999999999\n", "1".repeat(100)])(
    "refuses malformed owner %s",
    async (body) => {
      const { lock } = fixture();
      writeFileSync(lock, body, { mode: 0o600 });
      await expect(acquireTuiDownloadLock(lock, 15)).rejects.toThrow();
      expect(readFileSync(lock, "utf8")).toBe(body);
    },
  );
  it("refuses symlink and unsafe permissions", async () => {
    const { lock, root } = fixture();
    const target = join(root, "target");
    writeFileSync(target, "1234567\n", { mode: 0o600 });
    symlinkSync(target, lock);
    await expect(acquireTuiDownloadLock(lock, 15)).rejects.toThrow("unsafe");
    rmSync(lock);
    writeFileSync(lock, "1234567\n", { mode: 0o600 });
    chmodSync(lock, 0o666);
    await expect(acquireTuiDownloadLock(lock, 15)).rejects.toThrow("unsafe");
  });
  it("does not let an obsolete release callback remove a successor", async () => {
    const { lock, root } = fixture();
    const oldRelease = await acquireTuiDownloadLock(lock, 100);
    // Retain the exact former directory to model an obsolete release callback.
    renameSync(lock, join(root, "retired"));
    const release = await acquireTuiDownloadLock(lock, 100);
    const owner = readdirSync(lock);
    oldRelease();
    expect(readdirSync(lock)).toEqual(owner);
    release();
    oldRelease();
    expect(existsSync(lock)).toBe(false);
  });
  it("reclaims only a dead valid nonce owner", async () => {
    const { lock } = fixture();
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner-00000000-0000-0000-0000-000000000000"), "1234567\n", {
      mode: 0o600,
    });
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 1234567) return missing();
      return true;
    });
    const release = await acquireTuiDownloadLock(lock, 100);
    release();
    expect(existsSync(lock)).toBe(false);
  });
  it("rejects extra directory entries and preserves them", async () => {
    const { lock } = fixture();
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "unknown"), "evidence");
    await expect(acquireTuiDownloadLock(lock, 15)).rejects.toThrow("inventory");
    expect(readFileSync(join(lock, "unknown"), "utf8")).toBe("evidence");
  });
  it("refuses an unsafe empty directory before atomic publication", async () => {
    const { lock } = fixture();
    mkdirSync(lock, { mode: 0o700 });
    chmodSync(lock, 0o777);
    const inode = fs.lstatSync(lock).ino;
    await expect(acquireTuiDownloadLock(lock, 20)).rejects.toThrow("unsafe");
    expect(fs.lstatSync(lock).ino).toBe(inode);
  });
  it("refuses hard-linked legacy owner files", async () => {
    const { lock, root } = fixture();
    writeFileSync(lock, "1234567\n", { mode: 0o600 });
    linkSync(lock, join(root, "other"));
    await expect(acquireTuiDownloadLock(lock, 20)).rejects.toThrow("unsafe");
    expect(fs.lstatSync(lock).nlink).toBe(2);
  });
  it("preserves a write error while cleaning only its unpublished staging", async () => {
    const { lock, root } = fixture();
    const failure = new Error("controlled owner write failure");
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(acquireTuiDownloadLock(lock, 20)).rejects.toBe(failure);
    expect(readdirSync(root)).toEqual([]);
  });
  it("serializes contenders reclaiming a dead nonce directory", async () => {
    const { lock, root } = fixture();
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(join(lock, "owner-00000000-0000-0000-0000-000000000000"), "1234567\n", {
      mode: 0o600,
    });
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 1234567) return missing();
      return true;
    });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const release = await acquireTuiDownloadLock(lock, 1000);
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        --active;
        release();
      }),
    );
    expect(peak).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });
  it("retains changed staging evidence without masking the acquisition failure", async () => {
    const { lock, root } = fixture();
    const failure = new Error("controlled staging replacement");
    vi.mocked(fs.writeFileSync).mockImplementationOnce((file) => {
      const staging = String(file).slice(0, String(file).lastIndexOf("/"));
      renameSync(staging, join(root, "original-staging"));
      mkdirSync(staging, { mode: 0o700 });
      throw failure;
    });
    await expect(acquireTuiDownloadLock(lock, 20)).rejects.toBe(failure);
    expect(readdirSync(root)).toHaveLength(2);
  });
});
