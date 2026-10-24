import { afterEach, expect, test, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalImageOwner, cleanupLocalImageOwner } from "./local-image-owner.ts";
const roots: string[] = [];
const owners: LocalImageOwner[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "image-owner-test-"));
  await chmod(root, 0o700);
  roots.push(root);
  const identity = {
    generation: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const owner = await LocalImageOwner.create({ root, ...identity });
  owners.push(owner);
  const bytes = Buffer.from("image");
  const lease = await owner.acquire({
    generation: identity.generation,
    client: "client",
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex").slice(0, 32),
  });
  return { root, identity, owner, lease };
}
function dead() {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("dead"), { code: "ESRCH" });
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) await owner.dispose().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test("lease publication has a bounded manifest and ordinary disposal removes only its instance", async () => {
  const { root, owner, lease } = await fixture();
  const manifest = JSON.parse(await readFile(join(owner.path, "owner.json"), "utf8"));
  expect(manifest.files).toHaveLength(1);
  expect(manifest.files[0].identity.ino).toBe((await lstat(lease.path)).ino);
  const sibling = join(root, "unrelated");
  await writeFile(sibling, "keep");
  await owner.dispose();
  await expect(lstat(owner.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sibling, "utf8")).toBe("keep");
});
test("exact dead predecessor cleans recorded files without scanning other generations", async () => {
  const { root, identity, owner, lease } = await fixture();
  const sibling = join(root, `local-images-${randomUUID()}`);
  await writeFile(sibling, "keep");
  dead();
  expect(await cleanupLocalImageOwner({ root, owner: identity, proveDead: async () => true })).toBe(
    true,
  );
  await expect(lstat(lease.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(owner.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(sibling, "utf8")).toBe("keep");
});
test("alive, uncertain, mismatched start, and rejected authoritative proof retain files", async () => {
  const { root, identity, lease } = await fixture();
  const options = { root, owner: identity, proveDead: async () => true };
  expect(await cleanupLocalImageOwner(options)).toBe(false);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("permission"), { code: "EPERM" });
  });
  expect(await cleanupLocalImageOwner(options)).toBe(false);
  vi.restoreAllMocks();
  dead();
  expect(await cleanupLocalImageOwner({ ...options, proveDead: async () => false })).toBe(false);
  expect(
    await cleanupLocalImageOwner({
      ...options,
      owner: { ...identity, startedAt: "2000-01-01T00:00:00.000Z" },
    }),
  ).toBe(false);
  expect(await readFile(lease.path, "utf8")).toBe("image");
});
test("replacement and unknown files survive dead-owner cleanup", async () => {
  const { root, identity, owner, lease } = await fixture();
  const external = join(root, "foreign");
  await writeFile(external, "keep");
  await unlink(lease.path);
  await symlink(external, lease.path);
  dead();
  expect(await cleanupLocalImageOwner({ root, owner: identity, proveDead: async () => true })).toBe(
    false,
  );
  expect(await readFile(external, "utf8")).toBe("keep");
  await unlink(lease.path);
  const manifest = JSON.parse(await readFile(join(owner.path, "owner.json"), "utf8"));
  const unknown = join(owner.path, manifest.store.name, "unrecorded");
  await writeFile(unknown, "keep unknown");
  expect(await cleanupLocalImageOwner({ root, owner: identity, proveDead: async () => true })).toBe(
    false,
  );
  expect(await readFile(unknown, "utf8")).toBe("keep unknown");
  expect((await lstat(join(owner.path, "owner.json"))).isFile()).toBe(true);
});
test("swapped instance directory after dead proof is refused", async () => {
  const { root, identity, owner, lease } = await fixture();
  dead();
  await expect(
    cleanupLocalImageOwner({
      root,
      owner: identity,
      proveDead: async () => {
        await rename(owner.path, owner.path + "-old");
        await symlink(owner.path + "-old", owner.path);
        return true;
      },
    }),
  ).rejects.toThrow("directory replaced");
  expect(await readFile(lease.path, "utf8")).toBe("image");
});

test("startup finishes an interrupted disposal after the owned store is already gone", async () => {
  const { root, identity, owner, lease } = await fixture();
  const manifest = JSON.parse(await readFile(join(owner.path, "owner.json"), "utf8"));
  await unlink(lease.path);
  await rmdir(join(owner.path, manifest.store.name));
  dead();
  expect(await cleanupLocalImageOwner({ root, owner: identity, proveDead: async () => true })).toBe(
    true,
  );
  await expect(lstat(owner.path)).rejects.toMatchObject({ code: "ENOENT" });
});

test("canonicalizes trusted symlink ancestors but refuses a symlink root itself", async () => {
  const parent = await mkdtemp(join(tmpdir(), "image-owner-path-"));
  roots.push(parent);
  const actual = join(parent, "actual");
  await mkdir(actual, { mode: 0o700 });
  const alias = join(parent, "alias");
  await symlink(actual, alias);
  const root = join(alias, "private");
  await mkdir(root, { mode: 0o700 });
  const identity = {
    generation: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const owner = await LocalImageOwner.create({ root, ...identity });
  owners.push(owner);
  expect(owner.path).toBe(join(await realpath(root), `local-images-${identity.generation}`));
  await expect(LocalImageOwner.create({ root: alias, ...identity })).rejects.toThrow(
    "directory replaced",
  );
});
