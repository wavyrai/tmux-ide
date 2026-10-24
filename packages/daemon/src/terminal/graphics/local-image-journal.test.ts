import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalImageOwner } from "./local-image-owner.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "image-journal-"));
  const generation = randomUUID();
  const owner = await LocalImageOwner.create({
    root,
    generation,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  const bytes = Buffer.from("shared image");
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return {
    owner,
    root,
    manifest: join(owner.path, "owner.json"),
    input: { generation, digest, bytes },
  };
}

it("reuses the durable journal when leases leave the owned file set unchanged", async () => {
  const { owner, root, manifest, input } = await fixture();
  try {
    const first = await owner.acquire({ ...input, client: "first" });
    const original = await lstat(manifest);
    const second = await owner.acquire({ ...input, client: "second" });
    expect(second.path).toBe(first.path);
    expect((await lstat(manifest)).ino).toBe(original.ino);
    await owner.release(first);
    expect((await lstat(manifest)).ino).toBe(original.ino);
    expect(JSON.parse(await readFile(manifest, "utf8")).files).toHaveLength(1);
    await owner.release(second);
    expect(JSON.parse(await readFile(manifest, "utf8")).files).toEqual([]);
    await expect(lstat(first.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await owner.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("journal reuse still rejects a same-content replacement before publishing a lease", async () => {
  const { owner, root, manifest, input } = await fixture();
  try {
    await owner.acquire({ ...input, client: "first" });
    const replacement = join(owner.path, "replacement.json");
    await copyFile(manifest, replacement);
    await rename(replacement, manifest);
    await expect(owner.acquire({ ...input, client: "second" })).rejects.toThrow(
      "Local image manifest replaced",
    );
  } finally {
    await owner.dispose().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
