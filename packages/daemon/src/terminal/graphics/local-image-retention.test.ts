import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalImageOwner } from "./local-image-owner.ts";
import type { LocalImageLease } from "./local-image-store.ts";

it("retains only leased images through sustained redraw, slow readers and reconnects", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-retention-"));
  const generation = randomUUID();
  const owner = await LocalImageOwner.create({
    root,
    generation,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    store: { maxBytes: 8 * 65536, maxFiles: 4, maxLeases: 16 },
  });
  const held: LocalImageLease[] = [];
  let acquisitions = 0,
    peakFiles = 0,
    peakBytes = 0,
    peakManifest = 0;
  try {
    for (let cycle = 0; cycle < 96; cycle++) {
      const bytes = Buffer.alloc(65536, cycle);
      const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
      const leases = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          owner.acquire({ generation, client: `cycle:${cycle}:reader:${i}`, digest, bytes }),
        ),
      );
      acquisitions += leases.length;
      expect(new Set(leases.map((lease) => lease.path)).size).toBe(1);
      expect(await readFile(leases[0]!.path)).toEqual(bytes);
      if (cycle % 16 === 0) held.push(leases.shift()!);
      while (held.length > 2) await owner.release(held.shift()!);
      for (const lease of leases) await owner.releaseClient(lease);
      const encoded = await readFile(join(owner.path, "owner.json"));
      const manifest = JSON.parse(encoded.toString());
      const directory = join(owner.path, manifest.store.name);
      const names = await readdir(directory);
      let retained = 0;
      for (const name of names) retained += (await lstat(join(directory, name))).size;
      peakFiles = Math.max(peakFiles, names.length);
      peakBytes = Math.max(peakBytes, retained);
      peakManifest = Math.max(peakManifest, encoded.length);
      expect(names.length).toBeLessThanOrEqual(2);
      expect(retained).toBeLessThanOrEqual(2 * 65536);
      expect(manifest.files.length).toBe(names.length);
    }
    for (const lease of held) await owner.release(lease);
    const manifest = JSON.parse(await readFile(join(owner.path, "owner.json"), "utf8"));
    expect(manifest.files).toEqual([]);
    expect(await readdir(join(owner.path, manifest.store.name))).toEqual([]);
    expect(acquisitions).toBe(768);
    console.info(
      JSON.stringify({
        qualification: "local-image-retained-resources",
        cycles: 96,
        acquisitions,
        imageBytes: 65536,
        peakFiles,
        peakBytes,
        peakManifest,
        finalFiles: 0,
        scope: "source owner/store; no GUI, RSS or latency measurement",
      }),
    );
  } finally {
    await owner.dispose();
    await rm(root, { recursive: true, force: true });
  }
  await expect(lstat(owner.path)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);
