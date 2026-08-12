import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { WidgetAssetId } from "@tmux-ide/contracts";

import { createRichPreviewAssetLoader } from "./asset-loader.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(bytes: Uint8Array, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tmux-ide-rich-preview-"));
  roots.push(root);
  const assetId = createHash("sha256").update(bytes).digest("hex") as WidgetAssetId;
  const metadata = {
    version: 1,
    assetId,
    media: "text/markdown",
    name: "README.md",
    byteLength: bytes.length,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  await writeFile(join(root, `${assetId}.json`), JSON.stringify(metadata));
  await writeFile(join(root, `${assetId}.bin`), bytes);
  return { root, assetId };
}

describe("rich preview asset loader", () => {
  it("loads only regular metadata-matched content-addressed files", async () => {
    const bytes = new TextEncoder().encode("# Verified");
    const { root, assetId } = await fixture(bytes);
    const result = await createRichPreviewAssetLoader({ root })(
      assetId,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "ok",
      asset: { assetId, media: "text/markdown", name: "README.md", byteLength: bytes.length },
    });
    if (result.status === "ok") expect(result.asset.bytes).toEqual(bytes);
  });

  it("rejects metadata, size and hash mismatches", async () => {
    const bytes = new TextEncoder().encode("trusted");
    const invalidMetadata = await fixture(bytes, { byteLength: bytes.length + 1 });
    expect(
      await createRichPreviewAssetLoader({ root: invalidMetadata.root })(
        invalidMetadata.assetId,
        new AbortController().signal,
      ),
    ).toEqual({ status: "error", reason: "invalid-metadata" });

    const corrupt = await fixture(bytes);
    await writeFile(join(corrupt.root, `${corrupt.assetId}.bin`), "corrupt");
    expect(
      await createRichPreviewAssetLoader({ root: corrupt.root })(
        corrupt.assetId,
        new AbortController().signal,
      ),
    ).toEqual({ status: "error", reason: "hash-mismatch" });

    const oversized = await fixture(bytes);
    expect(
      await createRichPreviewAssetLoader({ root: oversized.root, maxBytes: 3 })(
        oversized.assetId,
        new AbortController().signal,
      ),
    ).toEqual({ status: "error", reason: "invalid-metadata" });
  });

  it("refuses symlinks and observes cancellation", async () => {
    const bytes = new TextEncoder().encode("safe");
    const linked = await fixture(bytes);
    const original = join(linked.root, "original.bin");
    await writeFile(original, bytes);
    await rm(join(linked.root, `${linked.assetId}.bin`));
    await symlink(original, join(linked.root, `${linked.assetId}.bin`));
    expect(
      await createRichPreviewAssetLoader({ root: linked.root })(
        linked.assetId,
        new AbortController().signal,
      ),
    ).toEqual({ status: "error", reason: "unsafe-path" });

    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      await createRichPreviewAssetLoader({ root: linked.root })(linked.assetId, cancelled.signal),
    ).toEqual({ status: "error", reason: "aborted" });
  });

  it("rejects future and expired metadata", async () => {
    const bytes = new TextEncoder().encode("time-bound");
    const future = await fixture(bytes, { createdAt: new Date(2_000).toISOString() });
    expect(
      await createRichPreviewAssetLoader({ root: future.root, now: () => 1_000 })(
        future.assetId,
        new AbortController().signal,
      ),
    ).toEqual({ status: "error", reason: "invalid-metadata" });

    const stale = await fixture(bytes, { createdAt: new Date(0).toISOString() });
    expect(
      await createRichPreviewAssetLoader({ root: stale.root, now: () => 100_000_000 })(
        stale.assetId,
        new AbortController().signal,
      ),
    ).toEqual({ status: "error", reason: "invalid-metadata" });
  });
});
