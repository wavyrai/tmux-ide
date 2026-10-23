import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalImageStore } from "./local-image-store.ts";
const generation = "12345678-1234-4234-8234-123456789abc";
const scope = { generation, client: "one" };
const roots: string[] = [];
const stores: LocalImageStore[] = [];
async function store(
  options: Omit<Parameters<typeof LocalImageStore.create>[0], "parent" | "generation"> = {},
) {
  const parent = await mkdtemp(join(tmpdir(), "local-image-test-"));
  await chmod(parent, 0o700);
  roots.push(parent);
  const result = await LocalImageStore.create({ parent, generation, ...options });
  stores.push(result);
  return result;
}
const input = (value = "pixels", client = "one") => {
  const bytes = Buffer.from(value);
  return {
    generation,
    client,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex").slice(0, 32),
  };
};
afterEach(async () => {
  for (const value of stores.splice(0)) await value.dispose().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("atomic private immutable files share bytes but independent clients own their leases", async () => {
  const owner = await store();
  const a = await owner.acquire(input());
  const b = await owner.acquire(input("pixels", "two"));
  expect(a.path).toBe(b.path);
  expect(a.id).not.toBe(b.id);
  expect(await readFile(a.path, "utf8")).toBe("pixels");
  expect((await lstat(owner.directory)).mode & 0o777).toBe(0o700);
  expect((await lstat(a.path)).mode & 0o777).toBe(0o400);
  expect(await owner.release({ ...scope, client: "two", id: a.id })).toBe(false);
  await expect(owner.release({ ...scope, generation: "other", id: a.id })).rejects.toThrow("scope");
  expect(await owner.release({ ...scope, id: a.id })).toBe(true);
  expect(await readFile(b.path, "utf8")).toBe("pixels");
  await owner.releaseClient({ ...scope, client: "two" });
  await expect(lstat(b.path)).rejects.toMatchObject({ code: "ENOENT" });
});
test("bounds and bad digests cannot evict live leases, expiry releases abandoned clients", async () => {
  let now = 100;
  const owner = await store({ maxBytes: 8, maxFiles: 1, maxLeases: 2, ttlMs: 20, now: () => now });
  const a = await owner.acquire(input("first"));
  await expect(owner.acquire(input("second"))).rejects.toThrow("bound");
  await expect(owner.acquire({ ...input("x"), digest: "a".repeat(32) })).rejects.toThrow("digest");
  const b = await owner.acquire(input("first", "two"));
  await expect(owner.acquire(input("first", "three"))).rejects.toThrow("lease bound");
  now = 119;
  await owner.sweep();
  expect(await readFile(a.path, "utf8")).toBe("first");
  now = 120;
  await owner.sweep();
  await expect(lstat(b.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await owner.acquire(input("second"))).digest).toBe(input("second").digest);
});
test("caller mutation and concurrent acquisition cannot change admitted bytes or scope", async () => {
  const owner = await store();
  const value = input();
  const acquisition = owner.acquire(value);
  value.bytes.fill(0);
  value.client = "changed";
  value.digest = "b".repeat(32);
  const lease = await acquisition;
  expect(lease.client).toBe("one");
  expect(await readFile(lease.path, "utf8")).toBe("pixels");
  const others = await Promise.all([owner.acquire(input()), owner.acquire(input())]);
  expect(others.every((other) => other.path === lease.path)).toBe(true);
});
test("symlink and replacement files are refused and never cleaned as owned files", async () => {
  const owner = await store();
  const lease = await owner.acquire(input());
  const victim = join(roots.at(-1)!, "unrelated");
  await writeFile(victim, "do not touch");
  await unlink(lease.path);
  await symlink(victim, lease.path);
  await expect(owner.acquire(input())).rejects.toThrow("replaced");
  await expect(owner.release({ ...scope, id: lease.id })).rejects.toThrow("replacement");
  expect((await lstat(lease.path)).isSymbolicLink()).toBe(true);
  expect(await readFile(victim, "utf8")).toBe("do not touch");
  await unlink(lease.path);
  await writeFile(lease.path, "other owner");
  await expect(owner.dispose()).rejects.toThrow("replacement");
  expect(await readFile(lease.path, "utf8")).toBe("other owner");
});
test("directory replacement and unexpected entries survive disposal", async () => {
  const owner = await store();
  const original = owner.directory + "-original";
  await rename(owner.directory, original);
  await symlink(original, owner.directory);
  await expect(owner.acquire(input())).rejects.toThrow("directory replaced");
  await expect(owner.dispose()).rejects.toThrow("directory replaced");
  expect((await lstat(owner.directory)).isSymbolicLink()).toBe(true);
  const other = await store();
  const foreign = join(other.directory, "foreign");
  await writeFile(foreign, "untouched");
  await expect(other.dispose()).rejects.toMatchObject({ code: "ENOTEMPTY" });
  expect(await readFile(foreign, "utf8")).toBe("untouched");
});
test("dispose drains acquisition and refuses new work", async () => {
  const owner = await store();
  const pending = owner.acquire(input());
  const disposal = owner.dispose();
  await expect(pending).rejects.toThrow("closed");
  await disposal;
  await expect(owner.acquire(input())).rejects.toThrow("unavailable");
  await expect(lstat(owner.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test("automatic expiry cleans a crashed client without another API request", async () => {
  const owner = await store({ ttlMs: 10 });
  const lease = await owner.acquire(input());
  await expect
    .poll(
      async () => {
        try {
          await lstat(lease.path);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
      },
      { timeout: 1000, interval: 10 },
    )
    .toBe(true);
});

test("queued memory is bounded and preexisting digest paths are never overwritten", async () => {
  const owner = await store({ maxBytes: 8 });
  const pending = owner.acquire(input("12345678"));
  await expect(owner.acquire(input("12345678", "two"))).rejects.toThrow("unavailable");
  await pending;
  const other = await store();
  const value = input();
  const foreign = join(other.directory, createHash("sha256").update(value.bytes).digest("hex"));
  await writeFile(foreign, "foreign");
  await expect(other.acquire(value)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(foreign, "utf8")).toBe("foreign");
  await expect(other.dispose()).rejects.toMatchObject({ code: "ENOTEMPTY" });
});
